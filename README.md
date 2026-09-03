# BIGHEAVY

Offline-first study apps for licensing exams, built from one monorepo against
shared packages. Every app is a static progressive web app — no server runtime,
no database, no bundler.

```
apps/
  hub/          the front door — directory, plans, about, contact, legal
  casebook/     ASWB social work licensing exam
  casebook-lcsw/ casebook-lbsw/ casebook-nursing/
  forge-cloud/ forge-security/ forge-systems/ forge-management/ forge-trades/
  keystone/     real estate licensing exam
packages/
  app-core/     the shared runtime: auth, tiers, tracking, recommender, dashboard
  registry/     the catalogue of verticals; drives the hub directory
supabase/       schema, tier migration, and the Stripe webhook function
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

The slug, the directory name, the `window.BH_APP_ID` the app declares, and the
`app` metadata on its Stripe price must all be the same string — entitlement is
decided by comparing `tier_app` to `BH_APP_ID`.

## Entitlements

`packages/app-core/js/tiers.js` decides what a visitor may use. The tier comes
from the server (`my_tier` RPC), not from the browser. Each app declares itself
before the modules load:

```html
<script>
  window.BH_APP_ID     = "casebook-lcsw";
  window.BH_APP_FAMILY = "casebook";   // descriptive only, not an entitlement
</script>
```

then asks `Tiers.can("tutor")` or `Tiers.requireGate("tutor", "…")`.

**Pro covers exactly one app; Unlimited covers all ten.** `tier_app` holds an
app slug, and entitlement is `tier_app === BH_APP_ID`. A family name is not
accepted there: `"forge"` would unlock five apps for the price of one and leave
Unlimited with nothing to sell. Each app therefore needs its own Stripe price,
tagged `tier=pro` and `app=<slug>`.

Two rules the gating depends on:

- **Unknown gate names are denied.** A typo should fail visibly, not hand out a
  paid feature.
- **Pro with no scope grants nothing.** Fail closed; failing open gives the
  whole catalogue away for the price of one app.

This is still a **soft gate** — content ships inside the bundle, so a determined
user can read it from source. That is the accepted trade for staying
offline-capable. Hard gating means serving premium content from an API.

The core app runs in a classic script and cannot import modules, so the module
layer publishes `window.Tiers` for it to gate against.

## Deploying

Each app is its own Netlify site, built from the repo root so shared packages
resolve. See `scripts/preflight.sh` and the deploy runbook.

## Before launch

- Fill the placeholders in `apps/hub/src/privacy.html` and `terms.html`, and
  have both reviewed. They are drafts, not legal advice.
- Replace `example.com` in `apps/hub/src/robots.txt` and `sitemap.xml`.
- Personalise the `TODO` section in `apps/hub/src/about.html`.
- Create the Supabase project, run `scripts/setup-supabase.sh <project-ref>`,
  and fill `CASEBOOK_SUPABASE_URL` / `CASEBOOK_SUPABASE_KEY` in each app.
- Create the Stripe products, tag each price with `tier` and `app` metadata,
  deploy the webhook, and set `CHECKOUT_URLS` in `packages/app-core/js/tiers.js`.
  Until then nothing is billable and every gate reports free.
