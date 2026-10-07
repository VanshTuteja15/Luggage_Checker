# LuggageTracker: Master Build Prompt

You are the lead engineer finishing LuggageTracker end to end. Work autonomously until every
phase below passes its acceptance checks. When something fails, diagnose, fix and re-verify. Do
not stop at "should work". Prove it with tests, builds and real runs.

## 0. Context: read these first, in this order

Project root: `D:\luggage-watch-main` (Windows; use PowerShell-compatible commands).

- `AGENTS.md`: Lovable-connected repo. Never force-push or rewrite pushed history.
- `docs/PROJECT_BRIEF.md`: goals and decision log.
- `docs/STORE_AUDIT.md` and `docs/store-audit.json`: 24 Canadian sellers (platform, robots, terms,
  official routes, live-verification class, gaps). This is the seed for the Source Registry.
- `docs/PROBE_SETUP.md` and `scripts/probe/*`: read-only protocol probe (Shopify UCP catalog MCP,
  Shopify product JSON, JSON-LD, Samsonite.ca, eBay Browse API).
- `src/lib/search/*`, `src/lib/tavily.ts`, `src/lib/retailers.ts`, `src/lib/db/*`, `src/app/**`,
  `supabase/migrations/*`, `scripts/verify-search.ts`.

**Product:** LuggageTracker, a Canadian luggage price-intelligence web app for Luggage Depot Inc.
(Calgary). Users search a product and get verified current prices across Canadian stores,
cheapest first, track products, get price history, alerts and a daily email report.
Long-term: a reusable engine other businesses can use (category-agnostic core, luggage as the
first "category pack").

**Stack:** Next.js 15 App Router, React 19, TypeScript, Tailwind v4, shadcn/ui, TanStack Query,
Supabase (Postgres/Auth/RLS/Realtime), Resend, Vercel (+ Vercel Cron), optional Gemini.

## 1. Non-negotiable rules

1. **Legitimate acquisition only.** Honour robots.txt and crawl delays. Identify honestly with a
   User-Agent containing a contact address. NO stealth browsers, fingerprint spoofing, TLS/JA4
   impersonation, residential/rotating proxies, CAPTCHA solving or any anti-bot circumvention.
   A block (403/429/challenge) is classified as BLOCKED and the planner switches to another
   legitimate route (official API, store-published agent channel, feed, other store) or
   reports "couldn't verify at this store".
2. **Never fetch HTML from stores whose terms forbid automated access** (see `store-audit.json`:
   Amazon, Walmart, Costco, eBay HTML, Best Buy, Canadian Tire/SportChek, London Drugs). Use only
   their official APIs/feeds when credentials exist; otherwise show "link only".
3. **$0 external spend.** No paid APIs or proxies. Tavily keeps its existing hard credit cap and
   moves to an optional, flag-controlled discovery fallback (default OFF once the own engine
   passes shadow mode). Never enable pay-as-you-go anything.
4. **Never fabricate or guess a price.** Every displayed price comes from a fetched source in THIS
   research session (label "Verified live · <time>") or is clearly labelled ("Feed as of <date>",
   "Last seen <time>, not current"). Search-engine snippets are discovery only, never verification.
5. **Do not modify the separate "Add New Product" / tracking workflow files:**
   `src/app/tracked/page.tsx`, `src/app/api/track/route.ts`, `src/lib/db/products.ts`.
   Research never creates or imports products. Integrate through their existing interfaces only.
6. **Secrets:** never commit keys; never print them; `.env.local` is edited by the human. Document
   every new variable in `.env.example` and `docs/HUMAN_ACTIONS.md`.
7. **Git:** work on a feature branch (`feat/price-engine`), small commits with clear messages, no
   force-push, no history rewrites. Keep `main` deployable.
8. **Database:** additive, idempotent migrations only (new numbered files). No destructive changes
   to existing data. RLS on every user-scoped table.
9. **GitHub workflows** in `.github/workflows` must stay manual-only (`workflow_dispatch`). Vercel
   Cron is the scheduler.
10. **When blocked by something only the human can do** (accounts, keys, publishing the UCP agent
    profile, running migrations in Supabase, choosing worker hosting, legal review), do NOT fake
    it: build it behind a feature flag with a clear "not configured" state, add the exact steps
    to `docs/HUMAN_ACTIONS.md`, and continue with everything else.

## 2. Target architecture (build this)

**Principles:** the database is memory (identity, known URLs, history, source intelligence); live
sources are current truth. Every user request for current prices triggers fresh verification of
the listings it shows (shared within a 90-second single-flight window). Deterministic first:
structured data → platform adapters → store adapters → rules → AI only to interpret queries and
write summaries from validated data.

**A. Source Registry** (DB + seed from `docs/store-audit.json` + probe results). Per store:
- allowed domains (exact, to block look-alike/fraud domains)
- market host/currency
- platform
- ranked routes
- robots summary, terms stance, permission status
- crawl delay/visit window
- UCP endpoint
- identity quality
- health (success/block rates)
- circuit breaker

**B. Identity graph.** products → variants → identifiers (UPC/GTIN, MPN/model number e.g.
Samsonite 137394-1041, store SKUs scoped to store) → listings (store × URL × external id).
Resolution order: GTIN → model number (+ colour code) → brand + line + size class + colour → AI
tie-break (candidates only, never invent). Admin review queue for uncertain matches; merge/split
correctable.

**C. Discovery/indexing** (offline, worker). Sitemap and Shopify catalog crawling for permitted
stores (incremental by lastmod/updated_at), UCP catalog search for Shopify stores, feed imports,
optional Tavily discovery (flag). Builds a Postgres full-text listings index so search is instant
with zero external requests.

**D. Research Session** (online).
- `POST /api/research` creates a session, dispatches it to the worker, and returns `session_id`
  immediately.
- The page subscribes to session events (Supabase Realtime; keep the existing NDJSON stream as
  fallback).
- Per-store tasks run in parallel with per-domain limiters and single-flight.
- 10–12 s session deadline, cancellation, and resume by id.
- Late results are stored but not added to a finished answer.
- Per-user rate limits.

**E. Acquisition adapters** (one module each, shared interface, fixture tests):
1. `shopify_ucp`: UCP Catalog MCP (`search_catalog`, `lookup_catalog`, `get_product`) with our
   agent profile URL from env; minor units → dollars; barcodes; availability.
2. `shopify_product_json`: `/products/<handle>.json` + `.js`, only where the registry permits.
3. `html_structured`: JSON-LD Product/ProductGroup/Offer (`@graph`, `hasVariant`,
   `priceSpecification`), OpenGraph/product meta, platform rules (Salesforce Commerce Cloud);
   cross-check displayed vs data price (Bentley discount case).
4. `ebay_browse_api`: EBAY_CA, OAuth client credentials, GTIN and keyword search, filter new
   condition and CAD; never HTML.
5. `amazon_creators_api`: implemented behind a flag; inactive until credentials exist.
6. `feed_import`: CSV/JSON dealer and affiliate feeds (Samsonite dealer list, Rakuten/Impact)
   with "as of" dates.
7. `manual_entry`: admin-entered price with "last checked" date.

A browser tier (Playwright) is used only for permitted stores that truly need JavaScript, inside
the worker, with an honest UA, never stealth.

**F. Extraction + Validation.** Confidence-scored validation of:
- identity and variant
- CAD currency (reject geo-USD)
- price sanity (vs history, MSRP band, other stores)
- seller/condition for marketplaces
- availability, page type, timestamp/cache age

Outcomes: accepted / low-confidence (labelled) / rejected → one bounded alternate route.

**G. Observations.** Append-only `fetch_attempts` (including blocks/errors) and `observations`
(price, currency, availability, method, evidence, extractor/validator version, fetched_at).
Collapse unchanged prices into ranges for history.

**H. Scheduler.** Daily verification of tracked products (lite mode, credit/budget caps),
discovery refresh, source health checks. Feeds alerts and the existing Resend daily report.

**I. Worker service.** A separate package (e.g. `/worker`, Node 20 + TypeScript) with:
- a job queue on Postgres (pg-boss or equivalent)
- a health endpoint and structured logs
- a Dockerfile
- run instructions for a free/cheap host and for running on the office PC

Vercel only orchestrates.

**J. Security.** The worker fetches only registry domains (SSRF guard). Vercel→worker requests
are signed. The service-role key is used only server-side. Input validation everywhere.

**K. Observability/admin.** `/admin` pages for source health, block rates, extraction failures,
the identity review queue and research session timings; admin role via Supabase.

**L. UI.** Search keeps the history dropdown, sort and All-stores view. Add:
- per-price freshness labels and source links
- "Re-verify now"
- "couldn't verify at <store>" rows
- streaming progress per store

## 3. Phases (each must pass its checks before the next)

Keep `docs/PROGRESS.md` updated (done / in progress / blocked + reason) after every phase.

- **P0: Evidence.**
  - Run `npm run probe:sources -- --selftest`.
  - If `UCP_AGENT_PROFILE_URL` / eBay keys are set, run the live probe; otherwise run it without
    them.
  - Write `docs/PROBE_REPORT.md` (accessible / reliable / permitted per store and protocol).
  - Update the registry seed from evidence, not assumptions.
- **P1: Schema.**
  - Migration 004+ with tables: sources, products, variants, identifiers, listings,
    research_sessions, session_events, fetch_attempts, observations, price_ranges,
    identity_review, feature flags.
  - RLS, indexes (incl. full-text on listings), seed script.
  - Check: migration applies cleanly on a fresh local Postgres (Supabase CLI or docker); typed DB
    helpers compile.
- **P2: Worker skeleton + queue + politeness layer.**
  - Robots parser, per-domain limiter, crawl delay, single-flight, block classifier, SSRF guard.
  - Check: unit tests; a local end-to-end job runs.
- **P3: Adapters + extraction + validation**, with recorded real fixtures (`scripts/fixtures`).
  - Check: each adapter has fixture tests for prices, sale prices, variants, currency,
    availability, and block/404/garbage cases.
- **P4: Research Session API + streaming UI + freshness labels + re-verify + per-user rate limit.**
  - Check: integration test with stubbed sources.
  - Check: a manual run in `npm run dev` shows fast stores first, slow stores later, blocked
    stores labelled.
- **P5: Discovery/indexing + identity resolution + admin review queue.**
  - Check: indexing permitted stores produces listings.
  - Check: the same UPC across stores resolves to one product.
  - Check: size classes (Carry-On/Medium/Large) never merge.
- **P6: Scheduler + tracked-product verification + alerts + daily report on the new observations.**
  - Check: cron route works with `CRON_SECRET`; budget caps respected.
- **P7: Admin/observability pages.**
  - Check: source health and recent failures visible.
- **P8: Shadow mode + test set.**
  - Build a test set of 30+ known products (with expected identity and price sources).
  - Run the new engine and the old Tavily path side by side; report coverage, accuracy and
    latency in `docs/SHADOW_REPORT.md`.
  - Cut over the default only when the new engine matches or beats the old path.
  - Targets: ≥99% correct identity+price on shown results, zero unlabelled stale prices, first
    verified price ≤3 s and complete ≤12 s for known products.
- **P9: Hardening + docs.**
  - `README`, `SETUP.md`, `docs/ARCHITECTURE.md`, `docs/HUMAN_ACTIONS.md`, `.env.example`.
  - `docs/RUNBOOK.md`: deploy Vercel + worker, rotate keys, add a store, handle a block.

## 4. Quality gates (run after every phase; all must pass)

- `npx tsc --noEmit` clean; `npm run lint` clean; `npx next build` succeeds.
- `npm run verify:search` passes; new test suites pass (add npm scripts for them).
- Worker builds and its tests pass.
- No `any` leaks in new public interfaces; strict TypeScript.
- No mock data reachable in production paths; demo/test data only in tests and fixtures.
- Accessibility basics (labels, focus, keyboard) and mobile layout on new UI.

## 5. Add what's missing

If you find something crucial missing, add it, note why in `docs/PROGRESS.md`, and keep it
within the rules above. Examples:
- error monitoring
- backups/retention policy
- rate limiting and health checks
- a CI test workflow (manual trigger only)
- French-language store pages
- GST/HST notes in price display
- accessibility
- privacy/terms pages for the app

## 6. Finish

Finish when every phase's checks pass, or when the only remaining items are human actions
listed in `docs/HUMAN_ACTIONS.md`. Then write a final report covering:
- what was built
- test and shadow results, with numbers
- known limitations and coverage gaps per store
- the exact human steps left to go live
