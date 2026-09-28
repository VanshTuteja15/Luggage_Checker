# LuggageTracker — Setup Guide

Live luggage price monitoring across Canadian retailers.

---

## 1. Database

1. Create a project at [supabase.com](https://supabase.com).
2. **SQL Editor** → run **`supabase/migrations/000_complete_setup.sql`**,
   then **`supabase/migrations/003_search_cache_and_quota.sql`**.
   Between them these create everything: tables, indexes, row-level
   security, triggers, the search cache and the provider usage counter.
   Both are idempotent, so re-running is always safe.
   (`001_` and `002_` are kept for history — you do not need to run them.)
   Each ends with a verification query: **5 rows** for the first,
   **4 rows** for the second. Fewer means it didn't finish — scroll up
   for the error.
3. **Settings → API**, copy:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` / publishable key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - a **secret key** (`sb_secret_…`) → `SUPABASE_SERVICE_ROLE_KEY` *(cron jobs only)*
     Supabase's newer key system replaces the legacy `service_role` JWT;
     either works in that variable, but legacy keys are being retired at the
     end of 2026, so create a secret key.
4. **Authentication → Users** → create your login.

> Setup also creates a `user_settings` row automatically for every new user,
> and backfills any that already exist.

---

## 2. Web research: Tavily (free)

All product research goes through **Tavily** — one search per lookup.

| | |
| --- | --- |
| Free plan | **1,000 credits a month**, no card |
| Cost per lookup | **1 credit** (basic depth — the default) |
| Get a key | [app.tavily.com](https://app.tavily.com) |

Put it in `.env.local` as `TAVILY_API_KEY`, restart, then run
`npm run diagnose` — it shows credits used and left, at no cost.

**Keeping it at $0.** Three layers:

1. The app refuses any call that would take the month past
   `TAVILY_MONTHLY_CREDIT_CAP` (default 950) — *before* the request is sent.
   It checks Tavily's own usage figure, not just its own count.
2. Past the free limit, Tavily refuses with HTTP 432. Nothing is billed —
   **as long as pay-as-you-go is off** in the Tavily dashboard. `npm run
   diagnose` warns if it looks enabled.
3. Optional: set a per-key usage limit in the Tavily dashboard.

To prove the real path end to end: `npm run diagnose -- --live "samsonite
freeform 21"` (1 credit). It prints every page Tavily returned, which became a
price and why the rest didn't, and saves the raw response to
`tavily-response.json`.

### Making 1,000 credits last

All automatic:

- **One call per lookup.** Price, stock status and specs all come from the
  same search — 20 pages with their text, for 1 credit. No per-field
  searches, and `auto_parameters` (which can silently double the cost) is
  never sent.
- **Caching.** A repeated search costs nothing — for
  `TAVILY_CACHE_TTL_MINUTES` / `SEARCH_CACHE_TTL_MINUTES` (default 6 hours).
  Word order, casing and punctuation don't cause a miss. An empty answer is
  cached for 30 minutes so the same dead end isn't bought twice.
- **No duplicates in flight.** Two identical searches at the same moment
  share one call.
- **Broadening only when useful.** If Tavily finds *no pages at all*, one
  broader query is tried. If it finds pages but no readable price, it stops —
  a broader query would just buy similar pages.
- **Scheduled refreshes are capped** at `CRON_MAX_CREDITS_PER_RUN` (25) per
  run, and stop when credits fall to `CRON_CREDIT_RESERVE` (200), so people
  doing research are never starved.

Rough budget at 950/month: 20 tracked products refreshed weekly (~86) leaves
~860 lookups.

> **No invented prices.** A price is only accepted when it appears on a
> Canadian retailer's own product page; "was", "list", "save", "per month"
> and "orders over" amounts are rejected, and the exact words the price was
> read from are kept as evidence (hover a price on the Search page to see
> them). When a page doesn't show a clear price, the answer is "no price" —
> never a guess. No LLM is involved in reading prices.

---

## 3. Email reports (optional)

1. Sign up at [resend.com](https://resend.com) (free: 100 emails/day).
2. Verify your domain, or use `onboarding@resend.dev` for testing.
3. Set `RESEND_API_KEY`, `REPORT_FROM_EMAIL`, `REPORT_TO_EMAIL`.

Without a key the cron still runs and records prices; it just doesn't send.

---

## 4. Environment

```bash
cp .env.example .env.local
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | Database + auth |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes | Browser + user-scoped API access |
| `SUPABASE_SERVICE_ROLE_KEY` | cron only | Bypasses RLS — never sent to the browser |
| `TAVILY_API_KEY` | yes | Web research — 1,000 free credits/month |
| `TAVILY_MONTHLY_CREDIT_CAP` | no | Hard monthly credit cap, default 950 |
| `TAVILY_SEARCH_DEPTH` | no | `basic` (1 credit, default) or `advanced` (2) |
| `TAVILY_INCLUDE_RAW_CONTENT` | no | Page text for price + specs in one call, default true |
| `TAVILY_TIMEOUT_MS` / `TAVILY_CACHE_TTL_MINUTES` | no | Default 15000 / 360 |
| `CRON_CREDIT_RESERVE` / `CRON_MAX_CREDITS_PER_RUN` | no | Scheduled refresh limits, default 200 / 25 |
| `GEMINI_API_KEY` | yes | Query parsing, product clustering, chat. Never produces a price. |
| `GEMINI_MODEL` | no | Optional override. Leave unset — the app tries current Flash models in order and caches the first that works, so a Google retirement can't break it. |
| `RESEND_API_KEY` | no | Daily report delivery |
| `REPORT_FROM_EMAIL` / `REPORT_TO_EMAIL` | no | Report addresses |
| `CRON_SECRET` | cron only | Protects the cron endpoints |
| `NEXT_PUBLIC_APP_URL` | no | Link target in report emails |
| `SEARCH_CACHE_TTL_MINUTES` | no | Cache lifetime, default 360 (6h) |

Generate a cron secret:

```bash
openssl rand -hex 32
```

Then:

```bash
npm install
npm run dev
```

---

## 5. Deploy

```bash
npm i -g vercel
vercel
```

Add every variable above in **Settings → Environment Variables**.

Vercel Cron runs the price check every 6 hours and the report at 15:00 UTC.
Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when that
variable is set. Vercel Cron needs the Pro plan; on the free tier use the
GitHub Actions workflows in `.github/workflows/` instead, with repo secrets
`APP_URL` and `CRON_SECRET`.

> **Note on the report time:** `0 15 * * *` is 9 AM during MDT and 8 AM during
> MST. Adjust seasonally if the exact hour matters to the client.

---

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── search/     ← natural-language search across retailers
│   │   ├── track/      ← POST/DELETE/PATCH tracking + price alerts
│   │   ├── products/   ← tracked products with offers + history
│   │   ├── refresh/    ← on-demand price re-check
│   │   ├── settings/   ← per-user settings
│   │   ├── chat/       ← AI assistant, grounded in real tracked data
│   │   └── cron/       ← scheduled price check + daily report
│   ├── dashboard/  search/  tracked/  history/  settings/
│   └── products/[productId]/
└── lib/
    ├── search/
    │   ├── index.ts        ← pipeline orchestrator
    │   ├── parse.ts        ← LLM query understanding
    │   ├── cluster.ts      ← LLM groups listings into products
    │   ├── extract.ts      ← price / stock / specs from page text
    │   └── providers/      ← tavily
    ├── db/                 ← persistence + refresh
    ├── retailers.ts        ← canonical retailer registry
    ├── queries.ts          ← TanStack Query hooks
    └── supabase/server.ts  ← requireUser() / service-role client
```

### Search pipeline

```
"hardside carry-on under $300"
  → cache lookup      (free — a repeat search costs nothing)
  → parse intent      (plain product names skip the LLM)
  → web research      (ONE Tavily search, credit-capped)
                      ← the only source of prices, read from retailer pages
  → cluster listings  (Gemini groups them into distinct products)
  → filter + rank     (retailer settings, price ceiling, majors first)
  → top 10 products, each with every offer we found
```

### Security

Every API route calls `requireUser()`, which validates the caller's Supabase
access token and builds a client scoped to that user, so **row-level security
decides what they can read and write**. No route takes a `userId` from the
request body. The service-role key is used in exactly one place — the cron
jobs, which have no user context.
