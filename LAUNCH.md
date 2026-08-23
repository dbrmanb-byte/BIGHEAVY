# Going live

The order matters. Stripe before the webhook, buckets before the upload, and the
front-end config last so you can verify each layer on its own.

Do the whole thing in **Stripe test mode** first. Everything below works the same
with `sk_test_` keys, and a mistake costs nothing.

> **This repository is public.** No key, no PDF and no question bank goes in it.
> The `.gitignore` blocks `ebooks/*.pdf` and `content/*/bank.json`; config comes
> from the environment at build time. If you ever find yourself pasting a secret
> into a file here, stop — that is not the intended path.

---

## Which key goes where

| Key | Where it lives | Reaches a browser? |
|---|---|---|
| Supabase **anon / publishable** key | Netlify env var `BH_SUPABASE_KEY` | Yes — this is fine, row-level security is the protection |
| Supabase **service role** key | Injected into Edge Functions automatically | **Never** |
| Stripe **secret** key | `supabase secrets set STRIPE_SECRET_KEY` | **Never** |
| Stripe **webhook signing** secret | `supabase secrets set STRIPE_WEBHOOK_SECRET` | **Never** |

The build refuses to run if `BH_SUPABASE_KEY` looks like a secret key, but do not
rely on that — it is a backstop, not a check.

---

## 1. Supabase

```bash
npm install -g supabase
supabase login

./scripts/setup-supabase.sh <project-ref>            # dry run — read it
./scripts/setup-supabase.sh <project-ref> --write
```

That links the project, applies the four migrations in `supabase/migrations/`
(schema, tiers, ebooks, and the one that creates the two private buckets), and
deploys the three edge functions. It prints the secrets to set afterwards; type those
yourself.

Both buckets must stay **private**. Splitting the paid banks out of the app
bundles is the whole content-protection story — a public bucket undoes it in one
click.

## 2. Upload the paid content

Neither of these is in git, by design — the repository is public. **A fresh clone
has an empty `ebooks/` and no `content/*/bank.json`**, and the banks cannot be
regenerated from the repo: only the free ten questions per app remain in the
bundles. Restore them from your backup archive before this step, and keep a copy
somewhere that is not one laptop.

```bash
unzip -o BIGHEAVY-paid-content.zip     # into the repo root
node scripts/check-ebooks.mjs          # names must match the registry
```

```bash
for f in ebooks/*.pdf;        do supabase storage cp --experimental "$f" "ss:///ebooks/$(basename "$f")"; done
for f in content/*/bank.json; do supabase storage cp --experimental "$f" "ss:///content/$(basename $(dirname "$f"))/bank.json"; done
```

Every `supabase storage` command needs `--experimental` — the CLI refuses to run
them without it.

**Each PDF must be named `<slug>.pdf`** — `casebook.pdf`, not `casebook-lmsw.pdf`.
The download route builds the path from the slug, so a mismatch 404s for someone
who has already paid. `node scripts/check-ebooks.mjs` checks the names against
the registry.

## 2b. Check the backend before moving on

```bash
./scripts/check-supabase.sh
```

Read-only. It verifies the migrations applied, all three functions deployed, all
ten PDFs and all ten banks uploaded, and the Stripe secrets set — every one of
which fails silently in the same direction if it is missing: the site keeps
working and quietly serves the free tier to someone who paid.

## 3. Stripe

```bash
STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.mjs           # dry run
STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe.mjs --write
```

Creates, from the registry: ten Pro prices at $7.99/mo (one per app), one
Unlimited price at $14.99/mo, ten book prices at $9.99, and the two coupons.

The metadata is the part that matters, and it is why this is a script:

- Pro prices carry `tier=pro` **and** `app=<slug>`
- Unlimited carries `tier=all_access` and no `app`
- Book prices carry `ebook=<slug>`

The webhook refuses to guess when a price is unmapped — it grants nothing and
logs loudly. That is the safe direction to fail, but it is still a refund. Re-run
the script any time; it reports drift instead of creating duplicates.

## 4. The webhook

Stripe → Developers → Webhooks → Add endpoint

```
URL:    https://<project-ref>.supabase.co/functions/v1/stripe-webhook
Events: checkout.session.completed
        customer.subscription.created
        customer.subscription.updated
        customer.subscription.deleted
```

```bash
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
```

Then trigger a test purchase and watch it land:

```bash
supabase functions logs stripe-webhook --tail
```

An `UNMAPPED PRICE` line means step 3 did not take for that price.

## 5. The front end

Set these on the host, not in source. Netlify → Site settings → Environment
variables. Every site in the monorepo needs them.

```
BH_SUPABASE_URL   https://<project-ref>.supabase.co
BH_SUPABASE_KEY   <anon / publishable key>
```

`scripts/build-site.mjs` writes them into `dist/config.js` at build time, and
every page loads that file. With them unset the build still succeeds and ships
the free tier — which is a working state, not a broken one, and is why it is
worth checking rather than assuming:

```bash
pnpm run build
node scripts/check-config.mjs
```

## 6. Before you flip it live

```bash
pnpm test                              # entitlement + coach
bash scripts/preflight.sh <slug>       # per site, all eleven
```

Then, by hand:

- [ ] Buy Pro on one app in test mode. Confirm that app unlocks and **a sibling does not**.
- [ ] Buy Unlimited. Confirm all ten unlock.
- [ ] Cancel. Confirm the tier drops at period end and local progress survives.
- [ ] Buy a book. Confirm it appears in `/library.html` and downloads watermarked.
- [ ] Buy three books. Confirm the 20% Unlimited code arrives.
- [ ] Load an app, go offline, confirm drills and glossary still work.
- [ ] Swap `sk_test_` for `sk_live_`, re-run step 3 against live, re-point the webhook.

---

## Still outstanding before launch

These are not backend work and none of them is blocked by it:

- **Legal.** `privacy.html` and `terms.html` carry placeholders.
- **Domain.** `robots.txt` and `sitemap.xml` still say `example.com`.
- **About.** There is a TODO where your reason for building this goes.
- **Credential review.** The NCLEX, CISSP and NEC content, and the social work
  eligibility routes in the coach, should be read by someone who holds the
  relevant credential. The "reviewed before publication" claim currently covers
  editorial review only.
