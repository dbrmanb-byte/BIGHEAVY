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
#   npm install -g supabase
#   supabase login
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

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not found. Install it with: npm install -g supabase"
  exit 1
fi

# Migrations run in filename order and each depends on the last: schema.sql
# creates the tables the tier and ebook migrations alter.
MIGRATIONS=(
  "supabase/schema.sql"
  "supabase/002_tiers.sql"
  "supabase/003_ebooks.sql"
)

FUNCTIONS=(content ebook-download stripe-webhook)

# Both buckets are private. The whole point of splitting paid content out of the
# bundles was that it stops being public — a public bucket undoes that in one
# click, so these are created private and the entitlement check in the edge
# function is the only way in.
BUCKETS=(ebooks content)

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
run supabase link --project-ref "$REF"

echo ""
echo "→ Migrations"
for m in "${MIGRATIONS[@]}"; do
  if [ ! -f "$m" ]; then
    echo "  MISSING $m — aborting rather than applying a partial schema."
    exit 1
  fi
  run supabase db push --file "$m"
done

echo ""
echo "→ Private buckets"
for b in "${BUCKETS[@]}"; do
  run supabase storage create "ss:///$b" --experimental
done

echo ""
echo "→ Edge functions"
for f in "${FUNCTIONS[@]}"; do
  # --no-verify-jwt on the webhook only: Stripe cannot present a Supabase JWT,
  # and the request is authenticated by its signature instead. The other two
  # must verify, because they decide what a signed-in user is entitled to.
  if [ "$f" = "stripe-webhook" ]; then
    run supabase functions deploy "$f" --no-verify-jwt
  else
    run supabase functions deploy "$f"
  fi
done

cat <<EOF

→ Secrets — type these yourself, they do not belong in a script

    supabase secrets set STRIPE_SECRET_KEY=sk_live_...
    supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
    supabase secrets set COUPON_PRO_10=BH_PRO_10
    supabase secrets set COUPON_ALL_ACCESS_20=BH_ALL_ACCESS_20
    supabase secrets set CONTENT_ALLOWED_ORIGIN=https://<your-domain>
    supabase secrets set EBOOK_ALLOWED_ORIGIN=https://<your-domain>

  SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are injected
  automatically. Never set the service role key anywhere a browser can read it.

→ Upload the paid content — neither of these is in git, by design

    for f in ebooks/*.pdf;        do supabase storage cp "\$f" "ss:///ebooks/\$(basename "\$f")"; done
    for f in content/*/bank.json; do supabase storage cp "\$f" "ss:///content/\$(basename \$(dirname "\$f"))/bank.json"; done

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
