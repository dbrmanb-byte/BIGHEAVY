/* Is this build actually wired to a backend?
 *
 * The failure this catches is silent: with no config every app still runs, still
 * looks right, and quietly serves the free tier to people who have paid. Nothing
 * throws, so the only way to notice is to check.
 *
 * Usage: node scripts/check-config.mjs [slug]
 *        node scripts/check-config.mjs <slug> --summary   # one line, for preflight
 */

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const only = args[0];
const SUMMARY = process.argv.includes("--summary");

if (SUMMARY) {
  const p = join(ROOT, "apps", only || "", "dist", "config.js");
  let line = "dist/config.js missing";
  if (existsSync(p)) {
    const s = await readFile(p, "utf8");
    const url = (s.match(/BH_SUPABASE_URL = "([^"]*)"/) || [])[1] || "";
    line = url ? `configured → ${url}` : "free-only (no backend configured)";
  }
  console.log(line);
  process.exit(0);
}

let fail = 0;
const say = (ok, label, note = "") => {
  if (!ok) fail++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(46)} ${note}`);
};

const slugs = (await readdir(join(ROOT, "apps"), { withFileTypes: true }))
  .filter(e => e.isDirectory()).map(e => e.name)
  .filter(s => !only || s === only);

console.log("");
const env = { url: process.env.BH_SUPABASE_URL || "", key: process.env.BH_SUPABASE_KEY || "" };
console.log(`  environment: BH_SUPABASE_URL ${env.url ? "set" : "not set"}`
          + `, BH_SUPABASE_KEY ${env.key ? "set" : "not set"}\n`);

for (const slug of slugs) {
  const dist = join(ROOT, "apps", slug, "dist");
  if (!existsSync(dist)) { say(false, slug, "not built — run pnpm run build"); continue; }

  const cfgPath = join(dist, "config.js");
  if (!existsSync(cfgPath)) { say(false, slug, "dist/config.js missing"); continue; }

  const cfg = await readFile(cfgPath, "utf8");
  const url = (cfg.match(/BH_SUPABASE_URL = "([^"]*)"/) || [])[1] ?? "";
  const key = (cfg.match(/BH_SUPABASE_KEY = "([^"]*)"/) || [])[1] ?? "";

  if (!url && !key) { say(true, slug, "free-only (no backend configured)"); continue; }
  if (!url || !key) { say(false, slug, "half-configured — one of URL/key is empty"); continue; }

  const looksSecret = /^sb_secret_|^sk_/.test(key) || /service_role/.test(key);
  say(!looksSecret, slug, looksSecret
    ? "SECRET KEY IN THE BROWSER BUNDLE — rotate it now and use the anon key"
    : `configured → ${url}`);
}

// Every page that talks to a backend has to actually load the generated file,
// or it reads an undefined global and silently degrades.
console.log("");
for (const slug of slugs) {
  const src = join(ROOT, "apps", slug, "src");
  const pages = (await readdir(src)).filter(f => f.endsWith(".html"));
  const needs = [];
  for (const p of pages) {
    const html = await readFile(join(src, p), "utf8");
    if (/BH_SUPABASE_(URL|KEY)/.test(html) && !/src="\.\/config\.js"/.test(html)) needs.push(p);
  }
  say(needs.length === 0, `${slug} pages load config.js`,
    needs.length ? `missing in: ${needs.join(", ")}` : "");
}

// Offline, a page that fetches an uncached config.js gets a 404 and no backend.
console.log("");
for (const slug of slugs) {
  const sw = join(ROOT, "apps", slug, "src", "sw.js");
  if (!existsSync(sw)) continue;
  const src = await readFile(sw, "utf8");
  say(/["']\.\/config\.js["']/.test(src), `${slug} caches config.js offline`,
    /["']\.\/config\.js["']/.test(src) ? "" : "add ./config.js to the SHELL list");
}

console.log(fail ? `\n  ${fail} problem${fail === 1 ? "" : "s"}.\n` : "\n  Config is consistent.\n");
process.exit(fail ? 1 : 0);
