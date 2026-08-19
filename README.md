# BIGHEAVY

Offline-first study apps for licensing exams, built from one monorepo against
shared packages. Every app is a static progressive web app — no server runtime,
no database, no bundler.

```
apps/
  hub/          the front door — directory, plans, about, contact, legal
  casebook/     ASWB social work licensing exam
packages/
  entitlements/ what a visitor may use; consumed by every app
  registry/     the catalogue of verticals; drives the hub directory
scripts/
  build-site.mjs   copy a site's src to dist and lay shared packages on top
  check-package.mjs verify a shared package is present and parseable
  preflight.sh     pre-deploy checks
  serve.mjs        serve a built site locally
```

## Working on it

```bash
pnpm install
pnpm run build              # shared packages, then every app
pnpm --filter casebook build
node scripts/serve.mjs casebook   # http://localhost:8099
```

A service worker will not register from `file://`, so use the server rather than
opening `dist/index.html` directly.

**Shared packages build first, always.** A site that ships against a stale
shared package still deploys and still loads — it just breaks quietly later.
`pnpm run build` enforces the order; `scripts/preflight.sh <slug>` checks it
before a deploy.

## Adding an app

1. `apps/<slug>/src/` — the site itself.
2. `apps/<slug>/package.json` — a `build` script calling `build-site.mjs <slug>`,
   and a `bigheavy.shared` array naming the packages it needs.
3. `apps/<slug>/netlify.toml` — publish `apps/<slug>/dist`.
4. Add an entry to `packages/registry/apps.json`. The hub picks it up with no
   code change.

The `slug`, the directory name, and the `__BH_APP_ID` the app declares must all
match: a Pro subscription is matched against that id.

## Entitlements

`packages/entitlements` is the single source of truth for what a visitor may
use. Each app declares itself before loading it:

```html
<script>window.__BH_APP_ID = "casebook";</script>
<script src="./entitlements.js"></script>
```

then asks `Entitlements.can("tutor")`. Free grants `quiz.short` on every app;
Pro grants everything for **one** app; Unlimited grants everything everywhere.
The tier is cached locally so paid users keep access offline.

This is a **soft gate**. All content ships inside the bundle, so a determined
user can read it from source — an accepted trade for staying offline-capable.
Hard gating means serving premium content from an API instead of bundling it.

Billing is not connected yet: nothing verifies payment, and the tier is set
locally. When a provider lands, only `Entitlements.set()` changes. For testing,
`?tier=pro`, `?tier=unlimited` and `?tier=free` set it in the current browser.

## Deploying

Each app is its own Netlify site, built from the repo root so shared packages
resolve. See `scripts/preflight.sh` and the deploy runbook.

## Before launch

- Fill the placeholders in `apps/hub/src/privacy.html` and `terms.html`, and
  have both reviewed. They are drafts, not legal advice.
- Replace `example.com` in `apps/hub/src/robots.txt` and `sitemap.xml`.
- Personalise the `TODO` sections in `apps/hub/src/about.html` and
  `apps/casebook/src/index.html`.
- Connect a billing provider and wire checkout on both pricing pages.
