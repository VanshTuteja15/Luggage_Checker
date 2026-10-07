# Store Audit: Canadian Luggage Sources

**Date:** 5 Oct 2026  **Stores audited:** 24  **Machine-readable data:** [`store-audit.json`](./store-audit.json), the seed for the Source Registry

> **What this is.** For each store: platform, robots.txt, terms, sitemap, official data routes, how prices / variants / stock / currency appear, and the *legitimate* way our own engine can verify prices live.
> **Ground rules.** Public pages only; robots.txt honoured; nothing bypassed. A store that blocks automated access is recorded as a finding.
> **Not legal advice.** Terms were read as an engineer would. Items marked ⚖ need a human or legal read before going live.

---

## 1. Headline findings

1. **Shopify gives most stores an official agent channel.** 10 of the 24 stores run on Shopify, and every one now publishes `/.well-known/ucp`, `agents.md` and a **UCP Catalog MCP** endpoint (`/api/ucp/mcp`). This is a sanctioned, machine-readable way for agents to search a store and read price, variants and availability. **One adapter covers all 10 stores.**
2. **Identity data is excellent on Shopify.** Product JSON carries **UPC barcodes per variant** and often the **manufacturer model number in the SKU** (e.g. U.N. Luggage `137394-Black`, Canada Luggage Depot `135955-1247`). That makes deterministic cross-store matching realistic.
3. **Samsonite.ca is probably not blocked.** Its robots.txt explicitly allows Claude, OpenAI and Perplexity bots (10 s crawl delay), its terms have no anti-robot clause, and our fetcher loaded product pages normally. Tavily's earlier failures look specific to Tavily. **This must be confirmed from our own server.**
4. **The big chains can't be accessed directly, legitimately.** Amazon, Walmart, Costco and eBay forbid robots or scraping in their terms (eBay explicitly bans "LLM-driven bots"). Best Buy, Canadian Tire and London Drugs render prices only with JavaScript. Their legitimate routes are **APIs or partnerships**:
   - **eBay:** Browse API (free)
   - **Amazon:** Creators API (requires referral sales)
   - **Walmart:** Rakuten feed (not yet confirmed)
   - **Best Buy:** Impact affiliate program, plus written permission to show prices
5. **Terms vs agent channel conflict (⚖).** Most Shopify stores keep Shopify's boilerplate "spider, crawl, or scrape" clause while their robots.txt and agents.md invite agents to use UCP. Our position: use **only** the store-published UCP channel at low volume, and get legal sign-off (or written permission from priority stores) before launch.
6. **Corrections to our current code.**
   - **Hudson's Bay is gone:** it was liquidated in 2025 and `thebay.com` now redirects to Canadian Tire.
   - **Bentley moved:** it's now `shopbentley.com` (`bentley.ca` no longer resolves).
   - **Canada Luggage Depot is a competitor, not the client:** it's a Quebec company, not Luggage Depot Inc.
   - **Fraud risk:** `delseyluggagecanada.ca` and `delseyluggageca.ca` look like fraudulent look-alikes.

---

## 2. Coverage map

| Store | Category | Platform | Live verification | Best legitimate route | Fallback | Identity data | Conf. |
|---|---|---|---|---|---|---|---|
| **Samsonite.ca** | Brand | SFCC | `direct_http` (probe) | Dealer feed / EDI via Samsonite rep | Polite HTTP, 10 s delay | Model + colour code | Med |
| **Travelpro.ca** | Brand | Shopify | `official_api` | UCP Catalog MCP | Product JSON ⚖ | UPC + SKU | High |
| **Delsey.ca** | Brand | Shopify | `official_api` | UCP Catalog MCP | Product JSON | UPC + SKU | High |
| **TUMI (ca.tumi.com)** | Brand | SFCC | `direct_http` (probe) | Dealer feed (Samsonite Group) | Polite HTTP, 5 s delay, visit window | Style + colour ID | Med |
| **Briggs & Riley (.ca)** | Brand | Shopify | `official_api` | UCP Catalog MCP ⚖ | CJ affiliate feed | UPC + SKU | High |
| **Heys (ca.heys.com)** | Brand | Shopify | `official_api` | UCP Catalog MCP ⚖ | Dealer feed | UPC + SKU (+ stock count) | High |
| **Monos (ca.monos.com)** | Brand | Shopify | `official_api` | UCP Catalog MCP ⚖ | Awin affiliate | Barcode + SKU | High |
| **Away (/en-ca)** | Brand | Shopify | `official_api` | UCP Catalog MCP ⚖ | — | UPC + SKU | High |
| **U.N. Luggage** | Specialty | Shopify | `official_api` | UCP Catalog MCP | Product JSON | UPC + model in SKU | High |
| **Canada Luggage Depot** | Specialty | Shopify | `official_api` | UCP Catalog MCP | Product JSON (allowed by its agents.md) | UPC + model in SKU | High |
| **Luggage City** | Specialty | Shopify | `official_api` ⚖ | UCP after legal review | Ask permission | SKU (barcodes often empty) | Med |
| **Bentley (shopbentley.com)** | Specialty | Shopify | `official_api` | UCP (confirm sale prices) | Own affiliate program | Barcode + SKU | Med |
| **JP Grimard** | Specialty | Unknown | `blocked` (403) | Ask for permission or a feed | Manual | Unknown | Low |
| **Luggage Warehouse Van.** | Specialty | Wix | `none` | No online prices: in-store only | Manual | — | High |
| **eBay.ca** | Marketplace | eBay | `official_api` | Browse API (`EBAY_CA`) | — | GTIN / MPN search | High |
| **Amazon.ca** | Marketplace | Amazon | `not_permitted` | Creators API (needs Associates sales) | Link only | ASIN | Med |
| **Walmart.ca** | Major | Custom | `not_permitted` | Rakuten affiliate feed (if offered) | Link only | Item ID | Med |
| **Best Buy Canada** | Major | Custom SPA | `needs_js` | Impact affiliate + written price permission | Link only | SKU / model in title | Med |
| **Costco.ca** | Major | WebSphere | `not_permitted` | None found | Manual or exclude | Exclusive SKUs | Med |
| **Canadian Tire / SportChek** | Major | AEM | `needs_js` | Impact affiliate feed (ask) | Manual | House brands | Med |
| **Sporting Life** | Major | SFCC | `direct_http` (probe) | Polite HTTP from product sitemaps | — | — | Med |
| **Simons** | Major | Custom | `direct_http` (confirm robots) | Polite HTTP: price/availability meta | — | Name only | Med |
| **London Drugs** | Major | Kibo + Next.js | `needs_js` | Ask for a feed | Manual | — | Low |
| **Hudson's Bay** | — | — | defunct | Remove | — | — | High |

### Coverage in numbers

| Live-verification class | Stores | Which |
|---|---|---|
| Official agent/API channel | **11** | 10 Shopify stores via UCP + eBay Browse API |
| Direct HTTP (to be probed) | **4** | Samsonite, TUMI, Sporting Life, Simons |
| Needs partnership/API approval | **6** | Amazon, Walmart, Best Buy, Canadian Tire/SportChek, London Drugs, JP Grimard |
| No automated route | **2** | Costco (terms + no feed), Luggage Warehouse Van. (no online prices) |
| Defunct | **1** | Hudson's Bay |

**For the brands Luggage Depot actually sells (Samsonite, Travelpro, Delsey, Briggs & Riley, Heys, TUMI):**
- Every brand's own store is reachable live.
- 4 of the 6 Canadian specialty retailers are reachable live.
- The gap is the big-box chains.

---

## 3. Gaps we cannot solve technically

| Gap | Why | What we can do |
|---|---|---|
| Amazon.ca live prices | Terms ban robots/data mining; robots refuses AI agents | Creators API once an Associates account has qualifying sales; until then link without a price |
| Walmart.ca live prices | Terms ban "intelligent agents" | Apply to Rakuten; ask for a product feed |
| Best Buy Canada prices | JS-only; affiliate terms need written permission to show prices | Apply through Impact and ask for permission |
| Costco.ca | Terms ban bots; no Canadian affiliate; exclusive SKUs | Manual "last checked" entries, or exclude |
| Canadian Tire / SportChek / London Drugs | JS-only prices; CT terms limit to non-commercial use | Ask for partner feeds; manual |
| JP Grimard | 403 for automated clients | Ask for permission or a feed |
| Luggage Warehouse Vancouver | No online prices | In-store checks only |
| In-store-only discounts (e.g. JP Grimard) | Not published online | Out of scope; label "online price" |
| Marketplace volatility (Amazon buy box, eBay sellers, Walmart 3P) | Price depends on the seller and changes by the minute | Store seller and condition with each observation; compare new-condition offers from authorized sellers only |

---

## 4. What this means for the architecture

1. **Adapters per protocol, not per store.** Seven adapters cover everything above:
   - `ucp_catalog`: 10 stores through one implementation
   - `shopify_product_json`: fallback where the store allows it
   - `html_structured`: JSON-LD, then OpenGraph/meta price, then platform rules (SFCC)
   - `ebay_browse_api`
   - `amazon_creators_api`: later
   - `feed_import`: dealer CSV/EDI, affiliate feeds
   - `manual_entry`: human-entered price with a "last checked" date
2. **Source Registry fields this audit shows we need:**
   - **Allowed domains:** exact list per store, so fraud look-alikes can never be used
   - **Market host:** the host that serves CAD (`ca.monos.com`, `/en-ca`)
   - **Policy:** robots result, terms stance, written permission yes/no, legal review status
   - **Timing:** crawl delay and visit window (TUMI)
   - **Routes:** ranked
   - **UCP endpoint**
   - **Identity quality:** barcode yes/no, model number in SKU
   - **Health:** status and success rate
3. **Identity resolution order:** UPC from Shopify → manufacturer model number (Samsonite `137394` = Outline Pro Medium, `-1041` = colour) → brand + line + size + colour → AI tie-break only.
4. **Validation rules found in the audit:**
   - **Displayed vs data price:** Bentley's product JSON misses sale prices applied when the page renders, so cross-check the displayed price.
   - **Currency by host:** monos.com serves USD by geo.
   - **No price shown:** out-of-stock pages may show no price (Walmart); that's "no price", never zero.
   - **Seller/condition:** marketplace offers need both.
   - **USD listings:** eBay listings in USD are filtered out or flagged, never silently converted.
5. **The UCP adapter needs an agent profile.** The Catalog MCP requires a `meta.ucp-agent.profile` URL identifying our agent. We publish a profile page for LuggageTracker, which is also good practice for transparency.
6. **Politeness is per store.** Honour crawl delays (Samsonite 10 s, Canadian Tire 10 s, TUMI 5 s plus its visit window) and per-IP MCP rate limits (Monos). Live verification fetches only the few listings a query needs.

---

## 5. Business actions (not code; Luggage Depot or us)

| # | Action | Unlocks |
|---|---|---|
| 1 | Ask the **Samsonite Canada rep** for the dealer price list / EDI catalog | Samsonite, TUMI and American Tourister reference prices |
| 2 | Ask the **Travelpro, Delsey, Briggs & Riley and Heys reps** the same | Brand MSRP/MAP baselines |
| 3 | Create an **eBay developer account** and test the Browse API on `EBAY_CA` | eBay coverage |
| 4 | Apply to **Rakuten** (Walmart CA) and **Impact** (Best Buy, SportChek) as a comparison publisher; ask about product feeds and price-display permission | Big-box coverage |
| 5 | Open an **Amazon Associates (Canada)** account; Creators API once eligible | Amazon coverage |
| 6 | **Legal read** (⚖): using store-published UCP channels vs boilerplate anti-scrape terms | Go-live sign-off for the Shopify stores |
| 7 | Optional: short permission emails to priority retailers (Luggage City, U.N. Luggage, JP Grimard) | Removes ambiguity, may unlock JP Grimard |

---

## 6. Audit limitations and what to verify next

- **JSON-LD unconfirmed.** The audit fetcher strips `<script>` tags, so no "absent" result here is final.
- **Different IP.** Fetches came from a US cloud IP. Blocking, geo-currency and rate limits must be re-checked from **our own server, with an honest User-Agent**.
- **UCP responses not yet called.** Discovery documents loaded, but no catalog query was run (it needs our agent profile).
- **Third-party sources.** Amazon Creators API eligibility and dates, and Walmart/Rakuten feed availability, come from secondary sources and need confirming.

**Next step (Phase 0.5, before architecture is final):** a read-only **probe** run from our server against each store's sample URLs. It checks HTTP status, challenge detection, JSON-LD/meta price, currency, and one UCP `lookup_catalog` call per Shopify store. Output: a `verified` column added to this table.
