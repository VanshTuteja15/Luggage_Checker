STATUS: IN PROGRESS (A4 done 04:05; working on A5 matching v2, then A6, A7, A8)

# PROGRESS V4: own AI price engine (overnight run)

## Morning summary (run 1, 00:46–03:35 MDT)

- **Done (evidence below):** Ollama fixed (it already read `D:\ollama\models`; RX 6500M via Vulkan, 95–100% GPU). **Stage R** complete: `planning/v4/review/01–06`, `MASTER_PROMPT_V4_DRAFT.md`, research notes, 6 labelled sets from real data. **A1** AI layer (all flags off). **A2** `npm run eval`. **A3** catalogue reads + event storage + identity fix.
- **Measured (all fields right, rules vs best local model):** queries 60 vs 35; titles 49 vs 38 (qwen3:4b); attributes 95 vs 55; promos 93 vs 40; terms 100 vs 81; pairs: models more accurate (74–83%) but 7–10 **wrong merges** each, so they only advise. **Rules win every task; AI stays off; prices never come from AI.**
- **Biggest findings:** Shopify `/products.json` has no barcode/currency; our Delsey prices were 3 weeks stale; a live wrong-merge bug (TUMI Ventra Large Carry-On) is fixed; Delsey's feed lists products not on delsey.ca (the canary stopped it); bulk reads would fill Supabase in ~19 days without event storage (now built).
- **CLD identifiers:** 98 → 2,103 of 3,345 pages (catalogue run, 16 requests). Live requests tonight: ~57 of 200.
- **Also done:** A4.2 promotion rules (eval 96.7%, 0 fake promotions).
- **PERF-1 after A3 ✅:** Paralux 1.2 s, TUMI 4.2 s total (first price ≤ 1.21 s). The Delsey "23 inch" query finds nothing: a pre-existing size-class filter gap (UNVERIFIED section), not from tonight.
- **Partly done / skipped:** qwen3 bench incomplete and thinking mode not measured (memory pressure stopped it); GTIN backfill not run live; A4 storage and **A5–A8 not started** (context budget).
- **Gates (last run):** tsc ✅ lint ✅ build ✅ verify:search 351 ✅ npm test 346 ✅ test:db 99 ✅ worker 10 ✅ probe 36 ✅ eval ✅.
- **Assumptions, UNVERIFIED, Questions, Ready-to-commit:** sections below (commit order: Stage R → A1 → A2 → A3; run migration 007 in Supabase).

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
| A5–A8 | Matching v2 judge wiring, Discovery v2, API v1, Oracle deploy kit | IN PROGRESS (A5 started 04:05) | the advisory judge `ai/tasks.ts` and hard vetoes already exist |

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

Total so far: **80** of 200 (review stage 12 of 20). Counted from `fetch_attempts` from row 58 on.

## Assumptions

1. Line 1 of this file is the `STATUS:` line because `planning/v4/run-overnight.ps1` reads it to decide when to stop.
2. I didn't run `setx OLLAMA_MAX_LOADED_MODELS 1`: changing the user environment and restarting Ollama isn't needed when the scripts unload models themselves (`keep_alive: 0`, or `ollama stop <model>`). `OLLAMA_NUM_PARALLEL` is already 1.
3. Every AI flag defaults **off**, and so do the new catalogue flags (`source.canadaluggagedepot.catalog`, `source.delsey-ca.catalog`): turning them on would change discovery for live stores, which is the owner's call. The live run used `ENGINE_FLAGS` for that one command.
4. Default model `qwen2.5:3b` (the only benchmarked model fully in the laptop's VRAM). `qwen3:4b-q4_K_M` (2.6 GB on D:) is left installed only so the owner can re-run its incomplete bench; remove it with `ollama rm qwen3:4b-q4_K_M` if not wanted.
5. Catalogue observations keep the adapter name `shopify_product_json` (same Shopify product JSON channel), with `evidence.channel = "products.json catalogue"`, instead of a new adapter id (no change to validation confidences or the registry).
6. The currency canary runs after page 1 (it needs product handles from it) but before anything from the run is written.
7. Eval runs rules only by default; the model path needs `npm run eval -- --ai`, so routine gates never load a model on this 7 GB laptop.

## UNVERIFIED items

- `qwen3:4b-q4_K_M` on attributes/pairs/promos/terms, and **thinking mode at all** (bench stopped by memory pressure).
- Oracle A1 CPU speed for 3–4 B models (no Arm machine); the Oracle Always Free cut date; the sign-up card wording.
- Shopify `If-None-Match` → 304 on `/products.json` (not tested); WooCommerce Store API field details (no permitted store).
- Common Crawl licence text and a `.ca` filter size; brand dealer-locator URLs.
- **PERF-1 after A3** (3 live searches ≤ 8 s), run at 03:33 (≈ 15 requests to CLD): "Samsonite Paralux Medium" → CLD $434.95 Verified live ×3 colours (same as V2 A2.1); "Tumi 19 Degree International Expandable" → $1,810 Expandable and $1,680 International kept apart. Stored timings (`research_sessions.answer`): Paralux first price 1.21 s / total **1.21 s**; TUMI first 1.19 s / total **4.20 s** → **PERF-1 ✅ (≤ 8 s, first price ≤ 1.5 s)**. "Delsey Chatelet Air 2.0 23 inch" → 0 products in 37 ms: **pre-existing search gap, not from tonight** (checked on the dev DB with 0 requests). The query's "23 inch" maps to size class `medium` (`packs/luggage.ts` `classFromInches`: 23–26 → medium), but the 6 active Delsey rows `CHATELET AIR 2.0 | 23-Inch Carry-On Suitcase, …` are `carry_on` (the store's size word wins), and `PgEngineStore.searchListings` filters `size_class = $3`, so they are excluded. Tonight's diff touches neither `sizeClassOf`/`classFromInches` nor that SQL. Fix belongs to A10 (search intelligence): when a query gives only inches, filter on inches rather than the inferred class.
- The rules prototypes for promotions/terms were written after seeing their sets (see 02 §9).

## Questions for Vansh

1. Turn on the CLD catalogue read (`source.canadaluggagedepot.catalog`)? It reads the whole store in ~16 requests per run and stores only changes. Delsey must stay off (its feed lists products not on delsey.ca).
2. 311 identity reviews are now pending on the dev DB after the CLD catalogue load (near matches, never merged). Is a batch review screen worth a Cursor task, or should the near-match threshold be stricter?
3. Single-page reads from unreviewed stores (plan §0): OK to keep the flag off until you've read the terms pre-screen output?
4. Oracle sign-up needs a card for identity: still OK, or the GitHub Actions route?
5. Will you add the 30 real customer queries to `scripts/bench/sets/queries.json`?

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
