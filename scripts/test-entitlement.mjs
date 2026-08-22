/* The entitlement rule, checked against the real source rather than a copy.
 *
 * This is the one piece of logic where a mistake is silently expensive: too
 * generous and one $7.99 plan buys the catalogue, too strict and a paying
 * customer is locked out. The rule lives in two places that must agree —
 * tiers.js in the browser and covers() in the content function — so both are
 * pulled from their files and run against the same table.
 *
 * Usage: node scripts/test-entitlement.mjs
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Extract covers() from the edge function and make it callable. */
async function serverRule() {
  const src = await readFile(join(ROOT, "supabase/functions/content/index.ts"), "utf8");
  const m = src.match(/function covers\(tier: any, slug: string\): boolean \{([\s\S]*?)\n\}/);
  if (!m) throw new Error("could not find covers() in the content function");
  return new Function("tier", "slug", m[1].replace(/: any|: string|: boolean/g, ""));
}

/** Extract _coversThisApp() from tiers.js, with its module state injected. */
async function clientRule() {
  const src = await readFile(join(ROOT, "packages/app-core/js/tiers.js"), "utf8");
  const m = src.match(/function _coversThisApp\(\) \{([\s\S]*?)\n\}/);
  if (!m) throw new Error("could not find _coversThisApp() in tiers.js");
  // The function closes over _tier and APP_ID; supply both as parameters.
  return new Function("_tier", "APP_ID", m[1]);
}

const CASES = [
  [{ tier: "all_access", tier_app: null, is_active: true }, "forge-cloud", true,
    "unlimited covers any app"],
  [{ tier: "all_access", tier_app: null, is_active: true }, "keystone", true,
    "unlimited covers all ten"],
  [{ tier: "pro", tier_app: "casebook-lcsw", is_active: true }, "casebook-lcsw", true,
    "pro covers its own app"],
  [{ tier: "pro", tier_app: "casebook-lcsw", is_active: true }, "casebook", false,
    "pro does not cover a sibling"],
  [{ tier: "pro", tier_app: "casebook", is_active: true }, "casebook-lbsw", false,
    "pro does not spread across the family"],
  [{ tier: "pro", tier_app: "forge", is_active: true }, "forge-cloud", false,
    "a family value grants nothing"],
  [{ tier: "pro", tier_app: "forge", is_active: true }, "forge-trades", false,
    "a family value grants nothing (2)"],
  [{ tier: "pro", tier_app: null, is_active: true }, "casebook", false,
    "unscoped pro fails closed"],
  [{ tier: "free", tier_app: null, is_active: true }, "casebook", false,
    "free grants nothing"],
];

// is_active is checked by the server rule; the client checks it in isPro()
// around _coversThisApp, so the expired case is server-only.
const SERVER_ONLY = [
  [{ tier: "pro", tier_app: "casebook", is_active: false }, "casebook", false,
    "expired pro grants nothing"],
  [null, "casebook", false, "no record grants nothing"],
];

const server = await serverRule();
const client = await clientRule();

let pass = 0, fail = 0;
const run = (label, got, expect) => {
  const ok = got === expect;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(44)} expected ${String(expect).padEnd(5)} got ${got}`);
};

console.log("\n  server — covers() in the content function");
for (const [tier, slug, expect, label] of [...CASES, ...SERVER_ONLY]) {
  run(label, server(tier, slug), expect);
}

console.log("\n  client — _coversThisApp() in tiers.js");
for (const [tier, slug, expect, label] of CASES) {
  run(label, client(tier, slug), expect);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
