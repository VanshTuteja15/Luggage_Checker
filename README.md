# LuggageTracker

Luggage price intelligence across Canadian retailers, built for Luggage Depot Inc.

Search in plain language, see each store's **verified** price with its source and the time it was read, track a product, and get told when the price drops.

---

## What it does

**Verified prices (default search).** Type "Samsonite Omni 3.0 Large" or "Delsey Chatelet Air 2.0 Medium". The price engine finds the product in its index and reads each store's current price from the store itself, or from the store's official channel, during your search: fast stores appear in about a second, every store gets a row (verified, blocked, link only, not set up), and every price says where and when it was read ("Verified live · 10:41 a.m."). Stores whose terms forbid automated access (Amazon, Walmart, Costco, Best Buy, Canadian Tire/Sport Chek, London Drugs, eBay's website) get a link, never a guessed price.

**Web research (optional).** The original Tavily-based search is one click away. It reaches more stores but its prices are read by a search service and labelled "Web research · read <time>". In the side-by-side test the engine was right on 115/115 prices; web research on 8 of the 14 we could check ([`docs/SHADOW_REPORT.md`](./docs/SHADOW_REPORT.md)).

**Track and monitor.** One click saves a product and its offers; price history starts at once. A daily job re-verifies tracked products through the engine, emails target-price alerts (once per product per day) and a daily summary.

**Admin.** `/admin` shows store health and block rates, recent failures, the identity review queue, session timings and flags, and takes dealer feeds and manual prices.

### The rule that shapes the whole design

**Nothing invents a price.** Every price comes from a page or official feed that was actually read, with its link and time; older prices say so ("Feed as of", "Last seen …, not current"). The AI only interprets queries and groups listings. The engine identifies itself honestly, honours robots.txt and crawl delays, and never works around a block.

---

## Stack

| Layer | |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript strict |
| Styling | Tailwind v4, shadcn/ui, Recharts |
| Data | Supabase (Postgres + Auth + RLS + Realtime) |
| Price engine | `src/lib/engine`: source registry, polite fetcher, store adapters, validation, identity resolution, research sessions |
| Worker | `worker/`: Node 22 + pg-boss, runs research and daily jobs (optional; Vercel runs them inline without it) |
| Web research | Tavily (free plan, hard credit cap), optional |
| AI | Gemini: query parsing, product grouping, chat. Never a price. |
| Email | Resend |
| Scheduler | Vercel Cron (`vercel.json`) |

---

## Getting started

See **[SETUP.md](./SETUP.md)**. The short version:

```bash
npm install
cp .env.example .env.local     # fill in the keys (DATABASE_URL for the engine)
npm run dev
```

Database: run `supabase/migrations/000_complete_setup.sql`, `003_search_cache_and_quota.sql`, `004_price_engine.sql` and `005_scheduler_alerts.sql` in the Supabase SQL Editor, then the registry seed (`npm run db:seed` writes `supabase/seed/sources.sql`). Build the product index with `npm run engine:discover`.

For local engine work without Supabase: `npm run db:dev -- up` starts a throwaway Postgres with the schema and seed, and prints its `DATABASE_URL`.

---

## Documentation

| | |
|---|---|
| [SETUP.md](./SETUP.md) | Install, environment, database, deploy |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the engine works: registry, politeness, adapters, identity, sessions, data, security |
| [docs/RUNBOOK.md](./docs/RUNBOOK.md) | Deploy Vercel and the worker, rotate keys, add a store, handle a block, routine checks |
| [docs/HUMAN_ACTIONS.md](./docs/HUMAN_ACTIONS.md) | Steps only a person can take (keys, terms reads, migrations, hosting) and the go-live checklist |
| [docs/SHADOW_REPORT.md](./docs/SHADOW_REPORT.md) | Engine vs Tavily on 35 products: accuracy, coverage, latency |
| [docs/PROBE_REPORT.md](./docs/PROBE_REPORT.md) | What each store allows and what we could actually read |
| [docs/PROGRESS.md](./docs/PROGRESS.md) | Build log, quality gates, decisions |

---

## Architecture (short)

```
src/
├── app/
│   ├── api/
│   │   ├── research/   ← verified-price sessions (202 + stream / Realtime)
│   │   ├── admin/      ← overview, flags, feeds, manual prices, review queue
│   │   ├── search/     ← web research (Tavily)
│   │   ├── track/      ← tracking workflow (separate from research)
│   │   ├── products/  refresh/  settings/  chat/
│   │   └── cron/       ← daily price check (engine first) + daily report
│   ├── search/  admin/  dashboard/  tracked/  history/  settings/  privacy/  terms/
│   └── .well-known/ucp-agent/   ← our agent profile for Shopify's UCP
├── lib/
│   ├── engine/         ← the price engine (see docs/ARCHITECTURE.md)
│   ├── search/         ← web research pipeline (Tavily)
│   └── db/  supabase/  retailers.ts  email.ts
worker/                 ← Node 22 worker: queue, signed HTTP API, jobs
supabase/migrations/    ← additive, idempotent SQL (RLS on every table)
scripts/                ← probe, fixtures, discovery, shadow run, test harnesses
```

Research is read-only: it never creates tracked products. Tracking is its own workflow (`/api/track`).

### Security

Every API route authenticates the caller with `requireUser()`, and row-level security decides what can be read and written. Admin routes also require an `app_admins` row. The engine's `DATABASE_URL`, the worker secret and all API keys are server-only; Vercel → worker requests are HMAC-signed with a timestamp and a one-time nonce. The fetcher can only contact hosts listed for each store, after checking they resolve to public addresses.

---

## Scripts

```bash
npm run dev                 # dev server
npm run build               # production build
npm run lint                # eslint
npx tsc --noEmit            # typecheck
npm test                    # engine test suites (Vitest)
npm run verify:search       # web-research pipeline harness
npm run test:db             # migrations + store contract on a fresh Postgres 17 (Docker)
npm run worker:build        # bundle the worker; npm run test:worker / test:worker:e2e
npm run probe:sources       # live, read-only store probe (-- --selftest offline)
npm run engine:discover     # build/refresh the product index (polite, budgeted)
npm run engine:research -- "Samsonite Omni 3.0 Large"   # one real session (local DB)
npm run shadow:run          # engine vs web research on the test set; shadow:report
npm run db:dev -- up        # local Postgres for engine work
```

---

## Operational notes

- **Scheduling** is Vercel Cron only (`vercel.json`: price check 13:00 UTC, report 15:00 UTC). The GitHub workflows are manual triggers, including "CI (manual)", which runs every quality gate.
- **Report time** `0 15 * * *` is 9 AM MDT / 8 AM MST.
- **$0:** no paid APIs or proxies. Tavily stays on its free plan with a hard monthly cap (default 950 of 1,000 credits); keep pay-as-you-go off.
- **Vercel's Hobby plan is non-commercial only.** Fine for building and demos; a business deployment needs a paid plan or another host.
- `src/lib/search/providers/serper.ts` and `gemini-grounded.ts` are unused legacy providers; SerpAPI remains a configured fallback for web research.
