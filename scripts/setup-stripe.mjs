/* Create the Stripe catalogue from the registry.
 *
 * Every entitlement decision the webhook makes comes from metadata on the
 * price: `tier` = pro | all_access, `app` = <slug> for Pro, `ebook` = <slug>
 * for a book. Get one of those wrong in the dashboard and the buyer pays and
 * receives nothing — the webhook refuses to guess, which is the safe direction
 * to fail but still a refund and a support ticket. Twenty-one prices clicked in
 * by hand is twenty-one chances to make that mistake, so they are generated
 * from packages/registry/apps.json instead.
 *
 * Idempotent: products and prices are looked up by a stable lookup_key before
 * anything is created, so re-running after adding an app touches only the new
 * one. Prices in Stripe are immutable — a changed amount creates a new price
 * and archives the old one, leaving existing subscriptions on what they bought.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.mjs           # dry run
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.mjs --write
 *
 * Run it against a test key first. The output is the same either way.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITE = process.argv.includes("--write");
const KEY = process.env.STRIPE_SECRET_KEY;

if (!KEY) {
  console.error("setup-stripe: STRIPE_SECRET_KEY is not set.");
  console.error("  Stripe Dashboard → Developers → API keys → Secret key.");
  console.error("  Pass it in the environment; never put it in a file in this repo.");
  process.exit(1);
}
if (!/^sk_(test|live)_/.test(KEY)) {
  console.error("setup-stripe: that does not look like a Stripe secret key (sk_test_… or sk_live_…).");
  process.exit(1);
}
const LIVE = KEY.startsWith("sk_live_");

/* ---------------- a very small Stripe client ---------------- */

const API = "https://api.stripe.com/v1";

/** Stripe takes form-encoded bodies, including for nested metadata. */
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2024-12-18.acacia",
    },
    body: body ? form(body).toString() : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Stripe ${method} ${path}: ${msg}`);
  }
  return json;
}

/* ---------------- what to create ---------------- */

const reg = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const live = reg.apps.filter(a => a.status === "live");

const PRO = 799, ALL_ACCESS = 1499;
const money = c => "$" + (c / 100).toFixed(2);

const plan = [];

// One Pro price per app. `app` must be the slug — a family name matches no app
// and leaves the buyer with nothing.
for (const a of live) {
  plan.push({
    kind: "subscription",
    lookup_key: `pro_${a.slug}`.replace(/-/g, "_"),
    product: `BIGHEAVYINK Pro — ${a.name}`,
    description: `Full question bank, timed exam simulation and the on-device tutor for ${a.name}.`,
    amount: PRO,
    interval: "month",
    metadata: { tier: "pro", app: a.slug },
  });
}

plan.push({
  kind: "subscription",
  lookup_key: "all_access",
  product: "BIGHEAVYINK Unlimited",
  description: "Every study app unlocked under one subscription, including apps released later.",
  amount: ALL_ACCESS,
  interval: "month",
  // No `app`: all_access is not scoped to one, and the webhook stores null.
  metadata: { tier: "all_access" },
});

// One-time price per companion book.
for (const a of live.filter(x => x.ebook)) {
  plan.push({
    kind: "one_time",
    lookup_key: `ebook_${a.slug}`.replace(/-/g, "_"),
    product: a.ebook.title,
    description: `Companion PDF for ${a.name}. Every term and rationale, in reading order.`,
    amount: Math.round((a.ebook.price ?? reg.ebooks.price ?? 9.99) * 100),
    metadata: { ebook: a.slug },
  });
}

const COUPONS = (reg.ebooks?.promos || []).map(p => ({
  id: p.applies_to === "pro" ? "BH_PRO_10" : "BH_ALL_ACCESS_20",
  name: p.applies_to === "pro"
    ? "10% off Pro — thank you for buying a book"
    : "20% off Unlimited — thank you for buying three books",
  percent_off: p.percent_off,
  duration: "forever",
  env: p.applies_to === "pro" ? "COUPON_PRO_10" : "COUPON_ALL_ACCESS_20",
}));

/* ---------------- reconcile ---------------- */

console.log(`\n  ${LIVE ? "LIVE MODE" : "test mode"} · ${WRITE ? "writing" : "dry run, nothing will be created"}\n`);
if (LIVE && WRITE) console.log("  This is your live catalogue. Real prices, real customers.\n");

const created = [];

for (const item of plan) {
  // Prices are found by lookup_key, which survives renames and re-runs.
  const found = await stripe("GET", `/prices?lookup_keys[]=${item.lookup_key}&active=true&expand[]=data.product`);
  const existing = found.data?.[0];

  if (existing) {
    const meta = { ...(existing.product?.metadata || {}), ...(existing.metadata || {}) };
    const drift = Object.entries(item.metadata).filter(([k, v]) => meta[k] !== v);
    const amountDrift = existing.unit_amount !== item.amount;
    const status = drift.length ? "METADATA DRIFT" : amountDrift ? "PRICE CHANGED" : "ok";
    console.log(`  ${status.padEnd(15)} ${item.lookup_key.padEnd(26)} ${money(existing.unit_amount)}`
      + (drift.length ? `  ${drift.map(([k, v]) => `${k}: "${meta[k] ?? ""}" should be "${v}"`).join(", ")}` : "")
      + (amountDrift ? `  should be ${money(item.amount)} — Stripe prices are immutable, archive and re-create` : ""));
    continue;
  }

  console.log(`  ${(WRITE ? "creating" : "would create").padEnd(15)} ${item.lookup_key.padEnd(26)} ${money(item.amount)}`
    + `  ${Object.entries(item.metadata).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  if (!WRITE) continue;

  const product = await stripe("POST", "/products", {
    name: item.product,
    description: item.description,
    metadata: item.metadata,          // on the product too, so a future price inherits it
  });
  const price = await stripe("POST", "/prices", {
    product: product.id,
    currency: "usd",
    unit_amount: item.amount,
    lookup_key: item.lookup_key,
    metadata: item.metadata,
    ...(item.kind === "subscription" ? { recurring: { interval: item.interval } } : {}),
  });
  created.push({ lookup_key: item.lookup_key, price: price.id });
}

console.log("");
for (const c of COUPONS) {
  let existing = null;
  try { existing = await stripe("GET", `/coupons/${c.id}`); } catch { /* not there yet */ }
  if (existing) {
    const ok = existing.percent_off === c.percent_off;
    console.log(`  ${(ok ? "ok" : "PERCENT DRIFT").padEnd(15)} coupon ${c.id.padEnd(19)} ${existing.percent_off}% off`
      + (ok ? "" : ` — should be ${c.percent_off}%`));
    continue;
  }
  console.log(`  ${(WRITE ? "creating" : "would create").padEnd(15)} coupon ${c.id.padEnd(19)} ${c.percent_off}% off`);
  if (WRITE) await stripe("POST", "/coupons", { id: c.id, name: c.name, percent_off: c.percent_off, duration: c.duration });
}

/* ---------------- what to do next ---------------- */

console.log(`\n  ${plan.length} prices, ${COUPONS.length} coupons.`);

if (!WRITE) {
  console.log("\n  Dry run. Re-run with --write to create anything marked above.\n");
} else {
  console.log("\n  Set these as Edge Function secrets so the webhook can issue the discounts:");
  for (const c of COUPONS) console.log(`    supabase secrets set ${c.env}=${c.id}`);
  console.log("\n  Then point a webhook at the function and set its signing secret:");
  console.log("    Stripe → Developers → Webhooks → Add endpoint");
  console.log("      URL:    https://<project-ref>.supabase.co/functions/v1/stripe-webhook");
  console.log("      Events: checkout.session.completed, customer.subscription.created,");
  console.log("              customer.subscription.updated, customer.subscription.deleted");
  console.log("    supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...\n");
  if (created.length) {
    console.log("  Created price ids, for the checkout buttons:");
    for (const c of created) console.log(`    ${c.lookup_key.padEnd(26)} ${c.price}`);
    console.log("");
  }
}
