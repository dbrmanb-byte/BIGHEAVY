/* Casebook service worker.
   Caches the app shell so the drills, vignettes and glossary work with no connection.
   Deliberately does NOT touch model weight downloads — WebLLM manages its own
   multi-gigabyte cache, and duplicating it here would double the disk cost. */

const VERSION = "casebook-v3b";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./js/supabase-client.js",
  "./js/tiers.js",
  "./js/tracker.js",
  "./js/dashboard.js",
  "./js/recommend.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png"
];

// Hosts serving model weights or the WebLLM runtime's own assets. Pass straight through.
const PASSTHROUGH = /(^|\.)(huggingface\.co|hf\.co|cdn-lfs[\w.-]*\.hf\.co|mlc\.ai|raw\.githubusercontent\.com)$/i;
// Hosts whose assets are small, stable and worth keeping for offline use.
const RUNTIME = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com|esm\.run|cdn\.jsdelivr\.net)$/i;

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  if (PASSTHROUGH.test(url.hostname)) return;

  // Navigations: serve the cached shell instantly, refresh it in the background.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("./index.html").then(hit => {
        const net = fetch(req).then(res => {
          if (res && res.ok) caches.open(VERSION).then(c => c.put("./index.html", res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Own files: cache first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  // Fonts and the WebLLM module: stale while revalidate.
  if (RUNTIME.test(url.hostname)) {
    event.respondWith(
      caches.match(req).then(hit => {
        const net = fetch(req).then(res => {
          if (res && (res.ok || res.type === "opaque")) {
            const copy = res.clone();
            caches.open(VERSION).then(c => c.put(req, copy));
          }
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
});
