/* Assemble the whole product into one deployable directory.
 *
 * The registry routes every app under the hub's origin — /casebook/, /keystone/
 * and so on — and the client code depends on that: per-app localStorage
 * namespacing, service workers that only evict their own caches, and any future
 * cross-app coach all assume one origin. Deploying the eleven dists as eleven
 * separate sites would silently break all of it, so this puts the hub at the
 * root and each live app in its slug directory, and site/ is what gets
 * published.
 *
 * Run after `pnpm run build`. The root netlify.toml chains the two.
 *
 * Usage: node scripts/assemble-site.mjs
 */

import { cp, mkdir, rm, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site");

const reg = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
const slugs = reg.apps.filter(a => a.status === "live").map(a => a.slug);

// The hub is the storefront; without it there is no site to assemble into.
const hubDist = join(ROOT, "apps/hub/dist");
if (!existsSync(join(hubDist, "index.html"))) {
  console.error("assemble-site: apps/hub/dist is missing — run `pnpm run build` first.");
  process.exit(1);
}

// Refuse to assemble a partial catalogue. A missing app would deploy as a 404
// on a URL the hub's directory links to.
const missing = slugs.filter(s => !existsSync(join(ROOT, "apps", s, "dist", "index.html")));
if (missing.length) {
  console.error(`assemble-site: no dist for: ${missing.join(", ")} — run \`pnpm run build\` first.`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(hubDist, OUT, { recursive: true });
for (const s of slugs) {
  await cp(join(ROOT, "apps", s, "dist"), join(OUT, s), { recursive: true });
}

// The apps' registry URLs must resolve inside this layout, or the storefront
// links to pages that are not there.
for (const a of reg.apps.filter(x => x.status === "live")) {
  const target = join(OUT, a.url.replace(/^\/|\/$/g, ""), "index.html");
  if (!existsSync(target)) {
    console.error(`assemble-site: registry url ${a.url} does not resolve to ${target}`);
    process.exit(1);
  }
}

async function du(dir) {
  let n = 0, bytes = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const r = await du(p); n += r.n; bytes += r.bytes; }
    else { n++; bytes += (await stat(p)).size; }
  }
  return { n, bytes };
}
const { n, bytes } = await du(OUT);
console.log(`assembled site/ — hub + ${slugs.length} apps, ${n} files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
