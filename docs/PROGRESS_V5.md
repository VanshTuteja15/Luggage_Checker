STATUS: IN PROGRESS: F2 smarter search

# PROGRESS V5: from narrow and local to a real, deployable price checker

Plan: `planning/v5/FINISH_PROMPT.md`. Branch `feat/own-engine`. The owner commits (AGENTS.md); nothing here is committed by the agent.

## Start state

- 2026-11-23, run 1. `git status --short`: clean (the owner committed `planning/v5/` as `73a1689` "making a plan to clear the gap"; V4 run 2 is in `b9858ea`).
- **Start commit: `73a1689dc40a15232b535228ed2793b96bb8d155`** on `feat/own-engine`. Every tracked file was clean at the start, so `git checkout -- <file>` only ever reverts this run's own edits.
- Machine at start: free RAM 0.79 GB, C: 5.89 GB free, **D: 3.58 GB free (below the 5 GB floor before any work)**. Docker Desktop stopped. Ollama not running.

## Status table

| Phase | Status | Evidence |
|---|---|---|
| F0 Baseline | ✅ DONE | Docker Desktop started; `lt-dev-db` up (`npm run db:dev -- up`). Gates at `73a1689`: tsc ✅ (root + worker) lint ✅ (0 errors; the 4 known warnings in the protected file) build ✅ verify:search **351** ✅ npm test **399** (+1 skip) ✅ test:db **110** ✅ worker **12** (+2 skip) ✅ probe **36** ✅ eval ✅ (queries 60%, titles 53%, attributes 95%, pairs 61.3% / wrong merges 0, terms 100%, promos 96.7% / fake 0). Memory: with 0.7 GB free, the first all-in-a-row run crashed `tsc` and the vitest workers (exit 134 / "Channel closed", out of memory) and `next build` hit a Windows lock on `.next/static/css/app`; each passed when re-run alone (`vitest --maxWorkers=2`). From here gates run one at a time. |
| F1 Web estimates on | ✅ DONE (code); coverage target **not met** (see F1 notes) | **F1.1** `estimates.web` was already on by default (code and dev DB); the gap was elsewhere (below). New plain switch on Store status → Usage ("Web estimates for stores we can't check live", On/Off, posts the existing `/api/admin/flags`); Usage line has three states ("left this month: N" / "switched off" / "aren't set up"). Tests: a research session with the **real** finder and `TAVILY_API_KEY` unset returns CLD's verified price, `estimates_done.skipped = not_configured`, no `session_failed`, **zero** fetches to the search service; flag off → the finder is never asked; flag on → asked for Amazon/Walmart/Samsonite… and never for CLD. **F1.2** Pass 2 re-check (identity, own product URL, "$" price, ratio band, accessory filter, brand-store search, tiles: all already guarded and tested in `tests/app/estimates.test.ts`); added guards with tests: used/renewed/pre-owned/open-box → refused; "discontinued / no longer available" → refused; "sold out / currently unavailable" → kept as **out of stock** (sorts after in-stock, stored on the observation). Fixed four false rejections seen in tonight's real snippets (instalment "every month", lone Shopify "Regular price", "US $"/"Approx. C $" converted amounts refused instead of read, brand lost when a title starts "TUMI - …"), and a shortened title ("… Spinner ...") may take its size from the snippet only when the snippet names exactly one size. **Brand-store search fix:** it started only after the combined search and then didn't fit (`brandSearch: "error"` on every Samsonite/TUMI query); it now starts alongside when the combined search hasn't answered in 1.2 s, with credits approved one at a time so two searches can't pass a call's limit. Validator version `estimate-validate/2`. **F1.3** `npm run coverage` (`scripts/bench/coverage.ts`) → `docs/COVERAGE_REPORT.md` + `docs/coverage/latest.json`. Gates: tsc ✅ (root + worker) lint ✅ (4 known) build ✅ verify:search 351 ✅ npm test **416** (+1 skip) ✅ test:db 110 ✅ worker 12 (+2 skip) ✅ probe 36 ✅ eval ✅ (unchanged). |
| F2 Smarter search | IN PROGRESS | |
| F3 Business features + Store status | NOT STARTED | |
| F4 Scheduled refresh | NOT STARTED | |
| F5 Deploy kit | NOT STARTED | |
| F6 Verify like a client | NOT STARTED | |
| F7 Docs and handover | NOT STARTED | |

## F1 notes: why most searches still show one store

Two real coverage runs (15 queries: Samsonite ×4, TUMI ×2, Travelpro ×2, Delsey ×2, Briggs & Riley ×2, American Tourister large spinner, aluminium carry-on, "24 inch hard spinner under $300"):

| Run | Index | Validator | Median stores with a number (top product) | Estimates shown | Wrong identity | Credits | Requests |
|---|---|---|---|---|---|---|---|
| 1 (14:57 UTC) | 3+ weeks old | v1 | **1** | 1 | 0 | 17 recorded (+ up to 4 unrecorded, see credits) | 47 |
| 2 (15:10 UTC) | refreshed (CLD catalogue + Delsey sitemap) | v2 + brand-search fix | **1** | 1 on top products (q46's 3 stores sit on its 2nd product, below) | 0 | 4 | 38 |

What the runs showed (every cause checked on the dev DB, none guessed):

1. **Tavily brings back little:** 11 of 17 searches in run 1 returned **0 results** (October's searches on the same domains returned 6–15). The same request returned 4 results an hour later in a 1-credit probe, so Tavily's answers vary between identical calls; nothing in our request changed.
2. **Snippets rarely carry a price:** most results that do come back are rejected with "no clear price in the search result" (Amazon, travelpro.ca, unluggage.com snippets are descriptions). Reading the page text instead is not allowed (R3: snippets only).
3. **Fixed tonight:** four false rejections (above), the brand-store search's timing.
4. **Stale index (F4's job):** CLD's TUMI 19 Degree Lite Medium page and all 8 Delsey ALU'R pages answered 404. The refresh retired 543 CLD pages and 345 of Delsey's 422 (Delsey.ca's own sitemap now lists 77 products; 8 of the retired pages were confirmed 404 tonight). Nothing was deleted.
5. **Ranking (F2's job):** "briggs riley baseline medium" found CLD $999 + Briggs & Riley $999 (web estimate) + U.N. Luggage $999 (web estimate) on "Baseline Medium Expandable Spinner", but ranked "Baseline **Compact Checked** Medium" ($949, CLD only) first because it is cheaper. Ranking full line matches first fixes that query to 3.
6. **Parser (F2's job):** "Delsey ALU'R 28" reads no size (bare 28), so the answer showed a 19" "Last seen" price.

Honest limit: at $0 and within the rules, more stores with a number need the human items (UCP profile + legal OK for 6 Shopify stores, Bentley's terms, eBay keys, the Samsonite/TUMI dealer list, staff-checked prices). Web estimates add a number only where Tavily's snippet states one.

## Live store request log (limit 200 tonight)

Counted from `fetch_attempts` (every PoliteFetcher request, robots.txt included). All to permitted hosts.

| # | Time (UTC) | Host | Path | Why | Result |
|---|---|---|---|---|---|
| 1–47 | 14:57:53–14:59:20 | www.canadaluggagedepot.ca, delsey.ca | robots.txt + product `.json`/`.js` | F1.3 coverage run 1 (15 searches) | 200s; 9 × 404 (CLD TUMI 19 Degree Lite Medium, 8 Delsey ALU'R pages) |
| 48–68 | 15:07:30–15:09:41 | www.canadaluggagedepot.ca, delsey.ca | robots.txt ×2, `/products.json` pages 1–15 + 2 canary `.json`, `/sitemap.xml`, `/sitemap_products_1.xml` | index refresh (`npm run engine:discover -- --source=canadaluggagedepot,delsey-ca --max=0`) | 21 × 200 |
| 69–106 | 15:10:27–15:11:28 | www.canadaluggagedepot.ca, delsey.ca | robots.txt + product `.json` | F1.3 coverage run 2 | 200s |

Total so far: **106** of 200.

## Tavily credits (limit 30 tonight)

The month's Tavily counter in the app is a per-process estimate, so the tally comes from `web_estimate_searches` plus the probe; searches that timed out after Tavily billed them aren't recorded, so run 1 is counted with up to 4 extra.

| # | Time (UTC) | What | Credits | Why |
|---|---|---|---|---|
| 1 | 14:57–14:59 | coverage run 1 (15 combined + 2 brand searches recorded) | 17 (+ ≤ 4) | F1.3 |
| 2 | 15:05 | 1 probe: "Travelpro maxlite 5 carry-on price", the app's exact request | 1 | why searches came back empty |
| 3 | 15:10–15:11 | coverage run 2 (4 brand searches; everything else from the cache) | 4 | F1.3 after the fixes |

Total: **22 recorded, ≤ 26 counted.** From here every run uses `TAVILY_MONTHLY_CREDIT_CAP=28`, so the app itself refuses past it, and the rest of the night reuses cached searches (6–12 h).

## Assumptions

1. **D: was below the 5 GB floor before any work (3.58 GB).** Removing the V4 bench model `qwen3:4b-q4_K_M` (2.6 GB, re-pullable) was refused by the permission system, so it stays; this run keeps D: growth small (no new dependencies so far, build output replaced in place). Your call: `ollama rm qwen3:4b-q4_K_M` frees 2.6 GB.
2. **Memory:** another project's `armms-*` containers start with Docker and hold ~0.7 GB; left alone (not ours). Gates run one at a time, `npm test` with `--maxWorkers=2`.
3. **U.N. Luggage "keep it off"** is read as: its live product read (`source.unluggage.product_json`) stays off. Web estimates from search results for unluggage.com stay as V2 built them (no visit to their site, the same basis as Amazon and Walmart, labelled "confirm on site"). To drop them too, remove `unluggage.com` from the estimate stores (one line) — say if you want it.
4. Scripts don't load `.env.local`; the coverage run used `node --env-file=.env.local` with the local `DATABASE_URL` set first (Node never overrides an existing variable), so the Tavily key was read but never printed and the local database was used.
5. A snippet that says "sold out" / "currently unavailable" keeps its estimate but shows it **out of stock** (it never leads unless nothing is in stock) rather than refusing it; "discontinued" is refused (an old price nobody can pay).
6. The brand-store search now starts alongside the combined search when that one hasn't answered in 1.2 s. That spends 1 extra credit on such searches only when Tavily is slow; the monthly cap, the email's reserve and a call's own limit still apply.

## UNVERIFIED items

- The 3 web estimates shown tonight (Travelpro Platinum Elite 21" $584.99 at travelpro.ca; Briggs & Riley Baseline Medium $999 at briggs-riley.ca and unluggage.com) were checked only against the search snippet; open their links (in `docs/COVERAGE_REPORT.md`) to confirm.
- Why Tavily returned 0 results for 11 of 17 searches tonight (provider side; one probe shows the same request can return results later).

## Questions for Vansh

1. Remove the unused `qwen3:4b-q4_K_M` model to get D: back above 5 GB?
2. Keep web estimates from unluggage.com (search results only), or drop them like its live read?

## Ready to commit (per phase)

### F1 Web estimates as an honest second source (awaiting owner commit)

Files:
- changed: `src/lib/engine/estimates/validate.ts` (condition/stock rules, price reading fixes, brand and size fallbacks, version 2), `src/lib/engine/estimates/run.ts` (stock on estimates, brand-store search head start, credits approved one at a time), `src/lib/store-status-view.ts` (`estimates.on`, `estimatesLine`), `src/app/api/admin/overview/route.ts` (passes the switch state), `src/app/admin/page.tsx` (Usage switch), `tests/app/plain-text.test.ts` (fixture field), `package.json` (`coverage` script), `docs/EVAL_REPORT.md`, `docs/eval/latest.json` (date only)
- new: `tests/engine/estimates-v5.test.ts`, `scripts/bench/coverage.ts`, `docs/COVERAGE_REPORT.md`, `docs/coverage/latest.json`, `docs/PROGRESS_V5.md`

Message: `feat(estimates): Usage switch, used/discontinued/stock rules, real-snippet price fixes, brand-store search fits slow searches; coverage report [F1.1-F1.3]`
