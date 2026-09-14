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

## 2. Price source (pick one — both free)

The app fetches real listings from a **price provider** and auto-selects
whichever key is present, preferring the one with the larger allowance.

| Provider | Free allowance | Card? | Get a key |
| --- | --- | --- | --- |
| **Serper.dev** | **2,500 searches, one-time** | No | [serper.dev](https://serper.dev) |
| **SerpAPI** | **250/month, renews** | No | [serpapi.com](https://serpapi.com) |

Set `SERPER_API_KEY` and/or `SERPAPI_KEY`. Configuring both is the best
free setup: Serper's large one-time pot gets spent first, leaving SerpAPI's
recurring 250/month as the permanent source once it runs out.

### Making a free allowance last

Two mechanisms, both automatic:

- **Caching.** A repeated search costs nothing. Results are cached for
  `SEARCH_CACHE_TTL_MINUTES` (default 6 hours), and price refreshes reuse a
  recent search rather than paying twice. Cached results keep their original
  fetch time and are labelled in the UI — a cached price never pretends to
  be live, and there's a one-click re-check.
- **Budget guard.** Every call is counted. Settings shows
  "173 / 250 used this month". When the allowance is gone the app says so
  plainly instead of failing with an opaque 429, and the cron job stops
  early, keeping a small reserve so manual searches still work.

Rough budget at 250/month: ~6 tracked products on a daily cron (180/month)
leaves ~70 for searching and manual refreshes.

### Option C — Gemini with Google Search grounding

**Disabled by default.** Set `ENABLE_GEMINI_GROUNDED_SEARCH=true` to opt in.

> **Requires billing.** Google Search grounding is **not** part of the Gemini
> API free tier. It needs a billing-enabled Google AI Studio project, which
> then includes 5,000 grounded searches/month free, then $14 per 1,000.
> A plain free-tier key fails with a clear message in the app.

Guardrails, because an LLM reporting prices needs them:

- A result is discarded unless its URL is on a **recognised retailer domain**.
- Prices outside $15–$6,000 CAD are discarded as implausible.
- The UI labels these results and says to confirm on the retailer's page.

> Whichever provider runs, **the LLM never produces a price.** It interprets
> the query and groups listings into products; every price and URL comes from
> the fetched listing.

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
| `SERPER_API_KEY` | one of | Google Shopping — 2,500 free, one-time |
| `SERPAPI_KEY` | one of | Google Shopping — 250 free per month |
| `GEMINI_API_KEY` | yes | Query parsing, product clustering, chat. Never produces a price. |
| `GEMINI_MODEL` | no | Optional override. Leave unset — the app tries current Flash models in order and caches the first that works, so a Google retirement can't break it. |
| `RESEND_API_KEY` | no | Daily report delivery |
| `REPORT_FROM_EMAIL` / `REPORT_TO_EMAIL` | no | Report addresses |
| `CRON_SECRET` | cron only | Protects the cron endpoints |
| `NEXT_PUBLIC_APP_URL` | no | Link target in report emails |
| `SERPER_CREDIT_LIMIT` / `SERPAPI_MONTHLY_LIMIT` | no | Raise when you leave a free plan |
| `SEARCH_CACHE_TTL_MINUTES` | no | Cache lifetime, default 360 (6h) |
| `SERPAPI_TIMEOUT_MS` | no | SerpAPI patience, default 25000. Raise on timeouts. |
| `ENABLE_GEMINI_GROUNDED_SEARCH` | no | Opt into grounded Gemini. Needs Google billing. |

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
    │   └── providers/      ← serpapi | gemini-grounded
    ├── db/                 ← persistence + refresh
    ├── retailers.ts        ← canonical retailer registry
    ├── queries.ts          ← TanStack Query hooks
    └── supabase/server.ts  ← requireUser() / service-role client
```

### Search pipeline

```
"hardside carry-on under $300"
  → cache lookup      (free — a repeat search costs nothing)
  → parse intent      (Gemini, structured JSON)
  → fetch listings    (Serper → SerpAPI → grounded Gemini)
                      ← the only source of prices, metered against quota
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
