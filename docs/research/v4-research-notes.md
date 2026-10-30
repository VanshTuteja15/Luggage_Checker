# v4 research notes: closing the gaps in the own-engine plan

Checked **2026-10-30** (all web sources on that date unless stated). "Our run" means a measurement made tonight from this laptop through the engine's own `PoliteFetcher` (honest UA `LuggageTrackerBot/1.0`, robots.txt honoured), logged in `docs/PROGRESS_V4.md`. **UNVERIFIED** marks anything I could not confirm, with how to confirm it. Not legal advice.

---

## 1. Bulk catalogue endpoints

### 1.1 Shopify `/products.json` (storefront, public)

| Fact | Evidence |
|---|---|
| `?limit=250&page=N`; 250 is the maximum, larger values are clamped silently; no `limit` gives 30 | [DEV: Shopify products.json pagination, 250 limit and the 25,000 cap](https://dev.to/odeeb/shopify-productsjson-pagination-250-limit-and-the-25000-cap-1g37) |
| Stop on an **empty** page, not a short one; `page × limit` above **25,000** returns HTTP 400 ("Page * Limit exceeds the 25000 limit"), so catalogues over 25k need per-collection paging (`/collections/<handle>/products.json`) | same source. Not an issue for our stores (CLD 3,229 products) |
| **Our run:** CLD page 1 = 250 products (1.77 MB, 633 ms), page 13 = 229 products (2.09 MB): the catalogue is **3,229 products in 13 requests**. Delsey page 1 = 250 products (1.08 MB, 347 ms) | `scripts/bench/record-catalog.ts`, requests #1–5 |
| **Our run:** variant fields are `id, title, option1-3, sku, requires_shipping, taxable, featured_image, available, price, grams, compare_at_price, position, product_id, created_at, updated_at`. **There is no `barcode`, no `price_currency` and no inventory field.** Product fields include `vendor`, `product_type`, `tags`, `body_html` | same run (351 + 568 + 250 variants: barcode 0, price_currency 0) |
| Third-party confirmation that the feed has no barcode key ("the GTIN/EAN/UPC only exists on the per-product endpoint") | [Apify Shopify products scraper page](https://apify.com/scrapersdelight/shopify-products-scraper) (a vendor; our run is the stronger evidence) |
| **Our run:** the bulk price equals the per-product `.json` price (which states `price_currency: CAD`) and the `.js` cents for the same variant (Delsey Alexandra 23", 148.00 / 148.00 CAD / 14800) | `scripts/bench/currency-check.ts`, requests #6–8 |
| **Our run:** bulk vs our stored readings: CLD 63/72 variants equal, the rest Travelpro (a sale ended since Oct 8); Delsey **0/47 equal, 47/47 same stock**: Delsey repriced after our Oct 8–10 readings, so stored Delsey prices were 3 weeks stale | `scripts/bench/bulk-vs-observed.ts` |
| `grams` is not a usable weight: every CLD variant sampled said 500 (a store default) | our run |
| Response headers carry an `etag` (`page_cache:…`) and `cf-cache-status: DYNAMIC`; whether `If-None-Match` returns 304 is **UNVERIFIED** (test with one conditional request) | our run |
| robots.txt allows `/products.json` and `/collections/all/products.json` for our token at **all 11 Shopify registry stores** that served robots.txt (offline evaluation of the P0 probe's recorded rules with the engine's own matcher); JP Grimard disallows it; Sporting Life and Simons were unreadable (403) | `scripts/bench/robots-paths.ts` over `docs/probe-results.json` (2026-10-07) |

**What it means for us:** one bulk read gives SKU, price, compare-at price, availability, vendor, product type, tags and description for the whole catalogue in 13 requests (vs ~6,400 per-product requests). It fixes **SKU/model depth** (Samsonite-group and Delsey model numbers live in the SKU), **not GTIN depth**: barcodes still need `/products/<handle>.json` (or `.js`), so a bounded, prioritised barcode backfill stays. Currency must stay implied by the Canadian storefront host, exactly as `validate/index.ts:83` already treats product JSON without `price_currency` (−0.1 confidence, never USD).

### 1.2 WooCommerce Store API

| Fact | Evidence |
|---|---|
| `GET /wp-json/wc/store/v1/products?per_page=100&page=N`, public and unauthenticated on most stores; some answer 403 | [Apify WooCommerce Public Catalog & Price Change API](https://apify.com/soilair/woocommerce-public-catalog-change-api), [DEV: import WooCommerce prices with minor units](https://dev.to/timmyzinin/import-woocommerce-prices-with-their-currency-minor-units-intact-2n08) |
| Prices are **strings in the currency's minor unit**, with `currency_minor_unit` (2 for CAD: "995" = 9.95); read it per store, never assume /100 | same sources |
| `prices.price`, `regular_price`, `sale_price`, `currency_code`; "sale_price is not always the sale price" warning from one vendor | same; **UNVERIFIED** against developer.woocommerce.com (read the Store API products schema before writing the adapter; record a real fixture) |
| None of the 24 registry stores is on WooCommerce today (platforms in `registry/seed.ts`) | our code |

**Decision input:** build the adapter only with a real permitted WooCommerce store's fixture; until one exists it would be untested code (the plan's M6 lesson applies).

### 1.3 BigCommerce / Magento

- **Magento 2 GraphQL** (`/graphql`): product and price queries work as a guest (no token); prices depend on the store view (`Store` header); catalogue visibility can be restricted for guests. [Mirasvit: GraphQL in Magento 2](https://mirasvit.com/knowledge-base/how-to-use-graphql-api-magento-2.html), [magento devdocs release notes](https://github.com/magento/devdocs/blob/master/src/guides/v2.4/graphql/release-notes.md).
- **BigCommerce GraphQL Storefront API** needs a token the store creates (standard tokens are CORS-scoped for browsers; server-to-server needs a private token the store must issue). [BigCommerce: GraphQL Storefront authentication](https://developer.bigcommerce.com/docs/start/authentication/graphql-storefront), [private storefront tokens](https://www.bigcommerce.com/blog/private-storefront-tokens/). So for us BigCommerce = existing `html_structured` (JSON-LD), not an API.
- No registry store runs either platform today. Skip both adapters until a permitted candidate appears.

---

## 2. Discovery sources

### 2.1 Common Crawl

- Latest index: **CC-MAIN-2026-43 (October 2026)**; 129 crawls listed in [index.commoncrawl.org/collinfo.json](https://index.commoncrawl.org/collinfo.json).
- Query pattern `https://index.commoncrawl.org/CC-MAIN-2026-43-index?url=*.example.ca&output=json`; each row has `filename/offset/length` for a Range read from data.commoncrawl.org ([secondary: Common Crawl index query by URL](https://moltchat-agent-commons.onrender.com/wiki/Common_Crawl_index_query_by_URL)). The index server is shared and rate-limits; **no official number found (UNVERIFIED)**: one request at a time with a multi-second pause, as the plan's "low volume, monthly" says.
- **Keyword discovery is not practical through the CDX API**: it indexes URLs, not page text. A `.ca`-wide query is the whole Canadian web; what works is (a) URL patterns on *known candidate domains* (does `/products/` or `/collections/luggage` exist?), (b) the columnar index (Parquet) for bulk filters, which means downloading index files (GBs). The size of a `.ca` filter: **UNVERIFIED** (measure with one Athena/DuckDB query on one crawl's `url_host_tld = 'ca'` partition).
- Terms: Common Crawl keeps restrictions minimal, asks users to respect the crawled sites' terms, not republish beyond fair use or resell ([Common Crawl FAQ](https://commoncrawl.org/faq)); publishers are actively challenging AI uses of it ([News/Media Alliance letter, 2026-04-29](https://www.newsmediaalliance.org/nma-letter-to-common-crawl/)). The exact licence text at commoncrawl.org/terms-of-use was not retrieved: **UNVERIFIED**, read it before the first query.
- **Use for us:** candidate-domain discovery only (does a store exist, which platform paths does it have), never prices or page content. Every candidate still goes through our own probe and the human terms read.

### 2.2 Brand dealer locators (Samsonite, TUMI, Travelpro, Briggs & Riley, Delsey, Heys)

- robots.txt status from the P0 probe: Samsonite.ca and TUMI allow our token (crawl-delay 10 s / 5 s + visit window) but serve PerimeterX challenges to us (blocked); Travelpro, Briggs & Riley, Heys and Delsey allow `/pages/*` paths (`scripts/bench/robots-paths.ts` shows `/policies` and `/search` rules only).
- The exact locator URLs were not looked up tonight (each store needs one request to find it): **UNVERIFIED**. Plan: add each brand's locator URL to the registry by hand (a human finds it in a browser), then one robots-checked read per brand per month.

---

## 3. robots.txt and AI user agents

- **RFC 9309**: crawlers MUST match their product token case-insensitively to a group and obey it; several matching groups are merged; otherwise the `*` group; "the most specific match found MUST be used", where most specific = most octets; 4xx on robots.txt = no restrictions, 5xx/unreachable = assume complete disallow. [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html).
- **Our code vs RFC:** `politeness/robots.ts:70` picks a named group when `token.includes(agentValue)`. A group named by any substring of `luggagetrackerbot` (e.g. `User-agent: bot`, `tracker`) would be chosen for us. RFC 9309 matches the product token; this is a **low-severity deviation** (it can make us obey a stricter or looser group than intended). Fix: exact token match (case-insensitive), ignoring version suffixes.
- **How stores treat AI agents (secondary data, methods vary):** ~30.8% of 107 prominent sites blocked GPTBot in a June 2026 sample; Dark Visitors reports ~20% of top sites block ClaudeBot (July 2026); ~8.7% of all sites block GPTBot ([ustechautomations](https://ustechautomations.com/resources/blog/how-many-sites-block-gptbot-2026), [Dark Visitors: ClaudeBot](https://api.darkvisitors.com/agents/claudebot), [Cloudflare-network analysis](https://technologychecker.io/blog/robots-txt-ai-crawlers-blocking-report)). Our own audit found Samsonite.ca's robots.txt explicitly allows Claude/OpenAI/Perplexity bots (`docs/STORE_AUDIT.md` §1.3).
- **Policy for our single-page reads (decision D5):** identify as `LuggageTrackerBot` only (never borrow GPTBot/ClaudeBot/ChatGPT-User tokens, never a browser UA); obey the group that names `LuggageTrackerBot`, else `*`; if a store blocks a generic AI agent class but not us, we still read only what the `*`/our group allows, at one page per search, and record the robots text hash with the observation.

---

## 4. Ollama

| Fact | Source |
|---|---|
| `keep_alive` default 5 min; `0` unloads right after the answer; a negative value keeps the model loaded | [Ollama FAQ](https://docs.ollama.com/faq) |
| `OLLAMA_NUM_PARALLEL` default **1**; `OLLAMA_MAX_LOADED_MODELS` default 3 × GPUs (3 on CPU); `OLLAMA_MAX_QUEUE` default **512**, then **HTTP 503** "server overloaded"; queued requests run in order; a request waits while a model loads | same |
| On Windows Ollama inherits user/system environment variables; quit the app, set them, start it again | same. **Our run:** the server log's "server config" line confirmed `OLLAMA_MODELS=D:\ollama\models`, `NUM_PARALLEL:1`, `MAX_LOADED_MODELS:0` (auto), `VULKAN:true` |
| Structured outputs: a JSON schema in `format` constrains generation; the application must still validate | [KDnuggets Ollama cheat sheet](https://www.kdnuggets.com/wp-content/uploads/KDnuggets_Cheat_Sheet_Ollama_for_Local_Language_Models.pdf). **Our run:** `zod/v4` `z.toJSONSchema()` (zod 3.25.76 already installed) produces the draft-2020-12 schema Ollama accepts; JSON validity measured per model in `planning/v4/review/02_MEASUREMENTS.md` |
| Vulkan on Windows: off by default in some builds (`OLLAMA_VULKAN`), integrated GPUs dropped unless `OLLAMA_IGPU_ENABLE=1`; upstream llama.cpp has open Vulkan regressions/hangs on some AMD parts | [administrator.de tutorial](https://administrator.de/tutorial/ollama-amd-radeon-890m-gpu-beschleunigung-ryzen-ai-678152.html), [llama.cpp weekly report](https://buttondown.com/weekly-project-news/archive/weekly-github-report-for-llamacpp-september-07-3592/). **Our run:** RX 6500M detected by Vulkan (4.0 GiB, 3.4 GiB free), models ran 95% on GPU; the log warns "AMD driver is too old" (that is the ROCm path) |
| Linux arm64: an official `ollama-linux-arm64` build exists; **no Ampere A1 tokens/s figure found (UNVERIFIED)**; generic reports put small models on server CPUs at single-digit tokens/s | [Ollama Linux install guide (secondary)](https://mustafa.net/2026/10/06/how-to-install-ollama-and-run-local-llms-on-linux/), [OpenBenchmarking ollama](https://mail.openbenchmarking.org/test/pts/ollama) |
| Calling it from the worker: one request at a time per lane, a hard timeout per call, treat 503/timeout as "AI unavailable" and fall back to rules; never on the interactive search path | design consequence of the FAQ above |
| Library sizes (ollama.com, today): `llama3.2:3b` 2.0 GB; `qwen3:4b` 2.5 GB (256K ctx); `qwen3:4b-q4_K_M` 2.6 GB (40K ctx, the hybrid thinking model); `qwen3:4b-instruct`/`-thinking` (2507) 2.5 GB each; `qwen2.5:3b` 1.9 GB (32K); `phi4-mini:3.8b` 2.5 GB (128K); `gemma3:4b` 3.3 GB (over our 3 GB cap) | [ollama.com/library/qwen3/tags](https://ollama.com/library/qwen3/tags), [qwen2.5/tags](https://ollama.com/library/qwen2.5/tags), [phi4-mini/tags](https://ollama.com/library/phi4-mini/tags) |

---

## 5. Small-model extraction and matching quality (what the literature says)

- **Attribute extraction (WDC-PAVE)**, Brinkmann, Baumann, Bizer 2024: GPT-4 ≈ **91% F1** (90.54 on one leaderboard), GPT-3.5 88.0, best pre-LLM extractor (AVEQA) 80.8; 59 websites, 5 categories. The paper evaluates hosted models; **no open small model numbers in it** (confirmed absent in the summaries). [arXiv 2403.02130](https://arxiv.org/abs/2403.02130v4), [Uni Mannheim note](https://www.uni-mannheim.de/dws/news/paper-accepted-for-adbis-2024/).
- **Entity matching (WDC Products, 80% corner cases, 4,500 test pairs)**, Steiner, Peeters, Bizer 2024, zero-shot F1: **Llama 3.1 8B 53.4**, Llama 3.1 70B 75.2, GPT-4o-mini 81.6, GPT-4o 81.6; Llama 3.1 8B fine-tuned 69.2. [arXiv 2409.08185, Table II](https://arxiv.org/html/2409.08185v2). Peeters, Steiner, Bizer (EDBT 2025): open models approach hosted ones only with task-specific examples or matching rules ([madoc](https://madoc.bib.uni-mannheim.de/68185)).
- **What it means for us:** a 3–4 B model will do *worse* than 8 B on hard matching pairs. It must never auto-merge; at most it breaks ties inside the grey zone that rules already narrowed, with "different" as the default and a human queue behind it. For attributes, structured data and spec-table rules come first; the model is a fallback for free text, gated by the evidence check. Our own measurements (02) decide per task.

---

## 6. Legal and ethics refresh (summary only; not legal advice)

- **Facts vs compilations (Canada):** facts aren't protected; a compilation is protected only if its selection or arrangement shows skill and judgment (CCH Canadian v Law Society, 2004 SCC 13, as summarised by [ShiftLaw](https://shiftlaw.ca/copyright-and-factual-content/)). The Federal Court enjoined scraping of MLS data in the TREB/MongoHouse matter ([Canadian Lawyer](https://canadianlawyermag.com/news/opinion/federal-court-makes-clear-website-scraping-is-illegal/276128)), and firms warn of contract claims based on terms of use ([Torkin Manes](https://www.torkin.com/insights/publication/scraping-the-surface-openai-sued-for-data-scraping-in-canada)). CanLII v Caseway AI is pending ([BetaKit](https://betakit.com/online-legal-database-canlii-sues-caseway-ai-for-alleged-copyright-infringement)).
- **Images: Trader v CarGurus, 2017 ONSC 1841**: dealer photos scraped and framed; framing = making available to the public; fair dealing rejected (commercial purpose, alternatives existed); statutory damages **$305,604** for ~152,500 photos (≈ $2/photo, a derived figure), not the $98 M claimed. [Bennett Jones](https://www.bennettjones.com/Insights/Blogs/2017/04/Yes-Copying-Photographs-from-the-Internet-Can-Get-You-into-Trouble), [Norton Rose Fulbright](https://www.nortonrosefulbright.com/en/knowledge/publications/ed6d21da/ip-monitor---car-websites-scraped-but-only-slightly-dented), [Torys](https://www.torys.com/insights/publications/2017/06/internet-framing-is-a-valid-ground-for-copyright-infringement-in-canada).
- **Terms of use:** our own read tonight (requests #10, #12): Delsey's terms page is Terms of Sale only, no automated-access clause; U.N. Luggage has no bot clause but says content may not be "reproduced, republished, distributed, displayed … without the express written permission" and is for "personal, non-commercial use only" (the ⚖ human read in HUMAN_ACTIONS §4 must weigh this).
- **Privacy:** PIPEDA has no broad "publicly available" exemption (OPC's Clearview finding, summarised by [ML Taikins](https://www.mltaikins.com/?p=16897)); prices and specs aren't personal information, but reviews or seller names can be. Keep the engine to product data.
- **robots.txt** is a signal, not a licence: obeying it is necessary for us, not sufficient (terms still apply).
- **Common Crawl:** see §2.1.
- **A lawyer should confirm:** (1) using store-published UCP channels where terms carry Shopify's anti-scrape clause; (2) U.N. Luggage's "reproduced … displayed" clause vs showing its prices internally; (3) whether showing a competitor's price inside our own internal tool is "commercial use" under "personal, non-commercial" clauses; (4) images: link-out vs thumbnails for internal use; (5) any external sale of the data (licence review per source); (6) the single-page-read policy for stores we have no agreement with.

---

## 7. Competitor teardown (what a luggage retailer needs every morning)

| Service | How it gets data | How it presents it | Take for us | Skip |
|---|---|---|---|---|
| **Flipp** | Retailers publish their flyers to it (800+ retailers); revenue per read/click ([BetaKit](https://betakit.com/flipp-receives-61-million-strategic-growth-investment-from-general-atlantic/), [Publitas](https://www.publitas.com/blog/flipp-alternative/)) | Flyer pages, deals by store | "Deals this week" from promo emails and structured sale prices, dated and labelled | Flyer imagery, consumer app |
| **PriceSpy** | Feeds from retailers, 3–5 updates a day; CPC/CPA ([ChannelX](https://channelx.world/2019/06/meet-the-company-pricespy/)) | Price history, price-drop alerts, store ratings | Price-drop alerts on chosen products (we have the morning email), history tables | Consumer reviews, ratings |
| **Google Shopping** | Merchant Center product data from merchants (feeds or on-site structured data) per Google's merchant listing rules ([Google merchant listing structured data](https://developers.google.com/search/docs/advanced/structured-data/merchant-listing)) | Offers grid, "price drop" badges | Trust JSON-LD `Offer`/`priceValidUntil`/strikethrough like Google does | Ads, a general index |
| **Keepa** | Monitors Amazon only; history for 6B+ products (New, Used, Buy Box, offer counts); method not officially documented ([Keepa listing](https://apps.apple.com/us/app/-/id1518541385)) | Event-based history per price type | Event-based history per price type and per-field "last updated" (plan §5.2) | Amazon (terms forbid us) |

**What matters for Luggage Depot's daily routine** (from `docs/CLIENT_REVIEW.md` and the V2 workflows): (1) the 9:00 email with every competitor price for chosen bags, lowest first, changes since yesterday; (2) a quick search during a customer conversation (≤ 8 s); (3) knowing when a competitor runs a sale on the brands they stock (Samsonite, TUMI, Travelpro, Briggs & Riley, Delsey, Heys); (4) honest coverage ("we can't read Costco"). **Must match:** fresh prices (hours, not weeks: tonight's Delsey finding), sale/was prices, promotions with end dates, alerts. **Skip:** consumer features, reviews, charts (the client rejected graphs), a general web index.

---

## 8. Hosting and storage facts

| Fact | Source |
|---|---|
| Oracle Always Free A1: **1,500 OCPU-hours and 9,000 GB-hours per month = 2 OCPUs and 12 GB** for Always Free tenancies; 200 GB block volume + 5 backups; 20 GB object storage; Always Free resources only in the **home region** | [Oracle docs: Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) |
| The cut from 4 OCPU/24 GB to 2/12 happened in 2026; secondary sources disagree on the date (June 15 vs Aug 18, 2026) | [InfoQ](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/), [labmemo (ja)](https://labmemo.com/?p=55273) |
| Idle reclamation: over 7 days, CPU p95 < 20% **and** network < 20% **and** memory < 20% (A1 only) | Oracle docs above |
| Sign-up: "most users will need a mobile phone number and a credit card"; the card isn't charged unless the account is upgraded | [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) (via search summary; quote not fetched directly: **UNVERIFIED wording**) |
| Supabase Free: 500 MB database per project, 5 GB egress/month, 2 active free projects, pauses after 7 days of inactivity; Pro $25/month (8 GB, no pause) | secondary: [Toolradar](https://toolradar.com/blog/supabase-pricing-2026), [Jetadmin](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/); **UNVERIFIED** against supabase.com/pricing |
| Playwright on arm64 Ubuntu: documented for Ubuntu 22.04/24.04 (secondary); an Ubuntu 26.04 beta issue existed | [playwright issue #40117](https://github.com/microsoft/playwright/issues/40117), [newreleases (Debian 12 arm64)](https://newreleases.io/project/github/microsoft/playwright-dotnet/release/v1.37.0); **UNVERIFIED** on the A1 image (check `npx playwright install --with-deps chromium` on the VM) |
