# LuggageTracker — Project Brief

**Status as of:** 28 September 2026
**Owner:** Vansh Tuteja
**Client:** Luggage Depot Inc. (Calgary, multi-location luggage retailer)
**Repo:** `luggage-watch-main`

> **Using this as a prompt.** This file is self-contained. Paste the whole thing
> into any assistant or hand it to a teammate and they have the full picture:
> what we're building, why, what's already been proven, and what still needs to
> be found out. Section 10 is the research brief for the next phase.
> Anything marked *(assumption)* hasn't been confirmed with the client yet.

> **Update, 28 Sep 2026: research moved from SerpAPI to Tavily.** Tavily
> returns the retailers' own pages (direct store links, which SerpAPI's
> Google Shopping results no longer included), and one search yields price,
> stock and specs together. Sections 8–9 below record the SerpAPI findings
> that led to this. The Tavily design is in the decision log (section 13)
> and in `SETUP.md`.

---

## 1. One-line summary

A web app where Luggage Depot staff type a bag's name, see what it sells for at other Canadian retailers (cheapest first, with links), then track it and get alerted when a competitor's price moves.

---

## 2. The problem

Luggage Depot competes on price with:

- **Big-box and online stores:** Amazon.ca, Walmart.ca, Costco, Best Buy, Staples
- **Brand-direct stores:** Samsonite.ca, Travelpro, TUMI
- **Other luggage specialists:** Bentley, Bagages Mira, Luggage City, Modern Tourist

Right now, checking a competitor's price means searching each site by hand, one bag at a time. *(assumption)* So it's slow, the results aren't consistent from one person to the next, and it doesn't happen often. The store tends to hear about a cheaper price from a customer at the counter.

There is also **no memory**. Nobody can say "Walmart dropped this bag $40 last week" or "Amazon is always cheapest on Samsonite spinners", because nothing gets recorded.

---

## 3. Goal

**Primary.** For any bag, show its lowest current prices across Canadian retailers:

- the top 10 sellers, cheapest first
- major retailers (Amazon, Walmart, Samsonite, and so on) included whenever they carry it
- every price traceable to a real listing

**Secondary.** Track chosen bags over time:

- scheduled price refresh
- price-history chart
- an alert when a price falls below a target
- a daily email report to `yycluggagedepot@gmail.com`

### Client's requirement, in the owner's words

> "The search should work like an AI search, where it can track the real price
> data and the details of the luggage from online. It will pick from the top 10
> websites which have the lowest price, which must include Amazon, Samsonite,
> Walmart and more of the major retailers. In short, it acts like a search
> engine for our product, with the LLM."

---

## 4. Aim: what "done" means for the client demo

Each point is testable. If any one fails, the demo isn't ready.

1. **Search works.** Typing `Samsonite Rhapsody 360` returns a list of real matching bags with CAD prices and retailer names in under ~20 seconds.
2. **Compare works.** Opening one bag shows every seller found for it, cheapest first, each with a working link to that store.
3. **Majors show up.** Amazon, Walmart and Samsonite appear whenever they sell the bag.
4. **Tracking works.** Tracking a bag puts it on the Tracked Products page, and its price history starts that day.
5. **Repeats are free.** Running the same search again within 6 hours costs zero API calls, because it's served from cache.
6. **No invented prices.** Every number on screen traces back to a fetched listing.
7. **$0 spend.**

---

## 5. What it solves

| Today | With LuggageTracker |
|---|---|
| Minutes per bag, per site, by hand | One search, seconds |
| Prices checked occasionally, if at all | Tracked bags refresh on a schedule |
| No record of competitor moves | Price history builds automatically |
| Finding out from customers | Alert when a competitor drops below your target |
| Gut-feel pricing | Pricing backed by evidence |

---

## 6. Hard constraints (non-negotiable)

1. **Zero spend.** Free tiers only. See section 9 for what that allows.
2. **Canada only.** Prices are in CAD, and searches use Google Canada (`gl=ca`, `google.ca`).
3. **The LLM never produces a price.** AI may interpret the query and group listings into products. Prices come only from fetched listings, and each one carries its source.
4. **Security.**
   - Every user-facing API route authenticates the caller.
   - Supabase Row Level Security decides what a user can read or write.
   - The service-role key is used only by cron jobs.
5. **Secrets stay out of chat and out of git.** Environment variables are always set by hand in `.env.local`.

---

## 7. Current system

### Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| UI | Tailwind v4, shadcn/ui, Recharts, lucide-react |
| Data fetching | TanStack Query |
| Database + auth | Supabase (Postgres, Auth, Row Level Security) |
| Research / prices | Tavily web research (Canada), 1 credit per lookup, hard-capped at $0 |
| AI (optional) | Google Gemini, for query parsing and product grouping; falls back to non-AI logic |
| Email | Resend |
| Hosting + scheduled jobs | Vercel, Vercel Cron / GitHub Actions |

### Search pipeline today

```
query
  → cache lookup          (Supabase, free; skipped if slow)
  → parse intent          (plain queries skip the LLM entirely)
  → SerpAPI Google Shopping (widens the query automatically if Google finds nothing)
  → group into products   (Gemini, or an instant heuristic)
  → filter + rank         (majors first, then retailer coverage, then price)
  → return top 10         (and cache in the background)
```

### Pages

Dashboard, Search Products, Tracked Products, Price History, Settings.

### Tooling

| Command | What it does | Cost |
|---|---|---|
| `npm run diagnose` | Checks every dependency, including SerpAPI searches left | Free |
| `npm run diagnose -- --live "<query>"` | Makes one real search and saves the raw response | 1 search |
| `npm run verify:search` | 177 offline checks on the search pipeline | Free |

---

## 8. What we've learned (evidence, not assumptions)

### From a real SerpAPI response (`samsonite luggage`, saved as `serpapi-response.json`)

| Finding | Detail |
|---|---|
| SerpAPI works | HTTP 200, 40 listings, **11 s** server time |
| Prices are reliable | `extracted_price` on 40/40 rows |
| Retailer names are there | `source` on 39/40, e.g. Walmart.ca, Amazon CA, Samsonite Canada, Staples Canada, Shop Bentley, Bagages Mira, Luggage City, Canada Luggage Depot |
| **No store links at all** | 0/40 rows have `link`. The only URL, `product_link`, opens Google's product panel. No retailer domain appears anywhere in the 328 KB response. |
| **One seller per row** | `multiple_sources: true` appears on 13 rows, but it's a yes/no flag; the other sellers aren't listed |
| `num` is ignored | You always get 40 results |
| ~5 junk rows | Foreign sellers (Costa Rica, Saudi Arabia) and bulk/promo listings ("6 pcs…", "Custom…") priced over $900 |
| Same bag listed twice | Walmart shows it once in English and once in French; Bentley and Empire Luggage each list the same bag twice |
| Grouping tool offered | Every row includes `immersive_product_page_token` and a ready-made `serpapi_immersive_product_api` URL |

### What that means

**A Google Shopping search gives a catalog, not a comparison:** many bags, one seller each. The client's core ask, "top 10 cheapest websites for *this* bag", can't be met from a search alone. Per-bag seller lists and direct store links most likely come from SerpAPI's `google_immersive_product` engine, one call per bag. **That hasn't been verified yet** (see R1).

### Lessons from debugging

Every failure so far came from one of two things:

- **Data shape:** the code rejected fields that Google no longer sends.
- **Time budgets:** Gemini and slow database calls used up the window before SerpAPI was even called.

None of it was environmental. That's why **Docker isn't planned**: it wouldn't change what the API returns, and the app deploys to Vercel, which doesn't use it. Revisit only if we self-host or teammates need an identical dev setup.

---

## 9. Proposed approach (pending research)

### Option B: two-step search, then compare

1. **Search** (1 call, cached for 6 h). Show a list of matching bags, each with its best price and seller.
2. **Compare** (1 call per bag, only when a bag is opened or tracked). Fetch every seller for that bag, cheapest first, with direct store links.

| Option | Calls | Verdict |
|---|---|---|
| A. Search list only | 1 per search | Doesn't meet the client ask |
| **B. Search, then compare on demand** | 1 + 1 per bag opened | **Recommended** |
| C. Compare all 10 bags up front | 11 per search | Burns the monthly allowance in ~22 searches |

### Budget reality

SerpAPI's free tier is **250 searches/month** (242 left at last check).

- **Searches and comparisons:** about 120 "search, then compare" actions a month, fewer if people open several bags per search. Cached repeats cost nothing.
- **Scheduled refresh is the real pressure.** Refreshing a tracked bag costs 1 call each time.

| Tracked bags | Refresh cadence | Calls/month | Left for searching |
|---|---|---|---|
| 10 | Daily | ~300 | **None. Over budget.** |
| 10 | Weekly | ~43 | ~200 |
| 20 | Weekly | ~86 | ~160 |
| 30 | Every 2 weeks | ~65 | ~185 |

So under zero-spend, **daily tracking of more than ~5 bags isn't possible on SerpAPI alone.** R3 and R4 look for a way around that.

---

## 10. Research brief (next phase)

Ordered by priority. For each question: why it matters, the cheapest way to answer it, and what it unblocks.

| # | Question | Why it matters | How to answer (cheapest first) | Unblocks |
|---|---|---|---|---|
| **R1** | What does `google_immersive_product` actually return? Seller list? Direct store links? Canadian sellers? Price fields? How many sellers? | Option B depends on it entirely | Call the `serpapi_immersive_product_api` URL already in `serpapi-response.json` once (**1 search**), save the output, read it | Go/no-go on Option B |
| **R2** | Is `product_id` stable across days? Does the immersive token expire? | Refresh needs to find the *same* bag again | SerpAPI docs; then compare two searches a few days apart | Refresh design |
| **R3** | How do we refresh tracked bags within 250/month? | Section 9 shows daily refresh is over budget | Math plus options: weekly cadence, refresh only bags with alerts, cache aggressively | Tracking promise to the client |
| **R4** | Does Serper.dev's shopping endpoint return store links or multiple sellers for Canada? | 2,500 free one-time credits could carry refresh | Serper docs, then 1 test call | Second price source |
| **R5** | Does SerpAPI's `google_shopping_light` engine give the same data faster? | Speed and reliability | SerpAPI docs | Possible engine swap |
| **R6** | Is the retailer registry accurate? Which retailers still operate and sell luggage online in Canada? (Hudson's Bay reportedly wound down in 2025; verify.) What labels does Google actually use? | Wrong registry means majors get mislabelled or missed | Map the 40 real `source` labels, then a quick web check per retailer | Correct "major retailer" logic |
| **R7** | Is "Canada Luggage Depot" the client's own store? | If so, it should show as *you*, not as a competitor | Ask the client | Comparison view |
| **R8** | What exact rules remove junk rows? (foreign sellers, bulk/custom promo, sets vs single bags, English/French duplicates) | Junk distorts "cheapest" | Hand-label the 40 real rows, then write the rules | Result quality |
| **R9** | How do we match the same bag across retailers? Does immersive return GTIN/UPC or model numbers? | Needed for reliable comparison and history | Read the R1 output | Matching logic |
| **R10** | Are we allowed to display this data to a client commercially? (SerpAPI free-plan terms, Google's terms) | Legal exposure for the client | Read SerpAPI's terms and legal page. Not legal advice; flag anything unclear. | Go-live |
| **R11** | Platform limits: Vercel Hobby function duration and cron frequency; whether Supabase free projects pause when idle, and the project's region | Explains the slow requests and cron constraints | Vercel and Supabase docs, plus the Supabase dashboard | Hosting plan |
| **R12** | Is Gemini worth keeping? (free-tier stability vs the quality it adds over heuristics) | It has caused most of the timeouts so far | Compare grouping quality with and without it on the real 40 rows | Simpler, faster pipeline |

**Research rule:** don't build on a data shape we haven't seen. Every API assumption gets checked against a real saved response first, the way `serpapi-response.json` exposed the missing-`link` problem.

---

## 11. Known risks and open issues

| Risk | Impact | Fix |
|---|---|---|
| Migration `003_search_cache_and_quota.sql` not run | No cache, so every search costs a call | Run it in the Supabase SQL editor |
| Diagnostic's "usable" filter is stricter than the app's | Reports "0 usable" when the app would show results | Align the two filters |
| Two credentials were pasted into chat (Supabase secret key, SerpAPI key) | The Supabase secret key bypasses RLS entirely | **Rotate both** |
| `SUPABASE_SERVICE_ROLE_KEY` not set | Cron jobs can't run | Set it in `.env.local` after rotating |
| Search checked offline against the real response, but not yet end-to-end in the UI | Demo risk | One live UI test after migration 003 |
| Links go to Google's panel until the compare step exists | Weaker demo | Option B |
| `src/lib/serpapi.ts` is dead code | Confusion | Delete |
| `src/app/tracked/page.tsx` was written in Cursor | Could be overwritten by accident | Edit only deliberately |

---

## 12. Out of scope

- Scraping retailer websites directly
- Any paid API or paid plan
- Inventory or stock management (separate project)
- Buying or checkout
- Non-Canadian prices

---

## 13. Decision log

| Decision | Reason |
|---|---|
| Zero spend on APIs | Owner's constraint |
| **Tavily replaces SerpAPI for all product research** (28 Sep 2026) | Direct retailer pages and links; price + stock + specs from one call; 1,000 free credits/month |
| One Tavily search per lookup, basic depth, 20 results with page text | Minimum credits: no per-field searches, `auto_parameters` never sent |
| App-enforced monthly credit cap (950), checked against Tavily's own usage | A call that would exceed the free plan is never sent |
| Prices only from Canadian storefront pages, with the page words kept as evidence | No fake results; USD storefronts, list/was/instalment amounts rejected |
| Research is read-only; tracking/adding products stays in its own workflow | Keeps research and product creation separate |
| SerpAPI as the primary price source | Free tier, real Google Shopping Canada data |
| Gemini optional, never a price source | Free tier is unreliable; prices must be traceable |
| Gemini grounded search disabled | Needs billing |
| No Docker for now | Problems weren't environmental; Vercel doesn't need it |
| Option B recommended | Meets the client ask within budget; **pending R1** |
