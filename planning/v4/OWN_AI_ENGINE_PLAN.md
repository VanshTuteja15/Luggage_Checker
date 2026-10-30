# Our own AI discovery and price-intelligence engine: plan (v4)

Prepared 2026-10-30. Status: **plan only; nothing built, no paid commitments.**
Builds on [`PRICE_DATA_PLATFORM_RESEARCH.md`](./PRICE_DATA_PLATFORM_RESEARCH.md) (research, legal notes, sources).

## 0. Owner decisions this plan follows

| Topic | Decision |
|---|---|
| Budget | **$0.** Open source, local AI (Ollama), free tiers, our own infrastructure. Nothing paid without explicit approval. |
| Independence | Our own discovery, crawling, indexing and AI. **Tavily/Exa are optional fallbacks only**; the system must work fully with them off. |
| AI | **Ollama** on the laptop (for development and heavy batch work when it's on) and on the cloud VM (small model, always on). |
| Hosting | **Oracle Cloud Always Free VM**, staying on the free-only account (no Pay-As-You-Go upgrade). We accept the idle-reclamation risk and design around it (§7). The laptop doesn't need to be on. **Note:** Oracle asks for a card at sign-up for identity verification even for Free Tier. Always Free use isn't charged. See §9 for the no-card alternative. |
| New stores | The AI may read **one product page per search** from a newly found store **if robots.txt allows our user agent** and the store isn't on our blocked/forbidden list. The store then goes into a review queue for regular crawling. |
| Data use | Internal first (our app, email and tools). Selling data externally needs a legal/licence review later. |
| Integrity | Genuine data only. Every value has a source URL, method, timestamp and evidence. Never bypass blocks. Never fabricate. |

## 1. Facts that shape the design (checked 2026-10-30)

- **Laptop** (owner's output, 2026-10-30): HP Victus 15-fb0xxx.
  - **CPU:** Ryzen 5 5600H (6 cores / 12 threads).
  - **RAM:** **7 GB usable**.
  - **GPUs:** **AMD Radeon RX 6500M** (discrete, 4 GB VRAM per AMD's spec, unverified on this unit) + Radeon integrated graphics.
  - **Free disk:** **C: 9 GB, D: 6 GB**. *[corrected 2026-10-30 00:47, measured: C: 15.5 GB, D: 16.6 GB free; 12.4 GB on D: after pulling `qwen3:4b-q4_K_M` and `qwen2.5:3b`.]*
  - **Ollama:** 0.40.13, no models yet. *[corrected 2026-10-30: `llama3.2:3b` installed in `D:\ollama\models`; the server reads `OLLAMA_MODELS` from the user environment.]*
  - **Consequences:**
    - (a) Only small models (≈ 1–4 B, Q4, ≤ ~3 GB) fit, and only with other apps closed. 7–8 B models are out.
    - (b) The RX 6500M isn't on Ollama's Windows ROCm list. The **Vulkan backend may use it** (to test with `ollama ps`); if it works, a 3–4 B model fits in its VRAM and runs much faster than on the CPU.
    - (c) **Disk space is the first blocker.** Free ≥ 20 GB on C before pulling models.
    - (d) The **Oracle VM (12 GB RAM) is stronger than the laptop for AI**, so it hosts the main model. The laptop is for development and optional GPU batch jobs.
- **First Ollama benchmark** (owner, 2026-10-30, `llama3.2:3b`, 2.0 GB):
  - **95% GPU / 5% CPU**, so the **RX 6500M works through Vulkan**.
  - Generation **45 tokens/s**, prompt **50 tokens/s**.
  - Cold load **11.8 s** (keep the model resident with `keep_alive` for batch work).
  - Output quality: it returned `line: "Paralux Hardside Spinner"` (should be `Paralux`). Small models need JSON-schema output, a few examples, and validation against our brand/line gazetteer. Free-form answers aren't trusted.
- **Oracle Always Free (since June 15, 2026):** *[checked 2026-10-30: Oracle's docs confirm 2 OCPU / 12 GB (1,500 OCPU-h + 9,000 GB-h a month) but give no date; secondary sources say June 15 or Aug 18, 2026, so the date is UNVERIFIED.]*
  - Ampere A1 **2 OCPU / 12 GB RAM** (Arm; was 4/24), two AMD micro VMs (1 GB each), 200 GB block storage.
  - **Idle reclamation:** an instance is reclaimed only if, over 7 days, *all* of these hold: CPU p95 < 20%, network < 20%, memory < 20% (A1).
- **Supabase Free:** 500 MB database, 5 GB egress, pauses after 1 week of inactivity, 2 active projects.
- **Ollama structured outputs:** a JSON schema in `format` constrains the model output. Use temperature 0 and a zod schema.
- **Common Crawl:** a free URL index (CDX API, "don't overload") plus a columnar index for bulk filtering. Terms: limited licence, follow the original sites' rights, legal advice recommended for commercial use.
- **Free LLM APIs** (Gemini free tier, Groq free) are now small and changeable (for example, Groq lists ~1K requests and ~200K tokens per day per model). They're optional extras, not foundations.

**What "our own search engine" can realistically be at $0:** a **vertical index** of luggage retailers and brands that allow reading (estimated tens to a few hundred Canadian domains; to be measured), kept fresh by our crawler, plus live verification at search time.

- A general index of the whole internet (what ChatGPT and Claude rent from search providers) is out of reach at $0.
- The big chains that forbid or block us stay at estimates, staff checks, feeds or links.

## 2. What we reuse (no rewrites)

- Registry and permissions (`fetchHosts`).
- PoliteFetcher: robots RFC 9309, crawl delays, per-host limiter, SSRF guard, block classifier, circuit breaker, honest UA.
- Adapters: Shopify JSON/UCP, structured data, eBay, Amazon (flag), feeds, manual.
- Validator with confidence; identity resolver + review queue.
- Discovery (sitemaps), research sessions (streaming, 8 s deadline), web estimates (optional), digest/email, scheduler tick.
- pg-boss worker (Node 22, Docker), Store status, eval plan (V3 S6).

## 3. Target architecture

```
                        ┌──────────── Oracle A1 VM (2 OCPU / 12 GB, always on) ─────────────┐
 Supabase (app, auth,   │  worker (pg-boss)  ── crawler (PoliteFetcher + catalogue adapters) │
 email, current offers) │        │                └─ Playwright tier (permitted JS stores)   │
        ▲               │        ├─ discovery jobs (stores, sitemaps, Common Crawl, brands)  │
        │ sync current  │        ├─ extraction (structured → rules → AI attributes)          │
        │ offers        │        ├─ matching (rules → AI judge for grey zone)                │
        │               │        ├─ Ollama (small model, CPU)  ← "ai.small" jobs             │
        │               │        └─ Postgres "index" DB (catalogue, listings, observations)  │
        │               └────────────────────────────────────────────────────────────────────┘
 Next.js app (Vercel or VM) ── /api/v1 (our price data API) ── research session (8 s)
                                                                     │
 Laptop (when on): ai-worker pulls "ai.large" jobs from the queue ── Ollama (bigger model)
```

- **Two AI job lanes.**
  - `ai.small`: always-on cloud. Query parsing, page classification, short attribute fills.
  - `ai.large`: the laptop when it's online. Backfill attribute extraction, match judging, terms pre-screening, eval runs.
  - The laptop connects **outbound** to the queue (no tunnel, no open port).
  - When it's off, `ai.large` jobs wait, or fall back to `ai.small`/rules with lower priority.
- **Interactive search never waits on the laptop.** The hot path is rules + index + live verify (≤ 8 s). The AI is only used for a ≤ 2 s query parse on the cloud model, or after the answer (async improvements show next time). *[corrected 2026-10-30: a ≤ 2 s parse is not achievable for a 3–4 B model on 2 Arm CPU cores (the laptop GPU already needs 1–2.4 s per parse); the hot path stays rules-only and any AI parse runs after the answer. See `review/02_MEASUREMENTS.md` §5, `review/04_DECISIONS.md` D1.]*
- **Storage split** (proposal; needs your OK):
  - The **index DB on the VM** (Postgres on the 200 GB disk) holds the crawl frontier, all listings and observation history.
  - **Supabase** keeps auth, app data, email, and *current* offers for tracked and email products.
  - This keeps Supabase under 500 MB.
  - Nightly backup of the index DB to Oracle Object Storage (free tier, size to verify) and a weekly dump download.

## 4. Pipeline: discovery → crawl → extract → match → verify → serve

### 4.1 Retailer discovery (our own, AI-assisted)

**Sources** (all free, all polite):

- (a) brand "where to buy" / dealer locator pages (fetched only if robots allows);
- (b) links and mentions on stores we already index;
- (c) Common Crawl CDX lookups for candidate domains (low volume; monthly);
- (d) the optional web-search fallback when it's turned on;
- (e) manual adds (you and staff).

**Each candidate goes through:**

1. Probe: platform detection, robots for our UA, sitemaps, agents.md/UCP, terms URL.
2. **AI terms pre-screen:** Ollama summarises any clauses about automated access, quoting the exact sentences.
3. A registry state:
   - `discovered`
   - `single_page_ok` (robots allows; no forbidding clause found by the pre-screen)
   - `approved_crawl` (after your review in Store status)
   - `forbidden` / `blocked`

### 4.2 Crawl (our own index)

- `approved_crawl` stores get:
  - bulk catalogue reads where the platform offers them (Shopify `/products.json`, WooCommerce Store API, UCP);
  - otherwise sitemaps + product pages.
- `single_page_ok` stores: only on-demand single-page reads during searches (decision §0).
- Freshness tiers:

  | What | How often |
  |---|---|
  | Email/tracked items | every 4–6 h |
  | Bulk-API catalogues | every 6–12 h |
  | Others | daily, with change-rate learning |

  Conditional GET (ETag/Last-Modified) where supported.
- A Playwright tier only for `approved_crawl` stores that need JS (Arm64 Chromium on the VM).

### 4.3 Extraction (evidence-first)

1. **Price:** only from platform APIs, JSON-LD/microdata/meta, cross-checked against the displayed price. The AI may **locate** a price on pages without structured data, but the value is accepted only if:
   - the exact price string appears in the page text next to the product title;
   - it matches the currency;
   - it passes the plausibility band;
   - otherwise it's rejected with a reason.
2. **Attributes** (size, dimensions, capacity, weight, material, wheels, expandable, warranty):
   - structured data → spec-table rules → **Ollama JSON-schema extraction**;
   - every value must appear in the source text (verbatim or by unit conversion), with provenance and confidence.
3. **Promotions:** strikethrough/compare-at, `priceValidUntil`, member price, promo text ("20% off", "ends Sunday"), stored as `promotions` with evidence.

### 4.4 Matching

Rules first (GTIN → MPN/style → brand + line + size + inches + version). The **AI judge** (Ollama) is used only for the grey zone (0.80–0.97 score) and returns `same | different | variant` with the reasons and features it used.

- Hard rules always win: sizes never merge, and versions must agree.
- Low-confidence results go to the existing review queue.

### 4.5 Verify and serve

- Research session (existing, ≤ 8 s): index search → live verify the top candidates at permitted stores → single-page reads for `single_page_ok` stores the index suggests → estimates (optional) → answer.
- Every price is shown with its label, time and source link.
- **Price Data API v1** (`/api/v1/*`, internal, OpenAPI) serves search, products, offers, history, promotions, stores, changes and verify, as in the research doc §5.3.

## 5. AI model plan (to be benchmarked; numbers below are estimates)

| Lane | Machine | Candidate models (Ollama library) | Expected speed | Used for |
|---|---|---|---|---|
| `ai.small` | Oracle A1, 2 Arm cores, CPU | ~3–4 B Q4 (e.g. `qwen3:4b`, `llama3.2:3b`, `gemma3:4b`) *[corrected 2026-10-30: `gemma3:4b` is 3.3 GB, over the 3 GB limit]* | a few tokens/s (estimate) | Query parse (≤ 2 s, else rules), page type, short fills *[corrected: not on the hot path, see above]* |
| `ai.large` | Laptop: RX 6500M via Vulkan if it works, else CPU; 7 GB RAM | ~3–4 B Q4 only (e.g. `llama3.2:3b`, `qwen3:4b`) | to be measured | Optional batch jobs (attribute backfill, match judge, eval) when the laptop is on |

- Choose models by **measured** results on our own eval sets: query intent, 300 match pairs, an attribute set, a promo set. Pick the smallest model that meets the targets.
- **Always** use JSON-schema structured output, temperature 0, short prompts, and caching by input hash.
- Model weights stay local. Product text and our prompts never leave our machines.
- Optional free API LLMs (Gemini/Groq) sit behind the same interface, off by default.

## 6. Quality targets (eval-gated)

| What | Target |
|---|---|
| Price accuracy vs live page | ≥ 99.5% |
| Wrong-product offers | 0 |
| Attribute accuracy | ≥ 95% |
| Promo precision | ≥ 95% |
| Match auto-merge precision | ≥ 99.5% |
| Catalogue coverage per approved store | ≥ 95% |
| Search total time | ≤ 8 s (first price ≤ 1.5 s) |

`npm run eval` writes `docs/EVAL_REPORT.md`. Nothing counts as "done" without its numbers.

## 7. Risks and how we handle them

| Risk | Handling |
|---|---|
| Oracle reclaims the VM (no card, accepted) | Real load keeps it non-idle: a resident model uses > 20% of memory, and scheduled crawls run all day. Nightly backups. Infrastructure as a script (`deploy/oracle/setup.sh`) so a rebuild takes < 1 h. Supabase + Vercel cron keep the email working if the VM is lost. |
| Free tiers change (Oracle already halved A1 in 2026) | Everything runs in Docker and is portable (VM ↔ laptop ↔ any Linux box) |
| CPU-only AI is slow | AI off the interactive hot path; batch lanes; smallest model that passes eval |
| Supabase 500 MB limit | Index DB on the VM; Supabase only for current offers + app data; size alert at 60% |
| Sites forbid or block us | Registry + robots enforced in code; single-page reads only where robots allows; a block is recorded and respected, never worked around |
| AI mistakes | Evidence check on every value; prices never from the AI alone; hard identity rules; review queue; eval gates |
| Legal (images, resale, Common Crawl, new-store reads) | Internal use only; link-out images for unknown stores; legal review before any external offering |

## 8. Phases (start after V2 Q8–Q10; each ends with a "Ready to commit" hand-off, and the owner commits)

| Phase | Work | Who |
|---|---|---|
| A0 | Benchmark: laptop specs, Ollama models, tokens/s on our prompts; same on a 2-OCPU Arm VM | You run the commands, Claude Code measures |
| A1 | Oracle VM: Docker, worker, Postgres index DB, Ollama small, Playwright, backups, `setup.sh` | You create the account; Claude Code writes the scripts |
| A2 | AI layer: `ai.small` / `ai.large` queues, Ollama client (zod → JSON schema), evidence checker, cache, laptop ai-worker | Claude Code |
| A3 | Bulk catalogue adapters + identifier backfill (fixes the 201/3,267 depth problem) *[corrected 2026-10-30: Shopify `/products.json` has no barcode and no currency field; the bulk read fixes SKU/model depth, GTINs still need a per-product backfill. Today: 98 of 3,103 CLD pages have any identifier]* | Claude Code |
| A4 | Extraction v2: attributes + promotions with evidence | Claude Code |
| A5 | Matching v2 with the AI judge + 300-pair eval | Claude Code |
| A6 | Discovery v2: candidates, probe, AI terms pre-screen, single-page reads, review queue UI | Claude Code (engine) + Cursor (UI) |
| A7 | Freshness scheduler, canaries, drift alerts | Claude Code |
| A8 | Price Data API v1 + move the app/email onto it | Claude Code (API) + Cursor (UI) |
| A9 | V3 search intelligence (parser, answer, suggestions) using `ai.small` | Claude Code + Cursor |
| A10 | Verify like a client, eval report, docs | Claude Code |

## 9. Your next actions

1. **Finish V2** (Q8–Q10) first.
2. **Run this on the laptop** (PowerShell) and paste the output, so we can size the models:

   ```powershell
   ollama --version
   ollama list
   Get-CimInstance Win32_ComputerSystem | Select-Object Model,@{n='RAM_GB';e={[math]::Round($_.TotalPhysicalMemory/1GB)}}
   Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors
   Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion
   Get-PSDrive C,D | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB)}}
   ```

3. **Cloud host decision.**
   - **Option A: Oracle Always Free (recommended).** Sign-up asks for a card *for identity verification only*; Always Free use isn't charged. Stay on the free-only account: don't upgrade to Pay-As-You-Go, and set a budget alert. Pick a Canadian home region if one is offered (Toronto or Montréal), because Always Free resources live only in your home region.
   - **Option B: no card at all.** Run the crawler and AI batches as **scheduled GitHub Actions** (a private repo includes 2,000 free minutes a month; ~60 min a day covers a few crawl batches with a small Ollama model in the runner). This needs you to lift the earlier "workflows manual-only" rule, just for these jobs. There's no always-on service, so freshness is ~4–6 h, and single-page reads happen inside the app's own search request.
4. Confirm the **storage split** (index DB on the VM, Supabase for app data).
