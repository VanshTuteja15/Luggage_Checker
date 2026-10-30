# 05 Risk register (v4)

2026-10-30. Likelihood / impact: H / M / L. Owner: **CC** = Claude Code, **V** = Vansh (owner), **CU** = Cursor. "Guard" is what stops it; "Test" is how we prove the guard works (IDs refer to `06_TEST_PLAN.md`).

| # | Risk | L | I | Guard | Test | Owner |
|---|---|---|---|---|---|---|
| R01 | A small model invents a dimension, capacity or weight and it is stored | H | H | Evidence check drops any value not in the text (verbatim or unit-converted); rules first; AI attributes off by default | U-EVID-1..6, EVAL-C (stored hallucinations = 0) | CC |
| R02 | An AI value becomes a shown price | L | Critical | AI schemas have no price fields outside promotions; promotion numbers need evidence + structured consistency; observations only from adapters | U-AI-PRICE-1, INJ-1..3 | CC |
| R03 | The AI judge merges two different bags | M | Critical | AI never merges; grey zone only; its "same" goes to the review queue; hard vetoes (size, inches, version, edition, Large Carry-On, extra line words) | U-MATCH-1..8, EVAL-D (wrong merges = 0) | CC |
| R04 | Existing rules merge Ventra Large Carry-On with Ventra Carry-On (live bug) | H | H | Pack fix + regression test before any matching change | U-MATCH-1 | CC |
| R05 | Bulk catalogue prices in USD (shared Delsey/US Shopify config) | L | H | Currency canary per run (2 per-product reads, `price_currency` must be CAD and equal) | U-CAT-4, I-CAT-2 | CC |
| R06 | Supabase 500 MB filled by bulk readings | H (without fix) | H | Event-based storage; size alert at 60%; retention; storage split when > 300 MB | U-OBS-1..3, DB-1 | CC |
| R07 | Stale prices look current | M | H | Freshness labels (existing rule 5); per-store "last full read" with a > 24 h warning | U-FRESH-1, existing digest tests | CC |
| R08 | Fake promotions (tags, "Sale price" = regular, comparable value) | H | H | Promotion rules: real discount or stated offer only; tags ignored; evidence + consistency | U-PROMO-1..10, EVAL-E (precision ≥ 95%, fake = 0) | CC |
| R09 | Prompt injection from store text | M | M | `<data>` fence, guard sentence, JSON schema only, no tools, evidence check, values from enums/gazetteer | INJ-1..3 | CC |
| R10 | `OLLAMA_URL` SSRF / Ollama exposed publicly | L | H | Loopback-or-allowlist check in the client; VM firewall closed; `127.0.0.1` bind | U-AI-URL-1..3 | CC (code), V (VM firewall) |
| R11 | Laptop RAM exhaustion (7 GB, Docker + other projects) | M | M | One model; `keep_alive` 5 min; unload between models; refuse to load when free RAM < 0.5 GB | manual check in A1 runbook | CC, V |
| R12 | Laptop offline: `ai.large` work waits forever | H | L | Job expiry; rules fallback; nothing waits on the laptop | U-LANE-2 | CC |
| R13 | Oracle reclaims or loses the VM | M | M | Real workload (resident model, crawls); nightly backups; `setup.sh` rebuild < 1 h; email independent of the VM | DEPLOY-1 (dry run of `setup.sh --check`) | V (account), CC (scripts) |
| R14 | Oracle account upgraded to Pay-As-You-Go by mistake → charges | L | H | HUMAN_ACTIONS says never upgrade; budget alert $1 | n/a (human) | V |
| R15 | Oracle sign-up needs a card the owner won't give | M | M | GitHub Actions fallback documented (needs lifting the "workflows manual-only" rule) | n/a | V |
| R16 | A store's terms forbid what we do (bulk or single page) | M | H | Bulk only for sanctioned/allowed + flag; single-page reads flag off by default; terms pre-screen quotes clauses for a human | U-POLICY-1..4 | V (legal read), CC |
| R17 | Look-alike / fraudulent store domains | L | H | Registry row with exact hosts before any read; look-alike check; SSRF guard | U-DISC-3 | CC |
| R18 | robots.txt group mismatch (substring rule) | L | L | Exact product-token match | U-ROBOTS-1 | CC |
| R19 | Search slower than 8 s | M | H | No AI on the hot path; single-page reads bounded to 3 s and in parallel; measured on 3 real searches per engine change | PERF-1 | CC |
| R20 | Catalogue run blocked mid-way (403/429/challenge) | L | M | Circuit breaker; stop the run on the first block; resume later; Store status sentence | U-CAT-6 | CC |
| R21 | Model output not valid JSON | L (measured 100%/99%) | L | zod validation; invalid → rules result | U-AI-JSON-1 | CC |
| R22 | Eval sets drift from reality / overfit rules | M | M | Sets from real recordings with sources; a held-out slice per store before turning an AI path on; owner-written queries (HUMAN_ACTIONS) | EVAL-ALL | CC, V |
| R23 | Images (copyright, CarGurus) | M | M | Link-out for unknown/unreviewed stores; no storage | existing UI rules | CC, CU |
| R24 | Disk fills (laptop D:, VM) | L | M | ≤ 3 models; prune unused; VM 70% alert; event storage | DEPLOY-2 | CC, V |
| R25 | Secrets leak (DB role for the AI worker) | L | H | Separate role with least privilege; env only; never logged | code review | CC, V |
| R26 | Client rejects AI wording / technical words | L | M | No AI text shown verbatim; plain fields with source and date; A5.2 scan stays green | existing `plain-text.test.ts` | CC, CU |
| R27 | Common Crawl licence misuse | L | M | Domain checks only, never content; read the terms first | n/a | V |
| R28 | WooCommerce/BigCommerce adapters built without a real store | M | L | Not built until a permitted store and fixture exist | n/a | CC |
