# Price Engine: Final Report

Branch `feat/price-engine` (not merged; `main` untouched). Every phase of [`MASTER_PROMPT.md`](../MASTER_PROMPT.md) passed its checks; what remains are steps only a person can take, listed in order in [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md#go-live-checklist-in-order). Detail per phase: [`PROGRESS.md`](./PROGRESS.md).

## What was built

- **Evidence (P0):** a read-only probe of 24 stores and their channels from the office network; [`PROBE_REPORT.md`](./PROBE_REPORT.md) says per store what is accessible, reliable and permitted. It overturned the audit on Samsonite.ca and TUMI.ca (blocked by PerimeterX) and confirmed two stores we may read today.
- **Database (P1, P6):** migrations 004 and 005, 16 tables plus a health view and a retention function, RLS on every table, append-only price history, tested on a fresh Postgres 17.
- **Fetching that stays polite (P2):** source registry with permissions and fetchable hosts, robots.txt (RFC 9309), per-host crawl delays, single-flight, SSRF guard, circuit breaker, honest User-Agent, block classifier. A block is recorded and respected, never worked around.
- **Store adapters (P3):** Shopify UCP, Shopify product JSON, structured data (JSON-LD/microdata), eBay Browse API, Amazon Creators API (behind a flag), dealer feeds, manual entry; validation with confidence scores; tests on recorded real responses.
- **Research sessions and UI (P4):** `POST /api/research` returns at once; stores are checked in parallel; prices stream in as they are read (Realtime or NDJSON); every store gets a row; every price carries "Verified live · time" (or an honest older label) and its source link; 11 s deadline, re-verify, stop, per-user rate limit.
- **Index and identity (P5):** product sitemaps of permitted stores; identity by barcode, model number, then brand + line + size (+ stated inches); version numbers must agree, sizes never merge, near-matches go to a human review queue.
- **Daily jobs (P6):** tracked products re-verified through the engine and written to the tracking workflow's tables through a bridge; target-price alerts once per day; the existing daily report; retention.
- **Admin (P7):** `/admin` with store health and block rates, failures, review queue, session timings, flags, dealer-feed import, manual prices, discovery trigger.
- **Shadow mode (P8):** 35-product test set, side-by-side run against the old Tavily path with every price checked against the store's page; the default search was cut over to the engine.
- **Hardening and docs (P9):** a worker (Node 22, pg-boss, signed requests, Docker), production readiness checks, privacy and terms pages, GST/HST note, a manual-only CI workflow; README, SETUP, ARCHITECTURE, RUNBOOK, HUMAN_ACTIONS, `.env.example`.

## Results

**Quality gates (latest run):** `tsc` clean (app and worker) · `npm run lint` 0 errors (4 pre-existing warnings in `src/app/tracked/page.tsx`, which the rules forbid editing) · `next build` succeeds · `verify:search` 341/341 · engine tests 159/159 · migrations 48/48 and store contract on Postgres 19/19 · worker 7/7 including end-to-end on Postgres + pg-boss · probe self-test 36/36.

**Real runs against the stores:**
- Indexing: Canada Luggage Depot 3,167 product pages, Delsey.ca 414 (one language each); all 446 recorded requests to these two stores succeeded, none blocked.
- A research session for "Aluminum Carry-On" checked both stores in parallel: Canada Luggage Depot's first verified price at 1.15 s (done 4.1 s), Delsey.ca done at 8.2 s, the four blocked stores labelled, the eight link-only stores linked.

**Shadow run (31 products sold by a store we may read; [`SHADOW_REPORT.md`](./SHADOW_REPORT.md)):**

| | Engine | Old Tavily path |
|---|---|---|
| Expected product found | 31/31 | 23/31 |
| Prices equal to the store's page | 115/115 (100%) | 8/14 checkable (57%) |
| Wrong-product offers in the product's card | 0/93 | 7/35 |
| Unlabelled stale prices | 0 | — |
| First price p50 / max | 0.3 s / 2.3 s (31/31 ≤ 3 s) | 3.3 s / 4.5 s (12/31) |
| Complete p50 / max | 1.2 s / 8.3 s (31/31 ≤ 12 s) | 14.1 s / 20.5 s (10/31) |

Cost: $0. The old path used 120 of Tavily's 1,000 free monthly credits, metered by the app's cap.

## Coverage today, per store, and what changes it

| Store | Today | What unlocks it |
|---|---|---|
| Canada Luggage Depot | **Verified live** (product JSON, sanctioned by its agents.md) | UCP profile adds a second channel |
| Delsey.ca | **Verified live** (product JSON; terms silent) | — |
| Travelpro, Briggs & Riley, Heys, Monos, Away | Not set up | Publish the UCP agent profile (§1) + legal read of their anti-scrape clause (§5) |
| Luggage City | Not set up (switched off) | Legal read, then flag `source.luggagecity.ucp` |
| U.N. Luggage, Bentley | Not set up | A person reads their terms (§4), then a flag |
| JP Grimard | Not set up | Ask the store (no online terms found) |
| Samsonite.ca, TUMI.ca | Blocked (PerimeterX CAPTCHA) | Dealer price list from the Samsonite rep (§6): "Feed as of <date>" |
| Sporting Life, Simons | Blocked (Cloudflare challenge, even on robots.txt) | Only the stores themselves (permission or a feed) |
| eBay.ca | Link only | Free Browse API keys (§3) |
| Amazon.ca | Link only (terms) | Creators API once an Associates account qualifies, plus its flag |
| Walmart, Costco, Best Buy, Canadian Tire / Sport Chek, London Drugs | Link only (terms forbid automated access) | Official feeds or affiliate programs, if they offer one |
| Luggage Warehouse Vancouver | Link only (no online store) | Manual prices in `/admin` |
| Hudson's Bay | Removed (defunct) | — |

## Known limitations

- **Cross-store comparison is thin until more stores are readable.** The two stores readable today share almost no products (Canada Luggage Depot doesn't sell Delsey), so most verified answers come from one store until the UCP stores, U.N. Luggage and Bentley are enabled.
- **Web research reaches more stores but can't be verified.** It stays available as the second search mode, labelled as such; in the test, 6 of its 14 checkable prices were wrong.
- **Products that only link-only stores sell** show a link and, if we saw it before, a "Last seen …, not current" price, never a current guess. After the cut-over the daily job no longer spends Tavily credits on them while the engine is running.
- **Delsey.ca is slow by its own rules:** its 1 s crawl delay applies to two requests per page, so a 4-colour product takes 7–8 s (inside the deadline).
- **Identity is cautious:** across stores without a shared barcode, near-identical names go to the review queue rather than merging automatically.
- **Not yet seen signed in:** the new screens were checked through real sessions from the terminal and HTTP checks of every route; a person still needs to look at them signed in (§10), since signing in would have meant typing the owner's password.
- **Without a worker**, research and daily jobs run inside Vercel functions, with their time limits.
- The privacy and terms pages are plain-language summaries awaiting legal review (§11).

## Steps left to go live (in order)

1. Rotate the Supabase secret key and SerpAPI key that were once pasted in chat (§9).
2. Run migrations 004 and 005 and the registry seed in Supabase; add yourself to `app_admins` (§7).
3. Set `DATABASE_URL` (session pooler), `CRON_SECRET` and `CRAWLER_CONTACT` in Vercel (§2).
4. Deploy the branch to a preview; merge to `main` once the next steps check out.
5. Build the product index: `npm run engine:discover` with the production `DATABASE_URL`.
6. Publish the UCP agent profile: `UCP_AGENT_PROFILE_URL=https://<app>/.well-known/ucp-agent` (§1).
7. Get the legal read on UCP for stores with an anti-scrape clause, or turn `policy.ucp_on_restricted_stores` off (§5).
8. Look at the new screens once, signed in, on desktop and phone (§10).
9. Recommended: run the worker (office PC + Cloudflare Tunnel, or Oracle Always Free), probe from it first (§8).
10. When convenient: eBay keys (§3), three terms reads (§4), dealer feeds (§6), privacy/terms review (§11).
11. Keep Tavily on the free plan with pay-as-you-go off.
