# Casebook — deploy notes

An installable, offline-capable study app for the ASWB social work licensing exam.
Static files only. No build step, no server runtime, no database.

```
index.html               the whole app — UI, 207 terms, 217 vignettes, tutor
sw.js                    service worker (offline shell caching)
manifest.webmanifest     install metadata
icon-*.png               app icons
_headers                 caching + security headers (Netlify / Cloudflare Pages)
Caddyfile                config for self-hosting
```

---

## Test it locally first

A service worker will not register from `file://`. Serve it over HTTP:

```bash
cd dist
python3 -m http.server 8099
```

Open `http://localhost:8099`. `localhost` counts as a secure context, so both the
service worker and WebGPU work without TLS. Confirm in DevTools → Application that
the service worker is activated and the manifest shows no errors.

---

## Option 1 — Netlify Drop (fastest)

1. Go to `app.netlify.com/drop`
2. Drag the whole `dist` folder onto the page
3. You get an HTTPS URL in about twenty seconds

Rename the site under Site settings → Change site name to get something sendable.
The `_headers` file is picked up automatically.

## Option 2 — Cloudflare Pages

```bash
npm i -g wrangler
wrangler pages deploy dist --project-name casebook
```

First run opens a browser to authorize. Redeploy with the same command.
Cloudflare also honours `_headers`.

## Option 3 — GitHub Pages

```bash
git init && git add . && git commit -m "Casebook"
git branch -M main
git remote add origin git@github.com:YOURNAME/casebook.git
git push -u origin main
```

Then Settings → Pages → deploy from `main`, folder `/` (or `/docs` if you nest it).
Note that GitHub Pages ignores `_headers`; caching will be less precise but nothing breaks.

## Option 4 — Self-host on the GX10

```bash
sudo mkdir -p /srv/casebook
sudo cp -r dist/* /srv/casebook/
sudo caddy run --config Caddyfile
```

Edit the domain at the top of the `Caddyfile` first. Caddy provisions TLS
automatically. If the box is not publicly routable, put a Cloudflare Tunnel in
front of it rather than opening a port:

```bash
cloudflared tunnel --url http://localhost:80
```

For a permanent service, the pattern matches the rest of the stack — a unit file
with `ExecStart=/usr/bin/caddy run --config /srv/casebook/Caddyfile`,
`Restart=always`, and `WantedBy=multi-user.target`.

---

## Requirements on the visitor's side

| Feature | Needs |
|---|---|
| Drills, vignettes, glossary | Any modern browser. Works offline after first visit. |
| Install to home screen | Chrome, Edge, or Safari on iOS via Share → Add to Home Screen |
| Tutor (local LLM) | WebGPU: Chrome or Edge 113+ on desktop, or Chrome on Android with a capable GPU |

The tutor is optional throughout. Where WebGPU is missing, the app says so plainly
and everything else keeps working.

The model downloads once — roughly 0.7 to 2.2 GB depending on which one is picked —
and is cached by the browser after that. The service worker deliberately does not
intercept those requests, so it is stored once, not twice.

---

## Updating content

All study content lives in a single `const DATA = { cards: [...], questions: [...] }`
declaration at the top of the script block in `index.html`.

A question object:

```js
{ id:"q041", n:41, cat:"Ethics",
  stem:"...",
  choices:["...","...","...","..."],
  answer:1,                    // zero-indexed
  label:"Duty to protect",     // shown in the verdict header
  why:"..." }
```

A flashcard: `{ id:"c208", term:"...", def:"...", cat:"Ethics" }`

Valid `cat` values: `HBSE`, `Assessment`, `Intervention`, `Ethics`, `Policy`,
`Research`, `Diversity`, `Supervision`. Anything else falls back to a neutral tab colour.

After editing, bump `VERSION` in `sw.js` (`casebook-v1` → `casebook-v2`) so returning
visitors get the update prompt instead of the cached copy.
