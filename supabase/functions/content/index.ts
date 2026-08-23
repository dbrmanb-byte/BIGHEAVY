// supabase/functions/content/index.ts
// Serves the paid question bank, and grades answers.
//
// Two things are enforced here and nowhere else:
//   1. Entitlement. The bank is only handed to a reader whose subscription
//      covers this app. The client is never trusted for that.
//   2. The answer key. Questions go out WITHOUT `answer`, `why` or `label`.
//      They come back only for items the reader has actually answered, so a
//      scraper with a paid account still has to work through the bank to
//      collect it, one submitted answer at a time.
//
// Deploy: supabase functions deploy content
//
// Secrets: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected)
//          CONTENT_BUCKET  optional, defaults to "content"

import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = Deno.env.get("CONTENT_BUCKET") ?? "content";
const ALLOWED_ORIGIN = Deno.env.get("CONTENT_ALLOWED_ORIGIN") ?? "*";

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

const validSlug = (s: unknown): s is string =>
  typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(s);

type Question = {
  id: string; n?: number; cat: string; stem: string; choices: string[];
  answer: number; label?: string; why?: string;
};

// Banks are small and change rarely; holding them between invocations saves
// re-reading storage on every request.
const bankCache = new Map<string, { at: number; bank: Question[] }>();
const BANK_TTL_MS = 5 * 60 * 1000;

async function loadBank(admin: any, slug: string): Promise<Question[] | null> {
  const hit = bankCache.get(slug);
  if (hit && Date.now() - hit.at < BANK_TTL_MS) return hit.bank;

  const { data, error } = await admin.storage.from(BUCKET).download(`${slug}/bank.json`);
  if (error || !data) {
    console.error("bank missing for", slug, error);
    return null;
  }
  try {
    const parsed = JSON.parse(await data.text());
    const bank: Question[] = parsed.questions || [];
    bankCache.set(slug, { at: Date.now(), bank });
    return bank;
  } catch (err) {
    console.error("bank unreadable for", slug, err);
    return null;
  }
}

/** Does this reader's subscription cover this app? Mirrors tiers.js, server-side.
    Pro covers one app, named by tier_app as a slug. A family value such as
    "forge" matches nothing here on purpose — it would unlock five apps. */
function covers(tier: any, slug: string): boolean {
  if (!tier || tier.is_active === false) return false;
  if (tier.tier === "all_access") return true;
  if (tier.tier !== "pro") return false;
  const scope = tier.tier_app;
  if (!scope) return false;                    // unscoped pro grants nothing
  return scope === slug;
}

/** Everything the reader may see before they have answered. */
const withoutKey = (q: Question) => ({
  id: q.id, n: q.n, cat: q.cat, stem: q.stem, choices: q.choices,
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "sign in to load the full question bank" }, 401);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "expected JSON" }, 400); }

  // `family` may still arrive from an older client; it is ignored, because
  // entitlement is per app.
  const { action, app, ids, answers } = body ?? {};
  if (!validSlug(app)) return json({ error: "unknown app" }, 400);

  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await asUser.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "sign in to load the full question bank" }, 401);
  }

  // Entitlement comes from the same RPC the client uses, but the answer here is
  // the one that counts.
  const { data: tier, error: tierErr } = await asUser.rpc("my_tier");
  if (tierErr) {
    console.error("tier lookup failed:", tierErr);
    return json({ error: "could not check your subscription, try again" }, 500);
  }
  if (!covers(tier, app)) {
    return json({ error: "the full question bank is part of Pro", entitled: false }, 403);
  }

  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const bank = await loadBank(admin, app);
  if (!bank) return json({ error: "that question bank is not available yet" }, 404);

  if (action === "bank") {
    // The whole bank, minus the answer key.
    return json({ app, total: bank.length, questions: bank.map(withoutKey) });
  }

  if (action === "grade") {
    // answers: { [id]: choiceIndex }. A key is only returned for an item the
    // reader submitted a choice for — asking for ids alone returns nothing.
    if (!answers || typeof answers !== "object") {
      return json({ error: "expected answers" }, 400);
    }
    const wanted = Object.keys(answers).slice(0, 500);
    const byId = new Map(bank.map(q => [q.id, q]));
    const results = wanted.flatMap(id => {
      const q = byId.get(id);
      if (!q) return [];
      const picked = answers[id];
      return [{
        id: q.id,
        answer: q.answer,
        label: q.label ?? null,
        why: q.why ?? null,
        correct: picked === q.answer,
      }];
    });
    return json({ app, results });
  }

  // `ids` is accepted for a targeted fetch, still without the key.
  if (Array.isArray(ids)) {
    const want = new Set(ids.slice(0, 500));
    return json({ app, questions: bank.filter(q => want.has(q.id)).map(withoutKey) });
  }

  return json({ error: "unknown action" }, 400);
});
