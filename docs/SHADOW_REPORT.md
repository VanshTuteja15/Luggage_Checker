# Shadow Report (P8)

The new price engine and the old Tavily web-research path, run side by side on the same 35 known products, with every shown price checked against what the store's own page says.

**Verdict: the engine matches or beats the old path on every target, so the default was cut over** (`engine.default_search` now defaults to on). Web research stays available one click away on the search page, and turning the flag off in `/admin` rolls the default back.

| Target (MASTER_PROMPT P8) | Engine | Old Tavily path | Met? |
|---|---|---|---|
| ≥ 99% correct identity + price on shown results | **115/115 prices equal the store page (100%)**, 0/93 wrong-identity offers in the expected product's card, 0/41 cards mixing products | 8/14 checkable prices correct (57%); 7/35 wrong-identity offers in the expected card; 10/162 cards mixing products; 166 of 180 prices not checkable | ✅ engine |
| Zero unlabelled stale prices | **0**: every price carries its freshness label. 3 prices were shared from the request just before (read 16.4–17.4 s earlier, measured in the database), inside the 90 s single-flight window the spec allows, and labelled with their real read time | every price labelled "Web research · read <time>"; 6 of 14 checkable prices differed from the store page | ✅ engine |
| First verified price ≤ 3 s (known products) | **31/31**; p50 302 ms, p95 1.7 s, max 2.3 s | 12/31; p50 3.3 s, p95 4.4 s | ✅ engine |
| Complete ≤ 12 s (known products) | **31/31**; p50 1.2 s, p95 7.7 s, max 8.3 s | 10/31; p50 14.1 s, p95 17.2 s, max 20.5 s | ✅ engine |

## How it was run

- **When / where:** completed 8 October 2026, 10:22 UTC, from the office network (the P0 probe network), against the real stores.
- **Engine:** `npm run shadow:run` → one real research session per product against the local index built by `npm run engine:discover` (Canada Luggage Depot 3,167 product pages, Delsey.ca 414, one language each). Same code as production: registry, PoliteFetcher (honest User-Agent, robots.txt, crawl delays), adapters, validation, identity, answer grouping.
- **Old path:** the app's own `search()` from `src/lib/search` (Tavily research + page reading + Gemini grouping), fresh (cache bypassed), metered through the app's `provider_usage` counter and its monthly cap. **120 Tavily credits** (free plan; the month was at 0/950 before the run), $0.
- **Ground truth:** every shown offer on a store we may read was re-read seconds later from the product page's own structured data (`html_structured`: a different endpoint and extractor than the engine's product JSON), matching the exact variant. 69 pages read. Prices on stores we may not read (Amazon, Walmart, the brands' blocked sites…) can't be checked by us and are counted as *not checkable*, never as correct.
- **Test set:** [`scripts/shadow/testset.json`](../scripts/shadow/testset.json). 35 products: 20 sold by Canada Luggage Depot (Samsonite, TUMI, Travelpro, Briggs & Riley, American Tourister, Swiss Gear, Ricardo, Roots, Herschel), 11 by Delsey.ca, and 4 sold only by stores we can't read today (Away, Monos, Samsonite Freeform, Heys). Each has its expected identity (brand, size class, line words that must and must not appear, stated inches) and expected price sources. The set deliberately includes the hard cases found while building: Nexis Large 28" vs 31", TUMI International vs International Expandable vs Continental, Rhapsody Medium vs its 2-piece sets, Herschel Hardshell vs Softshell, Delsey titles without the brand, "Spin Me Away" (Away is also a brand), "ALU'R".
- **Raw results:** [`docs/shadow/results.json`](./shadow/results.json) (every shown offer with its title, price, truth and identity verdict). Tables: `npm run shadow:report`.

## Products sold by a store we may read (31)

| Measure | Engine | Old Tavily path |
|---|---|---|
| Expected product found | **31/31** (with a price equal to the store page) | 23/31 |
| Expected product is the first card | **31/31** | 15/31 |
| Offers in the expected product's card that are a different product | **0/93** | 7/35 |
| Cards mixing different products | **0/41** | 10/162 |
| Shown prices we could check against the store page | 115/115 | 14/180 |
| …equal to the store page | **115/115 (100%)** | 8/14 (57%) |
| First price p50 / p95 / max | **302 ms / 1.7 s / 2.3 s** | 3.3 s / 4.4 s / 4.5 s |
| Complete p50 / p95 / max | **1.2 s / 7.7 s / 8.3 s** | 14.1 s / 17.2 s / 20.5 s |

The old path's wrong prices, all on stores we can check:

| Product | Old path showed | Store page |
|---|---|---|
| TUMI 19 Degree Aluminum Continental Carry-On (CLD) | $25 | $1,810 |
| Delsey Chatelet Air 2.0 30" | $485 | $391 |
| Delsey Cosmique 23" Carry-On | $187 | $189 |
| Delsey Cosmique 27" | $173 | $232 |
| Delsey Cruise 3.0 (shown for a carry-on query; the offer was the 32" check-in) | $325 | $435 |
| Delsey Turenne 2.0 30" | $394 | $406 |

Engine timings follow the stores' own pace: Canada Luggage Depot answers in 0.2–1.2 s; Delsey.ca takes about 1.2 s per product page because its crawl delay (1 s, honoured) applies to the two requests each page needs, so a 4-colour product completes in 7–8 s, still inside the 11 s deadline.

## Products sold only by stores we can't read (4)

| Product | Engine | Old Tavily path |
|---|---|---|
| Away The Bigger Carry-On | no price; Away "not set up" (needs the UCP agent profile), 8 link-only and 4 blocked rows, CLD/Delsey "no match" | 1 price for the product (Away's site), not checkable |
| Monos Carry-On Pro | no price; Monos "not set up" | 1 price (Monos's site), not checkable |
| Samsonite Freeform Carry-On | no price; Samsonite.ca "blocked", Amazon/Costco "link only" | 2 prices (Amazon.ca, Samsonite.ca), not checkable |
| Heys Xcase 2G Carry-On | no price; Heys "not set up" | nothing |

This is where the old path reaches further: it shows prices from stores the engine may not or cannot read. We can't verify those prices, and where we *could* check the old path it was right 57% of the time, so the engine shows these stores as honest "link only / blocked / not set up" rows with a link instead. Coverage here grows with the human actions below, not with more code.

## What would raise coverage (no code needed)

| Action ([HUMAN_ACTIONS.md](./HUMAN_ACTIONS.md)) | Stores it adds |
|---|---|
| Publish the UCP agent profile (§1) | Away, Monos, Heys, Travelpro, Briggs & Riley via Shopify Catalog (live prices); Luggage City after its legal read |
| eBay Browse API keys (§3, free) | eBay.ca through the official API |
| Read three stores' terms (§4) | U.N. Luggage and Bentley (product JSON), JP Grimard (after the store answers) |
| Dealer feeds (§6) | Samsonite, TUMI (blocked sites) as "Feed as of <date>" prices |

## Bugs the shadow work found and fixed before the run

- Delsey.ca titles never contain "Delsey", so brand queries found nothing: brand-direct stores now supply their own brand.
- Half of each index was `/fr/` copies of the same product pages: discovery keeps one language.
- TUMI International and International Expandable (C$1,680 vs C$1,810) were one product: "Expandable", "International" and "Domestic" now distinguish products (optional in queries).
- Samsonite Nexis Large 28" and 31" were one product: a stated size in inches is part of identity.
- A store's sizeless listings (a laptop bag) were checked for a "Medium" query: dropped once that store has exact-size matches.
- Sitemap titles kept HTML entities ("ALU&apos;R").
- First price was 7.8 s on a cold database connection: the pool is warmed at start-up.

Re-run: `npm run db:dev -- up`, `npm run engine:discover`, then `npm run shadow:run` (add `--engine-only` to spend no Tavily credits) and `npm run shadow:report`.
