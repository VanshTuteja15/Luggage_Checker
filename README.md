# LuggageTracker

Live luggage price monitoring across Canadian retailers, built for Luggage Depot Inc.

Search in plain language, see every retailer carrying a product side by side,
track it, and get told when the price drops.

---

## What it does

**Search** — Type "hardside carry-on under $300". Gemini interprets the query,
a shopping provider fetches real listings, Gemini groups those listings into
distinct products, and you get up to 10 products each showing every retailer
that carries it, cheapest first. Major Canadian retailers (Amazon.ca,
Walmart.ca, Costco.ca, Hudson's Bay, Canadian Tire, Best Buy, Bentley, London
Drugs) are never dropped from a result set when they carry the item.

**Track** — One click saves the product and all of its offers. Price history
starts recording immediately.

**Monitor** — Dashboard shows drops and increases since the last check.
Per-product price alerts email you when something falls below a target you set.
A scheduled job re-checks prices and sends a daily summary.

### The rule that shapes the whole design

**The LLM never produces a price.** It interprets queries and groups listings.
Every price and every URL comes from a listing a provider actually fetched. An
offer without a real source URL is discarded before it reaches you — in a price
tracker, a plausible-looking invented price is the most damaging possible
output.

---

## Stack

| Layer | |
| --- | --- |
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Styling | Tailwind v4, shadcn/ui, Recharts |
| Data | Supabase (Postgres + Auth + RLS) |
| Server state | TanStack Query |
| Prices | Serper.dev / SerpAPI (Google Shopping) |
| AI | Gemini — query parsing, product clustering, chat |
| Email | Resend |

---

## Getting started

See **[SETUP.md](./SETUP.md)** for the full walkthrough. The short version:

```bash
npm install
cp .env.example .env.local     # fill in the keys
npm run dev
```

Then run `supabase/migrations/000_complete_setup.sql` and
`003_search_cache_and_quota.sql` in the Supabase SQL Editor.

You need **one** price provider key — [Serper.dev](https://serper.dev)
(2,500 free searches) or [SerpAPI](https://serpapi.com) (250 free per month).
Neither asks for a credit card.

---

## Architecture

```
src/
├── app/
│   ├── api/
│   │   ├── search/     ← natural-language search across retailers
│   │   ├── track/      ← POST/DELETE/PATCH tracking + price alerts
│   │   ├── products/   ← tracked products with offers + history
│   │   ├── refresh/    ← on-demand price re-check
│   │   ├── settings/   ← per-user settings
│   │   ├── chat/       ← AI assistant, grounded in real tracked data
│   │   └── cron/       ← scheduled price check + daily report
│   ├── dashboard/  search/  tracked/  history/  settings/
│   └── products/[productId]/
└── lib/
    ├── search/
    │   ├── index.ts        ← pipeline orchestrator
    │   ├── parse.ts        ← LLM query understanding
    │   ├── cluster.ts      ← LLM groups listings into products
    │   ├── quota.ts        ← search cache + allowance guard
    │   └── providers/      ← serper | serpapi | gemini-grounded
    ├── db/                 ← persistence + refresh
    ├── retailers.ts        ← canonical retailer registry
    ├── queries.ts          ← TanStack Query hooks
    └── supabase/server.ts  ← requireUser() / service-role client
```

### Search pipeline

```
"hardside carry-on under $300"
  → cache lookup      free — a repeat search costs nothing
  → parse intent      Gemini, structured JSON
  → fetch listings    Serper → SerpAPI → grounded Gemini
                      the ONLY source of prices, metered against quota
  → cluster listings  Gemini groups them into distinct products
  → filter + rank     retailer settings, price ceiling, majors first
  → top 10 products, each with every offer found
```

Providers are tried in order; if one fails or is out of allowance, the next
takes over rather than failing the search.

### Staying inside a free tier

Free provider allowances are small, so two mechanisms make one last:

- **Caching** — search results are cached (default 6h). A repeated search costs
  nothing, and refreshes reuse a recent search. Cached results keep their
  original fetch time and are labelled in the UI with a one-click re-check — a
  cached price never pretends to be live.
- **Budget guard** — every call is counted atomically. Settings shows
  "173 / 250 used". When the allowance is spent the app says so plainly instead
  of surfacing an opaque 429, and the cron stops early, keeping a reserve so
  manual searches still work.

### Security

Every API route calls `requireUser()`, which validates the caller's Supabase
access token and builds a client scoped to that user — so **row-level security
decides what can be read and written**, not application code. No route accepts
a `userId` from the request body. The service-role key is used in exactly one
place: the cron jobs, which have no user context.

### Model resilience

Google retires Gemini models regularly, and a retired model returns 404 rather
than degrading. Instead of pinning one name, the app tries current Flash models
in order and caches the first that answers, permanently skipping any that 404s.
Set `GEMINI_MODEL` to force a specific one.

---

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run lint     # eslint
npx tsc --noEmit # typecheck
```

---

## Operational notes

- **Cron** runs via `vercel.json` (Pro plan) or the GitHub Actions workflows in
  `.github/workflows/` (free). Both need `CRON_SECRET`.
- **Report time** `0 15 * * *` is 9 AM MDT / 8 AM MST — adjust seasonally if the
  exact hour matters.
- **Vercel's Hobby plan is non-commercial only.** Fine for building and demos;
  if this becomes a business tool, move to a paid plan or a host whose free tier
  permits commercial use.
- `src/lib/serpapi.ts` is dead code, superseded by
  `src/lib/search/providers/serpapi.ts`. Safe to delete.
