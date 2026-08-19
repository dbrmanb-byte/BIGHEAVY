#!/bin/bash
# Casebook — Supabase setup
# Pushes the schema to your Supabase project.
#
# Prerequisites:
#   npm install -g supabase
#   supabase login
#
# Usage:
#   ./setup.sh <project-ref>
#   e.g. ./setup.sh abcdefghijkl

set -euo pipefail

REF="${1:?Usage: ./setup.sh <supabase-project-ref>}"

echo "→ Linking to project $REF..."
supabase link --project-ref "$REF"

echo "→ Pushing schema..."
supabase db push --file supabase/schema.sql

echo "→ Done. Now:"
echo "  1. Go to https://supabase.com/dashboard/project/$REF/settings/api"
echo "  2. Copy the URL and anon key"
echo "  3. Paste them into public/index.html in the config <script> block"
echo "  4. Deploy the public/ folder to Netlify, Cloudflare Pages, or your host"
