/* Which companion books exist, and which the storefront is advertising but
 * cannot deliver. The shelf renders from the registry, so a title listed there
 * with no file behind it is a page someone can buy and then not receive.
 *
 * Usage: node scripts/check-ebooks.mjs
 */

import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "ebooks");

const registry = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const expected = (registry.apps || []).filter(a => a.ebook);

const have = [], missing = [];

for (const app of expected) {
  // The download function fetches "<slug>.pdf", so the filename is not cosmetic.
  const file = join(DIR, `${app.slug}.pdf`);
  if (existsSync(file)) {
    const { size } = await stat(file);
    have.push({ slug: app.slug, title: app.ebook.title, kb: (size / 1024).toFixed(0) });
  } else {
    missing.push({ slug: app.slug, title: app.ebook.title });
  }
}

console.log(`\n  ${have.length} of ${expected.length} books present in ebooks/\n`);

if (have.length) {
  console.log("  have:");
  for (const b of have) console.log(`    ${(b.slug + ".pdf").padEnd(26)} ${b.kb.padStart(5)}KB   ${b.title}`);
}

if (missing.length) {
  console.log("\n  missing — listed on the site, no file to deliver:");
  for (const b of missing) console.log(`    ${(b.slug + ".pdf").padEnd(26)}         ${b.title}`);
  console.log("\n  Until these exist, either supply the files or set status/ebook on those");
  console.log("  registry entries so the shelf stops advertising them.");
}

console.log("");
process.exit(missing.length ? 1 : 0);
