#!/bin/bash
# BIGHEAVYINK — Supabase setup
#
# Links the project, applies the migrations in order, creates the two private
# buckets and deploys the three edge functions. Everything here is idempotent;
# re-running after a schema change is the intended way to use it.
#
# What it deliberately does NOT do: set secrets. Those are typed straight into
# your shell rather than passing through a script in a public repository.
# It prints the exact commands at the end.
#
# Prerequisites:
#   npm install -g supabase        (or let it fall back to npx)
#   supabase login                 (npx supabase login)
#
# Usage:
#   ./scripts/setup-supabase.sh <project-ref>          # dry run
#   ./scripts/setup-supabase.sh <project-ref> --write

set -euo pipefail

REF="${1:-}"
WRITE="${2:-}"

if [ -z "$REF" ]; then
  echo "Usage: ./scripts/setup-supabase.sh <project-ref> [--write]"
  echo "  The ref is in your project URL: https://supabase.com/dashboard/project/<ref>"
  exit 1
fi

# How to invoke the CLI. A global `npm install -g supabase` only works if npm's
# global bin directory is on PATH, which on Windows it frequently is not — so
# fall back to npx rather than telling someone their working install is missing.
# Override with SUPABASE_BIN if yours lives somewhere else.
if [ -n "${SUPABASE_BIN:-}" ]; then
  read -r -a SUPABASE <<< "$SUPABASE_BIN"
elif command -v supabase >/dev/null 2>&1; then
  SUPABASE=(supabase)
elif command -v npx >/dev/null 2>&1; then
  SUPABASE=(npx --yes supabase)
  echo "  (using \`npx supabase\` — no global install found on PATH)"
else
  echo "No supabase CLI and no npx. Install Node, then: npm install -g supabase"
  echo "Or set SUPABASE_BIN to the full path of your supabase binary."
  exit 1
fi

# `supabase db push` reads supabase/migrations/ and applies whatever the remote
# has not seen, in filename order, recording each in the migration history
# table. It takes no --file: an earlier version of this script passed one and
# the CLI rejected it. The four live there, including the one that creates the
# two private storage buckets — the CLI has no bucket command, and bucket
# privacy is not something to leave to a click anyway.
MIGRATION_DIR="supabase/migrations"

FUNCTIONS=(content ebook-download stripe-webhook checkout notify)

run() {
  if [ "$WRITE" = "--write" ]; then
    echo "  \$ $*"
    "$@"
  else
    echo "  would run: $*"
  fi
}

echo ""
if [ "$WRITE" = "--write" ]; then
  echo "  Setting up project $REF"
else
  echo "  Dry run for project $REF — nothing will change. Add --write to apply."
fi
echo ""

echo "→ Link"
run "${SUPABASE[@]}" link --project-ref "$REF"

echo ""
echo "→ Migrations and storage buckets"
COUNT=$(ls "$MIGRATION_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ')
if [ "$COUNT" -lt 4 ]; then
  echo "  Only $COUNT migration(s) in $MIGRATION_DIR — expected at least 4."
  echo "  Aborting rather than applying a partial schema."
  exit 1
fi
for m in "$MIGRATION_DIR"/*.sql; do echo "    $(basename "$m")"; done
run "${SUPABASE[@]}" db push --linked

echo ""
echo "→ Edge functions"
for f in "${FUNCTIONS[@]}"; do
  # --use-api bundles server-side. Without it the CLI wants a running Docker
  # daemon, which is one more thing to install and the commonest reason a
  # deploy fails on a laptop.
  #
  # --no-verify-jwt on the webhook only: Stripe cannot present a Supabase JWT,
  # and the request is authenticated by its signature instead. The other two
  # must verify, because they decide what a signed-in user is entitled to.
  if [ "$f" = "stripe-webhook" ] || [ "$f" = "notify" ]; then
    run "${SUPABASE[@]}" functions deploy "$f" --use-api --no-verify-jwt
  else
    run "${SUPABASE[@]}" functions deploy "$f" --use-api
  fi
done

SB="${SUPABASE[*]}"

cat <<EOF

→ Secrets — type these yourself, they do not belong in a script

    $SB secrets set STRIPE_SECRET_KEY=sk_live_...
    $SB secrets set STRIPE_WEBHOOK_SECRET=whsec_...
    $SB secrets set COUPON_PRO_10=BH_PRO_10
    $SB secrets set COUPON_ALL_ACCESS_20=BH_ALL_ACCESS_20
    $SB secrets set CONTENT_ALLOWED_ORIGIN=https://<your-domain>
    $SB secrets set EBOOK_ALLOWED_ORIGIN=https://<your-domain>

  SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected
  automatically. Never set the service role key anywhere a browser can read it.

→ Upload the paid content — neither of these is in git, by design

  The buckets are made private by the storage_buckets migration above.

    for f in ebooks/*.pdf;        do $SB storage cp --experimental "\$f" "ss:///ebooks/\$(basename "\$f")"; done
    for f in content/*/bank.json; do $SB storage cp --experimental "\$f" "ss:///content/\$(basename \$(dirname "\$f"))/bank.json"; done

  Every storage command needs --experimental; the CLI gates them all behind it
  and refuses to run without it.

  If those loops echo the glob back at you instead of uploading, the folders are
  empty. Restore the paid content from your backup archive first — it is not in
  git and cannot be regenerated from what is.

  Each PDF must be named <slug>.pdf — casebook.pdf, not casebook-lmsw.pdf —
  or the download 404s for someone who has paid.

→ Front end

  Set these on the host (Netlify → Site settings → Environment variables), not
  in source. The build writes them into dist/config.js.

    BH_SUPABASE_URL   https://$REF.supabase.co
    BH_SUPABASE_KEY   <the anon / publishable key, not the service role key>

  Check it worked:  node scripts/check-config.mjs
EOF
echo ""
