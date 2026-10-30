# 01 Codebase map (v4 pre-build review)

Read 2026-10-30 on branch `feat/own-engine` (= `feat/client-ready` @ `fd13f4d`). Every claim cites `path:line`. Numbers come from the dev DB (`lt-dev-db`, Postgres 17) via `scripts/bench/db-gaps.sql` unless stated.

## 1. What exists, and what v4 can reuse

| Module | What it does | Reuse for v4 | Evidence |
|---|---|---|---|
| Domain types | Sources, routes, listings, raw offers, observations, freshness labels; the invariant "a price reaches a user only as a validated observation with a freshness label" | Extend: `AdapterId` (add a catalogue adapter id), `discoveredVia` (add `catalog`), attribute + promotion types | `src/lib/engine/types.ts:8-11` (invariant), `:15-22` (AdapterId), `:218` (discoveredVia), `:242-275` (RawOffer) |
| Registry + policy | 24 stores; permission → which adapters are allowed; route flags; link-only URLs | Bulk catalogue reads = a storefront adapter, so `permissionAllows` already gates them: only `sanctioned`/`allowed` (CLD, Delsey) or `unclear` + a per-store flag (U.N., Bentley) | `src/lib/engine/registry/index.ts:69-91`, `:130-163`; seed `src/lib/engine/registry/seed.ts` (CLD `sanctioned` l.72, Delsey `allowed` l.115) |
| PoliteFetcher | SSRF → visit window → circuit → robots (RFC 9309, cached) → per-host limiter → honest UA → classify → record every attempt | The only network path for crawls, catalogue pages and single-page reads. Catalogue pages need `maxBytes` ≥ 10 MB (default 3 MB; CLD pages are 1.8–2.1 MB) | `src/lib/engine/politeness/fetcher.ts:140-221`, `:283`; robots `src/lib/engine/politeness/robots.ts:29-108` |
| Adapters | `shopify_product_json` (`.json` + `.js`), `shopify_ucp`, `html_structured`, eBay, Amazon (flag), feed, manual | The bulk adapter reuses the Shopify variant mapping (`offersFromShopify` takes a `ShopifyProduct`) | `src/lib/engine/adapters/shopify-product-json.ts:37-76`; `src/lib/engine/extract/shopify.ts:64-88` |
| Structured-data extraction | JSON-LD/microdata/meta + displayed price | Attribute rules can read JSON-LD `additionalProperty`, `weight`, `depth/width/height` here first | `src/lib/engine/extract/structured.ts` (334 lines) |
| Validation | Confidence; CAD only; own domain; band 15–6,000; history ±; displayed-vs-data; never changes a price | Bulk prices go through the same `validateOffer`; no currency field → the existing "implied by the Canadian storefront" path (−0.1) | `src/lib/engine/validate/index.ts:57-153`, `:83-85` |
| Observe | Upserts the listing, validates, **inserts one observation per reading**, resolves identity | Must change for bulk reads: store on change (see §3 gap G5) | `src/lib/engine/observe.ts:43-88` |
| Identity | GTIN → model (same size) → brand+line+size(+inches) key → near match (Jaccard ≥ 0.6) to review | Matching v2 builds on it; the review queue is the grey zone for the AI judge | `src/lib/engine/identity/resolve.ts:28-37` (key), `:123-157`, `:160-199` |
| Luggage pack | Brands, size classes, inches, colours, line words, model numbers, query parser | The rules baseline for bench tasks (a)(b)(d); gazetteer gaps measured in 02 | `src/lib/engine/packs/luggage.ts:52-99` (brands), `:188-229` (size), `:250-279` (models), `:283-348` (FILLER), `:438-469` (parseQuery) |
| Discovery | Sitemaps → listings; enrich ≤ 150 product pages per store per run (new first, then stalest without identifiers); UCP search; optional Tavily URLs | Bulk catalogue replaces per-page enrichment for Shopify stores; sitemaps stay for language/deactivation; enrichment shrinks to GTIN backfill | `src/lib/engine/discovery/index.ts:188-389`; budget `src/lib/engine/config.ts:86-89` |
| Research session | Plan → parallel store tasks → stream offers → deadline → grouped answer | Unchanged hot path; AI never on it (decision D1) | `src/lib/engine/research/session.ts:248-251`, `:670-690`; deadline default 8 s `src/lib/engine/config.ts:69` |
| Estimates (Tavily) | Snippet-only web estimates with a strict validator and budget | Stays optional; untouched tonight ($0 rule) | `src/lib/engine/estimates/*` |
| Store port | `EngineStore` with Postgres and memory twins, one contract test | New methods (catalogue upsert, attribute/promotion writes, AI cache) need both twins + contract tests | `src/lib/engine/store/port.ts:163-267`; `tests/engine/store.test.ts` |
| Worker + queue | pg-boss (or memory) with a fixed job-name list; `send` supports `singletonKey`, `priority`, `retryLimit`, `expireInSeconds`; `work` uses `batchSize 1` | `ai.small` / `ai.large` = two more job names + handlers; priority and singleton keys already exist | `worker/src/queue.ts:10-15`, `:65-87`; `worker/src/jobs.ts:42-109`; `worker/src/main.ts:26-102` |
| Flags | Known keys only; conservative defaults | New `ai.*` flags (all off by default) | `src/lib/engine/flags.ts` |
| Migrations | 000–006, additive and idempotent, tested twice by `npm run test:db` | v4 adds `007_*` (attributes, promotions, AI cache, event storage) the same way | `supabase/migrations/004_price_engine.sql:89-169` (catalogue, listings), `:234-262` (observations), `:265-278` (append-only), `:301-336` (range collapse) |
| Probe | Read-only probe of every store (robots, UCP, product JSON, structured data) with `--selftest` | Discovery v2's candidate probe reuses it | `scripts/probe/main.ts`, `scripts/probe/selftest.ts` |
| Fixtures | Real recordings through the PoliteFetcher; reduced HTML | Same rule for catalogue pages (tonight: `scripts/bench/fixtures/`) | `scripts/fixtures/record.ts:1-13` |

## 2. What the plan assumes that the code (or a measurement) contradicts

| # | Plan says | Reality | Evidence |
|---|---|---|---|
| C1 | A3 bulk catalogue adapters "fix the 201/3,267 depth problem" (identifiers) | `/products.json` carries **no `barcode`**, no `price_currency`, no inventory. It fixes SKU/model depth, not GTIN depth; barcodes still need per-product reads | our run 2026-10-30 (`scripts/bench/record-catalog.ts`: 1,169 variants, barcode 0) |
| C2 | The research doc §3.1: bulk gives "price, compare-at price, SKU, **barcode**, options, availability" | Same as C1 | same |
| C3 | "201 of 3,267 CLD listings have identifiers" | Today: **98 of 3,103** active CLD product pages have any identifier (3.2%), **82** a GTIN (2.6%); only the first `model` identifier is copied onto a page row | `db-gaps.sql` §1–2; `src/lib/engine/discovery/index.ts:375-384` (`.slice(0, 1)`) |
| C4 | Laptop "Ollama 0.40.13, no models"; "C: 9 GB, D: 6 GB" | `llama3.2:3b` was installed; tonight C: 15.46 GB, D: 16.64 GB free before pulls (12.4 GB after two) | PROGRESS_V4 "Ollama fix" |
| C5 | §3/§5: query parse "≤ 2 s on the cloud model" (Oracle A1, 2 OCPU, CPU) | Laptop GPU measurements (02) are ~1 s per short JSON answer; a 2-core Arm CPU is far slower (no A1 measurement possible tonight: **UNVERIFIED**, estimate in 02 §5). A ≤ 2 s AI parse on the A1 is not realistic for a 3–4 B model | `planning/v4/review/02_MEASUREMENTS.md` |
| C6 | §3 storage split keeps Supabase < 500 MB | True only if observations are **event-based**. Today every reading inserts a row (~940 B incl. indexes); bulk reads of CLD + Delsey every 6 h would add ~25 MB/day | `src/lib/engine/observe.ts:68-88`; `db-gaps.sql` §9 |
| C7 | ARCHITECTURE: research deadline 11 s | Code default is 8 s (`ENGINE_SESSION_DEADLINE_MS`, 3–12 s); `research_sessions.deadline_ms` default 11000 | `src/lib/engine/config.ts:69`; `supabase/migrations/004_price_engine.sql:187`; `docs/ARCHITECTURE.md:44` |
| C8 | §2 "eval plan (V3 S6)" is reusable | No eval harness exists yet (`scripts/eval/` absent) | repo tree |
| C9 | §4.4 identity hard rules "sizes never merge" are enough | A real wrong merge: "Tumi Ventra **Large** Expandable Carry-On" and "Tumi Ventra Expandable Carry-On" both get key `tumi|expandable ventra|carry_on` because `large` is filler and the store's own size word is "Carry-On" | `src/lib/engine/packs/luggage.ts:323` (FILLER `large`), `:211-212`; bench rules run (02 §3) |
| C10 | Line words come out right from `lineOf` | "global" (Briggs & Riley **Baseline Global** vs Domestic), "carry" (Delsey **Carefree Carry**) and "cabin" are filler, so real line words are dropped | `src/lib/engine/packs/luggage.ts:316`, `:319`, `:345` |
| C11 | robots.txt "RFC 9309" | Group selection uses `token.includes(agent)`: a robots group named by any substring of our token is chosen | `src/lib/engine/politeness/robots.ts:70` |
| C12 | Fresh prices ("hours") | Nothing has refreshed the index since 2026-10-26 (no hosted worker): Delsey's stored prices differed on 47/47 variants from today's catalogue | `db-gaps.sql` §7; `scripts/bench/bulk-vs-observed.ts` |

## 3. Current gaps, measured (dev DB, 2026-10-30)

| Gap | Number | Query |
|---|---|---|
| G1 Catalogue depth | CLD 3,103 active product pages (+193 variant rows); the store has **3,229** products (bulk count). Delsey 418 pages | db-gaps §1; bulk pages |
| G2 Identifiers | CLD pages with any identifier 98 (3.2%), with a GTIN 82 (2.6%); Delsey 125 (29.9%) / 65 (15.6%). `catalog_identifiers`: gtin 296, mpn 110, model 66, store_sku 312 | db-gaps §1–3 |
| G3 Attributes | **0** of 179 products and 0 of 338 variants have any `attributes` (the jsonb columns exist, unused) | db-gaps §3; `004_price_engine.sql:96`, `:115` |
| G4 Size class / brand on CLD pages | size class 1,928/3,103 (62%), brand 1,598/3,103 (51%), colour 744 (24%). By class: 596 luggage, 901 bags, 431 accessories, 1,175 unknown | db-gaps §4 + class breakdown |
| G5 Observation storage | 645 observations (630 shown, 15 rejected) over 4 days with data; ~940 B per row incl. indexes; **every reading is a row** | db-gaps §5, §7, §9 |
| G6 Promotions | No promotions table. 310 of 630 shown readings (49%) carry a list (compare-at) price, on 202 listings | db-gaps §6 |
| G7 DB size | **27 MB** total; `listings` 14 MB (7,206 rows, ~2.0 KB/row with its GIN index); observations 0.6 MB; fetch_attempts 0.3 MB | db-gaps §8–9 |
| G8 Freshness | Last observation 2026-10-26 15:10 UTC; 4 days with any readings since 2026-10-08 | db-gaps §5, §7 |
| G9 Review queue | 13 pending identity reviews | db-gaps §10 |
| G10 Live coverage | Verified live: CLD and Delsey only; other Shopify stores wait on the UCP profile or a human terms read | `docs/PROBE_REPORT.md`; registry |

## 4. Where v4 work lands (no rewrites)

| v4 part | New code | Extended code |
|---|---|---|
| AI layer | `src/lib/engine/ai/{ollama,schema,guard,evidence,cache,lanes,rules-fallback}.ts` | `config.ts` (OLLAMA_*), `flags.ts` (`ai.*`), `worker/src/queue.ts` (+`ai.small`, `ai.large`), `worker/src/jobs.ts`, migration 007 (`ai_cache`) |
| Eval | `scripts/eval/*`, `npm run eval` → `docs/EVAL_REPORT.md` | sets from `scripts/bench/sets/` |
| Bulk catalogue | `src/lib/engine/adapters/shopify-catalog.ts`, catalogue parser in `extract/shopify.ts` | `discovery/index.ts` (catalogue path before sitemap enrichment), `observe.ts` (store on change), types (`discoveredVia: catalog`), migration 007 (CHECK constraint) |
| Extraction v2 | `extract/attributes.ts`, `extract/promotions.ts` | `catalog_variants.attributes` (exists), new `promotions` table |
| Matching v2 | `identity/judge.ts` (grey zone only) | `packs/luggage.ts` (Large Carry-On, Global, Carry fixes), `identity/resolve.ts` |
| Discovery v2 | `discovery/candidates.ts`, terms pre-screen job | registry (`discovery_state`), probe |
| API v1 | `src/app/api/v1/*`, `docs/openapi-v1.yaml` | store port reads |
| Deploy kit | `deploy/oracle/*`, `docs/DEPLOY_ORACLE.md` | `worker/Dockerfile` |
