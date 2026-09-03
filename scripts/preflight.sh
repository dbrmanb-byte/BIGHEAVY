#!/usr/bin/env bash
# Preflight for a site deploy. The failure this exists to prevent is a site
# shipping against a stale or missing shared package: the deploy succeeds, the
# site loads, and something silently breaks.
#
# Usage: scripts/preflight.sh <site-slug>
set -uo pipefail

SLUG="${1:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

fail=0
ok()   { printf '  ok    %s\n' "$1"; }
bad()  { printf '  FAIL  %s\n' "$1"; fail=1; }
note() { printf '  --    %s\n' "$1"; }

if [ -z "$SLUG" ]; then
  echo "preflight: name a site, e.g. scripts/preflight.sh casebook"
  echo "available:"; ls apps 2>/dev/null | sed 's/^/  /'
  exit 1
fi

echo "preflight: $SLUG"

# 1. the site exists
if [ -d "apps/$SLUG/src" ]; then ok "apps/$SLUG/src present"
else bad "no such site — apps/$SLUG/src missing"; echo; echo "preflight FAILED"; exit 1; fi

# 2. working tree clean, and say which branch this actually is
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  bad "working tree is dirty — commit or stash before deploying"
  git status --short | sed 's/^/        /'
else
  ok "working tree clean"
fi
note "branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# 3. shared packages build before any site build is attempted
if pnpm --filter "./packages/*" build >/tmp/preflight-pkg.log 2>&1; then
  ok "shared packages build"
else
  bad "shared packages failed to build"
  sed 's/^/        /' /tmp/preflight-pkg.log | tail -20
fi

# 4. netlify.toml resolves to a real publish path
TOML="apps/$SLUG/netlify.toml"
if [ -f "$TOML" ]; then
  PUB="$(grep -E '^\s*publish' "$TOML" | head -1 | cut -d'"' -f2)"
  if [ "$PUB" = "apps/$SLUG/dist" ]; then ok "netlify publish path is $PUB"
  else bad "netlify publish path is '$PUB', expected apps/$SLUG/dist"; fi
else
  bad "$TOML missing"
fi

# 5. the site actually builds, and dist is not empty
if pnpm --filter "$SLUG" build >/tmp/preflight-site.log 2>&1; then
  COUNT="$(find "apps/$SLUG/dist" -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$COUNT" -gt 0 ]; then ok "site builds ($COUNT files in dist)"
  else bad "site built but dist is empty"; fi
else
  bad "site build failed"
  sed 's/^/        /' /tmp/preflight-site.log | tail -20
fi

# 6. every shared file the app declared is present in dist
DECLARED="$(node -e "try{const p=require('./apps/$SLUG/package.json');process.stdout.write(((p.bigheavy||{}).shared||[]).join(' '))}catch(e){}" 2>/dev/null)"
for name in $DECLARED; do
  case "$name" in
    registry)   f="apps.json";  kind="file" ;;
    app-core)   f="js";         kind="dir"  ;;
    *)          f="";           kind=""     ;;
  esac
  if [ -z "$f" ]; then
    bad "unknown shared package declared: $name (add it to SHARED in build-site.mjs and here)"
  elif [ "$kind" = "dir" ]; then
    n="$(ls "apps/$SLUG/dist/$f"/*.js 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$n" -gt 0 ]; then ok "shared $name present in dist ($n files in $f/)"
    else bad "shared $name declared but dist/$f is empty or missing"; fi
  elif [ -f "apps/$SLUG/dist/$f" ]; then ok "shared $name present in dist ($f)"
  else bad "shared $name declared but $f missing from dist"; fi
done

# 7. a PWA without its service worker ships with no offline drills
if [ -f "apps/$SLUG/src/sw.js" ]; then
  if [ -f "apps/$SLUG/dist/sw.js" ]; then ok "service worker in dist"
  else bad "sw.js in src but not in dist"; fi
  # every shell entry must exist, or install() rejects and nothing caches
  MISSING="$(node -e '
    const fs=require("fs"),p=process.argv[1];
    const t=fs.readFileSync(p+"/dist/sw.js","utf8");
    const m=t.match(/const SHELL\s*=\s*\[([\s\S]*?)\]/);
    if(!m){process.stdout.write("");process.exit(0)}
    const out=[...m[1].matchAll(/"([^"]+)"/g)].map(x=>x[1])
      .filter(u=>u!=="./"&&!fs.existsSync(p+"/dist/"+u.replace(/^\.\//,"")));
    process.stdout.write(out.join(" "));
  ' "apps/$SLUG" 2>/dev/null)"
  if [ -n "$MISSING" ]; then bad "service worker caches files that do not exist: $MISSING"
  else ok "service worker shell resolves"; fi

  # The reverse check: a module the page imports but the shell does not cache
  # loads fine online and 404s offline, taking the whole module graph with it.
  UNCACHED="$(node -e '
    const fs=require("fs"),p=process.argv[1];
    const sw=fs.readFileSync(p+"/dist/sw.js","utf8");
    const m=sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\]/);
    const shell=new Set(m?[...m[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]):[]);
    const html=fs.readFileSync(p+"/dist/index.html","utf8");
    const imports=[...html.matchAll(/from\s+"(\.\/js\/[^"]+)"/g)].map(x=>x[1]);
    process.stdout.write([...new Set(imports)].filter(u=>!shell.has(u)).join(" "));
  ' "apps/$SLUG" 2>/dev/null)"
  if [ -n "$UNCACHED" ]; then bad "imported but not cached by the service worker (breaks offline): $UNCACHED"
  else ok "every imported module is in the shell"; fi
fi

# Backend wiring. Free-only is a legitimate state and passes; a half-configured
# build or a secret key in the bundle is not, and neither throws at runtime.
if node "$ROOT/scripts/check-config.mjs" "$SLUG" >/dev/null 2>&1; then
  ok "backend config — $(node "$ROOT/scripts/check-config.mjs" "$SLUG" --summary)"
else
  bad "backend config is inconsistent — run: node scripts/check-config.mjs $SLUG"
fi

echo
if [ "$fail" -eq 0 ]; then echo "preflight PASSED — safe to deploy $SLUG"; exit 0
else echo "preflight FAILED — read the failures above, do not re-run to get past them"; exit 1; fi
