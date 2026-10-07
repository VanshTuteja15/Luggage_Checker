# Probe Report: what each source really returns (P0 evidence)

**Run:** 7 Oct 2026, 21:08 UTC, from the office network (Canadian residential IP, Vancouver CF edge)
**Command:** `npm run probe:sources` (raw output: [`probe-results.json`](./probe-results.json)), plus `--selftest` (36/36 pass)
**Identity:** `LuggageTrackerProbe/0.1 (price-comparison research for a Canadian retailer; read-only; contact: https://github.com/VanshTuteja15/Luggage_Checker/issues)`
**Volume:** 46 requests in total, robots.txt read first for every host, at least 3 s between requests to one host (10 s at Samsonite, 5 s at TUMI as their robots.txt asks).
**Not configured for this run:** `UCP_AGENT_PROFILE_URL` (so no UCP catalog call was made) and eBay keys (so no eBay call was made). Both are human actions (see [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md)).

Follow-up requests (2 in total, same UA): one Samsonite product page and one Sporting Life `robots.txt`, to record the block pages as classifier fixtures (`scripts/fixtures/blocks/`).

## How to read the verdicts

| Column | Meaning |
|---|---|
| **Accessible** | We got a usable response containing a price |
| **Reliable** | Identity + price + currency + availability present, and the channels agree with each other and with the page the customer sees |
| **Permitted** | robots.txt allows the path for our agent **and** the store's terms / published agent channel allow it. Not legal advice. ⚖ = needs a human or legal read |

## Results per store and protocol

### Shopify stores where we could read the public product data

| Store | Protocol | Accessible | Reliable | Permitted |
|---|---|---|---|---|
| **Canada Luggage Depot** | product `.json` | YES (134 ms) | YES with `.js` for availability (4/4 variants have UPC + Samsonite model-colour SKU `135955-1247`) | **YES**: its agents.md lists product JSON for agents |
| | product `.js` | YES | YES (availability per variant) | YES |
| | HTML JSON-LD | YES (892 KB page) | YES: ProductGroup + 4 variant Offers with GTIN, SKU, availability, `priceValidUntil`, strikethrough list price | YES (robots allows; agents.md invites agents) |
| | UCP MCP | `/.well-known/ucp` 200; catalog not called | not tested | YES (store-published channel) |
| **Delsey Canada** | product `.json` | YES | YES (1 variant, UPC `098376088166`, price 335 / compare-at 478) | LIKELY: terms silent |
| | product `.js` | YES | YES (availability) | LIKELY |
| | HTML JSON-LD | YES | **PARTIAL**: offer URLs point to `us.delsey.com` (shared Shopify config); `mpn` holds the Shopify product id, not a manufacturer number; page also embeds another product's ProductGroup | LIKELY |
| | UCP MCP | `/.well-known/ucp` 200 | not tested | YES |
| **U.N. Luggage** | product `.json` | YES | YES (4/4 UPC; SKU `137394-Black` = Samsonite model + colour name) | UNCLEAR ⚖: terms not yet read by a human |
| | product `.js` | YES | YES | UNCLEAR ⚖ |
| | HTML JSON-LD | YES | YES (ProductGroup, per-variant GTIN and stock) | UNCLEAR ⚖ |
| | UCP MCP | `/.well-known/ucp` 200 | not tested | YES (store-published channel) |
| **Bentley** | product `.json` | YES | YES: **now shows the sale** (125.99, compare-at 179.99) | UNCLEAR ⚖: /policies disallowed by robots, terms unread |
| | product `.js` | YES | YES | UNCLEAR ⚖ |
| | HTML JSON-LD | YES (1.8 MB page) | YES; `og:price` 125.99 matches the data price | UNCLEAR ⚖ |
| | UCP MCP | `/.well-known/ucp` 200 | not tested | YES |

### Shopify stores probed through their agent channel only (terms restrict scraping)

Travelpro Canada, Briggs & Riley Canada, Heys Canada, Monos, Away (en-ca) and Luggage City all served `robots.txt` (200, `*` group, no crawl delay) and `/.well-known/ucp` (200, about 4.8 KB). **Catalog calls were not made** because the agent profile URL is not configured.

| Store | Accessible | Reliable | Permitted |
|---|---|---|---|
| All six | NOT TESTED (needs `UCP_AGENT_PROFILE_URL`) | — | YES via UCP only ⚖ (terms carry Shopify's generic anti-scrape clause; legal sign-off pending) |

### Non-Shopify stores

| Store | Protocol | Accessible | Reliable | Permitted |
|---|---|---|---|---|
| **Samsonite Canada** | HTML product pages (3 URLs, 1 repeated ×3) | **NO: BLOCKED.** Every read returned `307` from Varnish with a **PerimeterX CAPTCHA** page ("Access to this page has been denied", `px-captcha`). | NO | robots allows (crawl-delay 10 s); terms silent. Blocked anyway, so not usable. |
| | sitemap | **NO: BLOCKED** (same 307 CAPTCHA) | — | — |
| **TUMI Canada** | HTML product page | **NO: BLOCKED** (identical PerimeterX 307) | NO | robots allows (crawl-delay 5 s, visit window); blocked anyway |
| **Sporting Life** | robots.txt + product page | **NO: BLOCKED.** Cloudflare managed challenge (`cf-mitigated: challenge`) even on `robots.txt` | NO | Unknown: robots.txt itself unreachable, so we treat the site as not permitted |
| **Simons** | robots.txt + product page | **NO: BLOCKED** (Cloudflare challenge on `robots.txt`) | NO | Unknown, as above |
| **JP Grimard** | robots.txt only | robots.txt **now returns 200** (`*` group, sitemap listed); the audit had recorded 403 | — | UNCLEAR ⚖: terms unknown; product pages not probed |

### Official APIs and stores we never touch

| Store | Result |
|---|---|
| **eBay.ca** | Browse API **not configured** (no keys). HTML is never fetched. |
| **Amazon.ca, Walmart.ca, Costco.ca, Best Buy, Canadian Tire / SportChek, London Drugs** | Not touched: their terms forbid automated access (MASTER_PROMPT rule 2). Shown as **link only** until an official API or feed exists. |
| **Luggage Warehouse Vancouver** | No online prices: manual only. |
| **Hudson's Bay** | Defunct: removed from the registry. |

## What the evidence changes (vs `STORE_AUDIT.md`)

1. **Samsonite.ca is blocked from our network.** The audit's "probably not blocked" came from a US cloud fetcher; from our own IP with an honest UA, PerimeterX serves a CAPTCHA on every page and the sitemap. Per rule 1 we do not solve CAPTCHAs or disguise ourselves. **Samsonite's live verification class becomes `blocked`.** Routes: dealer price list / EDI via the Samsonite rep (`feed_import`), then `manual_entry`. Samsonite products still get live prices from the Shopify retailers that carry them (U.N. Luggage, Canada Luggage Depot, Bentley).
2. **TUMI Canada is blocked** the same way (shared Samsonite Group infrastructure). Route: dealer feed via Samsonite Canada, then manual.
3. **Sporting Life and Simons are blocked** by Cloudflare challenges, even for `robots.txt`. Both have thin luggage ranges; classified `blocked`, no automated route.
4. **Bentley's sale-price gap no longer reproduces.** Product JSON now carries the sale price with `compare_at_price`. The `html_structured` displayed-vs-data cross-check stays in place as a guard, because the audit saw the gap once.
5. **Delsey's JSON-LD is not trustworthy for identity.** Offer URLs point to the US store, `mpn` is the Shopify product id, and the page embeds an unrelated ProductGroup. Delsey uses **product JSON first**; JSON-LD is only a cross-check, and its URLs are never used as listing URLs.
6. **JP Grimard's robots.txt is reachable now.** Terms are still unknown, so it stays `unclear` (no automated fetching) until a human reads them or the store grants permission.
7. **Identity data is as good as hoped.** 11 distinct UPCs across 4 stores, every variant carrying a barcode. Samsonite model numbers appear in SKUs in two shapes: `137394-Black` (U.N. Luggage, colour name) and `135955-1247` (Canada Luggage Depot, colour code; `1041` = Black at both Samsonite and CLD). eBay's sample GTIN `043202927614` is U.N. Luggage's Outline Pro Medium Black, so cross-store GTIN matching will work as soon as eBay keys exist.
8. **Shopify `updated_at` is not a change signal.** Every store returned the same `updated_at` second as the request time. Incremental discovery must use sitemap `<lastmod>`, not product `updated_at`.
9. **Freshness headers.** Shopify product JSON is served `cf-cache-status: DYNAMIC` (no CDN copy), so a read is current; the product HTML is `private, max-age=0`. A price read through these channels is a *live* price.

## Registry consequences (applied in `src/lib/engine/registry/seed.ts`)

| Store | Live class | Permission | Ranked routes (first usable wins) |
|---|---|---|---|
| Canada Luggage Depot | official_api | sanctioned | shopify_ucp → shopify_product_json → html_structured |
| Delsey Canada | official_api | allowed | shopify_ucp → shopify_product_json → html_structured (cross-check only) |
| U.N. Luggage | official_api | unclear ⚖ | shopify_ucp → (product JSON only after the terms are read: per-source flag) |
| Bentley | official_api | unclear ⚖ | shopify_ucp → (product JSON after terms read: per-source flag) |
| Travelpro, Briggs & Riley, Heys, Monos, Away, Luggage City | official_api | restricted ⚖ | shopify_ucp only |
| Samsonite Canada | **blocked** | allowed (robots + terms) | feed_import (dealer) → manual_entry |
| TUMI Canada | **blocked** | allowed | feed_import (dealer) → manual_entry |
| Sporting Life, Simons | **blocked** | unknown | manual_entry |
| JP Grimard | unknown | unclear ⚖ | manual_entry (ask permission) |
| eBay.ca | official_api | official API | ebay_browse_api (needs keys) |
| Amazon.ca | not_permitted | forbidden | amazon_creators_api (flag, needs eligibility) → link only |
| Walmart, Best Buy, Canadian Tire/SportChek, Costco, London Drugs | not_permitted / needs_js | forbidden | feed_import (affiliate, when approved) → link only / manual |
| Luggage Warehouse Vancouver | none | n/a | manual_entry |
| Hudson's Bay | defunct | n/a | removed |

## Caveat

This measures a residential Canadian connection. The worker will run either on the office PC (same network, so these results apply) or on a cloud host, whose data-centre IP may be treated more strictly. **Re-run `npm run probe:sources` from the worker host once it is chosen** (listed in HUMAN_ACTIONS).
