# LuggageTracker: Client Review (Deep Dive)

Date: 2026-10-10 · Reviewer stance: Luggage Depot Inc. as a paying client comparing us against competitors (Prisync, Price2Spy, camelcamelcamel/Keepa-style trackers).
Fixed client decisions (2026-10-10): **$0 budget**, **one shared login**, **no "our price" comparison**, **no graphs**, **morning email at 9:00 with chosen products**.

---

## Verdict as the client: **No, not yet.** It becomes a "yes" once the P0 items below are done.

What we would accept today: the verified engine is fast (first price 0.6–1.3 s), correct on what it can read (115/115 prices matched store pages in the shadow run), and honest about what it can't read.

Why we would reject it today:

1. **We asked for Amazon, Walmart and Samsonite prices and mostly get links.** Only 2 stores (Canada Luggage Depot, Delsey.ca) give verified prices today. A competitor tool shows a number for every store.
2. **The "Web research" mode showed wrong prices.** For example, a Samsonite Paralux **Large** at **$150** (cheaper than the Medium, with the same 47 L spec), and domino sets and pigeon rings for "Aluminum Carry-On". One wrong price in front of a manager ends the trial.
3. **The morning email we asked for doesn't exist as specified.** Today's daily report has these problems:
   - It covers *all* tracked products, not the ones we choose, and shows only the top 5 "lowest finds".
   - It goes to one address.
   - It runs at 15:00 UTC, which is 9:00 in summer but **8:00 in winter**. On Vercel Hobby it can also arrive **anywhere up to 59 minutes late**.
   - Its sender is a placeholder, and with the `resend.dev` sender Resend **only delivers to the account owner's own address**.
4. **Graphs everywhere** (Price History line chart, sparklines) after we said graphs are hard to read.
5. **Technical language visible to us.** We have one shared login, so we *are* the admin. The Admin page and several labels say things like "shopify_product_json", "UCP_AGENT_PROFILE_URL" and "adapter".
6. **Copy overclaims coverage:**
   - The search header says "Live lowest prices from Amazon, Walmart, Samsonite and 15+ Canadian retailers".
   - The login page says "Compare prices across 15+ Canadian retailers".

   Both are untrue for verified prices today.

---

## 1. Errors found (verified in this session unless marked)

| # | Error | Evidence | Severity |
|---|---|---|---|
| E1 | Web research returns wrong prices and wrong identities (Paralux Large $150 at Samsonite.ca; Large shows Medium's 47 L) | Screenshot 2026-10-09 23:40 | **Critical** |
| E2 | Web research returns non-luggage junk (domino set, pigeon rings) for "Aluminum Carry-On" | Screenshot 2026-10-09 23:32 | **Critical** |
| E3 | Search opened on Web research instead of Verified prices. The default falls back to web mode when the engine isn't reachable, and a choice is remembered in localStorage | `src/app/search/page.tsx` L102–124 | High |
| E4 | Daily report: all tracked products, top 5 only, single recipient, no product selection | `src/app/api/cron/daily-report/route.ts` | **Critical** (core client requirement) |
| E5 | Report time is fixed at `0 15 * * *` UTC, which is 9:00 MDT but 8:00 MST. The Settings "Timezone" field is never used | `vercel.json`, `user_settings.timezone` | **Critical** |
| E6 | Vercel Hobby cron precision is ±59 min, and Hobby is restricted to non-commercial personal use | Vercel docs (sources below) | **Critical** (business/legal) |
| E7 | Resend `resend.dev` sender only delivers to the Resend account's own address. `REPORT_FROM_EMAIL` is a placeholder (`reports@yourdomain.com`) | Resend docs; `.env.local` screenshot | **Critical** |
| E8 | No send log and no idempotency: a retried cron sends duplicates, and a failed send is invisible to the client | daily-report route | High |
| E9 | Graphs: `recharts` LineChart on /history and /products/[id]; Sparkline on cards | `src/app/history/page.tsx`, `src/components/Sparkline.tsx`, `ProductCard.tsx` | High (client requirement) |
| E10 | Identical rows per colour (3 × $434.95), and two pages at the same store for one product ($1,810/$1,815 Tumi) | Screenshots, CLI run | Medium |
| E11 | eBay row said "terms don't allow automated price checks" when the real cause is missing API keys | **Fixed this session** (uncommitted) | Low |
| E12 | Raw setup details shown to shoppers ("UCP_AGENT_PROFILE_URL", flag keys); "Couldn't verify" list | **Fixed this session** (uncommitted) | Medium |
| E13 | Settings retailer list is stale: includes Hudson's Bay (defunct), RIMOWA and CALPAK (not in the registry); doesn't match the 24-store registry | `000_complete_setup.sql` L75–80 | Medium |
| E14 | Store chips in web mode include Hudson's Bay (defunct) | Screenshot | Low |
| E15 | AI chat (Gemini) invites "What's the cheapest Samsonite right now?" but only knows tracked products, so it risks invented prices | `src/components/AiChat.tsx`, `src/app/api/chat/route.ts` | High |
| E16 | Public **Create Account** tab. With one shared login, strangers could sign up and spend the free Tavily credits | `src/app/page.tsx` L25, L218–229 | High (security/cost) |
| E17 | Accessories under $15 are silently rejected by the $15–$6,000 band (tags, locks) | Admin → Failures screenshot | Low (bags-only is acceptable; document it) |
| E18 | Exposed secrets: Resend key, CRON_SECRET and SerpAPI key visible in screenshots/chat | Screenshots | **Critical** (rotate) |
| E19 | `dev-db.ts` failed when a stopped container existed | **Fixed this session** (uncommitted) | Low |
| E20 | Supabase Free pauses projects after 7 days of low activity, which would stop the morning email silently | Supabase docs | Medium |

Not verified (needs a check by the coding agent):

- mobile layout of every page;
- Tracked Products page after the engine bridge writes;
- the behaviour of "Track" on a multi-colour product;
- Gemini free-tier data-use terms;
- Tavily free-plan commercial-use terms;
- Gmail SMTP daily limits.

---

## 2. What competitors do that we don't (and what we should take)

Sources: Prisync profile and reviews, Price2Spy feature page, Omnia (Capterra). Only features that fit a **$0, one-login, no-own-price, no-graph** client are kept.

| Competitor feature | Take it? | Why |
|---|---|---|
| Daily email summary of chosen products (Prisync Premium) | **Yes, P0** | It is the client's point 4 |
| Price + **stock** tracking per store (Prisync, Price2Spy) | **Yes, P0** | A cheap price that is out of stock is useless to a salesperson |
| Price-change notifications (both) | Yes (already have target alerts). Extend to "dropped since yesterday" in the email | Matches the daily routine |
| **Excel/CSV export** (Prisync Professional) | **Yes, P1** | Managers live in spreadsheets; it costs nothing |
| **Batch import** of products (Prisync) | Yes, P1 | Choosing 30 bags one by one is painful |
| Product **groups** (Prisync "custom product groups") | Yes, P1 | "Samsonite carry-ons", "TUMI" groups make choosing email products fast |
| **Broken-link alerts** (a Prisync *complaint*: it lacks them) | **Yes, P1** | A cheap differentiator: tell the client when a store link stops working |
| Price history (camelcamelcamel/Keepa) | Yes, **as tables, not charts** | The client explicitly rejected graphs |
| "Lowest in 30 days" / "highest" labels (camelcamelcamel) | Yes, P0 | Replaces graphs with one readable line |
| Product matching (Price2Spy AI matching) | Already have (UPC → model → brand+line+size + review queue) | Keep; make the review queue plain-English |
| Repricing rules, MAP monitoring, screenshots | **No** | For brands/repricers; the client declined our-price comparison |
| Dashboards with infographics | **No** | The client rejected graphs; use numbers and words |

---

## 3. Three review passes

### Pass 1: missing features and requirements

- **R-Email:**
  - The client chooses products.
  - Multiple recipients.
  - Sent daily at **9:00 America/Edmonton, DST-correct**.
  - Every chosen product shows its price at every store we have, lowest first.
  - Changes since yesterday are shown.
  - Has a send-test button, a preview, and a send log.
- **R-Prices:** the lowest price first, plus prices from other stores, not just links (point 3) **within $0**. The only honest $0 route for Amazon, Walmart and Samsonite is clearly labelled **web estimates** that pass strict checks, plus staff-checked prices and dealer feeds. Links are a last resort.
- **R-NoGraphs:** tables and plain-language change lines.
- **R-Stock:** in stock / out of stock wherever a store tells us.
- **R-Export:** CSV/Excel of the current prices of chosen or all tracked products.

### Pass 2: logic flaws and technical limits

- **Freshness at 9:00.**
  - Problem: prices in the email must be checked *that morning*. If a store can't be read, the last known price is shown with its date and never passed off as today's.
  - Fix: a "prepare" run at 8:00 and the send at 9:00.
- **Scheduling.**
  - Problem: Vercel Hobby can't do 9:00 sharp, and Vercel Hobby is non-commercial.
  - Fix: the scheduler must not depend on Vercel. Supabase `pg_cron` + `pg_net` (documented by Supabase) ticks every 15 minutes, and the app decides "is it 9:00 in Calgary and not yet sent today?" (idempotent). Fallbacks: the worker's pg-boss schedule (supports time zones) or Vercel cron.
- **Email delivery at $0.**
  - Resend: a free plan of 100/day and 3,000/month, but it needs a **verified domain** to reach anyone except the account owner.
  - Fallback: SMTP from a Luggage Depot Gmail with an app password (Google publishes per-account limits; to be checked).
  - Build a provider switch.
- **Tavily budget.**
  - The app cap is 950 credits/month, about 31/day.
  - Estimates for N email products cost about N credits/day, so ~20 products leaves ~10/day for searches.
  - Budget-aware refresh is needed: rotate estimates when over budget, never exceed the cap, never turn on pay-as-you-go.
- **Estimate accuracy.**
  - Problem: E1/E2 prove raw web results are unsafe.
  - Required checks:
    - same identity (brand + line + size, version agreeing, UPC when present);
    - the store's own product URL, not a category or search page;
    - a price with a "$";
    - within 0.6×–1.5× of the verified median for that product, or of other estimates when no verified price exists;
    - else hidden.
  - Labels: estimates are always labelled "Web estimate · confirm on site", never "Verified".
- **Duplicates.**
  - Problem: colours and twin pages repeat the same price.
  - Fix: one row per store, with the lowest price and colour chips.
- **Supabase pausing.**
  - Problem: the project can pause after 7 quiet days, which kills the email.
  - Fix: the daily email run makes database requests (activity). Document and monitor it.

### Pass 3: usability and business risks

- **One shared login means the client sees everything.**
  - Rename Admin to "Store status" in plain English, and hide technical details behind a "Technical details" toggle.
  - Disable public sign-up.
- **Trust.**
  - Every price shows where and when it was read.
  - Never show a number we can't defend.
  - Never claim "15+ retailers verified".
- **Coverage honesty.**
  - Until the UCP agent profile is published and the legal reads are done, verified coverage is **2 stores**. The client must hear that before launch, not after.
- **Daily workload.**
  - The review queue (11 items) is real work.
  - Make it 1-click approve/reject with plain wording, and show a count on the dashboard.
- **Failure visibility.**
  - If the 9:00 email fails, a banner shows in the app and the next email says so.
  - Silent failure is the fastest way to lose a client.
- **Legal and terms.**
  - Vercel Hobby is non-commercial. Options:
    - (a) self-host the Next.js app on the office PC or an Oracle Always Free VM, using the same worker plan;
    - (b) another free host whose terms allow business use (to be checked);
    - (c) accept Vercel Pro later.
  - This is a client decision; the code must run on both (`next start` + Docker).

---

## 4. Prioritised changes

### P0: Essential (any one missing → likely rejection)

| # | Change | How it raises approval |
|---|---|---|
| 1 | **Morning email** (chosen products, multiple recipients, 9:00 Calgary DST-correct, idempotent, preview, test send, send log, failure banner) | Delivers the client's explicit requirement |
| 2 | **One search view, lowest first, all stores with numbers:** verified prices, then strict web estimates, then staff/feed prices; links only when nothing else exists. Remove the separate "Web research" mode | Point 3 without wrong numbers |
| 3 | **Estimate validator** (identity, own-product-URL, ratio band, junk filter) with tests built on E1/E2 | Removes the two embarrassing failures |
| 4 | **No graphs:** history as tables, "Lowest in 30 days" labels, change arrows with $/% | Point 5 |
| 5 | **Plain-English UI for the single login**; honest coverage copy; public sign-up off | Trust and security |
| 6 | **Email delivery that works at $0:** a Resend verified domain or Gmail SMTP switch | Without it the email never arrives |
| 7 | **Scheduler independent of Vercel Hobby** (pg_cron tick + idempotent run table) and app deployable outside Vercel | Exact 9:00 and terms compliance |
| 8 | **Collapse duplicate rows** (colours, twin pages) | Readability |
| 9 | **Stock status** in search, tracked products and email | Business usefulness |
| 10 | **AI chat:** off until it answers only from stored, dated prices | No invented prices |
| 11 | Rotate exposed secrets; settings retailer list from the registry | Security and correctness |

### P1: Recommended

12. CSV/Excel export.
13. Product groups (for search filters and quick email selection).
14. CSV batch import of products to track.
15. Broken-link detection shown in Store status and the email.
16. A dashboard "Today" summary:
    - drops and increases since yesterday;
    - targets hit;
    - stores that couldn't be checked;
    - review items waiting.

### P2: Optional (needs human action, not code)

17. Publish the UCP agent profile (adds up to 6 Shopify stores after the legal read).
18. Free eBay API keys.
19. Read the terms of U.N. Luggage and Bentley.
20. Ask for the Samsonite dealer price list.
21. Accessories price band, if the client wants tags and locks.

---

## 5. Risks that remain even after all P0 work (be upfront with the client)

- **Amazon, Walmart, Best Buy, Costco and Canadian Tire will never be "verified live" at $0.** They will show *web estimates* (when found and validated), staff-checked prices, or a link. That is the honest ceiling of a $0 budget.
- **Tavily free credits cap how many products can get daily estimates** (about 20 at the current cap).
- **Free tiers can change their terms** (Tavily, Resend, Supabase, Gemini). Each is behind a switch, and the app keeps working with that piece off.
- **Hosting on Vercel Hobby breaks Vercel's non-commercial rule.** The client must pick a host.

## Sources

- [Vercel cron usage & pricing (Hobby: once/day, ±59 min)](https://vercel.com/docs/cron-jobs/usage-and-pricing)
- [Vercel Hobby plan (non-commercial personal use only)](https://vercel.com/docs/plans/hobby)
- [Resend account quotas (free: 100/day, 3,000/month, 3 domains)](https://www.resend.com/docs/knowledge-base/account-quotas-and-limits.md)
- [Resend 403 / resend.dev restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- [Supabase: scheduling with pg_cron + pg_net](https://supabase.com/docs/guides/functions/schedule-functions)
- [Supabase: free project pausing (7 days)](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Prisync profile, pricing and reviews (Software Advice)](https://www.softwareadvice.com/pricing-optimization/prisync-profile)
- [Price2Spy main features](https://price2spy.com/?p=14281)
- [Omnia Retail (Capterra)](https://capterra.com/p/166274/Omnia/)
- [SerpApi pricing (free 250/month, Starter $25), considered and rejected under $0](https://serpapi.com/pricing)
- [Amazon Creators API eligibility (10 qualified sales / 30 days)](https://affiliatexblocks.com/docs/amazon-creators-api/)
- [Walmart Canada affiliate program (via Rakuten; product-feed access not confirmed)](https://www.walmart.ca/en/cp/affiliate-program/6000208941216)
