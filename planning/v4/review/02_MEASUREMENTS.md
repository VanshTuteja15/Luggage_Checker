# 02 Measurements (v4 pre-build review)

Run 2026-10-30, 00:47–01:50 MDT, on the owner's laptop (HP Victus, Ryzen 5 5600H 6C/12T, **7.34 GB RAM**, AMD RX 6500M 4 GB via Vulkan, Windows 11), Ollama 0.40.13, dev DB `lt-dev-db` (Postgres 17). Raw results: `planning/v4/review/bench-results.json`; run log in the session scratchpad.

## 0. Commands

```
docker exec -i lt-dev-db psql -U postgres -P pager=off -f - < scripts/bench/db-gaps.sql
node scripts/run-ts.mjs scripts/bench/robots-paths.ts                     # offline, 0 requests
node scripts/run-ts.mjs scripts/bench/record-catalog.ts <rawDir>          # 5 requests
node scripts/run-ts.mjs scripts/bench/bulk-vs-observed.ts <rawDir>        # 0 requests (dev DB)
node scripts/run-ts.mjs scripts/bench/currency-check.ts delsey-ca 40392680500-alexandra-23-inch-expandable-carry-on-suitcase-black <bulkFile>   # 3 requests
node scripts/run-ts.mjs scripts/bench/record-terms.ts <outDir> delsey-ca unluggage                                                            # 4 requests
node scripts/run-ts.mjs scripts/bench/ollama-bench.ts --rules-only --tasks all
node scripts/run-ts.mjs scripts/bench/ollama-bench.ts --models llama3.2:3b,qwen2.5:3b,qwen3:4b-q4_K_M --tasks all --think off
```

Labelled sets (real data only, labels by hand; rules for each field in each file's `labelRules`): `scripts/bench/sets/` titles 100 (CLD + Delsey bulk pages), queries 60 (real product families), attributes 40 (real product text), pairs 80 (dev-DB titles; Delsey truth from the store's own 11-digit codes), promos 30 (recorded search snippets + CLD tags), terms 16 (recorded clauses + tonight's terms pages).

## 1. Hardware and Ollama

| Item | Measured |
|---|---|
| Ollama server config | `OLLAMA_MODELS=D:\ollama\models`, `NUM_PARALLEL 1`, `MAX_LOADED_MODELS 0` (auto), `KEEP_ALIVE 5m`, `VULKAN true`, host `127.0.0.1:11434` (server.log) |
| GPU | Vulkan sees the RX 6500M: 4.0 GiB total, 3.4 GiB free; the iGPU is dropped |
| Free RAM | 0.39–0.83 GB with nothing loaded (Docker/WSL and another project's emulators run beside us); 0.41–0.47 GB with a 2–2.4 GB model loaded |
| Disk | C: 15.46 GB, D: 16.64 GB free before; D: 12.4 GB after pulling two models |
| Memory limit hit | At 01:50 Claude Code's reaper stopped the bench because the system was critically low on memory, while `qwen3:4b-q4_K_M` (3.12 GB, only 75% on the GPU) was loaded. Not restarted (its instruction) |

## 2. Speed and memory per model (laptop GPU)

| Model | Size loaded | On GPU | Cold load | Output tok/s | p50 / p95 per call (titles · queries · attributes · pairs · promos · terms), ms |
|---|---|---|---|---|---|
| `llama3.2:3b` | 2.44 GB | 95% | 7.3 s | 39–43 | 966/1219 · 1379/1629 · 1826/3709 · 706/1983 · 2565/3167 · 1128/1714 |
| `qwen2.5:3b` | 2.01 GB | **100%** | 6.0 s | 42–50 | 762/930 · 993/1196 · 1754/2819 · 659/985 · 1923/2491 · 981/1717 |
| `qwen3:4b-q4_K_M` (no think) | 3.12 GB | 75% | 10.1 s | 20–21 | 1821/2320 · 2423/3245 · (stopped) |
| `qwen3:4b-q4_K_M` (think on) | — | — | — | — | **not measured** (memory; UNVERIFIED) |

JSON validity under a JSON-schema `format`: 100% everywhere except `qwen2.5:3b` attributes 39/40 (one output failed the schema).

## 3. Accuracy per task: models vs rules only

"All" = every labelled field right on an item. Rules = the existing luggage pack plus regex prototypes (`scripts/bench/ollama-bench.ts`).

| Task (n) | Rules | llama3.2:3b | qwen2.5:3b | qwen3:4b no-think |
|---|---|---|---|---|
| (a) queries (60), all | **60.0** | 35.0 | 31.7 | 25.0 |
| — brand / line / size / inches / type | 96.7 / 69.0 / 93.3 / 90.0 / 100 | 90 / 56.9 / 76.7 / 95 / 83.3 | 81.7 / 60.3 / 70 / 86.7 / 90 | 85 / 32.8 / 83.3 / 93.3 / 98.3 |
| (b) titles (100), all | **49.0** | 14.0 | 0.0 | 38.0 |
| — brand / line / size / inches / version | 80 / 59.3 / **87** / **100** / 97 | 47 / 61.6 / 54 / 95 / 81 | **0** / 48.8 / 39 / 99 / 93 | **90 / 79.1** / 62 / 96 / **100** |
| (c) attributes (40), all | **95.0** | 50.0 | 55.0 | stopped |
| — dims / capacity / weight / wheels / expandable | 100 / 100 / 100 / 95 / 97.5 | 72.5 / 72.5 / 77.5 / 77.5 / 100 | 85 / 85 / 90 / 77.5 / 95 | — |
| (d) pairs (80), accuracy | 53.8 (18 abstain) | 73.8 | **82.5** | stopped |
| — wrong merges (same/variant on a different pair) | 1 | **7** | **10** | — |
| (e) promos (30), all | **93.3** | 6.7 | 40.0 | stopped |
| — promo precision / recall / fake | 92.9 / 92.9 / 1 | 85.7 / 85.7 / 2 | 90.9 / 71.4 / 1 | — |
| (f) terms (16), category | **100** | 43.8 | 87.5 | stopped |
| — quote verbatim | 100 | 81.3 | 92.9 | — |

What the misses look like (real outputs): `qwen2.5:3b` returned `brand: null` for every title (even "Samsonite Ecodiver…"), turned "JH001A" into "jho001a" with an invented version "1.0", and called a suitcase a set; `llama3.2:3b` called a laptop backpack a garment bag. Rules miss brands absent from the gazetteer (Peak Design, Dakine, Matador, Helly Hansen, Austin House, Bellroy, JanSport, Mancini: all 20 brand misses), "Weekender"/"Hydration Pack"/"Adventure Pack" size classes, and bare inch numbers after a line name ("Platinum Elite 21").

## 4. Pairs: model only vs rules + model in the grey zone

The plan's design is rules first, the model only where rules are unsure (18 of 80 pairs are a near match the rules send to review).

| Pipeline | Accuracy | "same" precision / recall | Wrong merges |
|---|---|---|---|
| Rules (grey → no merge) | 61.3 | 42.9 / 10.3 | 1 (the Ventra Large Carry-On bug, `packs/luggage.ts:323`) |
| Rules + `llama3.2:3b` on grey | 68.8 | 69.2 / 31.0 | 2 |
| Rules + `qwen2.5:3b` on grey | 66.3 | 75.0 / 41.4 | 7 |
| `qwen2.5:3b` alone | 82.5 | 96.3 / 89.7 | 10 (as "variant") |

Rules can't match Delsey's French slug titles to the English ones, or a CLD title to a shorter Amazon/Samsonite one: that is the recall gap. Every model adds wrong merges even when it only sees the grey zone. **Conclusion:** a model verdict may only open a review item, never merge (decision D1, D3 of the review).

## 5. Evidence check (prototype in the bench)

| Model, task | Numbers returned | No evidence in text | Wrong values | Wrong values caught by the check | Correct values wrongly flagged |
|---|---|---|---|---|---|
| llama3.2:3b, attributes | 174 | 43 (**24.7%**) | 53 | 43 (81%) | 0 |
| qwen2.5:3b, attributes | 118 | 12 (10.2%) | 14 | 12 (86%) | 0 |
| llama3.2:3b, promos | 50 | 0 | 30 (mostly missing values) | 0 | 0 |
| qwen2.5:3b, promos | 15 | 1 (6.7%) | 6 | 1 | 0 |

The prototype accepted any number present anywhere in the text. The production checker (`src/lib/engine/ai/evidence.ts`) is stricter: it reads the unit next to each number in the text, so "21 x 14 x 9 in" can't evidence 21 cm (only 53.3 cm), and "8 cm wheels" can't evidence a wheel count. What the check can't catch: a wrong number that the text does state (e.g. the case dimensions instead of the overall ones), which is why rules stay first.

## 6. Oracle A1 feasibility (on paper; no Arm machine tonight)

- **RAM on 2 OCPU / 12 GB (estimate):** Postgres 1.5–2 GB (shared buffers 512 MB + cache), worker Node 0.3–0.5 GB, Ollama with a 2–3 GB Q4 model on CPU ~2.5–3.5 GB (weights + 4K context), Chromium when used 0.5–1 GB, OS 0.5 GB ⇒ **5.3–7.5 GB**, fits. A resident model keeps memory > 20%, so the idle-reclamation rule (all of CPU p95, network and memory < 20% for 7 days) isn't met by a real workload.
- **Speed (UNVERIFIED, estimate):** no Ampere A1 figure was found. Laptop GPU output is 40–50 tok/s; CPU inference on two server cores is generally single-digit tok/s for 3 B models (research §4). Our task answers are 40–150 tokens, so **one AI call ≈ 10–40 s on the A1**: fine for batch lanes, impossible inside an 8 s search (P1-03).
- **Support:** official `ollama-linux-arm64` build (secondary source); Playwright documents arm64 Ubuntu 22.04/24.04 (secondary; verify on the VM image).
- **Account:** official limits 2 OCPU / 12 GB, 200 GB block, 20 GB object storage, home region only; sign-up asks for a phone and card (not charged unless upgraded; wording UNVERIFIED).

## 7. Supabase size and growth

| Item | Measured / computed |
|---|---|
| DB size now | 27 MB (`pg_database_size`); `listings` 14 MB (7,206 rows ≈ 2.0 KB each incl. the GIN index), `observations` 0.6 MB (645 rows ≈ 940 B each), `fetch_attempts` 0.3 MB (≈ 475 B each) |
| Observation growth so far | 645 rows over 4 days with data (316 / 253 / 22 / 54) |
| Bulk plan, today's storage (one row per reading) | CLD ≈ 6,100 variants (3,229 products × 1.9 variants on the two pages read) + Delsey ≈ 430 ⇒ ~6,600 readings per pass × 4 passes/day ≈ 26,000 rows ≈ **25 MB/day ⇒ 500 MB in about 19 days** |
| Bulk plan, event storage (row only on a change) | change rate seen: CLD 9 of 72 variants changed in 3 weeks (12.5%), Delsey 47 of 47 (a repricing). Worst case ~5% of variants change per day ⇒ ~330 rows ≈ 0.3 MB/day; plus the listing rows once (≈ +6,000 variant rows ≈ 12 MB) ⇒ **years** of headroom for the two stores |
| fetch_attempts with bulk reads | 13 + 2 pages + canaries per pass ≈ 70/day ≈ 33 KB/day (negligible); per-product backfill 150/run ≈ 70 KB/run |

## 8. Corrections made to `OWN_AI_ENGINE_PLAN.md` (facts only, each marked "corrected 2026-10-30")

1. §1 free disk: C: 9 / D: 6 GB → measured 15.5 / 16.6 GB (12.4 GB on D: after two pulls).
2. §1 "Ollama 0.40.13, no models yet" → `llama3.2:3b` installed on D:.
3. §1 Oracle "since June 15, 2026": official limits confirmed, date UNVERIFIED (sources disagree).
4. §3 and §5 "≤ 2 s query parse on the cloud model" → not achievable; the hot path stays rules-only.
5. §5 `gemma3:4b` → 3.3 GB, over the 3 GB limit.
6. §8 A3 "fixes the 201/3,267 depth problem" → bulk fixes SKU/model depth only; GTINs need a backfill (no barcode in `/products.json`); today 98 of 3,103 CLD pages have an identifier.

## 9. Caveats (read before trusting the numbers)

- The rules prototypes for (c), (e) and (f) were written after looking at those texts, so they may be optimistic; a held-out slice per store is required before any decision that depends on a few points (D8).
- The title prompt said brand "as written": on Delsey.ca titles (which omit the brand) a model could fairly answer null, which lowers the models' brand scores a little. It does not explain `qwen2.5:3b`'s 0% (it returned null for "Samsonite Ecodiver" too).
- `qwen3:4b-q4_K_M` was measured on two tasks only and thinking mode not at all (memory). Its title line/brand/version numbers were the best of any pipeline, worth a re-run on a machine with more free RAM or after closing the other project's emulators.
- Sets are small (16–100 items); ±10 points on small tasks is noise. They are a baseline for `npm run eval`, to grow with owner-written queries and more recorded pages.
