// supabase/functions/ebook-download/index.ts
// Hands a buyer a short-lived link to a book they own.
//
// The bucket is private. Nothing here ever returns the file itself or a
// permanent URL — it checks ownership against the caller's own JWT, then signs
// a URL that expires in minutes. A leaked link stops working on its own.
//
// Deploy: supabase functions deploy ebook-download
//
// Secrets (Supabase dashboard → Edge Functions):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   EBOOK_BUCKET   optional, defaults to "ebooks"

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BUCKET = Deno.env.get("EBOOK_BUCKET") ?? "ebooks";
const LINK_TTL_SECONDS = 300;   // five minutes is plenty to start a download

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
    .select("ebook_slug")
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

  // Signing needs the service role: the bucket is private and the reader has no
  // rights to it. That key never leaves this function.
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const path = `${slug}.pdf`;

  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, LINK_TTL_SECONDS, {
      download: `${slug}.pdf`,          // save-as rather than render in a tab
    });

  if (signErr || !signed?.signedUrl) {
    console.error("signing failed for", path, signErr);
    return json({ error: "that book is not available for download yet" }, 404);
  }

  return json({
    url: signed.signedUrl,
    slug,
    expires_in: LINK_TTL_SECONDS,
  });
});
