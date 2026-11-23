STATUS: IN PROGRESS (run 2: A5–A8 done and green; working on A9 freshness, canaries, drift, then A10)

# PROGRESS V4: own AI price engine (overnight run)

## Morning summary (runs 1 and 2)

- **Run 1 (committed as `a869533`):** Ollama checked (it already read D:; RX 6500M via Vulkan); Stage R (review, measurements, 6 labelled sets, `MASTER_PROMPT_V4_DRAFT.md`); A1 AI layer (all flags off); A2 `npm run eval`; A3 catalogue reads + event storage; A4 attributes + promotions.
- **A5 matching v2 ✅** (your answer 2): a near match now needs the same product words when the store lists both pages itself (only the colour part may differ), else at most one word apart. New vetoes: S/M/L/XL sizes, any inch figure, any "… Edition", spinner vs upright. Suitcases with no size are no longer queued. **Dev DB queue: 311 → 42** (mostly colour pages or the same product with inches on one side, plus a few truly ambiguous ones such as a TUMI "Leather" page; 269 superseded, none deleted). Batch backend + **Cursor task T-501**. Eval: wrong merges 0, pairs 61.3% (unchanged).
- **CLD catalogue on by default ✅** (your answer 1): complete reads now also retire pages the store dropped (3 of the 116 dropped pages read live → 404). Migration 007 flips the old seed-written flag row (it would have kept the catalogue off).
- **A6 discovery v2 ✅:** candidate stores are inactive registry rows, with a polite probe (robots.txt + terms quoted verbatim) and a look-alike guard; **Cursor task T-601**. Single-page reads are built but **off and not wired** (your answer 3).
- **A7 Price Data API v1 ✅:** 7 read-only `/api/v1` routes, hashed keys, a per-key rate limit, a label on every price, `docs/openapi-v1.yaml`. Off (503) until you make a key.
- **A8 Oracle kit ✅ scripts only** (your answer 4): `deploy/oracle/*` and `docs/DEPLOY_ORACLE.md`; nothing created.
- **Models vs rules (run 1):** rules win every task (e.g. attributes 95% vs 55%, promotions 93% vs 40%); the models' pair answers made 7–10 wrong merges. AI stays off, advice only; prices never come from a model.
- **PERF-1 after A5 ✅:** Paralux 1.31 s, TUMI first price 1.24 s / total 4.26 s, Omni 1.30 s (limit 8 s).
- **Gates (final):** tsc ✅ (root+worker) lint ✅ (4 known, protected file) build ✅ verify:search 351 ✅ npm test **399** (+1 skip) ✅ test:db **110** ✅ worker 12 ✅ probe 36 ✅ eval ✅ (no drops).
- **Live requests:** 93 of 200 in total (run 2: 13, all CLD). The dev DB got migration 007 and the queue re-check.
- **Not done:** A9 freshness scheduler (it schedules live crawls, and its host is your Oracle / GitHub Actions decision); A10 search intelligence; GTIN backfill live run; qwen3 / thinking bench (memory).
- **UNVERIFIED** (section below): qwen3 + thinking mode; Oracle Arm speed; Shopify 304s; `lineOf` drops the word after a 5+ digit code (slug titles; fix with a re-resolve in A10); the 42 queue items were judged by me, not you.
- **Questions for Vansh:** (1) Oracle (card for identity) or GitHub Actions? (2) Apply the queue re-check on Supabase too (`npm run engine:review-recheck`, V4-2)? (3) A9 cadence once hosted: CLD catalogue every 8 h, tracked/email products every 4–6 h?
- **Commit order (Ready-to-commit, below):** A5 → CLD catalogue default → A6 → A7 → A8 (they share `flags.ts`, `store/*`, `types.ts` and 007: commit them together if staging by hunk is a bother). Then re-run **migration 007** in Supabase (V4-1).
- **Left running:** Docker Desktop (started for the dev DB and `test:db`; another project's `armms-*` containers start with it). Quit it if you need the RAM.
- **Assumptions:** 1–18 below (run 2: 8–18).

## Run 2 (2026-10-30, from 07:20 MDT)

- **Start:** the owner committed run 1 as `a869533` ("making our own agent"), including the half-done A5 files; the tree was clean. Docker Desktop was stopped and was started; `lt-dev-db` was started with `npm run db:dev -- up`. Another project's containers (`armms-azurite`, `armms-cosmos-emulator`) start with Docker and were left alone.
- **Owner answers (2026-10-30 morning), applied:**
  1. CLD catalogue read **on by default**: `flags.ts`. The catalogue path now also retires pages the store no longer lists, as the sitemap path did. Otherwise turning it on would have stopped CLD deactivations.
  2. Near-match rule made **stricter** (only real near matches) + **Cursor task T-501** (batch review screen) + its backend (batch endpoint, word differences).
  3. Single-page reads stay **off** (A6).
  4. Oracle pending: A8 stays **scripts only**.
  5. Queries: the owner adds them later (A2.3 stays a human action).

## Status table

| Step | What | Status | Evidence |
|---|---|---|---|
| 0 | Branch `feat/own-engine`, record start state | DONE | see "Start state" |
| 1 | Fix Ollama (§2) | DONE (no restart needed) | see "Ollama fix" |
| R | Stage R: pre-build review and plan | ✅ DONE 01:58 (qwen3 partial, think-on not measured: memory) | `planning/v4/review/01–06`, `planning/v4/MASTER_PROMPT_V4_DRAFT.md` (self-reviewed against OVERNIGHT §3 priorities: passes), `docs/research/v4-research-notes.md`, plan corrections listed in 02 §8. Earlier detail: | R1 read ✅ → `planning/v4/review/01_CODEBASE_MAP.md`; R2 measure: DB gaps ✅ (`scripts/bench/db-gaps.sql`), bulk catalogue fields ✅, labelled sets ✅ (`scripts/bench/sets/`: titles 100, queries 60, attributes 40, pairs 80, promos 30, terms 16), Ollama bench: rules + llama3.2:3b + qwen2.5:3b ✅, qwen3:4b no-think ⏳, think-on subset ☐ → `02_MEASUREMENTS.md` ☐; R3 research ✅ `docs/research/v4-research-notes.md`; R4 review ✅ `03_REVIEW.md`; R5 decisions ✅ `04_DECISIONS.md` (fill qwen3 column), risks ✅ `05_RISK_REGISTER.md`, test plan ✅ `06_TEST_PLAN.md`; `MASTER_PROMPT_V4_DRAFT.md` ☐; plan fixes ☐ |

### Bench run stopped by memory pressure (01:50)

- Claude Code's background-task reaper **stopped the bench at ~01:50 because the system was critically low on memory** (7.34 GB RAM; ~0.8 GB free at baseline with Docker/WSL and another project's emulators; `qwen3:4b-q4_K_M` loaded at 3.12 GB with only 75% on the GPU, so ~0.8 GB sat in system RAM). Per the reaper's instruction it was **not restarted**.
- Saved in `planning/v4/review/bench-results.json`: rules (all six tasks), `llama3.2:3b` (all six), `qwen2.5:3b` (all six).
- `qwen3:4b-q4_K_M` (no think): only **titles** and **queries** completed (numbers from the run log, copied into 02); attributes/pairs/promos/terms **not measured**.
- **Thinking on: not measured** (UNVERIFIED). It would load the same 3.12 GB model with longer outputs on a machine that just ran out of memory.
- Afterwards no model was loaded; free RAM back to 0.83 GB.

### Stage R key findings so far (for a resumed session)

- Shopify `/products.json` has **no barcode / no price_currency / no inventory** (1,169 variants checked); CLD = 3,229 products in 13 pages; bulk price = per-product CAD price (Delsey canary).
- Delsey prices in the dev DB were 3 weeks stale (0/47 equal to today's catalogue).
- Live identity bug: "Tumi Ventra Large Expandable Carry-On" and "Tumi Ventra Expandable Carry-On" share key `tumi|expandable ventra|carry_on` (`packs/luggage.ts:323` FILLER "large").
- Storage: one observation per reading (~940 B) → bulk every 6 h ≈ 25 MB/day → event-based storage needed (D2).
- Bench (all-fields-right): rules beat llama3.2:3b and qwen2.5:3b on queries (60 vs 35/32), titles (49 vs 14/0), attributes (95 vs 50/55), promos (93 vs 7/40), terms (100 vs 38/81); models only win pair recall but with 7/10 wrong merges → D1: rules only; AI flags off by default; AI judge advisory in the grey zone, never merges.
- Evidence check on llama attributes caught 43/53 wrong values, 0 false flags; llama left 24.7% of its numbers unevidenced, qwen2.5 10.2%.
- Delsey terms page: no automated-access clause; U.N. Luggage: "reproduced … without written permission", "personal, non-commercial use only".
- robots group selection uses substring (`robots.ts:70`), low severity.
- Ollama facts (FAQ): NUM_PARALLEL 1, MAX_QUEUE 512 → 503, keep_alive default 5 m. Oracle A1 official: 2 OCPU/12 GB; idle rule all three < 20% for 7 days.
| B | Stage B: build phases from `MASTER_PROMPT_V4_DRAFT.md` | IN PROGRESS | see the phase rows below |
| A1 | AI layer foundation | ✅ DONE 02:11 | Ollama client (zod/v4 → JSON schema `format`, temp 0, seed, keep_alive, timeout, URL allow-list), unit-aware evidence checker, prompt guard, result cache (memory + Postgres `ai_cache`), task runner with rules fallback (flags off by default), tasks attributes / match_judge (advisory, hard vetoes) / terms, `ai.small`/`ai.large` lanes on pg-boss (served only with `AI_LANES`; refused over HTTP), rules attribute extractor (40-page set ≥ 95% per field). Gates: tsc ✅ (root+worker) lint ✅ (4 known) build ✅ verify:search 351 ✅ npm test 334 (+1 skip) ✅ test:db 99 ✅ test:worker 10 (+2 skip) ✅ probe 36 ✅. PERF-1 not run: no search code changed (run after A3). Live smoke call deferred to A2 (`scripts/eval/ai-smoke.ts`) |
| A2 | Eval harness | ✅ DONE 02:16 | `npm run eval` (`scripts/eval/run.ts`, `score.ts`) runs the six sets through PRODUCTION functions, writes `docs/EVAL_REPORT.md` + `docs/eval/latest.json`, fails on unexplained drops (> 1 pt) or more wrong merges; `--ai` adds the model path (never in routine gates: memory). Baseline: queries 60%, titles 51%, attributes 95%, pairs 53.8% (wrong merges 1 = Ventra bug, 18 to review), terms 100%, promos n/a (A4). Live smoke `scripts/eval/ai-smoke.ts`: qwen2.5:3b valid JSON, correct, quote verbatim, 8.3 s incl. ~6 s cold load (keep_alive 0; warm p50 ~1 s per bench), unloaded after |
| A3 | Bulk catalogue + event storage + backfill (A3.0 identity hot-fix first) | ✅ DONE 03:30 (Delsey stays on sitemaps, see finding) | A3.0 identity fix (`packs/luggage.ts`: "Large Carry-On" kept as a line word, "global" optional, "carry" kept outside "carry-on"; eval wrong merges 1 → 0, titles 51% → 53%); `adapters/shopify-catalog.ts` (pages until empty, ≤ 100, stop on block, currency canary on 2 products' own `.json`, skips 404s); event storage (`touchPriceRange` in port + both twins; `observeOffer({ onlyOnChange })`); discovery catalogue path behind `source.<id>.catalog` (both **off** by default) + GTIN backfill (luggage classes first); `discovered_via='catalog'` (007). Tests: `tests/engine/catalog.test.ts` 6, `identity-v4.test.ts` 4. Gates: tsc ✅ (root+worker) lint ✅ (4 known) build ✅ verify:search 351 ✅ npm test 344 (+1) ✅ test:db 99 ✅ test:worker 10 (+2) ✅ probe 36 ✅ eval ✅ (no drops). **Live run (dev DB, flags on for the command only):** CLD 3,229 products in 16 requests (+robots), 240 new pages; CLD pages with any identifier **98 → 2,103 of 3,345 (63%)**; 6,307 first readings stored (one-time initial load; DB 27 → 44 MB); repeats store nothing (I-CAT-1). **Delsey finding:** 5 of 6 products listed in its `/products.json` answer 404 on their own delsey.ca page (shared US/CA shop): the feed lists products not on the Canadian storefront, so the canary stopped the run twice and nothing from it was used; Delsey stays on sitemap discovery. GTIN backfill not run live (`--max=0`, request budget). PERF-1 (3 live searches) not run: see UNVERIFIED |
| A4 | Extraction v2 | ✅ DONE 04:00 (Cursor task T-401 written) | **Rules:** A4.1 attribute rules (`extract/attributes.ts`; eval 95%) + **JSON-LD** reader `attributesFromJsonLd` (weight, height/width/depth QuantitativeValue with units, additionalProperty capacity/dimensions/wheels/expandable; unitless numbers skipped); A4.2 promotion rules (eval promos 96.7%, 0 fake). **Storage:** `promotions` table (007: kinds/methods CHECKed, sale < was, % in 0–100, evidence list, `UNIQUE(listing_id, fingerprint)`, RLS read for signed-in, anon none); store port + both twins `recordPromotions` / `currentPromotions` (current = shown by the listing's latest shown reading, listing active, own end date not passed; nothing is written for a reading without promotions) and `mergeVariantAttributes` / `variantsForProduct` (field-level: new field, same store restating, or better method JSON-LD > rules > AI; otherwise the first value stays). `promotionsFromOffer`: Shopify compare-at > price (method `compare_at`), JSON-LD priceSpecification ListPrice/Strikethrough > price with `priceValidUntil` verbatim + approximate (`jsonld`), `evidence.offerText` text rules only when the text's sale price is this offer's price; **AggregateOffer highPrice is never a "was" price** (new `listPriceFrom` in `extract/structured.ts`); a "was" > 5× the price is dropped as a data error. Wiring: `observeOffer` records promotions for shown persisted readings (sessions included, 1 write only when there are any) and merges attributes outside sessions; catalogue runs attach `body_html` spec attributes only when every variant is the same size. Tests: store contract +3 (both twins; Postgres via test:db), `promotions.test.ts` +4 (recorded CLD Omni JSON-LD page through the real adapter), `attributes-jsonld.test.ts` 5, `catalog.test.ts` (2 compare-at promotions current after a repeat run; variants get rules attributes with evidence). Gates: tsc ✅ (root+worker) lint ✅ (4 known, protected file) build ✅ verify:search 351 ✅ npm test 358 (+1 skip) ✅ test:db **106** ✅ (+7 promotions checks) test:worker 10 (+2) ✅ probe 36 ✅ eval ✅ (no drops). **PERF-1 after A4 ✅** (dev DB, 9 requests): Paralux 1.33 s total, TUMI 4.19 s (first price 1.19 s), Omni 3.0 Large 1.19 s; sessions stored real compare-at promotions (e.g. Omni $279.99 was $440, CLD's own `compare_at_price`) |
| A5 | Matching v2 | ✅ DONE 09:05 (run 2) | **A5.1** store SKU first (`resolve.ts` step 1b); two products of one store (other store id or SKU) never merge on the name. **A5.2** hard vetoes in `identity/match.ts`, shared by resolution, the AI judge and the eval: size class, inches, **new: any stated inch figure** (13" vs 15", 30" vs 36": `inchesOf` only reads 14–34), **new: stated sizes** (S/M/L/XL, Small/Medium/Large, X-Large), versions, **new: wheels from the bag type** (spinner = 4, upright/rollaboard = 2), **new: any "<word> Edition"** (Roland Garros, Third, Limited), Large/Small/Compact carry-on, extra line words. **A5.3, stricter (owner answer 2):** a near match now needs (a) no veto, and (b) when the store itself lists the candidate as another of its own pages (other store id, same language), the product names may differ **only in the colour part**; otherwise the names may be **at most one product word apart** and overlap ≥ 0.6 (was: overlap ≥ 0.6 alone). The product name leaves out the colour part, however long ("- New Taupe Green/TNF Black-NPF"). A suitcase with no size class gets no review any more (there's no candidate to join it to). **Measured on the dev DB queue (311 pending, all same-store):** the re-check keeps **42** (TNF, Cole Haan, Baggallini and Briggs ZDX colour pages; TUMI "Textured Finish"; the same product with inches on one side) and supersedes **269**: 99 listed apart by the store, 90 two or more words apart, 37 no candidate, 11 edition, 10 sizes, 4 wheels, 3 inches, 15 extra line words. Applied on the dev DB (`npm run engine:review-recheck -- --apply`: pending 42, superseded 269, nothing deleted; one SQL line undoes it). **Eval:** pairs verdict 61.3% (unchanged), wrong merges **0**, sent to review 8 → 7, same-recall 10.3% (title-only; the 22 Delsey "same" pairs are EN title vs FR slug, which production matches by store SKU, U-MATCH-4). **Backend for T-501:** `POST /api/admin/review/batch` (1–100 ids, per-id results), `GET /api/admin/review` gains `limit` (≤ 1000) and `words` (product words only one side has); `EngineStore.supersedeReview` (both twins). Tests: `tests/engine/match-v4.test.ts` 16 (U-MATCH-3…8, near-match rule, re-check, batch), `worker/test/advisor.test.ts` 2 (U-MATCH-6: the judge is queued on ai.small only with both AI flags), store contract +1 (both twins); V2 identity test updated (unknown size: kept apart, no review). Gates: tsc ✅ (root+worker) lint ✅ (4 known) build ✅ verify:search 351 ✅ npm test **376** (+1 skip) ✅ test:db 106 ✅ worker 12 (+2 skip) ✅ probe 36 ✅ eval ✅ (no drops). **PERF-1 after A5 ✅** (9 requests): Paralux 1.31 s total, TUMI first price 1.24 s / total 4.26 s, Omni 3.0 Large 1.30 s |
| A3.2 follow-up | CLD catalogue on by default (owner answer 1) | ✅ DONE 09:05 (run 2) | `source.canadaluggagedepot.catalog` default **on** (Delsey stays off). The catalogue path now retires pages a **complete** read no longer lists (and their variant listings), as the sitemap path does; a read that would retire > 30% of the store's pages retires nothing and says so. Checked first, with no writes: 116 active CLD pages (last seen in the 2026-10-10 sitemap crawl) aren't in the 2026-10-30 catalogue; 3 of them read live → all **404**, so they really are gone. `CatalogRead.complete` added. Tests: `catalog.test.ts` +1 (retire 1 page; 50% missing → nothing retired), I-CAT-1 now runs on the default and checks the sitemap route when switched off; `discovery.test.ts` sets the flag off for its sitemap test |
| A6 | Discovery v2 | ✅ DONE 09:50 (run 2; single-page reads built but **off** and not wired into searches, owner answer 3) | **A6.1 candidate stores** (`discovery/candidates.ts`): a store someone found becomes a `sources` row first: exact host, `inactive`, disabled, no routes, `discovery` jsonb (migration 007) with state `discovered`. Nothing is fetched before that (U-DISC-1); every module that reads or crawls skips inactive or disabled stores. **Look-alikes** (same name on another domain, ≤ 2 edits, a store's name inside another, `xn--`) are flagged, never probed and can only be rejected (U-DISC-3). **Probe** through the PoliteFetcher: robots.txt (our token on `/products/` and `/product/`), then up to 3 usual terms paths; `single_page_ok` only when robots.txt allows us and the terms pre-screen quoted nothing, else `needs_review` with plain reasons (U-DISC-2). **Terms quotes** (`termsQuotes` in `ai/tasks.ts`): whole sentences, verbatim, with a category; never a permission decision (U-TERMS-1). `approved_crawl` / `rejected` are the owner's (approval needs a probe; an engineer then adds routes in `seed.ts`). Admin API: `GET/POST /api/admin/candidates`, `POST /api/admin/candidates/<id>` {probe, approve, reject}; candidates are kept out of the Store status rows. **A6.2 single-page reads** (`discovery/single-page.ts`): flag `discovery.single_page_reads` **off**; when on: one page of one `single_page_ok` store, its own host only, 3 s budget, robots.txt honoured by the fetcher, label "Read once from <store> · not reviewed yet", image dropped, nothing stored (U-POLICY-1…4); **not wired into research sessions**. Store: `saveCandidate` (both twins; never over a curated row). **Migration 007** also flips a seed-written `source.canadaluggagedepot.catalog` row to on (`updated_by IS NULL` only; an admin's value is kept): the old seed row (`false`) overrode the new code default on the dev DB, and would on Supabase too. Applied to the dev DB: the flag now reads on. Cursor task **T-601** (Store status: stores found, not reviewed yet). Tests: `tests/engine/candidates.test.ts` 9, store contract +1 (both twins), test:db +4 (column; seed row flipped; admin row kept). Gates: tsc ✅ (root+worker) lint ✅ (4 known) build ✅ verify:search 351 ✅ npm test **386** (+1 skip) ✅ test:db **110** ✅ worker 12 (+2 skip) ✅ probe 36 ✅ eval ✅ (no drops). No live requests (all probe tests stubbed) |
| A7 | Price Data API v1 | ✅ DONE 10:30 (run 2) | Read-only `/api/v1/search`, `/products/{id}`, `/products/{id}/offers`, `/products/{id}/history`, `/promotions`, `/stores`, `/changes` (`POST /verify` later, per plan). Core in `src/lib/engine/api-v1/core.ts` (no HTTP), shell in `http.ts`, 7 thin route files. **Keys** only as SHA-256 hashes in `PRICE_API_KEYS` (`name:hex,…`), compared in constant time against every key; `Authorization: Bearer` or `x-api-key`; **503** until a key is set, **401** without a valid one; **rate** per key per minute (`PRICE_API_RATE_PER_MIN`, default 60) → **429** + Retry-After; zod parameters → **400** with one plain sentence; unknown product **404**. **Every price** carries `source`, `method`, `observed_at`, `confidence`, `label` (the app's own `freshnessLabel`), `type` (`estimate` for web estimates, labelled "confirm on site"); `observed_at` is the later of the reading and its event-storage range (a price confirmed since). Answers come from the index only (no store contacted). `/changes` = readings whose price or stock differs from the page's previous one (new store method `observationsSince`, both twins, SQL `lag()`); `/history` = every stored reading. Search groups by product and offers all its active pages (CLD keeps prices on variant pages); a page we never priced and can't place in a product is left out. `docs/openapi-v1.yaml` (OpenAPI 3.1). `npm run api:new-key -- <name>` prints a key once and its hash entry. **Smoke on the dev DB** (no live request): search 59–100 ms, offers 16 ms (Omni 3.0 Large: 4 × $279.99 "Verified live · 9:00 a.m."), history 8 ms (20 readings), changes 93 ms, promotions 22 ms (Omni $279.99 was $440, confidence 0.95), 23 stores. Tests: `tests/engine/api-v1.test.ts` 6 (U-API-1…4: keys/503/401, every price labelled + estimate typed, plain 400s + per-key 429, the spec's paths = the route files and each answers 200), store contract +1 (`observationsSince`, both twins). Gates: tsc ✅ (root+worker) lint ✅ (4 known) build ✅ (7 routes) verify:search 351 ✅ npm test **393** (+1 skip) ✅ test:db 110 ✅ worker 12 (+2 skip) ✅ probe 36 ✅ eval ✅ |
| A8 | Oracle deploy kit (scripts only, owner answer 4) | ✅ DONE 11:00 (run 2; no account, no cloud resource) | `deploy/oracle/compose.yml` (worker + Ollama, both on **127.0.0.1 only**; Ollama `keep_alive -1`, 1 parallel, 1 model, `qwen2.5:3b` by default; optional profiles `localdb` (Postgres, published nowhere) and `tunnel` (Cloudflare Tunnel, so the app can reach the worker with no inbound port); log rotation; memory limits), `setup.sh` (`--check` dry run that changes nothing; `--yes`: updates + unattended-upgrades, ufw SSH only, Docker from Docker's repo, start, model pull, nightly backup cron, checks; refuses root without `--yes`; never prints `.env` values), `backup.sh` (pg_dump of `public` via the postgres:17 image with the URL in the environment, gzip, OCI Object Storage when `OCI_BUCKET` is set, keeps its own 7 newest; `--dry-run`), `restore.md` (scratch restore first, then Supabase or localdb), `env.example` (names only; `.env` is git-ignored; no leading dot, so it can't be taken for a protected `.env*` file), `docs/DEPLOY_ORACLE.md` (costs to avoid: Always Free only, never Pay As You Go, $1 budget alert, home region, idle-reclaim rule; console steps; checks; backups; updates; undo). HUMAN_ACTIONS V4-5. **DEPLOY-1/2 run here:** `docker compose … config` exit 0, worker and Ollama published on 127.0.0.1, all 4 services with profiles; `bash -n` both scripts ✓; `setup.sh --check` on this laptop: 2 problems (no `.env`, 12 GB free), "nothing was changed", exit 1 ✓; as root without `--yes`: refused, exit 1 ✓; no option: exit 2 ✓; `backup.sh --dry-run` without `.env`: refuses ✓. shellcheck not installed (not run). `tests/app/deploy-kit.test.ts` 6 (ports, profiles, Ollama settings, root guard, no secrets in `deploy/oracle/`). Gates: tsc ✅ (root+worker) lint ✅ npm test **399** (+1 skip) ✅ (build unchanged since A7: no app code in A8) |
| A9–A10 | Freshness scheduler, search intelligence | NOT STARTED | A9 schedules recurring live crawls, which need the always-on worker, and its host (Oracle or GitHub Actions) is the owner's pending decision. A10 is the large search phase (V3 S1–S4 + the 20-search client check). Both go to the next run |

## Start state (recorded before any edit)

- Date: 2026-10-30 00:46 (local clock)
- Branch at start: `feat/client-ready` @ `fd13f4d` → switched with `git switch -c feat/own-engine`
- `git status --short` at start:

```
?? planning/v4/
```

- So every tracked file was unchanged before tonight; reverting my own edits with `git checkout -- <file>` is safe on any tracked file.

## Ollama fix (§2), 2026-10-30 00:47–00:50

1. `[Environment]::GetEnvironmentVariable('OLLAMA_MODELS','User')` = `D:\ollama\models`. `D:\ollama\models` has `manifests`, `manifests-v2`, `blobs` (7 files, 1.88 GB) and `metadata`; the manifest is `registry.ollama.ai/library/llama3.2/3b`.
2. The `ollama app` (pid 28368) and `ollama` server (pid 30512) had been restarted at 00:40:32, before this run. That server already reads the variable: `server.log` "server config" shows `OLLAMA_MODELS:D:\\ollama\\models`, `OLLAMA_NUM_PARALLEL:1`, `OLLAMA_MAX_LOADED_MODELS:0` (auto), `OLLAMA_KEEP_ALIVE:5m0s`, `OLLAMA_VULKAN:true`, `OLLAMA_FLASH_ATTENTION:false`, host `127.0.0.1:11434`.
   - So `ollama list` already shows `llama3.2:3b  a80c4f17acd5  2.0 GB`. **No restart or re-download was needed.**
3. GPU: the log has `inference compute ... library=Vulkan name=Vulkan1 description="AMD Radeon(TM) RX 6500M" type=discrete total="4.0 GiB" available="3.4 GiB"`. The iGPU was dropped (`OLLAMA_IGPU_ENABLE` unset), and one warning said "AMD driver is too old" (ROCm path only; Vulkan works).
4. `ollama ps` after a 5-token warm-up: `llama3.2:3b  2.6 GB  5%/95% CPU/GPU  CONTEXT 4096  RUNNER llamacpp`. Cold load measured 6,844 ms.
5. Machine: Ryzen 5 5600H 6C/12T, RAM 7.34 GB total (0.69–0.78 GB free with Docker/WSL running), RX 6500M 3.98 GB + iGPU. Disk free at start: **C: 15.46 GB, D: 16.64 GB**.
6. "One model at a time": `OLLAMA_MAX_LOADED_MODELS` is auto (0), so I didn't change system settings. Instead the bench and client unload each model explicitly (`keep_alive: 0`) before loading another. See Assumption 2.

## Live store request log (limit 200 tonight, review stage limit 20)

| # | Time (UTC) | Host | Path | Why | Result |
|---|---|---|---|---|---|
| 1 | 2026-10-30 06:57:16 | www.canadaluggagedepot.ca | /robots.txt | PoliteFetcher robots check (R1.1 bulk catalogue research) | 200 |
| 2 | 06:57:16 | www.canadaluggagedepot.ca | /products.json?limit=250&page=1 | bulk catalogue fields + eval text | 200, 250 products, 1.77 MB, 633 ms |
| 3 | 06:57:18 | www.canadaluggagedepot.ca | /products.json?limit=250&page=13 | pagination check | 200, 229 products (last page), 2.09 MB |
| 4 | 06:57:19 | delsey.ca | /robots.txt | PoliteFetcher robots check | 200 |
| 5 | 06:57:19 | delsey.ca | /products.json?limit=250&page=1 | bulk catalogue fields + eval text | 200, 250 products, 1.08 MB, 347 ms |
| 6 | 06:59:09 | delsey.ca | /robots.txt | PoliteFetcher robots check (new process) | 200 |
| 7 | 06:59:09 | delsey.ca | /products/40392680500-alexandra-23-inch-…-black.json | bulk vs per-product currency check | 200, 148.00 CAD = bulk 148.00 |
| 8 | 06:59:10 | delsey.ca | /products/40392680500-alexandra-23-inch-…-black.js | same, storefront cents | 200, 14800 = bulk |
| 9 | 07:07:03 | delsey.ca | /robots.txt | PoliteFetcher robots check (new process) | 200 |
| 10 | 07:07:03 | delsey.ca | /policies/terms-of-service | terms pre-screen + eval set (f) | 200; Terms of Sale only, no automated-access clause |
| 11 | 07:07:04 | unluggage.com | /robots.txt | PoliteFetcher robots check | 200 |
| 12 | 07:07:04 | unluggage.com | /policies/terms-of-service | terms pre-screen + eval set (f) | 200; no bot clause; "reproduced … without written permission", "personal, non-commercial use only" |

| 13–29 | 09:24:32–09:24:50 | www.canadaluggagedepot.ca | /robots.txt, /products.json pages 1–14, 2 canary `.json` | A3.7 live run #1 (failed on the old CHECK before writing; not recorded in fetch_attempts, count from the code path) | ~17, est. |
| 30–46 | 09:25:09–09:25:24 | www.canadaluggagedepot.ca | /robots.txt + 14 pages + 2 canary | A3.7 live run #2 | 17 × 200 |
| 47–49 | 09:26:41–09:26:43 | delsey.ca | /robots.txt, page 1, 1 canary | A3.7 Delsey | 200, 200, 404 (canary stopped) |
| 50–57 | 09:27:3x | delsey.ca | /robots.txt, page 1, 6 canary `.json` | Delsey retry after the canary fix | 1 ok, 5 × 404 → stopped |
| 58–71 | 09:32:54–09:33:17 | www.canadaluggagedepot.ca | 4 × /robots.txt, 10 product pages / `.json` (Paralux medium, 4 TUMI 19 Degree) | PERF-1 after A3 (2 rounds of the searches) | 14 × 200 |
| 72–80 | 09:57:30–09:57:37 | www.canadaluggagedepot.ca | 3 × /robots.txt, 6 product pages / `.json` (Paralux, TUMI ×4, Omni 3.0 Large) | PERF-1 after A4 (promotions written by sessions) | 9 × 200 |

| 81–84 | 14:56:11–14:56:14 | www.canadaluggagedepot.ca | /robots.txt + 3 product `.json` (Samsonite Nuon, Osprey Archeon 30, Kipling Money Land) | run 2: are pages missing from the catalogue really gone? | 3 × 404 |
| 85–93 | 15:00:24–15:00:32 | www.canadaluggagedepot.ca | robots.txt + product pages / `.json` (Paralux, TUMI 19 Degree ×4, Omni 3.0 Large) | PERF-1 after A5 | 200s |

Total so far: **93** of 200 (review stage 12 of 20). Counted from `fetch_attempts` from row 58 on (run 2: 13 attempts since 14:50 UTC, all CLD).

## Assumptions

1. Line 1 of this file is the `STATUS:` line because `planning/v4/run-overnight.ps1` reads it to decide when to stop.
2. I didn't run `setx OLLAMA_MAX_LOADED_MODELS 1`: changing the user environment and restarting Ollama isn't needed when the scripts unload models themselves (`keep_alive: 0`, or `ollama stop <model>`). `OLLAMA_NUM_PARALLEL` is already 1.
3. Every AI flag defaults **off**, and so do the new catalogue flags (`source.canadaluggagedepot.catalog`, `source.delsey-ca.catalog`): turning them on would change discovery for live stores, which is the owner's call. The live run used `ENGINE_FLAGS` for that one command.
4. Default model `qwen2.5:3b` (the only benchmarked model fully in the laptop's VRAM). `qwen3:4b-q4_K_M` (2.6 GB on D:) is left installed only so the owner can re-run its incomplete bench; remove it with `ollama rm qwen3:4b-q4_K_M` if not wanted.
5. Catalogue observations keep the adapter name `shopify_product_json` (same Shopify product JSON channel), with `evidence.channel = "products.json catalogue"`, instead of a new adapter id (no change to validation confidences or the registry).
6. The currency canary runs after page 1 (it needs product handles from it) but before anything from the run is written.
7. Eval runs rules only by default; the model path needs `npm run eval -- --ai`, so routine gates never load a model on this 7 GB laptop.
8. (Run 2) "Only real near matches" also means no queue items without a candidate: a suitcase with no size class or brand keeps a product of its own (as before) but no longer opens a review, because there is nothing a person could join it to. To undo: restore the `suitcaseLike` block in `identity/resolve.ts` step 4.
9. (Run 2) "The store lists them apart" = the candidate product already has a page at the listing's own store with another store product id (else another URL path), in the same language (`/fr/…` pages are the same products). Variant pages of one Shopify product share its id, so they never count.
10. (Run 2) I applied the queue re-check on the **dev DB** only (269 superseded, 42 left). On Supabase it is the owner's choice: `DATABASE_URL=<supabase> npm run engine:review-recheck` (dry run), then `-- --apply`.
11. (Run 2) Two stores' near matches keep the old overlap ≥ 0.6 and must also be at most one product word apart. That's stricter, but it means the CLD vs U.N. Luggage Paralux pair (overlap 0.5, only "Expandable" apart) is still not queued, as before. Loosening this for very short names would add real near matches; not done, because the owner asked for stricter.
12. (Run 2) Turning on the CLD catalogue also turns on its deactivation step (a complete read retires pages it no longer lists, with a 30% guard). Without it, CLD pages would never be retired again, because the sitemap path no longer runs for CLD.
13. (Run 2, A6) Candidate stores live in `sources` (not a separate table): the PoliteFetcher's SSRF guard reads `source.fetchHosts` and every attempt is logged with a `source_id` that must exist in `sources`. Candidates are written by their own `saveCandidate` (not the seed SQL), so the seed never needs migration 007's new column, and a database that hasn't re-run 007 is unaffected until a candidate is added.
14. (Run 2, A6) The probe treats "no robots.txt" (404) as no rules (RFC 9309), as the fetcher already does; "couldn't read robots.txt" means no reads at all. "No terms page at the usual addresses" sends the store to a person, not to `single_page_ok`.
15. (Run 2, A6) Single-page reads are built (and tested) but not called from searches: with the owner's answer "keep single-page reads off" there's no reason to touch the 8-second search path tonight. Wiring them in is one call to `pickSinglePageRead` + `readOnce` in the research session, behind the same flag.
16. (Run 2, A7) The API's rate limit counts per server instance (in memory). On Vercel each instance counts on its own, so the real ceiling is (instances × rate); a shared counter (Postgres) is a later step if the API gets outside users. Fine for an internal API.
17. (Run 2, A7) Field names are snake_case (`observed_at`, as the test plan names them), unlike the app's own camelCase JSON: this is a contract for other programs, kept separate from the UI's.
18. (Run 2, A7) A promotion's `confidence` is the confidence of the listing's latest shown reading (the reading that shows it); promotions have no confidence of their own, and none is invented.

## UNVERIFIED items

- `qwen3:4b-q4_K_M` on attributes/pairs/promos/terms, and **thinking mode at all** (bench stopped by memory pressure).
- Oracle A1 CPU speed for 3–4 B models (no Arm machine); the Oracle Always Free cut date; the sign-up card wording.
- Shopify `If-None-Match` → 304 on `/products.json` (not tested); WooCommerce Store API field details (no permitted store).
- Common Crawl licence text and a `.ca` filter size; brand dealer-locator URLs.
- **PERF-1 after A3** (3 live searches ≤ 8 s), run at 03:33 (≈ 15 requests to CLD): "Samsonite Paralux Medium" → CLD $434.95 Verified live ×3 colours (same as V2 A2.1); "Tumi 19 Degree International Expandable" → $1,810 Expandable and $1,680 International kept apart. Stored timings (`research_sessions.answer`): Paralux first price 1.21 s / total **1.21 s**; TUMI first 1.19 s / total **4.20 s** → **PERF-1 ✅ (≤ 8 s, first price ≤ 1.5 s)**. "Delsey Chatelet Air 2.0 23 inch" → 0 products in 37 ms: **pre-existing search gap, not from tonight** (checked on the dev DB with 0 requests). The query's "23 inch" maps to size class `medium` (`packs/luggage.ts` `classFromInches`: 23–26 → medium), but the 6 active Delsey rows `CHATELET AIR 2.0 | 23-Inch Carry-On Suitcase, …` are `carry_on` (the store's size word wins), and `PgEngineStore.searchListings` filters `size_class = $3`, so they are excluded. Tonight's diff touches neither `sizeClassOf`/`classFromInches` nor that SQL. Fix belongs to A10 (search intelligence): when a query gives only inches, filter on inches rather than the inferred class.
- The rules prototypes for promotions/terms were written after seeing their sets (see 02 §9).
- (Run 2, found, not fixed) `packs/luggage.ts` `lineOf` drops the word after a 5+ digit code ("40303160000 Flanerie …" loses "flanerie"): the model-number regex `\b\d{5,}[-\s]?\w*\b` eats the next word when a space follows. It only matters for slug-built titles (Delsey /fr/ pages, which aren't resolved today) and changing `lineOf` re-keys existing products, so it waits for A10 with a re-resolve on the dev DB.
- (Run 2) The 42 near matches left on the dev DB were read by me, not by the owner: all looked like real candidates (colour pages, inches stated on one side), but "same product" is the owner's call in T-501.

## Questions for Vansh

Run 1's five questions were answered on 2026-10-30 (see "Run 2" above). Open after run 2:

1. Hosting: Oracle Always Free (the sign-up needs a card for identity; `docs/DEPLOY_ORACLE.md`) or the GitHub Actions route? The A8 kit stays scripts only until you decide, and A9's scheduled crawls need the answer.
2. Apply the stricter queue on Supabase too? `DATABASE_URL=<Supabase> npm run engine:review-recheck` shows what would leave; `-- --apply` marks it superseded (V4-2).
3. A9 cadence once hosted: CLD catalogue every 8 h and tracked/email products every 4–6 h (the plan's tiers), or different?

## Ready to commit (per phase)

### Stage R (review and plan): ready

Files (all new unless marked):
- `planning/v4/OVERNIGHT_PROMPT.md`, `planning/v4/PRE_BUILD_REVIEW_PROMPT.md`, `planning/v4/PRICE_DATA_PLATFORM_RESEARCH.md`, `planning/v4/run-overnight.ps1` (the owner's files, untracked before tonight)
- `planning/v4/OWN_AI_ENGINE_PLAN.md` (the owner's file + factual corrections marked "corrected 2026-10-30")
- `planning/v4/MASTER_PROMPT_V4_DRAFT.md`
- `planning/v4/review/01_CODEBASE_MAP.md`, `02_MEASUREMENTS.md`, `03_REVIEW.md`, `04_DECISIONS.md`, `05_RISK_REGISTER.md`, `06_TEST_PLAN.md`, `bench-results.json`
- `docs/research/v4-research-notes.md`
- `scripts/bench/db-gaps.sql`, `robots-paths.ts`, `record-catalog.ts`, `bulk-vs-observed.ts`, `currency-check.ts`, `record-terms.ts`, `ollama-bench.ts`
- `scripts/bench/sets/titles.json`, `queries.json`, `attributes.json`, `pairs.json`, `promos.json`, `terms.json`
- `scripts/bench/fixtures/canadaluggagedepot__products_p1.json`, `canadaluggagedepot__products_p13.json`, `delsey-ca__products_p1.json`, `manifest.json` (reduced: first 40 products each, objects unchanged)
- `docs/PROGRESS_V4.md`

Message: `docs(v4): pre-build review, measurements, labelled sets, research, draft master prompt`

### A1 AI layer foundation: ready

Files:
- new: `src/lib/engine/ai/guard.ts`, `evidence.ts`, `ollama.ts`, `cache.ts`, `run.ts`, `tasks.ts`, `index.ts`
- new: `src/lib/engine/extract/attributes.ts`
- new: `supabase/migrations/007_own_engine.sql` (ai_cache, ai_cache_prune)
- new: `tests/engine/ai.test.ts`
- changed: `src/lib/engine/flags.ts` (4 AI flags, off), `src/lib/engine/config.ts` (`ai` block, describeConfig), `worker/src/queue.ts` (job names), `worker/src/jobs.ts` (AI lanes, `aiLanes`), `worker/src/http.ts` (refuses `ai.*` over HTTP), `worker/test/http.test.ts` (+2 tests), `scripts/db/test-migrations.ts` (007 on both paths + 6 checks)

Message: `feat(ai): local AI layer with rules fallback, evidence check, prompt guard, cache and pg-boss lanes (all flags off) [A1.1–A1.7]`

Human action: run `supabase/migrations/007_own_engine.sql` in Supabase (additive, idempotent) before turning on any AI flag.

### A2 Eval harness: ready

Files: new `scripts/eval/run.ts`, `scripts/eval/score.ts`, `scripts/eval/ai-smoke.ts`, `docs/EVAL_REPORT.md`, `docs/eval/latest.json`; changed `package.json` (`eval` script).

Message: `feat(eval): npm run eval on the labelled sets with drop guard; AI smoke test [A2.1–A2.2]`

### A3 Bulk catalogue + event storage: ready (run the 3 PERF-1 searches first, see UNVERIFIED)

Files:
- new: `src/lib/engine/adapters/shopify-catalog.ts`, `tests/engine/catalog.test.ts`, `tests/engine/identity-v4.test.ts`
- changed: `src/lib/engine/packs/luggage.ts` (A3.0 identity fix), `src/lib/engine/observe.ts` (`onlyOnChange`, `stored`), `src/lib/engine/store/port.ts` + `memory.ts` + `pg.ts` (`touchPriceRange`), `src/lib/engine/discovery/index.ts` (catalogue path + GTIN backfill), `src/lib/engine/types.ts` (`discoveredVia: catalog`), `src/lib/engine/flags.ts` (2 catalogue flags, off), `supabase/migrations/007_own_engine.sql` (discovered_via check), `docs/EVAL_REPORT.md`, `docs/eval/latest.json`

Message: `feat(catalog): Shopify catalogue reads with currency canary, event-based observations, identity fix for Large Carry-On/Global/Carry [A3.0–A3.6]`

### A4.2 (rules part) Promotions: ready

Files: new `src/lib/engine/extract/promotions.ts`, `tests/engine/promotions.test.ts`; changed `scripts/eval/run.ts` (promos task), `docs/EVAL_REPORT.md`, `docs/eval/latest.json`.

Message: `feat(extract): promotion rules from offer text, no fake deals (eval promos 96.7%, 0 fake) [A4.2]`

### A4 storage (promotions table, attributes on variants): ready

Files:
- changed: `supabase/migrations/007_own_engine.sql` (`promotions` table + RLS), `src/lib/engine/store/port.ts` (`PromotionInput`/`PromotionRecord`, `CatalogVariant.attributes`, 4 methods), `src/lib/engine/store/memory.ts`, `src/lib/engine/store/pg.ts`, `src/lib/engine/extract/promotions.ts` (`promotionsFromOffer`, `promotionFingerprint`, `approximateEnd`), `src/lib/engine/extract/attributes.ts` (`attributesFromJsonLd`, `toStoredAttributes`, `mergeAttributes`, method `jsonld`), `src/lib/engine/extract/structured.ts` (`listPriceFrom`, product `attributes`), `src/lib/engine/extract/shopify.ts` (`description`), `src/lib/engine/adapters/html-structured.ts` (evidence `listPriceFrom`, offer `attributes`), `src/lib/engine/adapters/shopify-catalog.ts` (`body_html` → text), `src/lib/engine/types.ts` (`RawOffer.attributes`), `src/lib/engine/observe.ts` (promotions + attributes), `src/lib/engine/discovery/index.ts` (single-size spec attributes, `promotions` count), `scripts/db/test-migrations.ts` (+7 checks)
- tests: changed `tests/engine/store.test.ts`, `tests/engine/promotions.test.ts`, `tests/engine/catalog.test.ts`; new `tests/engine/attributes-jsonld.test.ts`
- new: `src/lib/engine/facts.ts` (`factsForUrls`: current promotions + variant attributes by store page URL, index only) and `src/app/api/engine/offer-facts/route.ts` (signed-in, 1–20 https URLs, the T-401 contract)
- task: new `docs/agents/tasks/T-401.md` (Cursor: attributes and promotions on the product page), new `docs/agents/BOARD.md`

Message: `feat(extract): promotions table with event storage and JSON-LD/compare-at sources, attributes on variants with provenance [A4.1 A4.2]`

Human action: re-run `supabase/migrations/007_own_engine.sql` in Supabase (additive, idempotent; adds `promotions`).

### A5 Matching v2 (run 2): ready (awaiting owner commit)

Files:
- changed: `src/lib/engine/identity/match.ts` (new vetoes, `productName`/`productWords`, `nearMatch`, `matchVerdict` uses them), `src/lib/engine/identity/resolve.ts` (`judgeCandidate`, store-lists-apart check, no review without a candidate), `src/lib/engine/identity/review.ts` (`recheckReviews`, `decideReviews`, `wordsApart`), `src/lib/engine/store/port.ts` + `memory.ts` + `pg.ts` (`supersedeReview`), `src/app/api/admin/review/route.ts` (`limit`, `words`), `package.json` (`engine:review-recheck` script), `docs/EVAL_REPORT.md`, `docs/eval/latest.json`, `docs/agents/BOARD.md`, `docs/PROGRESS_V4.md`
- new: `src/app/api/admin/review/batch/route.ts`, `scripts/engine/review-recheck.ts`, `docs/agents/tasks/T-501.md`
- tests: new `tests/engine/match-v4.test.ts`, `worker/test/advisor.test.ts`; changed `tests/engine/identity.test.ts` (unknown size: no review), `tests/engine/store.test.ts` (supersede contract)

Message: `feat(match): only real near matches go to review (same-store pages may differ only in colour; else one word apart), new vetoes, queue re-check, batch decisions [A5.1–A5.3]`

Human action (optional): on Supabase, `DATABASE_URL=<supabase url> npm run engine:review-recheck` shows what would leave the queue; add `-- --apply` to supersede them (nothing is deleted).

### CLD catalogue on by default (owner answer 1, run 2): ready (awaiting owner commit)

Files: changed `src/lib/engine/flags.ts` (default on for CLD), `src/lib/engine/adapters/shopify-catalog.ts` (`complete`), `src/lib/engine/discovery/index.ts` (retire pages a complete read no longer lists, 30% guard), `tests/engine/catalog.test.ts`, `tests/engine/discovery.test.ts`.

Message: `feat(catalog): Canada Luggage Depot catalogue read on by default; complete reads retire pages the store no longer lists [A3.2 owner 2026-10-30]`

Note: these two commits touch different files except `docs/PROGRESS_V4.md`; commit A5 first.

### A6 Discovery v2 (run 2): ready (awaiting owner commit; after the two above)

Files:
- new: `src/lib/engine/discovery/candidates.ts`, `src/lib/engine/discovery/single-page.ts`, `src/app/api/admin/candidates/route.ts`, `src/app/api/admin/candidates/[id]/route.ts`, `tests/engine/candidates.test.ts`, `docs/agents/tasks/T-601.md`
- changed: `src/lib/engine/types.ts` (`CandidateInfo`, `SourceRecord.discovery`), `src/lib/engine/ai/tasks.ts` (`termsQuotes`; pre-screen regexes shared, same results), `src/lib/engine/store/port.ts` + `memory.ts` + `pg.ts` (`saveCandidate`, `discovery` read back), `src/lib/engine/flags.ts` (`discovery.single_page_reads` off), `src/lib/engine/registry/sql.ts` (its description), `src/lib/engine/admin-actions.ts` (candidates kept out of Store status rows), `supabase/migrations/007_own_engine.sql` (`sources.discovery`; CLD catalogue seed row → on), `scripts/db/test-migrations.ts` (+4 checks), `tests/engine/store.test.ts` (+1 contract), `docs/agents/BOARD.md`

Message: `feat(discovery): candidate stores as inactive registry rows, polite probe with verbatim terms quotes, look-alike guard; single-page reads behind an off flag [A6.1 A6.2]`

Human action: re-run `supabase/migrations/007_own_engine.sql` in Supabase (additive, idempotent; adds `sources.discovery` and turns the CLD catalogue flag on where the seed wrote it).

Note: `src/lib/engine/flags.ts`, `store/*`, `types.ts` and `007` are also touched by the A5 / catalogue commits; if committing phase by phase, stage with `git add -p` or commit A5 + catalogue + A6 together as one: `feat(engine): matching v2, CLD catalogue on, discovery v2 [A5 A6]`.

### A7 Price Data API v1 (run 2): ready (awaiting owner commit)

Files:
- new: `src/lib/engine/api-v1/core.ts`, `src/lib/engine/api-v1/http.ts`, `src/app/api/v1/search/route.ts`, `src/app/api/v1/products/[id]/route.ts`, `src/app/api/v1/products/[id]/offers/route.ts`, `src/app/api/v1/products/[id]/history/route.ts`, `src/app/api/v1/promotions/route.ts`, `src/app/api/v1/stores/route.ts`, `src/app/api/v1/changes/route.ts`, `docs/openapi-v1.yaml`, `scripts/api/new-key.ts`, `tests/engine/api-v1.test.ts`
- changed: `src/lib/engine/store/port.ts` + `memory.ts` + `pg.ts` (`observationsSince`, `ObservationWithPrevious`), `tests/engine/store.test.ts` (+1 contract), `package.json` (`api:new-key`), `docs/HUMAN_ACTIONS.md` (v4 section: V4-1…V4-5)

Message: `feat(api): read-only Price Data API v1 with hashed keys, per-key rate limit and a label on every price; OpenAPI spec [A7.1 A7.2]`

Human action (only if wanted): V4-3 in `docs/HUMAN_ACTIONS.md` (make a key, set `PRICE_API_KEYS` on Vercel).

### A8 Oracle deploy kit, scripts only (run 2): ready (awaiting owner commit)

Files: new `deploy/oracle/compose.yml`, `deploy/oracle/setup.sh`, `deploy/oracle/backup.sh`, `deploy/oracle/restore.md`, `deploy/oracle/env.example`, `docs/DEPLOY_ORACLE.md`, `tests/app/deploy-kit.test.ts` (and `docs/HUMAN_ACTIONS.md` V4-5, committed with A7).

Message: `feat(deploy): Oracle Always Free kit, scripts only: compose (127.0.0.1 only), setup with dry run, nightly backups, restore, runbook [A8]`

Human action: decide Oracle vs GitHub Actions (V4-5); nothing is created until you do.
