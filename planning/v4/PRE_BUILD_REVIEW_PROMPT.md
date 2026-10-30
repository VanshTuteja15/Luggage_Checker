# PRE-BUILD REVIEW: our own AI price-intelligence engine (v4)

You are Claude Code, the lead engineer for LuggageTracker / Real Pricer (Luggage Depot Inc., Calgary).

This task is **analysis, research, measurement and planning only**. **Do not build features and do not change app code.** The goal is to remove as many mistakes as possible *before* building, so the build prompt that comes out of this is correct, complete and realistic.

"Zero errors" can't be promised. What you must do is find every error you can, prove claims with evidence, and turn the remaining risks into explicit tests and acceptance checks.

## 0. Rules (binding)

1. Read `AGENTS.md` first. **Never run `git commit`, `push`, `merge`, `rebase`, `reset` or `stash`.** The owner (Vansh) commits. End with a "Ready to commit" list.
2. **Write only to:**
   - `planning/v4/**`
   - `scripts/bench/**` (benchmark scripts)
   - `docs/research/**`

   Don't edit `src/**`, `supabase/**`, `worker/**`, `.env*`, `.github/` or the protected files (`src/app/tracked/page.tsx`, `src/app/api/track/route.ts`, `src/lib/db/products.ts`).
3. **$0.** No paid APIs, no sign-ups, nothing that can create a charge. Don't spend Tavily credits. Measurements use local Ollama, the local dev DB and recorded fixtures.
4. **No anti-bot evasion**, ever. Live fetches only through the existing PoliteFetcher, only to hosts the registry permits, and at most 20 polite requests in total for this review.
5. **Evidence over opinion.** Every external fact gets a source URL and the date you checked it. Every claim about our code cites `path:line`. Every performance number comes from a run you did, with the command. Mark anything you couldn't verify as **UNVERIFIED** and say how to verify it.
6. Disk is tight (C: ~9 GB free). **Don't pull models larger than ~3 GB.** Check free space before any pull and stop if C: would drop below 5 GB.
7. If something needs the owner's decision, list it under "Questions for Vansh". Don't guess.

## 1. Read everything (in this order)

1. `planning/v4/OWN_AI_ENGINE_PLAN.md` (the plan under review)
2. `planning/v4/PRICE_DATA_PLATFORM_RESEARCH.md` (research, legal notes, sources)
3. `planning/v3/MASTER_PROMPT_V3.md`, `planning/v3/AGENT_PROTOCOL.md`
4. `MASTER_PROMPT_V2.md`, `docs/PROGRESS_V2.md`, `docs/CLIENT_REVIEW.md`, `docs/ARCHITECTURE.md`, `docs/HUMAN_ACTIONS.md`, `docs/STORE_AUDIT.md`, `docs/PROBE_REPORT.md`, `docs/SHADOW_REPORT.md`
5. The engine code: `src/lib/engine/**` (registry, politeness, adapters, extract, validate, identity, discovery, research, estimates, store), `worker/**`, `supabase/migrations/**`, `scripts/engine/**`, `scripts/probe/**`

Write `planning/v4/review/01_CODEBASE_MAP.md` covering:

- what exists, what each module does, and what can be reused for each part of the v4 plan (with `path:line`);
- what the plan assumes that the code contradicts;
- current gaps, with numbers from the dev DB where you can measure them. For example: listings with identifiers vs total, per store; attribute fields present; promotions stored; observation volume and DB size.

## 2. Measure, don't assume

Use local tools only.

1. **Hardware and Ollama** (Windows, PowerShell, Ollama 0.40.13 at `http://localhost:11434`).

   The owner's first test with `llama3.2:3b` gave:
   - 95% GPU (RX 6500M via Vulkan);
   - 45 tokens/s generation;
   - 11.8 s cold load;
   - it returned `line: "Paralux Hardside Spinner"`, which is wrong (should be "Paralux").

   Write `scripts/bench/ollama-bench.ts`. It calls `/api/chat` with a **JSON-schema `format`**, temperature 0, and `keep_alive`. It records:
   - cold vs warm latency;
   - tokens/s;
   - RAM and VRAM used (`ollama ps`);
   - JSON validity rate;
   - accuracy against expected answers.
2. **Models to compare** (≤ ~3 GB each; check the Ollama library for exact tags and sizes first, and record them): `llama3.2:3b` (installed), plus at most two of `qwen3:4b`, `gemma3:4b`, `phi4-mini`, `qwen2.5:3b`.
   - For any "thinking" model, measure with thinking off and on.
   - Remove models you don't keep, to protect disk space.
3. **Tasks to benchmark.** Build small labelled sets from **real data in the dev DB and recorded fixtures** (never invented products). Save them in `scripts/bench/sets/`.

   | Task | Set |
   |---|---|
   | (a) query → intent JSON (brand, line, size class, inches, type, colour, max price) | 60 queries |
   | (b) title → brand/line/size/version | 100 real listing titles |
   | (c) attribute extraction (dimensions, capacity, weight, wheels, expandable) from real product text | 40 pages |
   | (d) same/different/variant judgement | 80 real listing pairs, including the known traps: Nexis 28"/31", TUMI International vs International Expandable, Chatelet Air 2.0 vs 1.0, Paralux Medium vs Large |
   | (e) promotion text → structured promo | 30 real snippets |
   | (f) robots/terms clause classification | 15 real terms excerpts already in the repo or probe results |

   For each task and model, report:
   - accuracy and precision;
   - JSON validity;
   - latency p50/p95;
   - **whether "rules only" (no AI) already does as well**, which is the baseline to beat.
4. **Evidence check prototype.** Measure how often a model's extracted value can't be found in the source text (hallucination rate), and test that our verbatim/unit-conversion check catches it.
5. **Arm/Oracle feasibility on paper:**
   - estimate RAM for Postgres + worker + Ollama (3–4 B) + Chromium on 2 OCPU / 12 GB;
   - check Ollama and Playwright support for linux/arm64 (sources);
   - check Oracle's current Always Free limits and the idle-reclamation rule;
   - check whether sign-up needs a card.

   Mark anything you can't measure as UNVERIFIED.
6. **Supabase size:** current DB size, growth per day of observations, and when 500 MB would be reached under the v4 crawl plan.

Write the results to `planning/v4/review/02_MEASUREMENTS.md`, with the commands, raw numbers and conclusions.

## 3. Research to close the gaps (cite sources with dates)

Verify, or correct, each of these:

1. **Bulk catalogue endpoints:**
   - Shopify `/products.json` (pagination params, limits, fields, whether it is commonly blocked or disallowed in robots);
   - WooCommerce Store API (price fields, `currency_minor_unit`, enabled by default?);
   - BigCommerce / Magento public options.

   Then **check each registry store's robots.txt and terms for these paths** with the probe (≤ 20 requests), and record what is allowed.
2. **Discovery sources:**
   - Common Crawl CDX API (query syntax, rate guidance, latest crawl IDs, whether keyword discovery is practical, and how big a `.ca` filter is);
   - brand dealer-locator pages for Samsonite, TUMI, Travelpro, Briggs & Riley, Delsey, Heys (robots status only).
3. **Robots.txt for AI user agents:** how stores treat AI agents in robots.txt (e.g. `GPTBot`, `ClaudeBot`, `ChatGPT-User`, `OAI-SearchBot`), and what our own UA string and policy should be for single-page reads. RFC 9309 precedence rules.
4. **Ollama:**
   - structured-output reliability limits;
   - `keep_alive` and concurrency settings (`OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`);
   - Vulkan on AMD Windows (known issues);
   - the arm64 build;
   - how to call it from the worker safely (timeouts, queueing).
5. **Small-model extraction quality:** recent papers or benchmarks on small open models for product attribute extraction and entity matching (e.g. WDC-PAVE, WDC Products). Report the numbers and what they mean for us.
6. **Legal and ethics refresh:**
   - Canadian position on scraping public prices;
   - copyright on product images (Trader v. CarGurus);
   - Common Crawl terms;
   - robots.txt as a signal.

   Summarise only, not legal advice, and list what a lawyer should confirm.
7. **Competitor teardown:**
   - how Flipp, PriceSpy, Google Shopping and Keepa source and present data;
   - which features matter to a luggage retailer's daily routine;
   - what we must match and what we should skip.

Write `docs/research/v4-research-notes.md` with every claim sourced and dated.

## 4. Three review passes on the plan (be critical)

Go through `OWN_AI_ENGINE_PLAN.md` section by section, three times, each pass with a different lens. Put the findings in `planning/v4/review/03_REVIEW.md` as a table: **ID, severity, finding, evidence, fix**.

- **Pass 1, correctness and feasibility.** Wrong facts, impossible steps, hardware/RAM/disk limits, free-tier limits, time budgets (search ≤ 8 s), Arm builds, single points of failure, data growth.
- **Pass 2, data integrity.** Every way a wrong price, wrong product, stale price, fake promotion or wrong store could reach the client. For each, the exact guard (validator rule, evidence check, test) that stops it. Include AI hallucinations, currency, sale vs regular price, variants/colours, out-of-stock, duplicate pages, time zones, and caches serving old data as new.
- **Pass 3, operations, security, cost and legal.**
  - Secrets, SSRF, prompt injection from scraped pages into the LLM (scraped text is data, never instructions), queue abuse, job retries and idempotency.
  - VM reclamation and backups, monitoring and alerts, the laptop being offline, disk filling.
  - Accidental paid usage, robots and terms compliance, images.
  - Anything that would make the client reject it.

## 5. Decisions and the final plan

1. `planning/v4/review/04_DECISIONS.md`: one short ADR per significant choice, with options, the evidence-based recommendation, and consequences. Cover:
   - model per task (or rules only);
   - storage split (VM index DB vs Supabase);
   - host (Oracle vs GitHub Actions);
   - bulk-catalogue policy;
   - the single-page-read policy and UA;
   - queue design for the `ai.small` / `ai.large` lanes;
   - the evidence-check rules;
   - the eval thresholds.
2. `planning/v4/review/05_RISK_REGISTER.md`: each risk with likelihood, impact, guard, test and owner.
3. `planning/v4/review/06_TEST_PLAN.md`:
   - the unit, integration, eval and real-world checks that the build must pass;
   - per-phase acceptance criteria with exact commands;
   - "golden" fixtures to record.
4. **`planning/v4/MASTER_PROMPT_V4_DRAFT.md`:** the corrected, complete build prompt (phases A0–A10, updated with everything above), written for Claude Code (brain) + Cursor (UI worker) per `planning/v3/AGENT_PROTOCOL.md`, owner-commits rule included. It is **only a draft for the owner's approval**: do not start building.
5. Update `planning/v4/OWN_AI_ENGINE_PLAN.md` only to fix factual errors, and list each change.

## 6. Finish

Stop and report in ≤ 20 lines:

- the top 10 findings (with severity);
- the measured model results (best model per task vs rules only);
- what changed in the plan;
- every UNVERIFIED item;
- "Questions for Vansh".

Then give the **"Ready to commit"** list (files + suggested message, e.g. `docs(v4): pre-build review, measurements, research, draft master prompt`). Do not commit.
