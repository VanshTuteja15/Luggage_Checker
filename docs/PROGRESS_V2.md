# Client-ready release (V2): Progress

Branch: `feat/client-ready`, created from `feat/price-engine` (no force-push, no history rewrite, no merge to `main`).
Plan and rules: [`MASTER_PROMPT_V2.md`](../MASTER_PROMPT_V2.md) (V1 rules in [`MASTER_PROMPT.md`](../MASTER_PROMPT.md) still apply unless changed there). Why each change exists: [`CLIENT_REVIEW.md`](./CLIENT_REVIEW.md). Human-only steps: [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md).

A stopped session resumes here: the first phase not marked ✅ is next.

| Phase | Status | Evidence / reason |
|---|---|---|
| **Q0 Inspect** | ✅ done | All gates green on `feat/client-ready` (table below). Uncommitted 2026-10-10 changes reviewed, one test updated to the new shopper wording, committed as `40f16b3`. §2 facts checked; differences listed below. |
| **Q1 Safety** | ✅ done | Commits `0deb513`, `f8e437d`, `0c337a2`. **A5.1 passes**: `POST /api/auth/signup` answers 403 with the flag off and never calls Supabase (`tests/app/safety.test.ts`, fetch spy). R5.1 tab hidden behind `NEXT_PUBLIC_ALLOW_SIGNUP` (default off), demo sign-in removed, HUMAN_ACTIONS V2-1. R5.4 `chat.enabled` off by default; with no stored prices the reply is "I don't know; run a search." (test asserts no digit and no model call); invented amounts are replaced; every stated price gets a source line. R2.7 login and search copy updated. R5.3 Settings stores from the registry (23 active; legacy names translated); env-name and `vercel.json` wording removed from Settings. Gates: tsc ✅ lint ✅ (4 known) build ✅ verify:search 341/341 ✅ npm test 173/173 ✅ test:db 48/48 ✅ test:worker 6/6 ✅ probe 36/36 ✅. |
| **Q2 Search** | ✅ done | Commits `36eaea0`, `c2b13e2`. R2.1 web-research mode, toggle and key removed; one search = engine session, limited to Settings stores. R2.2/R2.6 `src/lib/engine/research/rows.ts` (one row per store, colour chips, "+N more pages", in-stock first, out-of-stock never leads unless nothing is in stock). R2.3 headline with both lines when an estimate is lower. R2.4 "Also compare at" links. R2.5 "Checking N more stores…", `/api/research/last-known` fallback with dated prices + retry, `src/app/search/error.tsx`. R6 tri-state `retailer_offers.availability` (006), bridge writes it; stock badges in search. **A2.1** real run (session `6fee49c2`): "Samsonite Paralux Medium" → 1 product, 3 raw offers → **one row: Canada Luggage Depot $434.95, Verified live, Black · Stone Grey · Midnight Navy, in stock** (first price 1.3 s). **A2.2** real run (`c69c8e45`): "Aluminum Carry-On" → 4 products, all aluminium carry-on suitcases (3 TUMI 19 Degree at CLD, Delsey ALU'R), no junk; TUMI $1,810/$1,815 twin pages = one row "+1 more page"; ALU'R out of stock in all 4 colours → "Out of stock everywhere we checked", sorted last. **A2.3** `tests/app/search-fallback.test.ts`: production without the engine DB → `POST /api/research` 503 plain sentence; `/api/research/last-known` serves tracked prices with their dates. Tests: `search-rows.test.ts` 14, `search-fallback.test.ts` 2, manual-entry stock 1. Gates: tsc ✅ lint ✅ build ✅ verify:search 341 ✅ npm test 190 ✅ test:db 53 ✅ worker 6 ✅ probe 36 ✅. A2.1's "plus any validated estimates" part is completed in Q3. |
| **Q3 Estimates** | ✅ done | Commits `3d73fbb`, `6aaaae4` (owner's commit: Prettier pass + `mergeEstimateGroups`), `c8017ab`. `src/lib/engine/estimates/{validate,budget,store,run,deps}.ts`; estimates run inside every research session (flag `estimates.web`, default on), snippets only (`includeRawContent: false`); migration 006 adds `web_estimate_searches/spend/rejections`, excludes `web_estimate` from `price_ranges`, extends retention; Tavily extract refuses forbidden/restricted/unclear/blocked registry stores (`extractRefused`, **A3.2**); legacy price writes retired (`/api/cron/fetch-prices` engine-only, `/api/refresh` via engine `verifyTracked(productIds)`); constant-time `src/lib/cron-auth.ts`; fixtures `scripts/fixtures/estimates/e1-*.json`, `e2-*.json` (**A2.4**). Tests: `estimates.test.ts` 24 (**A3.1** every R3.2 rule + E1/E2, A3.2 fetch spy), `budget.test.ts` 11 (**A3.3** cap never exceeded, email priority, rotation), session estimate test in `research.test.ts`, `search-rows.test.ts` +2 (estimates whose title omits an optional line word join the verified product; never across sizes, never into one of two verified products). `test:db` +15 checks for 006 (an estimate observation never opens or extends a `price_ranges` row; purpose/snippet/spend constraints; RLS non-admin/admin/anon on the three estimate tables; retention removes only expired searches and >180-day rejections). **Real run** (dev DB, session `c5cf34a7`, free credits): "Samsonite Paralux Medium" → **one product**: Canada Luggage Depot $434.95 Verified live (Black · Stone Grey · Midnight Navy), plus web estimates Amazon.ca $434.95, Luggage City $434.95, Samsonite.ca $434.95, U.N. Luggage $520.00, all labelled "Web estimate · found … · confirm on site"; 4 accepted, 11 rejected ("a different size", "a search, category or listing page", "a different version", "no clear price in the search result"). First verified price 1.3 s, complete 4.4 s. This completes A2.1's "plus any validated estimates". Gates: tsc ✅ (root + worker) lint ✅ (4 known) build ✅ verify:search 350 ✅ npm test 228 (+1 skip) ✅ test:db 68 ✅ worker:build ✅ test:worker 6 ✅ test:worker:e2e 7 ✅ probe 36 ✅. Carried to Q7: "Web estimates left this month" is on Settings today; R5.2's Store status → Usage tab gets it too. |
| **Q4 Email core** | ☐ | Migration 006, mailer, time module, digest builder/renderers, `/email` |
| **Q5 Scheduler** | ☐ | `/api/cron/tick`, prepare/send, idempotency, catch-up, banner, `schedule.sql`, worker fallback |
| **Q6 No graphs** | ☐ | R4 |
| **Q7 Plain English** | ☐ | R5.2, R5.5, rendered-text scan |
| **Q8 P1 features** | ☐ | R7.1–R7.5 |
| **Q9 Verify like a client** | ☐ | §8 workflows, A1.3, 375 px |
| **Q10 Docs and handover** | ☐ | README, SETUP, ARCHITECTURE, RUNBOOK, HUMAN_ACTIONS, DEPLOY, `.env.example`, FINAL_REPORT_V2 |

## Q0 baseline: quality gates

Run on 2026-10-10 (Node 24.15, Windows 11, Docker 29.8 with local Postgres 17), at `f7b1002`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (root + worker) | ✅ both exit 0 |
| `npm run lint` | ✅ 0 errors; the 4 known `react-hooks/exhaustive-deps` warnings in the protected `src/app/tracked/page.tsx` |
| `npx next build` | ✅ 32 routes |
| `npm run verify:search` | ✅ 341/341 |
| `npm test` | ✅ 159/159 + 1 Postgres-only skip. Before the fix: 1 failure (`research.test.ts` expected the Travelpro row to mention "agent profile"; the 2026-10-10 change now says "not connected yet" on shopper rows, by design, E12). The test now asserts the plain wording and that no shopper row carries an env-style or flag-style identifier. |
| `npm run test:db` | ✅ 48/48 (+ store contract 19/19) |
| `npm run worker:build`, `test:worker`, `test:worker:e2e` | ✅ bundle OK; 6/6 (+1 skip); 7/7 on real Postgres + pg-boss |
| `npm run probe:sources -- --selftest` | ✅ 36/36 |

## Q0 findings: differences from MASTER_PROMPT_V2 §2

All §2 statements were checked against the code. They hold, with these additions and corrections:

1. **Git status.** The session snapshot said "clean", but the working tree had exactly the three modified files §2 names (`dev-db.ts`, `ResearchResults.tsx`, `registry/index.ts`) plus the untracked `MASTER_PROMPT_V2.md` and `docs/CLIENT_REVIEW.md`. All are now committed.
2. **Charts and the protected file.** `src/app/tracked/page.tsx` imports no chart directly, but it renders `TrackedProductCard` from `src/components/ProductCard.tsx`, which draws a `Sparkline`. `ProductCard.tsx` is not protected, so R4 can remove the sparkline there without touching the protected page.
3. **`esc()` is private** to `src/lib/email.ts` (not exported). R1.12 says reuse it, so it will be exported rather than copied.
4. **The daily report compares `CRON_SECRET` with `===`** (not constant time) and accepts GET. The new tick endpoint uses a constant-time compare and POST only (§10); the old route is delegated in Q5.
5. **`observations` already has `availability` and `evidence` columns, and `adapter` is free text** (no check constraint). There is no `freshness` column: freshness is derived when reading (live, feed, manual, stale). Migration 006 therefore needs no column for these; what it must change is the `price_ranges` collapse trigger, so a `web_estimate` observation never extends verified history (R3.1).
6. **Untracking** goes through `DELETE /api/products/[id]` and `DELETE /api/track`, both deleting the `tracked_products` row. An FK from `email_digest_products.tracked_product_id` to `tracked_products(id) ON DELETE CASCADE` meets R1.3 with no change to protected files.
7. **The retailer list** in Settings comes from the `user_settings.retailers` default in `000_complete_setup.sql` (includes Hudson's Bay, RIMOWA, CALPAK), as §2/E13 say.

## Decisions (with reasons)

| What | Why |
|---|---|
| `research.test.ts` expectation changed instead of reverting the 2026-10-10 change | The change is the intended fix for E12 (shoppers must not see setup identifiers). Admin still shows the detailed reason (`admin.test.ts` checks it). |
| `MASTER_PROMPT_V2.md` and `docs/CLIENT_REVIEW.md` committed | They are the binding plan and its sources; a resumed session needs them in the branch. |
| Demo sign-in removed from the login page | Without Supabase it let anyone "sign in" to an empty shell: a placeholder screen (rule 4). The page now says sign-in isn't set up. |
| Settings → Stores now limits the one search (server-side `storeIds`) | R5.3 says remove settings that do nothing; with web research gone the old retailer list would have filtered nothing. Old saved lists are translated; stores the old list never had count as chosen. |
| `src/lib/time/local.ts` created in Q1 (planned for Q4) | The chat guard and the rule-5 labels needed it first; one module for every time-zone question (§4). |
| New freshness kind `estimate` and method types `web_estimate` / `tracked_record` added in Q2 | The headline logic (R2.3) and "never track an estimate" had to be built and tested with the search; Q3 produces the estimates. |
| A live price read on an earlier local day is labelled "Last seen · Oct 8" | Rule 5: nothing older than today may look like today's price. |
| Pre-order and back-order count as "Out of stock" | Three states for people (R6); neither can be bought off the shelf today. |
| Migration 006 started in Q2 (stock column), extended in later phases | R6 is a Q2 requirement and needs the tri-state column; the file stays one additive, idempotent migration. The bridge checks the column exists, so deploying before 006 is safe. |
| "All stores" tab and timing line removed from search | One row per store replaces the flat per-variant list; first-price timings are internal (Store status → Technical details). |
| `POST /api/search` (old Tavily search) kept | It backs the protected Add New Product panel in `src/app/tracked/page.tsx` (rule 2). Its prices reach the tracking tables only through the protected `/api/track`. They are never shown as "Verified live": tracking-table prices are read back as "Last seen · {date}" in search fallback and email (Q4 labels each email row from its `retailer_offers` date). The search page itself uses only the engine session (R2.1). |
| Estimates join a verified product only through `mergeEstimateGroups` | A snippet's title often drops a word the store's page has ("Expandable"). Joining only estimate-only groups, only into exactly one verified group of the same brand, size and inches, and only across optional line words keeps TUMI International vs International Expandable apart (identity rules) while putting Amazon's "Paralux Hardside Spinner Medium" next to CLD's "Paralux Hardside Expandable Spinner Medium". |
| Estimate titles that fit two verified products stay on their own | Guessing which one they mean could show a price for the wrong bag (rule 10). |
| Estimates run inside the research session, not as a separate request | One search (R2.1); the session already streams per-store events, so estimates appear as they arrive (R2.5) and their spend goes through the same Tavily credit reservation. |
| Rejected estimates stored in `web_estimate_rejections`, not `observations` | They aren't readings of a listing (many have no product page), and they must never be shown; a separate admin-only table makes that structural. |

## New dependencies

None yet.

## §15 Missing requirements found during the work

None yet.
