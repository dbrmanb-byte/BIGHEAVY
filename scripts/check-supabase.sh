#!/bin/bash
# Is the backend actually ready to take money?
#
# Every layer here fails silently in the same direction: the site keeps working
# and quietly serves the free tier. A missing bank means a paying subscriber
# sees ten questions; a missing PDF means a 404 after checkout; a missing
# function means neither ever gets asked. None of that throws an error anyone
# sees, so it has to be checked rather than assumed.
#
# Read-only. It changes nothing.
#
# Usage: ./scripts/check-supabase.sh

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

if [ -n "${SUPABASE_BIN:-}" ]; then
  read -r -a SB <<< "$SUPABASE_BIN"
elif command -v supabase >/dev/null 2>&1; then
  SB=(supabase)
elif command -v npx >/dev/null 2>&1; then
  SB=(npx --yes supabase)
else
  echo "No supabase CLI and no npx."; exit 1
fi

fail=0
ok()  { printf "  ok    %-46s %s\n" "$1" "${2:-}"; }
bad() { printf "  FAIL  %-46s %s\n" "$1" "${2:-}"; fail=$((fail+1)); }

# The slugs that should have paid content, straight from the registry, so a new
# app is covered here the moment it is added there.
SLUGS=$(node -e '
  const r=require("./packages/registry/apps.json");
  process.stdout.write(r.apps.filter(a=>a.status==="live").map(a=>a.slug).join(" "));
')
COUNT=$(echo "$SLUGS" | wc -w | tr -d ' ')

echo ""
echo "  Checking $COUNT live apps against the project"
echo ""

# ---- migrations ----
MIG=$("${SB[@]}" migration list 2>/dev/null)
LOCAL=$(echo "$MIG" | grep -cE '^\s+.20[0-9]{12}.')
APPLIED=$(echo "$MIG" | grep -E '^\s+.20[0-9]{12}.' | grep -cE '.20[0-9]{12}..\s*\|\s*.20[0-9]{12}.')
if [ "$LOCAL" -gt 0 ] && [ "$LOCAL" -eq "$APPLIED" ]; then
  ok "migrations applied" "$APPLIED of $LOCAL"
else
  bad "migrations applied" "$APPLIED of $LOCAL — run scripts/setup-supabase.sh <ref> --write"
fi

# ---- edge functions ----
FN=$("${SB[@]}" functions list 2>/dev/null)
for f in content ebook-download stripe-webhook; do
  if echo "$FN" | grep -q "$f"; then ok "function deployed" "$f"
  else bad "function MISSING" "$f — nothing will be entitled without it"; fi
done

# ---- everything in storage, in one call ----
#
# `storage ls` on a path is unreliable — given ss:///content/casebook it returned
# a bucket listing rather than that folder's contents, which had this script
# reporting twenty uploaded files as missing. Recursive from the root is
# unambiguous: one call, and every object comes back as a full path like
#   /ebooks/casebook.pdf
#   /content/casebook/bank.json
# so the check is an exact string match instead of a guess about layout.
OBJECTS=$("${SB[@]}" storage ls --experimental -r ss:/// 2>/dev/null)

if [ -z "$OBJECTS" ]; then
  bad "storage unreachable" "no objects listed — check the buckets exist"
else
  miss=""
  for s in $SLUGS; do
    echo "$OBJECTS" | grep -qx "/ebooks/$s.pdf" || miss="$miss $s.pdf"
  done
  if [ -z "$miss" ]; then ok "all books uploaded" "$COUNT of $COUNT"
  else bad "books missing" "$miss — buyers of these get a 404 after paying"; fi

  missb=""
  for s in $SLUGS; do
    echo "$OBJECTS" | grep -qx "/content/$s/bank.json" || missb="$missb $s"
  done
  if [ -z "$missb" ]; then ok "all question banks uploaded" "$COUNT of $COUNT"
  else bad "banks missing" "$missb — those apps serve 10 questions to paying users"; fi

  # A file at the wrong path uploads happily and is then invisible to the
  # functions, which build their paths from the slug.
  STRAY=$(echo "$OBJECTS" | grep -vE '^/(ebooks/[a-z0-9-]+\.pdf|content/[a-z0-9-]+/bank\.json)$' | tr '\n' ' ')
  [ -z "$STRAY" ] || printf "  --    %-46s %s\n" "unexpected objects in storage" "$STRAY"
fi

# ---- secrets ----
# Names only. The CLI prints digests rather than values, and neither belongs here.
SEC=$("${SB[@]}" secrets list 2>/dev/null)
for k in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET; do
  if echo "$SEC" | grep -q "$k"; then ok "secret set" "$k"
  else bad "secret NOT set" "$k — the webhook cannot verify or charge anything"; fi
done
for k in COUPON_PRO_10 COUPON_ALL_ACCESS_20; do
  if echo "$SEC" | grep -q "$k"; then ok "secret set" "$k"
  else printf "  --    %-46s %s\n" "optional secret not set" "$k — ebook discounts will not be issued"; fi
done

echo ""
if [ "$fail" -eq 0 ]; then
  echo "  Backend looks ready. Next: Stripe prices, then the webhook endpoint."
else
  echo "  $fail problem(s). Nothing above is fixed by retrying — read the lines and act on them."
fi
echo ""
exit $((fail > 0))
