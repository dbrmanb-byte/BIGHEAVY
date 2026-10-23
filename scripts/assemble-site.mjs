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

import { cp, mkdir, rm, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "site");

const reg = JSON.parse(await readFile(join(ROOT, "packages/registry/apps.json"), "utf8"));
// "live" is the paid catalogue; "free" ships the same way but carries no
// Stripe price, no ebook and no private bank — the commerce scripts skip it.
const SHIPPED = new Set(["live", "free"]);
const slugs = reg.apps.filter(a => SHIPPED.has(a.status)).map(a => a.slug);

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
for (const a of reg.apps.filter(x => SHIPPED.has(x.status))) {
  const target = join(OUT, a.url.replace(/^\/|\/$/g, ""), "index.html");
  if (!existsSync(target)) {
    console.error(`assemble-site: registry url ${a.url} does not resolve to ${target}`);
    process.exit(1);
  }
}

/* ---- Response headers ----------------------------------------------------
   Netlify reads ONE _headers file, at the publish root. Each app's own
   _headers was copied into site/<slug>/ and silently ignored, so its rules are
   folded in here under the app's path. The root file also gets the Content
   Security Policy, which can only be written now: it allows the site's inline
   scripts by hash, and the hashes exist only once every page is built. */

const CSP_HOSTS = {
  // supabase-js comes from esm.sh; the tutor's WebLLM from esm.run, which
  // redirects to jsDelivr.
  script: ["https://esm.sh", "https://esm.run", "https://cdn.jsdelivr.net"],
  // The service worker re-fetches fonts and CDN modules, and the tutor
  // downloads model weights (Hugging Face, whose files redirect to *.hf.co)
  // and its compiled model library (GitHub raw). Supabase is the backend; a
  // custom Supabase domain would need adding here.
  connect: ["https://*.supabase.co", "https://esm.sh", "https://esm.run", "https://cdn.jsdelivr.net",
            "https://fonts.googleapis.com", "https://fonts.gstatic.com",
            "https://huggingface.co", "https://*.huggingface.co", "https://*.hf.co",
            "https://raw.githubusercontent.com"],
};

async function htmlFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await htmlFiles(p));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

// Every executable inline <script>, hashed exactly as the browser will see it.
const hashes = new Set();
for (const f of await htmlFiles(OUT)) {
  const html = await readFile(f, "utf8");
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (type && !/^(module|text\/javascript|application\/javascript)$/i.test(type)) continue;
    hashes.add(`'sha256-${createHash("sha256").update(m[2], "utf8").digest("base64")}'`);
  }
}

const csp = [
  "default-src 'self'",
  // wasm-unsafe-eval lets the tutor compile WebAssembly. It does not allow eval().
  `script-src 'self' 'wasm-unsafe-eval' ${CSP_HOSTS.script.join(" ")} ${[...hashes].sort().join(" ")}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  `connect-src 'self' ${CSP_HOSTS.connect.join(" ")} data: blob:`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

/* Split a _headers file into { path, lines } rules. */
function rules(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) out.push({ path: line.trim(), lines: [] });
    else if (out.length) out[out.length - 1].lines.push(line.trim());
  }
  return out;
}

const root = rules(await readFile(join(OUT, "_headers"), "utf8"));
const all = root.find(r => r.path === "/*");
if (!all) { console.error("assemble-site: the hub _headers has no /* rule"); process.exit(1); }
// The apps' "Say it first" asks for the microphone, so it stays allowed for
// this site's own pages. Camera and location remain off everywhere.
all.lines = all.lines.filter(l => !/^(Permissions-Policy|Content-Security-Policy)\s*:/i.test(l));
all.lines.push("Permissions-Policy: geolocation=(), microphone=(self), camera=()");
all.lines.push(`Content-Security-Policy: ${csp}`);

for (const s of slugs) {
  const f = join(OUT, s, "_headers");
  if (!existsSync(f)) continue;
  for (const r of rules(await readFile(f, "utf8"))) {
    // /* is already covered at the root, with the stricter site-wide values.
    if (r.path === "/*") continue;
    root.push({ path: `/${s}${r.path}`, lines: r.lines });
  }
  await rm(f);
}

await writeFile(join(OUT, "_headers"),
  root.map(r => [r.path, ...r.lines.map(l => "  " + l)].join("\n")).join("\n\n") + "\n");
console.log(`headers: CSP with ${hashes.size} inline-script hashes, ${root.length} rules`);

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
