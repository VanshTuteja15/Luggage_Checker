# Price Engine: Progress

Branch: `feat/price-engine` (no force-push, no history rewrites; `main` untouched until merge).
Plan and rules: [`MASTER_PROMPT.md`](../MASTER_PROMPT.md). Things only a human can do: [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md).

| Phase | Status | Evidence / reason |
|---|---|---|
| **P0 Evidence** | ✅ done | Probe selftest 36/36. Live probe run (46 requests, honest UA, robots honoured). [`PROBE_REPORT.md`](./PROBE_REPORT.md). Registry seed `src/lib/engine/registry/seed.ts` updated from the evidence; 47 registry/pack tests pass. |
| **P1 Schema** | ✅ done | `supabase/migrations/004_price_engine.sql`: 14 tables (sources, feature_flags, app_admins, catalog_products/variants/identifiers, listings + GIN full-text index, research_sessions, session_events, fetch_attempts, observations, price_ranges, identity_review, feed_imports), RLS on all, append-only triggers, range-collapsing trigger, `source_health` view, retention function, Realtime publication. `npm run test:db`: **45/45** on a fresh Postgres 17 (both install paths, applied twice, RLS as owner/other/admin/anon, FTS, append-only, CAD-only check, plus the EngineStore contract on Postgres, 9/9). Seed: `npm run db:seed` → `supabase/seed/sources.sql`. Typed helpers: `src/lib/engine/store/{port,pg,memory}.ts`. |
| **P2 Worker + queue + politeness** | ✅ done | Politeness layer in `src/lib/engine/politeness/` (robots RFC 9309 + cache, per-host limiter with crawl delay and deadline, single-flight, block classifier, SSRF guard with DNS + redirect re-checks, circuit breaker, visit windows, `PoliteFetcher`): **23 tests**, including the recorded Samsonite/Sporting Life block pages. Worker package `worker/` (Node 22, pg-boss queue, signed HTTP API, JSON logs, `/health`, Dockerfile, README with $0 hosting options): typecheck + bundle OK, **7/7 tests** incl. **e2e on real Postgres + pg-boss** (`npm run test:worker:e2e`: signed request → queue → job → fetch_attempts). Real run: the start-up health job checked 14 permitted stores in 6.6 s (Sporting Life/Simons still challenged, matching P0). Docker image builds and runs as non-root. |
| **P3 Adapters + extraction + validation** | ✅ done | 7 adapters in `src/lib/engine/adapters/` (shopify_ucp, shopify_product_json, html_structured incl. SFCC microdata + displayed-price cross-check, ebay_browse_api, amazon_creators_api behind a flag, feed_import CSV/JSON, manual_entry), extractors in `extract/`, confidence-scored validator in `validate/`. Real fixtures recorded through our own PoliteFetcher (`npm run fixtures:record`: CLD + Delsey .json/.js/HTML/UCP discovery + a real 404) plus the P0 block pages; channels that need a human action use doc-shaped responses with real values (`scripts/fixtures/README.md`). **28 adapter tests** (prices, sale prices, variants, currency, availability, block/404/garbage per adapter) + **10 validation tests**. |
| **P4 Research Session API + streaming UI** | 🟡 automated check ✅, manual dev run after P5 | Engine: `research/session.ts` (planner, parallel per-store tasks, one bounded alternate route, 90 s single-flight, 11 s deadline, cancel, late results stored not added, "last seen" fallback, freshness on every price), `manager.ts`, `follow.ts`, `api.ts` (zod input, per-user rate limit, ownership). API: `POST /api/research` (202 + session id; signed worker dispatch or inline via `after()`), `GET /api/research/[id]` (resume), `/stream` (NDJSON), `/cancel`; worker `/v1/research` wired. UI: search page "Verified prices / Web research" switch; per-store progress, freshness badges + source links, low-confidence caveats, "Couldn't verify at <store>" rows, Re-verify now, Stop, history dropdown, sort, All-stores view kept; Tavily prices now labelled "Web research · read <time>". `/.well-known/ucp-agent` serves our agent profile. **Integration test with stubbed sources: 10/10** (fast store first, slow later, blocked/link-only/not-configured rows, deadline + late result, single-flight, re-verify, cancel, validation rejection, follow/resume, rate limit). Manual dev run needs the product index from P5. |
| **P5 Discovery/indexing + identity + review queue** | ✅ done | **Real run** (`npm run engine:discover` into a local Postgres): Canada Luggage Depot 6,188 product pages indexed (40 enriched, 49 requests), Delsey.ca 828 (40 enriched, 43 requests); 85 catalog products, 4 pending reviews (down from 50 after two fixes the run exposed: non-suitcases with no size no longer flood the queue; trailing ", Colour" segments no longer split colour-variant products), 0 listings under a product of a different size. The two stores readable today share no products, so "same UPC → one product" is proven by the deterministic test (3 stores, 1 product). |
| _(P5 details)_ | | | `discovery/index.ts`: product sitemaps of stores whose storefront we may read (new URLs first, then stalest, per-run budget; Shopify `<lastmod>` is identical for every product (finding), so not trusted), UCP catalog discovery for agent-channel stores, optional Tavily discovery (flag, URLs only). `identity/resolve.ts`: GTIN → model (+colour code, same size) → brand+line+size → review queue; version numbers must agree; sizes never merge; conflicts flagged. `identity/review.ts` + admin API (`/api/admin/review`, `/review/[id]`, `/products/merge`, `/listings/[id]/split`, admin via `app_admins`). Worker jobs `discover.source`, `discover.refresh`. Tests: **identity 7/7** (same UPC at 3 stores → 1 product; Carry-On/Medium/Large never merge), **discovery 5/5** (recorded CLD sitemaps). 139 root tests pass. |
| **P6 Scheduler + tracked verification + alerts + report** | ✅ done | `jobs/verify-tracked.ts`: tracked bags (stalest first, product + fetch budgets) → their listings on permitted stores (known links, UPC, brand+line+size) → re-read via the engine → identity guard (UPC, else brand+size+line with versions) → lowest verified price per store written through `bridge/tracked.ts` (same tables and pattern as `refresh.ts`; protected files untouched) → tracked page, history and the **existing Resend daily report** run on engine observations. Target-price alerts (`sendPriceAlert`) once per user/product/day (`price_alerts_sent`, migration **005**, + `engine_runs`). Scheduling: Vercel Cron's existing `/api/cron/fetch-prices` (CRON_SECRET) now runs the engine first (signed worker jobs `verify.tracked`/`discover.refresh`/`sources.health`, or inline with a 120 s limit) and keeps Tavily only for products the engine couldn't verify (none once `engine.default_search` is on). No extra cron entry (Vercel Hobby limits). Tests: **5/5** (verify + write + alert once/day, wrong-size guard, budget cap, identity guard, cron 401 without secret). `test:db` **48/48** incl. 005. |
| P7 Admin/observability | ⏳ | |
| P8 Shadow mode + test set | ⏳ | |
| P9 Hardening + docs | ⏳ | |

## Next steps (working notes)

1. **P4 manual dev run.** Local Postgres `lt-dev-db` (`npm run db:dev -- up`, `DATABASE_URL=postgres://postgres:dev@localhost:54331/postgres`) already holds the real CLD + Delsey index. Run `npm run dev` with that `DATABASE_URL`, sign in, choose "Verified prices", search e.g. "Samsonite Omni 3.0 Large". The local `auth.users` needs the signed-in user's id, because `research_sessions.user_id` has a foreign key. Expect CLD/Delsey verified first, blocked stores (Samsonite, TUMI, Sporting Life, Simons) labelled, Amazon/Walmart link-only.
2. **P7 `/admin` pages:**
   - source health and block rates (`source_health` view)
   - recent failures and extraction failures (`recentRejections`)
   - identity review queue (API done)
   - session timings
   - flags
   - feed upload and manual price entry
   - discovery trigger
   - admin role via `app_admins`
3. **P8 shadow mode.** Test set of 30+ products in `scripts/shadow/testset.json` (expected identity and price sources); runner compares the engine against the old Tavily path; write `docs/SHADOW_REPORT.md` covering coverage, accuracy and latency; cut over only if the engine matches or beats Tavily.
4. **P9 docs:**
   - README, SETUP, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, HUMAN_ACTIONS, `.env.example`
   - PROBE_REPORT note on Shopify `lastmod`
   - privacy and terms pages, a GST/HST note in price display, a manual-only CI test workflow

## Quality gates (latest run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ 0 errors. 4 pre-existing `react-hooks/exhaustive-deps` warnings remain in `src/app/tracked/page.tsx`, which rule 5 forbids editing. |
| `npm run verify:search` | ✅ 339/339 |
| `npm run probe:sources -- --selftest` | ✅ 36/36 |
| `npm test` (Vitest) | ✅ 47/47 |
| `npx next build` | not yet run on this branch |

## P0 notes

- **Samsonite.ca and TUMI.ca are blocked** (PerimeterX CAPTCHA, HTTP 307) from our network with an honest UA, so the audit's "probably not blocked" is overturned. Sporting Life and Simons sit behind Cloudflare challenges even for `robots.txt`. All four are `blocked` in the registry; per rule 1 we do not work around them.
- The probe classifier logged the 307 CAPTCHA as a generic `error`. Fixed (`scripts/probe/http.ts` → `challenge`), with 6 new selftest cases.
- **Contact in the User-Agent:** no `PROBE_CONTACT` / `CRAWLER_CONTACT` was configured. The probe and engine use the project's public issue tracker (`https://github.com/VanshTuteja15/Luggage_Checker/issues`), so every request carries a working contact without exposing anyone's personal email. A monitored business address is better: see HUMAN_ACTIONS.
- **Coverage today, without any human action:** live prices from Canada Luggage Depot (product JSON sanctioned by its agents.md) and Delsey.ca (terms silent). Six more Shopify stores light up when the UCP agent profile is published; U.N. Luggage and Bentley when a human reads their terms; eBay with free API keys.

## Decisions and additions (MASTER_PROMPT §5)

| What | Why |
|---|---|
| New identity tables are prefixed `catalog_` (`catalog_products`, `catalog_variants`, `catalog_identifiers`) | A `products` table already exists and belongs to the tracking workflow (rule 5). Additive, no collision. |
| `fetchHosts` separate from `allowedDomains` in the registry | Makes rule 2 structural: stores whose terms forbid automated access have no storefront host the fetcher may contact, so a coding mistake can't fetch their HTML. |
| Worker targets **Node 22 LTS**, not Node 20 | Node 20 reached end-of-life in April 2026, and pg-boss 12 requires Node ≥ 22.12. |
| ESLint 9 + `eslint-config-next` installed, flat config added | `npm run lint` could not run at all: ESLint wasn't installed, so `next lint` would have prompted interactively. |
| Outfit font moved to `next/font` | Fixes a lint warning; the font is self-hosted, so visitors' browsers no longer call Google Fonts (privacy). |
| Vitest for new suites (`npm test`) | The existing `verify:search` harness stays as is; new engine suites use Vitest. |
