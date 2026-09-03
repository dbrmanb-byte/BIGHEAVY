/* Make the registry's counts match the content that actually exists.
 *
 * terms/questions were typed in by hand, and they are not decoration: the hub
 * prints them on every app card and in the blurb a buyer reads before paying.
 * Once content grows, hand-kept numbers become quiet lies. This reads the real
 * figures and rewrites them, and reports anything that moved.
 *
 * Usage: node scripts/sync-registry.mjs           report only
 *        node scripts/sync-registry.mjs --write   apply
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REG = join(ROOT, "packages/registry/apps.json");
const write = process.argv.includes("--write");

const registry = JSON.parse(await readFile(REG, "utf8"));

/** Real counts: the glossary from the bundle, the questions from the bank. */
async function actual(slug) {
  const out = { terms: null, questions: null };

  const freePath = join(ROOT, "apps", slug, "src", "content-free.js");
  if (existsSync(freePath)) {
    const t = await readFile(freePath, "utf8");
    try {
      const d = JSON.parse(t.slice(t.indexOf("window.DATA = ") + 14, t.lastIndexOf(";")));
      out.terms = (d.cards || []).length;
      // meta.total is the size of the whole bank, not the bundled sample.
      out.questions = d.meta?.total ?? (d.questions || []).length;
    } catch { /* leave null; reported as unreadable */ }
  }

  const bankPath = join(ROOT, "content", slug, "bank.json");
  if (existsSync(bankPath)) {
    try {
      const bank = JSON.parse(await readFile(bankPath, "utf8"));
      if (bank.questions?.length) out.questions = bank.questions.length;
    } catch { /* bundle figure stands */ }
  }

  return out;
}

const drifted = [], unreadable = [];

for (const app of registry.apps || []) {
  const real = await actual(app.slug);
  if (real.terms === null && real.questions === null) { unreadable.push(app.slug); continue; }

  const changes = [];
  if (real.terms !== null && real.terms !== app.terms) {
    changes.push(`terms ${app.terms} → ${real.terms}`);
    app.terms = real.terms;
  }
  if (real.questions !== null && real.questions !== app.questions) {
    changes.push(`questions ${app.questions} → ${real.questions}`);
    app.questions = real.questions;
  }
  if (changes.length) drifted.push({ slug: app.slug, changes, blurb: app.blurb });
}

if (unreadable.length) {
  console.log(`\n  no content found for: ${unreadable.join(", ")}`);
}

if (!drifted.length) {
  console.log("\n  registry counts match the content.\n");
  process.exit(0);
}

console.log(`\n  ${drifted.length} app(s) out of date:\n`);
for (const d of drifted) {
  console.log(`    ${d.slug.padEnd(20)} ${d.changes.join(", ")}`);
  // Blurbs repeat the numbers in prose, and no script should rewrite a
  // sentence someone wrote. Flag them instead.
  if (/\d+\s+(terms|scenarios|vignettes|questions)/i.test(d.blurb || "")) {
    console.log(`      blurb still reads: "${d.blurb.slice(0, 80)}…"`);
  }
}

if (write) {
  await writeFile(REG, JSON.stringify(registry, null, 2) + "\n");
  console.log("\n  registry updated. Check the blurbs above by hand, then rebuild.\n");
} else {
  console.log("\n  run with --write to apply.\n");
}

process.exit(write ? 0 : 1);
