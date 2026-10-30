# Price Data Platform: research, critique and plan

Prepared 2026-10-30 for Vansh (Luggage Depot / Real Pricer). Status: **research and plan only; nothing built yet.**
Sources are at the end. Anything marked **(unverified)** still needs checking before we rely on it.

---

## 1. What you asked for, restated

1. **Professional-grade extraction.** Read retailer and brand pages and pull out the data a business needs: name, price, sale/was price, promotion, size, dimensions, colour, stock, identifiers. It has to be reliable enough to run a business on.
2. **"Like Flipp," refreshed within hours.** Cover the stores shoppers care about, with prices and deals that are hours old, not days old.
3. **Our own price data API.** An internal service like the commercial ones (Keepa, Zyte, Diffbot, PriceSpy's back end) that our app, the morning email and future products all read from.
4. **Plan first, build later.**

---

## 2. The most important finding (read this first)

### 2.1 Flipp and PriceSpy don't get their data by scraping. The retailers send it to them.

- **Flipp** (Toronto) is a flyer marketplace: retailers put their digital flyers on it, and it earns from engagement-based advertising (cost per read / per click). It reports flyers from 800+ retailers, including Walmart, Macy's, Dollar General and Lowe's. The data comes from **partner retailers**, not from crawling them.
- **PriceSpy** (a price-comparison site) is "updated by a feed of all retailers", 3–5 times a day. It earns per click or per sale from those retailers.

**What this means for us:** the businesses that show Walmart, Costco or Best Buy prices "in hours" do it through **partnerships and feeds**. No better scraper gets you there. Our scraper can be world-class on the stores that allow reading, and that's exactly where we should invest. For Amazon, Walmart, Costco, Best Buy, Canadian Tire and London Drugs, the professional route is a **feed or partnership**, the same as Flipp's, plus staff-checked prices and clearly labelled estimates until then.

### 2.2 Our extraction isn't the weak point. Coverage and depth are.

- **Accuracy is already proven.** In the P8 shadow run, all 115 of 115 prices matched the store's own page, with 0 wrong-product matches.
- **What's weak is how much we cover and how deep we go:**
  - Only 2 stores are readable live today.
  - Only **201 of 3,267** Canada Luggage Depot listings have identifiers (UPC/SKU). Discovery enriches at most 150 pages per store per run, one product page at a time.
  - Size, dimensions, capacity and weight aren't stored as fields. Matching and "24 inch" queries rely on titles.
  - Promotions are limited to compare-at and strikethrough prices. There's no promo text, no end date shown, no codes or bundles.
  - There's no tier for stores that only show prices after JavaScript runs.
- Fixing those gives the professional-level data you're describing. Section 4 covers how.

---

## 3. Research findings

### 3.1 How retailer pages expose product data (and how to read it best)

| Source on the page or store | What it gives | Reliability | Notes |
|---|---|---|---|
| **Platform catalogue APIs**: Shopify `/products.json` (paginated) and `/products/<handle>.json`/`.js`; WooCommerce **Store API** `/wp-json/wc/store/v1/products` (public, unauthenticated, `per_page` ≤ 100) | Every product and variant with price, compare-at price, SKU, barcode, options, availability | ★★★★★ | **Biggest efficiency win.** A 3,000-product Shopify store is about 15 paginated requests instead of 3,000 page reads. Check permission per store (robots, terms, agents.md). |
| **JSON-LD schema.org** `Product` / `ProductGroup` / `Offer` | Name, brand, GTIN, SKU/MPN, price, currency, availability, `priceValidUntil`, strikethrough price (`priceSpecification.priceType = StrikethroughPrice`), member prices, shipping (`OfferShippingDetails`), returns, variants (`hasVariant`, `variesBy`) | ★★★★ | Web Data Commons 2024: JSON-LD is used on 70% of sites that annotate (≈11.5 M), and Product annotations are on **3.3 M sites**. Google's merchant-listing rules push retailers to keep it accurate. |
| Microdata / RDFa | Same fields, older format (used by Salesforce Commerce Cloud stores) | ★★★ | Already parsed. |
| OpenGraph `product:price:*`, `product:sale_price:*` | Price, sale price, availability | ★★ | Cross-check only. |
| Visible page text (HTML) | Everything a person sees, including promo banners and spec tables | ★★ raw → ★★★★ with validation | Needed for specs and promotions. Rule-based first, then an LLM fallback (§3.3). |
| JavaScript-rendered pages | Prices that only appear after scripts run | ★★★ | Headless browser tier, **only for permitted stores**. Today none of the permitted stores need it. |
| **Feeds** (dealer price lists, affiliate datafeeds, Google Merchant-style CSV) | Full catalogue with prices | ★★★★★ | How Flipp and PriceSpy work. Import already exists. |
| **Store-published agent channels** (Shopify UCP / agents.md) | Catalogue search and lookup for agents | ★★★★ | 6 luggage stores publish one; it needs our agent profile published plus a legal OK. |

### 3.2 What commercial price-data APIs actually provide (and what we copy)

| Product | Model | What we copy |
|---|---|---|
| **Keepa** (Amazon) | Event-based history: a point is stored only when a value changes. Separate series for each price type: list, new, buy box, used, offer count. Per-field "last updated" times. Token-metered API | Event-based history (we already collapse unchanged prices into ranges), separate series per price type, per-field timestamps, honest "last updated" |
| **Zyte API** (automatic extraction) | Give it a URL and get a product record back, with a `probability` confidence score | A confidence score on every extracted record |
| **Diffbot Product API** | Automatic extraction of offer price, regular price, discount, specs, multiple products per page | A spec/attribute bag; detecting the regular vs offer price |
| **PriceSpy / Flipp** | Retailer feeds, refreshed 3–5×/day; deal discovery | Refresh targets measured in hours; a deals/promotions view |

### 3.3 AI extraction: what's realistic

- Research (Brinkmann et al., WDC-PAVE, 2024): GPT-4 reaches **F1 91%** on product attribute extraction, about 10 points above the older methods. Open-source models weren't reported in that paper (unverified for our use).
- **What that means for us:** an LLM is good for attributes (size, dimensions, capacity, material, features) and promotion text. It is **not** good enough to be the source of the price.
- **Our rule:** prices always come from structured data or platform APIs, cross-checked against the displayed price. LLM output is used only for attributes, and only after it passes validation (units, ranges, consistency with the title).
- **Model choice at $0:** a local model (Ollama on the office PC) first, then Gemini's free tier only for public product text (it may be used by Google to improve its products), otherwise none.

### 3.4 Legal and risk landscape (not legal advice; get a professional read before any external launch)

- **Prices and specs are facts.** Copyright cases have been about **photos**: *Trader v. CarGurus* (Ontario, 2017) held that showing dealer photos sourced from another site infringed copyright; fair dealing was rejected; damages were cut to $2 per photo, about $305k.
  - **Risk for us:** the app currently shows retailer product images by URL. That's fine for an internal tool used by one business, but **risky if Real Pricer becomes a public product.** Plan: show images only from stores that permit it, or show none and link to the store.
- **Terms of service.** *Meta v. Bright Data* (N.D. Cal., Jan 2024): logged-out scraping of public data wasn't a breach of Meta's terms. It's a US district court decision; appeals are possible and other terms differ.
  - Canada has no equivalent precedent that I found (unverified).
  - **Our policy stays:** honour robots.txt and terms, never bypass blocks, and get a legal read before reselling any data.
- **Reselling data.**
  - Data from Tavily, Google or affiliate feeds usually comes with **licence limits on redistribution** (unverified for each).
  - Our internal API can serve our own app. **Selling** it to other businesses needs a licence review for every source.

---

## 4. Critique of our current engine and plans (mistakes and gaps)

| # | Problem | Evidence | Fix |
|---|---|---|---|
| M1 | Discovery reads products **one page at a time**, at most 150 per store per run, so catalogue depth is low | 201 of 3,267 CLD listings have identifiers | Use **bulk catalogue reads** (Shopify `/products.json`, WooCommerce Store API) where permitted. Full catalogue in minutes, refresh every few hours |
| M2 | **Attributes aren't stored**: size class comes from the title; there are no dimensions, litres, weight, wheels, material or warranty | Matching and "24 inch" queries rely on title text | An attribute extractor (rules → spec tables → LLM fallback) into `catalog_variants`, with units normalised |
| M3 | **Promotions are thin**: only compare-at and strikethrough | No promo text, end date, member price, codes, bundles, free shipping | A promotion model (§5.2), plus promo extraction from the page and from retailer promo emails |
| M4 | **Only refresh by product** (tracked daily, search on demand) | No catalogue-wide freshness promise | Freshness tiers with targets measured in hours (§5.4) |
| M5 | **No data layer between the engine and the app.** Each screen calls its own internal route | Hard to reuse, test or offer to others | An internal Price Data API v1 (§5.3) |
| M6 | The JS tier is planned but has no candidates; none of the permitted stores need it | Registry: the `needs_js` stores are all ones whose terms forbid us | Build it only when a permitted store needs it; don't over-invest |
| M7 | **Product images** shown by URL | *CarGurus* risk if the product goes public | Image policy per store; link-out by default for external use |
| M8 | The V3 plan treats "our own Tavily" as achievable | A general web search index is out of reach at $0, and Flipp-type data comes from partnerships | Reframe: **our own index of permitted stores + feeds + partnerships**; Tavily stays an optional estimate plug-in |
| M9 | Freshness and accuracy aren't measured continuously | Only the one-off shadow run in P8 | Daily canaries, field-level accuracy audits, a public (internal) data-quality page |
| M10 | Worker hosting is still undecided | Vercel can't crawl every hour | The office PC (always on) or an Oracle Always Free VM is a **prerequisite** for hour-level freshness |

---

## 5. Plan: "Real Pricer Data Platform" (replaces and absorbs the V3 scraper workstream)

### 5.1 Acquisition: professional-grade and polite

1. **Bulk catalogue adapters.**
   - Shopify catalogue (`/products.json?limit=250&page=n`, or `/collections/all/products.json`) with variants, barcode, SKU, compare-at price and availability (via `.js` or UCP where needed).
   - WooCommerce Store API.
   - Each adapter gets platform auto-detection in the probe, permission checks per store (robots, terms, agents.md) and recorded fixtures.
2. **Attribute extraction** into `catalog_variants`:
   - Structured fields (JSON-LD `additionalProperty`, `size`, `color`, `weight`, `depth/width/height`).
   - Spec tables and bullet lists (rules for cm/in/L/kg/lb).
   - **LLM fallback** for attributes only (local model first). Every value carries its provenance and confidence.
3. **Promotion extraction:**
   - From structured data: strikethrough price, `priceValidUntil`, member prices.
   - From page text: "X% off", "save $Y", "buy 2 get…", codes, free shipping, "ends Sunday".
   - From **retailer promo emails**: a dedicated mailbox subscribed to luggage stores' newsletters, parsed into promotions and labelled "From Bentley's email, Oct 30". This is our legitimate equivalent of Flipp's flyers.
4. **Store onboarding programme** (from V3 S5.1): candidate list → probe → human terms read → adapter → fixtures → spot checks. Target +10 permitted stores; report the real number.
5. **Feeds and partnerships** (Flipp/PriceSpy model):
   - The dealer price list (Samsonite/TUMI).
   - Ask brands and specialists for a CSV feed.
   - Affiliate datafeeds where Luggage Depot qualifies (unverified per network).
   - Import with an "as of" date.
6. **JS tier** (Playwright) behind a flag, only for permitted stores that need it.

### 5.2 Data model additions

- `catalog_variants` gets: `dimensions_cm (h,w,d)`, `capacity_l`, `weight_kg`, `wheels`, `shell`, `material`, `expandable`, `warranty_years`, `attributes jsonb` (with provenance + confidence per value).
- `promotions`: `id, source_id, listing_id?, scope (product|category|sitewide), type (percent|amount|bogo|bundle|code|free_shipping|member), value, code, text, starts_at, ends_at, evidence, found_via (page|structured|email|feed|staff), confidence`.
- `observations` (exists) gets: a `price_type` series (`offer`, `regular`, `member`, `clearance`) and per-field `observed_at`, like Keepa.
- `price_history` stays event-based (store on change; ranges collapse).

### 5.3 Internal Price Data API v1 (our own "commercial" API; internal only at first)

- REST + an OpenAPI spec at `/api/v1/*`. Server-side API keys for internal clients (the app, the email, the worker, future products). Rate limits; JSON with provenance on every price.
- Endpoints:
  - `GET /v1/search?q=&filters` (index search; optional live verify)
  - `GET /v1/products/{id}` (identity, attributes, variants)
  - `GET /v1/products/{id}/offers` (current price per store: price, regular price, promo, stock, label, observed_at, confidence)
  - `GET /v1/products/{id}/history?type=offer|regular&days=` (event-based)
  - `GET /v1/promotions?store=&active=true`
  - `GET /v1/stores` (coverage, freshness, health in plain words)
  - `POST /v1/verify` (live re-check now)
  - `GET /v1/changes?since=` (price drops/increases feed)
  - webhooks `price.changed`, `promotion.started`
- **Rules:**
  - Every response carries `source`, `method`, `observed_at` and `confidence`.
  - Estimates are always typed as estimates.
  - Nothing goes external until a licence and legal review is done.

### 5.4 Freshness targets (achievable once a worker is hosted)

| Data | Target |
|---|---|
| Morning-email and tracked products at permitted stores | Re-read every **4–6 h**, and within 60 min before the 9:00 email |
| Full catalogue of bulk-API stores | Every **6–12 h** (minutes of polite requests per store) |
| Other permitted stores (page-by-page) | Daily, with change-rate learning |
| Promotions from email | Within an hour of the email arriving |
| Estimates (optional) | Within the Tavily free budget only |

### 5.5 Quality targets and proof

- **Price accuracy:** ≥ 99.5% against the live page (daily random audit of 50 prices).
- **Attribute accuracy:** ≥ 95% on a labelled set of 300.
- **Promotion precision:** ≥ 95% (no fake deals).
- **Catalogue coverage:** ≥ 95% of each permitted store's luggage.
- **Canaries:** 3 per store per day.
- **Drift alert:** if > 30% of pages lose a field, Store status says so in plain words and the owner gets an email.
- `npm run eval` publishes `docs/EVAL_REPORT.md`. Nothing counts as done without numbers.

### 5.6 Phases (after V2 Q8–Q10 are finished)

| Phase | Work | Owner (agents) |
|---|---|---|
| D0 | Host the worker (office PC + Cloudflare Tunnel, or an Oracle VM) | You + Claude |
| D1 | Bulk catalogue adapters + permission checks + backfill of identifiers | Claude |
| D2 | Attribute extraction + labelled eval set | Claude |
| D3 | Promotions: structured + page + promo-email mailbox | Claude |
| D4 | Freshness scheduler + canaries + drift alerts | Claude |
| D5 | Price Data API v1 + OpenAPI + migrate the app and email onto it | Claude (API), Cursor (UI changes) |
| D6 | Store onboarding (+10) and the feed/partnership outreach kit | Claude + you |
| D7 | V3 search intelligence (parser, matcher, answer, suggestions) on top of API v1 | Claude + Cursor |
| D8 | Deals view, promotions in the morning email, CSV export of offers | Cursor (spec by Claude) |

---

## 6. What it costs and what it needs

- **$0 in software:** the extractors, the API, Postgres (Supabase free), the worker on the office PC or an Oracle free VM, and a local LLM (Ollama, if the PC can run it).
- **Your time:**
  - terms reads for each new store (15 min each);
  - setting up the promo-email mailbox and subscribing to newsletters (30 min);
  - outreach emails to brands and specialists for feeds (templates provided);
  - the Samsonite dealer list.
- **The real ceiling at $0:** Amazon, Walmart, Costco, Best Buy, Canadian Tire and London Drugs stay at estimates, staff checks or links unless a feed or partnership is obtained.

## Sources

- [Flipp: $61M General Atlantic investment, 800+ retailers, retailer partnerships (BetaKit)](https://betakit.com/flipp-receives-61-million-strategic-growth-investment-from-general-atlantic/)
- [Flipp advertising model (CPR/CPC), Publitas](https://www.publitas.com/blog/flipp-alternative/)
- [PriceSpy: retailer feeds, 3–5 updates/day, CPC/CPA (ChannelX)](https://channelx.world/2019/06/meet-the-company-pricespy/)
- [Web Data Commons 2024 corpus statistics (Univ. of Mannheim)](https://www.uni-mannheim.de/dws/news/wdc-json-ld-microdata-rdfa-data-corpus-2024-published)
- [Google merchant listing structured data (strikethrough, member price, shipping, returns)](https://developers.google.com/search/docs/advanced/structured-data/merchant-listing)
- [WooCommerce Store API (public, unauthenticated)](https://developer.woocommerce.com/docs/apis/store-api/)
- [Keepa API guide (event-based history, token model)](https://www.nexscope.ai/blog/keepa-api-guide)
- [Zyte API reference (automatic extraction, probability)](https://docs.zyte.com/zyte-api/usage/reference.html)
- [Brinkmann et al., LLMs for product attribute extraction (WDC-PAVE)](https://arxiv.org/abs/2403.02130v4)
- [Trader v. CarGurus summary (Norton Rose Fulbright)](https://www.nortonrosefulbright.com/en/knowledge/publications/ed6d21da/ip-monitor---car-websites-scraped-but-only-slightly-dented)
- [Meta v. Bright Data summary (Farella Braun + Martel)](https://www.fbm.com/technology/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/)
