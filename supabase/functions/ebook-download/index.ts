// supabase/functions/ebook-download/index.ts
// Hands a buyer a short-lived link to a book they own.
//
// The bucket is private and the file never gets a URL of its own. This checks
// ownership against the caller's own JWT, stamps the buyer's identity onto every
// page, and streams the bytes back. There is nothing to share but the file, and
// the file says who it was sold to.
//
// Deploy: supabase functions deploy ebook-download
//
// Secrets (Supabase dashboard → Edge Functions):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   EBOOK_BUCKET   optional, defaults to "ebooks"

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

const BUCKET = Deno.env.get("EBOOK_BUCKET") ?? "ebooks";

// Allow the sites to call this from the browser. Set to your domains in
// production; "*" is fine while nothing is deployed yet.
const ALLOWED_ORIGIN = Deno.env.get("EBOOK_ALLOWED_ORIGIN") ?? "*";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

/** Slugs are used to build a storage path, so they must not be able to escape it. */
function validSlug(s: unknown): s is string {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "sign in to download your books" }, 401);
  }

  let slug: unknown;
  try {
    slug = (await req.json())?.slug;
  } catch {
    return json({ error: "expected a JSON body with a slug" }, 400);
  }
  if (!validSlug(slug)) return json({ error: "unknown book" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;

  // Identify the caller from their own token. Using the anon key with the
  // caller's Authorization header means RLS applies and the reply can only ever
  // describe that user.
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await asUser.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "sign in to download your books" }, 401);

  // Ownership is decided here, server-side. The client is never trusted for it.
  const { data: owned, error: ownErr } = await asUser
    .from("ebook_purchases")
    .select("id, ebook_slug")
    .eq("user_id", user.id)
    .eq("ebook_slug", slug)
    .maybeSingle();

  if (ownErr) {
    console.error("ownership lookup failed:", ownErr);
    return json({ error: "could not check your library, try again" }, 500);
  }
  if (!owned) {
    // Deliberately not "this book exists but you have not bought it" — there is
    // nothing useful in distinguishing the two for a caller who owns neither.
    return json({ error: "not in your library", owned: false }, 403);
  }

  // Reading the private object needs the service role. That key never leaves
  // this function, and the file is never exposed at a URL of its own.
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const path = `${slug}.pdf`;

  const { data: file, error: dlErr } = await admin.storage.from(BUCKET).download(path);
  if (dlErr || !file) {
    console.error("could not read", path, dlErr);
    return json({ error: "that book is not available for download yet" }, 404);
  }

  // Watermark. This does not stop copying — nothing does, for a file someone is
  // allowed to read. It makes a leaked copy traceable to the account that
  // bought it, which is what actually changes behaviour.
  let bytes: Uint8Array;
  try {
    bytes = await watermark(await file.arrayBuffer(), {
      email: user.email ?? user.id,
      orderRef: owned.id ?? "",
    });
  } catch (err) {
    // A book that cannot be stamped is not shipped unstamped: the mark is the
    // only deterrent on the file once it leaves here.
    console.error("watermarking failed for", path, err);
    return json({ error: "could not prepare that download, please try again" }, 500);
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      ...cors,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${slug}.pdf"`,
      "Cache-Control": "private, no-store",
      "X-Ebook-Slug": slug,
    },
  });
});

/** Stamp a footer identifying the buyer onto every page. */
async function watermark(
  input: ArrayBuffer,
  who: { email: string; orderRef: string },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(input);
  const font = await pdf.embedFont(StandardFonts.Helvetica);

  const stamped = new Date().toISOString().slice(0, 10);
  const ref = who.orderRef ? String(who.orderRef).slice(0, 8) : "";
  const line = `Licensed to ${who.email}${ref ? ` · ${ref}` : ""} · ${stamped} · BIGHEAVYINK`;

  const size = 7;
  for (const page of pdf.getPages()) {
    const { width } = page.getSize();
    const textWidth = font.widthOfTextAtSize(line, size);
    page.drawText(line, {
      // Centred in the bottom margin, light enough to ignore while reading and
      // awkward to crop out of every page.
      x: Math.max(8, (width - textWidth) / 2),
      y: 14,
      size,
      font,
      color: rgb(0.45, 0.45, 0.45),
      opacity: 0.75,
    });
  }

  // Metadata carries the same fact for a copy that gets re-rendered.
  pdf.setSubject(line);
  pdf.setProducer("BIGHEAVYINK");

  return await pdf.save({ useObjectStreams: false });
}
