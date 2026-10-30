# 04 Decisions (ADRs) for v4

2026-10-30. Each ADR: context → options → recommendation (with the evidence) → consequences. Numbers: `02_MEASUREMENTS.md` (bench on our own labelled sets; laptop RX 6500M via Vulkan). The owner pre-approved the master prompt draft for tonight; anything below that would *replace* working architecture is a proposal only and is marked **PROPOSAL (not tonight)**.

## D1. Model per task (or rules only)

**Context.** Six tasks benchmarked on real labelled data: (a) query intent, (b) title parse, (c) attributes, (d) same/variant/different, (e) promotions, (f) terms pre-screen. Rules = the existing luggage pack plus regex prototypes.

**Measured (all-fields-right rate unless stated; see 02 §3 for every field):**

| Task | Rules | llama3.2:3b | qwen2.5:3b | qwen3:4b (no think) |
|---|---|---|---|---|
| (a) queries | **60.0%** | 35.0% | 31.7% | 25.0% |
| (b) titles | **49.0%** | 14.0% | 0% (brand always null) | 38.0% (best brand 90, line 79, version 100; size class 62) |
| (c) attributes | **95.0%** | 50.0% (24.7% of its numbers unevidenced) | 55.0% (10.2% unevidenced) | not measured (memory) |
| (d) pairs accuracy | 53.8% (abstains on 18 grey pairs, 1 wrong merge) | 73.8%, **7 wrong merges** | 82.5%, **10 wrong merges** | not measured |
| (e) promos | **93.3%** (1 fake) | 6.7% (2 fake) | 40.0% (1 fake) | not measured |
| (f) terms | **100%** | 37.5% | 81.3% | not measured |
| Hybrid pairs (rules + model on the 18 grey pairs) | 61.3%, 1 wrong merge | 68.8%, 2 | 66.3%, 7 | — |

**Recommendation.**
- (a), (b), (e), (f): **rules only**. No model beats rules; rules improve with gazetteer fixes (brands missing: Peak Design, Dakine, Matador, Helly Hansen, Austin House, Bellroy, JanSport, Mancini) and the Shopify `vendor` field from the bulk feed.
- (c): **rules first** (95% on CLD's spec format). AI fallback **off by default** (`ai.attributes`), allowed only for text where rules find nothing, every value through the evidence check (D7). Turn on per store only after a held-out eval on that store's text beats rules.
- (d): **rules + human review queue**. The AI judge (`ai.match_judge`, off by default) may run on grey-zone pairs only, and its "same"/"variant" **creates a review item, never a merge**. Measured wrong-merge counts make auto-merge by a 3–4 B model unacceptable; the literature agrees (Llama 3.1 8B zero-shot F1 53.4 on WDC Products).
- Model choice when an AI path is enabled: the smallest model that passes D8 on that task. Default `OLLAMA_MODEL=qwen2.5:3b`: the only model that fits 100% in the laptop's VRAM (2.0 GB), the fastest (p50 0.66–1.9 s), and the best of the three at terms (87.5%) and pair recall. `qwen3:4b-q4_K_M` (3.12 GB, 75% GPU) pushed the 7 GB laptop out of memory; keep it off this machine.

**Consequences.** The AI layer is still built (priority 1 of the overnight prompt: client, guard, evidence checker, cache, lanes, rules fallback) because it is the safe foundation for later, but every AI flag starts **off**, and the product works the same with Ollama off. The eval harness keeps measuring, so a future model can earn a task by numbers.

## D2. Storage split (VM index DB vs Supabase)

**Context.** DB is 27 MB today; `listings` 2.0 KB/row, observations ~940 B/row. Bulk reads every 6 h of CLD + Delsey ≈ 6,600 variants ≈ 26k readings/day; one row per reading ≈ 25 MB/day.

**Options.** (1) Keep one Supabase DB, change storage to event-based. (2) Move index tables to a VM Postgres now. (3) Both.

**Recommendation.** (1) now: **event-based observations** (insert on change of price, list price, stock or currency; otherwise extend the open `price_ranges` row). This keeps Supabase viable for the stores we may read today (estimated < 1 MB/day). (2) is a **PROPOSAL (not tonight)**: move the index (listings, observations, price_ranges, fetch_attempts) to the VM DB when Supabase passes 300 MB (60%) or > 10 bulk-read stores, keeping app data, email and *current* offers in Supabase. Size alert at 60% in Store status.

**Consequences.** One migration (007) adds a range-touch function and the change test; history stays exactly as today for users (ranges); evidence for unchanged readings lives in `price_ranges.observation_count/last_seen_at`.

## D3. Host (Oracle A1 vs GitHub Actions)

**Context.** Owner chose Oracle Always Free (§0). Official limits today: 2 OCPU / 12 GB (1,500 OCPU-h + 9,000 GB-h a month), 200 GB block, 20 GB object storage, home region only; idle reclaim if CPU p95, network and memory are all < 20% for 7 days. Sign-up asks for a card (not charged unless upgraded).

**Recommendation.** Oracle A1 as the always-on worker (crawler, scheduler, small-model lane), **scripts only tonight** (`deploy/oracle/*`, `docs/DEPLOY_ORACLE.md`, steps in `docs/HUMAN_ACTIONS.md`). GitHub Actions stays the documented no-card fallback (needs lifting "workflows manual-only" for those jobs). No AI on the A1 hot path (D1, P1-03).

**Consequences.** Resident model + scheduled crawls are a real workload (memory > 20%) so the idle rule isn't hit; nightly backups to Object Storage; rebuild < 1 h.

## D4. Bulk-catalogue policy

**Recommendation.**
- Only stores whose storefront we may read: `sanctioned`/`allowed`, or `unclear` with the per-store flag a human turned on; plus a new per-store flag `source.<id>.catalog` (on for CLD and Delsey only).
- Every page through the PoliteFetcher (robots for our token; crawl delay ≥ the store's; `maxBytes` 10 MB); `limit=250`; stop on the first empty page; max 100 pages; per-collection paging only above 25,000.
- **Currency canary** first (2 variants via `/products/<handle>.json`: `price_currency` = CAD and equal to bulk, else stop).
- Every 6–12 h once hosted; never during a research session; one store at a time.
- GTIN backfill: per-product `.json` for luggage-class pages without a GTIN, tracked/email products first, ≤ 150 per store per run (today's budget).

## D5. Single-page-read policy and user agent

**Recommendation.**
- UA stays `LuggageTrackerBot/1.0 (+contact; price comparison for a Canadian luggage retailer; read-only, honours robots.txt)`; never another bot's token or a browser UA.
- robots: the group naming `LuggageTrackerBot` (exact token, case-insensitive), else `*`; unreachable robots = no read.
- A candidate store must exist as a registry row (`discovered`, exact hosts, look-alike check) before any read; forbidden/blocked stores never.
- Flag `discovery.single_page_reads` **off by default**; when on: ≤ 1 store per search, ≤ 1 page, 3 s budget, parallel, never blocks the answer; label "Read once from <store> · not reviewed yet"; no image stored.
- The store then goes to the review queue with the terms pre-screen quotes.

## D6. Queue design for `ai.small` / `ai.large`

**Recommendation.**
- Two pg-boss queues: `ai.small` (always-on worker; short jobs ≤ 30 s; concurrency 1) and `ai.large` (laptop worker, connects outbound with a least-privilege DB role over TLS; batch jobs; concurrency 1).
- Job = `{ task, inputHash, input, promptVersion, schemaVersion }`; `singletonKey = task:inputHash`; `retryLimit 1`; `expireInSeconds` 900 (small) / 86,400 (large); dead letters kept by pg-boss.
- Results go to `ai_cache` (key = sha256(model, prompt version, schema version, input)); the consumer reads the cache, never the job.
- When a lane is off, busy (503), timed out or expired → the rules result stands; the job records `fallback`.

## D7. Evidence-check rules

**Recommendation.** An AI value is kept only if:
1. **Numbers** appear in the source text verbatim (± 0.005), or by a declared conversion: inch→cm (± 0.6 cm), lb→kg (± 0.06 kg), cu in→L (± 0.6 L); dims checked per value.
2. **Strings** (quotes, terms clauses) appear verbatim (whitespace-normalised substring).
3. **Enums** come from the schema (size class, wheels ∈ {2, 4}, promotion kinds).
4. **Brand/line words** are in the gazetteer or literally in the text.
5. **Promotion numbers** pass 1 **and** are consistent: sale < was; stated % ≈ (was − sale) / was within 1 point; the offer's structured price equals the stated sale price when both exist.
6. **Prices never come from the AI.**
Measured on llama3.2:3b attributes: the check caught 43 of 53 wrong values and flagged 0 correct ones (02 §3); the remainder are wrong-but-present numbers, which is why rules stay first.

## D8. Eval thresholds

**Recommendation.** `npm run eval` writes `docs/EVAL_REPORT.md`. An AI path may be switched on for a task only when, on that task's set and a held-out slice: JSON valid ≥ 99%; accuracy ≥ rules + 5 points; **stored hallucinations = 0** (after the evidence check); **wrong merges = 0** (pairs); **fake promotions = 0** and promotion precision ≥ 95%; attribute accuracy ≥ 95% per field. Rules metrics must not drop more than 1 point between reports without a written reason. Plan targets (§6) stand: price accuracy ≥ 99.5%, wrong-product offers 0, match auto-merge precision ≥ 99.5%, search ≤ 8 s.
