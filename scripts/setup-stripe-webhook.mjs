/* Create the Stripe webhook endpoint from the command line.
 *
 * Exists because the dashboard's event picker groups events under headings and
 * matches search oddly, which makes "tick these four" harder than it should be.
 * The API takes the four names literally — and, unlike the dashboard, returns
 * the signing secret in the creation response, so this prints the exact
 * `supabase secrets set` command to run next.
 *
 * Idempotent: if an enabled endpoint already exists for the URL it is left
 * alone. Stripe only reveals a signing secret at creation, so for an existing
 * endpoint the secret has to come from the dashboard page instead.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe-webhook.mjs <project-ref>
 */

const KEY = process.env.STRIPE_SECRET_KEY;
const REF = (process.argv[2] || "").trim();

if (!KEY || !/^sk_(test|live)_/.test(KEY)) {
  console.error("setup-stripe-webhook: set STRIPE_SECRET_KEY to your sk_test_… or sk_live_… key.");
  process.exit(1);
}
if (!/^[a-z]{15,25}$/.test(REF)) {
  console.error("setup-stripe-webhook: pass your Supabase project ref, e.g.");
  console.error("  STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe-webhook.mjs ppmtaaomixlgjdyhyszo");
  process.exit(1);
}

const URL_ = `https://${REF}.supabase.co/functions/v1/stripe-webhook`;

// The four events the webhook function actually handles. Extra events would be
// ignored, but subscribing to exactly these keeps the deliveries readable.
const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];

async function stripe(method, path, params) {
  const body = params
    ? params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
    : undefined;
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer " + KEY,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Stripe ${method} ${path}: ${json?.error?.message || res.statusText}`);
  return json;
}

console.log(`\n  ${KEY.startsWith("sk_live_") ? "LIVE MODE" : "test mode"}`);
console.log(`  endpoint: ${URL_}\n`);

const existing = (await stripe("GET", "/webhook_endpoints?limit=100")).data
  .filter(w => w.url === URL_ && w.status === "enabled");

if (existing.length) {
  const w = existing[0];
  const missing = EVENTS.filter(e => !w.enabled_events.includes(e) && !w.enabled_events.includes("*"));
  console.log(`  Already exists (${w.id}).`);
  if (missing.length) {
    console.log(`  Adding missing events: ${missing.join(", ")}`);
    await stripe("POST", `/webhook_endpoints/${w.id}`,
      [...w.enabled_events, ...missing].map(e => ["enabled_events[]", e]));
    console.log("  Updated.");
  } else {
    console.log("  All four events are enabled.");
  }
  console.log("\n  Stripe only reveals a signing secret at creation. Get it from the");
  console.log("  endpoint's page (Developers → Webhooks → this endpoint → Signing secret),");
  console.log("  then:\n");
  console.log("    npx --yes supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...\n");
  process.exit(0);
}

const created = await stripe("POST", "/webhook_endpoints", [
  ["url", URL_],
  ["description", "BIGHEAVYINK entitlements — created by scripts/setup-stripe-webhook.mjs"],
  ...EVENTS.map(e => ["enabled_events[]", e]),
]);

console.log(`  Created ${created.id} with ${created.enabled_events.length} events.`);
console.log("\n  Its signing secret — shown this once. Set it now:\n");
console.log(`    npx --yes supabase secrets set STRIPE_WEBHOOK_SECRET=${created.secret}`);
console.log("\n  Then: ./scripts/check-supabase.sh\n");
