# MASTER PROMPT V3: Real Pricer, our own luggage search engine

**Start only when V2 is finished**: `docs/PROGRESS_V2.md` shows Q0–Q10 ✅ and `feat/client-ready` is committed. If V2 is not finished, stop and say so.

You are **Claude Code, the lead engineer ("brain")** for LuggageTracker / Real Pricer, built for Luggage Depot Inc. (Calgary).

- **Cursor is your worker ("hands").** You plan, design contracts, build the engine-critical parts yourself, write precise tasks for Cursor, review its work, and merge.
- **Coordination:** `planning/v3/AGENT_PROTOCOL.md` explains how you and Cursor coordinate. Read it before anything else after this file.

Read, in order:

1. this file;
2. `planning/v3/AGENT_PROTOCOL.md`;
3. `AGENTS.md`;
4. `MASTER_PROMPT_V2.md` (all V2 rules still apply);
5. `docs/PROGRESS_V2.md`, `docs/FINAL_REPORT_V2.md`, `docs/ARCHITECTURE.md`, `docs/CLIENT_REVIEW.md`.

Track progress in `docs/PROGRESS_V3.md`, using the same format as V2. **Resume from it if it exists.**

---

## 0. The goal in one paragraph

Turn the app into **our own luggage price search engine** that understands plain questions ("cheapest 24 inch hard spinner under $300", "Samsonite carry-on black"), finds the right bags across every store we are allowed to read, matches the same bag across stores without mixing sizes or models, writes a short honest answer on top, and suggests better or cheaper options. Everything runs on **our own code and our own index**. Outside services (Tavily, Gemini) become **optional plug-ins** that can be switched off without breaking anything.

## 1. Owner decisions (fixed)

| Topic | Decision |
|---|---|
| Budget | **$0.** No paid plans, no card-on-file services, nothing that can create a charge. |
| Rules | **Unchanged.** No anti-bot bypass, no fetching hosts the registry forbids, honest User-Agent, robots.txt respected. More coverage comes only from allowed channels. |
| Independence | Own engine first: our crawler, index, parser, matcher and answer builder. **Tavily and Gemini become optional providers behind interfaces**, and the product must work fully with both off. |
| AI model | Rules first. A model is used only when our parser is unsure. Provider order: local model (Ollama on the office PC, if configured) → Gemini free tier (if enabled) → none. Only search text and public product data are ever sent; never customer or account data. |
| Priorities | 1. understand plain questions; 2. better matching; 3. AI answer on top; 4. suggestions. Plus a better, wider, more reliable scraper. |
| Stores that matter | Amazon/Walmart/Costco, Samsonite/TUMI, luggage specialists, and brand DTC stores (all of them; see §5 for what is possible for each). |
| Tools | Claude Code = brain (engine, data, contracts, reviews, merges). Cursor = worker (UI and well-specified tasks). |

### The honest limit (put it in `docs/PROGRESS_V3.md` and the final report)

"Our own Tavily" can only crawl stores that allow it. Amazon, Walmart, Costco, Best Buy, Canadian Tire and London Drugs forbid automated access in their terms. Samsonite.ca and TUMI.ca actively block bots. Searching Google by scraping its result pages is also forbidden and blocked.

So for those stores our own engine provides only:

- (a) a link;
- (b) staff-checked prices;
- (c) dealer or affiliate feeds when obtained;
- (d) an *optional* third-party estimate provider, if the owner keeps one switched on.

Never pretend otherwise. Never work around it.

---

## 2. Workstreams, requirements and acceptance

IDs (S1.x …) go in commits, task files and progress.

### S1. Understand plain questions (own parser first)

- **S1.1** Build `src/lib/engine/query/` (extend `luggagePack.parseQuery`; don't fork it). It produces a typed `QueryIntent`:
  - brand, product line, model or style number, GTIN;
  - size class (carry-on / medium / large / extra-large), stated inches, cm, litres;
  - type (spinner, upright, duffel, backpack, garment bag, trunk, set);
  - shell (hard / soft / hybrid), material (aluminium, polycarbonate, polypropylene, nylon, ballistic, leather);
  - colour (normalised), features (expandable, TSA lock, USB port, front pocket, laptop sleeve);
  - price constraints (under, over, between, "cheapest", "best deal"), store filter ("at Amazon"), in-stock only, sort intent;
  - `confidence` per field, plus overall.
- **S1.2** Vocabulary comes from **our own index**:
  - a gazetteer of brands, lines and models auto-built from `catalog_products` / `listings`, refreshed after discovery;
  - a hand-kept synonym file (`query/synonyms.ts`), for example "carry on/cabin/hand luggage", "checked/check-in", "hardside/hard shell", "alu", "28in/28\"/71 cm".
- **S1.3** Typo tolerance:
  - Postgres `pg_trgm` similarity on gazetteer terms;
  - Damerau-Levenshtein ≤ 2 for words of 6+ letters;
  - "Did you mean …?" when the corrected query differs.
- **S1.4** **Model fallback** (`query/llm.ts`):
  - only when overall confidence < 0.6;
  - provider interface `IntentModel` with implementations `ollama` (env `OLLAMA_URL`, model `OLLAMA_MODEL`) and `gemini` (existing key), plus `none`;
  - the model must return JSON validated by zod against `QueryIntent`, with no free text;
  - values not in the gazetteer or allowed enums are dropped;
  - a timeout of 2 s, and the parser result wins on timeout;
  - cache by normalised query for 7 days;
  - flag `query.llm_fallback`, off by default until S6 evaluation shows it helps.
- **S1.5** Evaluation set `scripts/eval/queries.json`:
  - ≥ 150 real-world style queries with the expected intent;
  - include 30 written by the owner from real customer questions (HUMAN_ACTIONS: ask Vansh);
  - include typos, French words (valise, bagage cabine), inches and cm, price phrases, and model numbers.
- **Acceptance A-S1:**
  - field accuracy ≥ 95% on the eval set without the model;
  - "Sky Max 3.0" is never read as a price;
  - parser p95 < 15 ms.

### S2. Better matching (same bag across stores, never mixing)

- **S2.1** Attribute extraction into `catalog_variants` from every source:
  - dimensions (cm and in), capacity (L), weight (kg), wheels, expandable;
  - colour (normalised) and colour code;
  - GTIN (normalise UPC-A ↔ EAN-13 ↔ GTIN-14, with check digits validated);
  - MPN or style number.
- **S2.2** Per-brand identifier rules (`identity/brands/*.ts`), with real examples taken from recorded fixtures (never invented):
  - Samsonite style-colour codes, TUMI model numbers, Travelpro, Delsey, Briggs & Riley SKUs, Heys, Monos, Away.
  - Rules must be data-driven and tested.
- **S2.3** Candidate generation (blocking) by brand + size class + type, then a **scored matcher** with explainable features:
  - GTIN equal (decisive), MPN equal, line equal, version equal, inches equal, capacity within 5%, dimensions within 2 cm, title token similarity, colour.
  - Thresholds: auto-merge ≥ 0.97; review queue 0.80–0.97; reject < 0.80.
  - Store each decision's features for audit.
  - Sizes never merge (V1 rule).
- **S2.4** Labelled pair set `scripts/eval/pairs.json`:
  - ≥ 300 pairs from the real index (same / different / variant-of-same);
  - include known traps: Nexis Large 28" vs 31", TUMI International vs International Expandable, Chatelet Air 2.0 vs 1.0.
- **Acceptance A-S2:**
  - auto-merge precision ≥ 99.5%;
  - recall reported (target ≥ 85%);
  - review-queue volume per discovery run reported;
  - zero size-mixing (DB check from V1 stays green).

### S3. Search, ranking and suggestions

- **S3.1** Retrieval:
  - Postgres full-text + `pg_trgm` over the catalogue (name, brand, line, attributes);
  - structured filters from `QueryIntent`;
  - facet counts (brand, size, type, price band, store, in stock).
  - No external search service.
- **S3.2** Ranking (documented, unit-tested):
  - intent match first (hard constraints must hold; soft ones add score);
  - then in-stock, then price (lowest first), then freshness.
  - Constraint failures never appear above full matches.
- **S3.3** **Autocomplete** endpoint `GET /api/search/suggest?q=`:
  - brands, lines, models and popular queries from our index;
  - p95 < 100 ms on the dev DB with the full index;
  - never sends keystrokes to third parties.
- **S3.4** **Suggestions** under results:
  - "Cheaper alternatives": same size class and type, capacity within ±15%, a lower verified price, with the saving shown;
  - "Other sizes in this line";
  - "Also available in colours";
  - "Did you mean".

  All are built from our own data only.
- **S3.5** Live verification stays: the session re-reads the top candidates live (existing engine). The index decides *what* to check; live reads decide *the price*.
- **Acceptance A-S3:**
  - on the eval set, the expected product is in the top 3 for ≥ 90% of queries that have a match in the index;
  - "cheapest 24 inch hard spinner under $300" returns only hard spinners in the 24–26" medium class under $300, cheapest first;
  - suggestions never include a product that fails a hard constraint.

### S4. AI answer on top (never invents)

- **S4.1** `research/summary.ts` builds a deterministic answer from the answer data. Examples:
  - "Cheapest: $434.95 at Canada Luggage Depot (verified 9:02 a.m.). Amazon.ca shows $434.95 (web estimate). Out of stock at 1 store."
  - The answer also covers the price spread, how many stores, the freshness of the cheapest price, and a note when the cheapest is an estimate.
- **S4.2** Optional rewording by a model (flag `answer.llm_wording`, off by default). A **number guard** applies:
  - every number, price, store name and time in the model's text must appear in the input data;
  - otherwise the template text is used;
  - this is unit-tested with adversarial cases.
- **Acceptance A-S4:**
  - 100% of numbers in shown answers are traceable to offers (automated check over the eval run);
  - the answer renders within 100 ms of the final result.

### S5. Our own scraper: wider, fresher, more reliable

- **S5.1 Store discovery programme** (more stores, legally):
  1. Build `docs/STORE_CANDIDATES.md`: Canadian stores selling luggage, from the owner's and staff's knowledge, brand "where to buy" pages (only fetch pages whose robots.txt allows it) and the existing audit.
  2. For each candidate, run the existing probe (`npm run probe:sources`) and record platform, robots, terms URL, sitemaps, agents.md/UCP, structured data and block status.
  3. Each candidate needs a human terms read before activation (HUMAN_ACTIONS checklist per store). Only stores marked permitted get `fetchHosts`.
  4. Onboarding checklist per store:
     - registry entry;
     - recorded fixtures through the PoliteFetcher;
     - adapter tests;
     - a discovery run;
     - 10 spot-checked prices against the live page.
  - Target: **+10 permitted stores**. Report the real number, whatever it is.
- **S5.2 Platform adapters:**
  - **WooCommerce Store API** (`/wp-json/wc/store/v1/products`, public, read-only);
  - generic **Shopify** (`/products/<handle>.json` exists; add a paginated `/products.json` catalogue read where permitted);
  - **BigCommerce/Magento** structured data via the existing `html_structured`;
  - **platform auto-detection** in the probe.

  Each adapter must have recorded real fixtures and tests (block, 404, garbage).
- **S5.3 Freshness scheduler:**
  - priority queue: email products and tracked products daily; products searched in the last 7 days every 2 days; everything else weekly;
  - learn each listing's change rate and check more often when it changes often;
  - conditional GET (ETag / If-Modified-Since) where the server supports it;
  - per-host politeness unchanged.
- **S5.4 Reliability:**
  - daily **canary checks**: 3 known products per store, with expected fields;
  - **schema-drift detection**: extraction suddenly empty or price missing on > 30% of pages → circuit opens, Store status says "Couldn't read Delsey.ca since 9:00, we're looking into it", and an email to the owner;
  - retries with backoff; dead-letter queue in pg-boss.
- **S5.5 Data quality:**
  - a ±50% price change against the last verified price is held for one re-read before it is shown or alerted;
  - the sale price uses `compare_at` (show "was $X") only when the store states it;
  - every observation is CAD;
  - prices per variant.
- **S5.6 Optional providers stay optional:**
  - Tavily estimates and Gemini sit behind `EstimateProvider` / `IntentModel` interfaces with flags;
  - a test runs the whole search suite with **all third-party providers off** and must pass;
  - Store status shows which helpers are on, in plain words.
- **S5.7 Staff quick price check:**
  - a mobile-first page (`/quick-check`) for staff to record a competitor price they saw (in a store, flyer or website);
  - fields: product (autocomplete), store, price, date, optional photo note;
  - shown as "Staff-checked · Oct 9".

  This is the legitimate way to cover Costco and others.
- **S5.8 Worker in production:**
  - with the owner, finish the hosting choice (office PC + Cloudflare Tunnel, or an Oracle Always Free VM);
  - discovery, freshness and canaries run on the worker, not on Vercel;
  - document the setup in `docs/DEPLOY.md`.
- **Targets A-S5:**
  - first verified price p50 < 1 s; complete p95 < 6 s;
  - ≥ 95% of each permitted store's luggage products indexed;
  - tracked and email products re-read ≤ 24 h;
  - 0 fetches to forbidden hosts (test with a fetch spy over a full discovery run);
  - canaries green on all active stores.

### S6. Evaluation harness (proof, not claims)

- `npm run eval` runs, and writes `docs/EVAL_REPORT.md` with numbers and dates:
  - query parsing (S1.5);
  - matching pairs (S2.4);
  - retrieval top-3 (S3);
  - answer number guard (S4);
  - price accuracy audit: 50 random verified prices re-read live and compared.
- No feature in S1–S5 is "done" without its eval numbers.

### S7. UI (mostly Cursor; you write the specs)

- The search bar has autocomplete (S3.3), keyboard navigation, recent searches (existing) and "Did you mean".
- **Filter chips** come from facets: size, type, brand, price, colour, store, in stock. Chips are removable, and the URL reflects the state (shareable).
- An **answer card** sits on top (S4), and the suggestions sections sit below results (S3.4).
- The `/quick-check` page (S5.7) is mobile-first.
- The plain-English **Store status** additions:
  - stores added, canary state, helpers on/off;
  - evaluation numbers in one table, without charts (the client rejected graphs).
- All V2 UI rules apply: no graphs, labels with time, 375 px, accessibility, plain English.

---

## 3. Phases

| Phase | Owner | Work | Done when |
|---|---|---|---|
| V3-0 Setup | Claude | Create `docs/PROGRESS_V3.md`; set up the agent protocol (copy `planning/v3/cursor-rules/*.mdc` → `.cursor/rules/`, create `docs/agents/`); create the worktree and branches (protocol §3); run all V2 gates | Gates green; Cursor smoke task T-000 done and reviewed |
| V3-1 Contracts | Claude | `src/lib/contracts/search.ts` (QueryIntent, facets, suggestion, answer types), API shapes for `/api/search/suggest` and extended research results; contract tests | Types compile; Cursor can build UI against them |
| V3-2 Eval first | Claude | S6 harness + query and pair sets (owner's 30 queries requested) | `npm run eval` produces a baseline report |
| V3-3 Parser | Claude | S1.1–S1.3, S1.5 | A-S1 without the model |
| V3-4 Matching | Claude | S2 | A-S2 |
| V3-5 Retrieval + suggestions | Claude (engine) + Cursor (UI T-tasks) | S3, S7 search UI | A-S3; UI reviewed |
| V3-6 Answer | Claude (engine) + Cursor (card) | S4 | A-S4 |
| V3-7 Scraper | Claude | S5.2–S5.6, S5.8 | A-S5 |
| V3-8 Stores | Claude + owner | S5.1 onboarding per permitted store | Each store's checklist complete |
| V3-9 Quick check + status UI | Cursor (spec by Claude) | S5.7, S7 status | Reviewed; tests |
| V3-10 Model fallback | Claude | S1.4, S4.2 behind flags; enable only if eval improves | Eval shows a gain, or the flags stay off with the reason |
| V3-11 Verify + docs | Claude | Full eval; real searches for 20 queries; update README, ARCHITECTURE, RUNBOOK, HUMAN_ACTIONS, DEPLOY; write `docs/FINAL_REPORT_V3.md` | All acceptance met, or the gaps are documented honestly |

Each phase follows the same loop: inspect → test first → build or delegate → review → gates → commit → progress.

## 4. Quality gates (every phase)

- All V2 gates.
- `npm run eval`: no metric drops more than 1 point versus the last report without an explanation.
- Every Cursor change is reviewed by you (protocol §5) before merge.

## 5. What each priority store gets (be exact in docs and UI)

| Store group | Best legal route | Our engine's role |
|---|---|---|
| Luggage specialists (Canada Luggage Depot, Luggage City, Bentley, U.N. Luggage, JP Grimard, new candidates) | Product JSON / UCP / structured data where terms allow | **Verified live**. The main coverage growth area (S5.1) |
| Brand DTC (Travelpro, Briggs & Riley, Heys, Monos, Away, Delsey) | Shopify UCP (needs the published agent profile + legal read) or product JSON | **Verified live** once enabled |
| Samsonite.ca, TUMI.ca | Dealer price list from the Samsonite rep (feed import) | "Dealer list · as of …"; never crawled (they block bots) |
| Amazon.ca | Creators API, only if the business ever qualifies (10 sales / 30 days); otherwise the optional estimate provider or staff checks | Link + estimate (if enabled) + staff checks |
| Walmart, Costco, Best Buy, Canadian Tire, London Drugs | Terms forbid automated access; affiliate feeds unconfirmed | Link + estimate (if enabled) + staff checks (`/quick-check`) |

## 6. Finish

Write `docs/FINAL_REPORT_V3.md` covering:

- what changed per ID;
- eval numbers before → after;
- stores added;
- what is still impossible at $0, and why;
- human actions, in order.

Give a 10-line summary. Do not merge to `main` or push unless the owner asks.
