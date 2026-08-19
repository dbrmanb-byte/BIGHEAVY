/* Serve a built site over HTTP for local checking. A service worker will not
   register from file://, so the PWA behaviour can only be verified this way.

   Usage: node scripts/serve.mjs <slug> [port]
*/

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slug = process.argv[2];
const port = Number(process.argv[3]) || 8099;

if (!slug) {
  console.error("serve: needs a site slug, e.g. `node scripts/serve.mjs casebook`");
  process.exit(1);
}

const dist = join(ROOT, "apps", slug, "dist");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2"
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    // normalize() collapses any ../ before it can escape dist
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let path = join(dist, rel);

    if ((await stat(path).catch(() => null))?.isDirectory()) path = join(path, "index.html");
    if (!path.startsWith(dist)) { res.writeHead(403).end("forbidden"); return; }

    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(path)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}).listen(port, () => {
  console.log(`  ${slug} → http://localhost:${port}  (serving apps/${slug}/dist)`);
});
