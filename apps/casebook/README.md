# Casebook

An adaptive study companion for the social work licensing exam.
207 terms, 217 vignettes, spaced repetition, an on-device AI tutor,
performance tracking, and recommendations that get smarter as you study.

## Architecture

```
┌────────────────────────────────────────────┐
│                Browser                      │
│                                             │
│  index.html ← static app, works offline     │
│  ├── Drill (spaced repetition, localStorage)│
│  ├── Vignettes (10/50/100/150 + adaptive)   │
│  ├── Dashboard (charts, study plan)          │
│  ├── Glossary (207 terms, filterable)        │
│  └── Tutor (WebLLM, runs on-device)         │
│                                             │
│  js/tracker.js ← records every answer        │
│  js/recommend.js ← adaptive item selection   │
│  js/dashboard.js ← performance viz           │
│  js/supabase-client.js ← auth + sync         │
└───────────────┬─────────────────────────────┘
                │ online + signed in
                ▼
┌───────────────────────────┐
│  Supabase (free tier)      │
│  ├── Auth (email/password) │
│  ├── profiles              │
│  ├── responses (every ans) │
│  ├── study_sessions        │
│  └── RPC functions:        │
│     ├── my_category_stats  │
│     ├── my_daily_trend     │
│     ├── item_difficulty    │
│     ├── my_weakest_items   │
│     ├── my_sessions        │
│     └── my_streak          │
└───────────────────────────┘
```

**Offline-first.** The app works fully without Supabase.
Drills, vignettes, glossary, and the tutor all run from the static file.
localStorage tracks progress locally. When a user signs in, their history
syncs to Supabase and the dashboard unlocks cross-device data and population-
level item difficulty.

## Files

```
casebook/
├── public/                    # deploy this folder
│   ├── index.html             # the whole app
│   ├── js/
│   │   ├── supabase-client.js # auth + Supabase init
│   │   ├── tracker.js         # response recording + sync
│   │   ├── dashboard.js       # dashboard rendering
│   │   └── recommend.js       # adaptive engine
│   ├── sw.js                  # service worker
│   ├── manifest.webmanifest
│   ├── *.png                  # app icons
│   └── _headers               # Netlify/CF caching headers
├── supabase/
│   └── schema.sql             # full DB schema, run once
├── setup.sh                   # one-command Supabase setup
├── .env.example
└── README.md
```

## Setup

### 1. Create a Supabase project

Go to [supabase.com](https://supabase.com), create a free project.

### 2. Push the schema

**Option A — CLI:**

```bash
npm install -g supabase
supabase login
chmod +x setup.sh
./setup.sh YOUR_PROJECT_REF
```

**Option B — Dashboard:**

Open the SQL Editor in your Supabase dashboard, paste the contents of
the migrations in `supabase/migrations/` in filename order, and click Run. Easier: `./scripts/setup-supabase.sh <ref> --write` from the repo root.

### 3. Configure the app

Open `public/index.html` and find the config block near the top:

```html
<script>
window.CASEBOOK_SUPABASE_URL = "";  // paste your project URL
window.CASEBOOK_SUPABASE_KEY = "";  // paste your anon key
</script>
```

Get both values from: Dashboard → Settings → API.

### 4. Enable email auth

In your Supabase dashboard: Authentication → Providers → Email.
Enable it. The defaults work. For production, configure a custom
SMTP sender so confirmation emails don't land in spam.

### 5. Deploy

**Netlify (fastest):**
Drag the `public/` folder onto [app.netlify.com/drop](https://app.netlify.com/drop).

**Cloudflare Pages:**
```bash
npx wrangler pages deploy public --project-name casebook
```

**GitHub Pages:**
Push the repo, enable Pages from the `public/` folder.

**Self-host:**
```bash
sudo cp -r public/ /srv/casebook/
# Use the Caddyfile from the previous version, or nginx/Apache
```

### 6. Set the site URL in Supabase

Authentication → URL Configuration → set:
- Site URL: `https://your-domain.com`
- Redirect URLs: `https://your-domain.com`

This ensures magic links and confirmation emails point to the right place.

## How the adaptive engine works

Every answer is a data point: `(user, item, correct, category, timestamp)`.

**Category targeting:** The engine calculates per-category accuracy and
overweights items from the weakest areas. A user at 45% in Ethics and 90%
in HBSE will see roughly 3x more Ethics items.

**Item difficulty:** Once Supabase has enough data (3+ attempts per item),
the engine pulls population-level difficulty — what percentage of all users
miss each item. Hard items get more repetitions.

**Diversity cap:** No single category exceeds 40% of any set, so even a
very weak area doesn't monopolize the session.

**Previously missed items** get a bonus so they resurface before the user
has forgotten the rationale.

**Fallback:** With no history, sets are random. With local-only history
(no sign-in), the engine still works using localStorage data.

## How the data flows

```
User answers a question
  → tracker.record() writes to localStorage immediately
  → if signed in, queues a row for Supabase
  → flush() sends the queue (batched, retry on failure)
  → on reconnect, auto-flushes

User completes a set
  → tracker.recordSession() writes to study_sessions
  → summary screen shows results

User opens Dashboard
  → dashboard.fetchDashboard() calls Supabase RPCs
  → falls back to localStorage if offline or not signed in
  → renders category bars, trend chart, study plan, session history

User starts "Recommended for you"
  → recommend() fetches category stats + item difficulty
  → scores every item by weakness + difficulty + miss history
  → returns a balanced 20-item set with a human-readable reason

First sign-in
  → tracker.backfillHistory() uploads localStorage history
  → only runs if the user has zero server-side responses
```

## Extending the question bank

Questions live in the `const DATA = {...}` block in `index.html`.

A question object:
```js
{
  id: "q218",          // unique, sequential
  n: 218,
  cat: "Ethics",       // HBSE | Assessment | Intervention | Ethics | Policy | Research | Diversity | Supervision
  stem: "...",
  choices: ["A","B","C","D"],
  answer: 2,           // zero-indexed
  label: "Short name",
  why: "Full rationale"
}
```

After adding items, bump `VERSION` in `sw.js` so returning users get the update.

## Costs

- **Supabase free tier:** 500 MB database, 50K auth users, 2 GB bandwidth/month.
  A study app with a few hundred users won't approach these limits.
- **Hosting:** Netlify/CF Pages free tiers are more than enough.
- **Total: $0** until you have thousands of active users.

## What's next

Ideas for future versions, in rough priority:

1. **Admin dashboard** — see aggregate difficulty, flag bad items, add new ones
2. **Spaced repetition for vignettes** — not just flashcards, bring back missed vignettes at increasing intervals
3. **Study groups** — shared leaderboards, group accuracy comparison
4. **Content expansion** — LCSW-specific clinical content, state-specific law modules
5. **Mobile app wrapper** — Capacitor or TWA for App Store distribution
6. **Stripe integration** — paid tiers with expanded content

## Legal

Not affiliated with or endorsed by ASWB®.
ASWB is a registered trademark of the Association of Social Work Boards.
All study content is original.
