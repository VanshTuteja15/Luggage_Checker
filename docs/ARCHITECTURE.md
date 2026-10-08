# Price Engine Architecture

How LuggageTracker gets a **verified** Canadian price: read from the store, or from the store's official channel, during the user's own search. Every price carries its source link and the time it was read. Rules behind every choice are in [`MASTER_PROMPT.md`](../MASTER_PROMPT.md) §1; what only a human can do is in [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md).

```
Browser (search page, /admin)
   │  POST /api/research ─► 202 {sessionId}       GET /api/research/[id]/stream (NDJSON)
   ▼                                              or Supabase Realtime on session_events
Next.js on Vercel ── orchestrates only ──────────────────────────────────────────────┐
   │  signed request (HMAC, 5-min window, nonce)          no worker configured?      │
   ▼                                                       run inline via after()    │
Worker (Node 22, pg-boss)  ◄── Vercel Cron 13:00 UTC: /api/cron/fetch-prices ────────┤
   │  ResearchManager · jobs: verify.tracked, discover.refresh, discover.source,     │
   │  sources.health                                                                  │
   ▼                                                                                  │
PoliteFetcher ─► stores' official channels and permitted pages                        │
   ▼                                                                                  │
Supabase Postgres (engine tables, RLS) ◄──────────────────────────────────────────────┘
```

The worker and the inline fallback run the **same code** (`src/lib/engine`). The worker exists so long jobs and many parallel store reads don't run inside short serverless functions, and so the egress IP is one we probed from (P0).

## Layers

| Layer | Where | What it does |
|---|---|---|
| Source Registry | `registry/seed.ts`, `registry/index.ts`, table `sources` | 24 stores. Per store: permission (sanctioned / allowed / unclear / restricted / forbidden / not applicable), terms stance, robots summary, crawl delay, `allowedDomains` (whose links are its own) vs `fetchHosts` (hosts the fetcher may contact: the SSRF allowlist), ranked routes (adapters), identity quality, house brand, link-only search URL, P0 evidence. `checkRoutes()` turns permission + flags + configuration into "usable, or why not". Forbidden stores have no storefront fetch host at all, so their HTML can't be fetched even by mistake. |
| Feature flags | `flags.ts`, table `feature_flags`, `/admin` → Flags | Defaults are conservative (`discovery.tavily` off, blocked-store HTML off, unread-terms stores off, Amazon off); `engine.default_search` is on since the P8 shadow run. Unknown keys are refused. `ENGINE_FLAGS` overrides for operators. |
| Politeness | `politeness/*`, `PoliteFetcher` | In order: SSRF guard (DNS must be public, redirects re-checked, only `fetchHosts`) → visit window → circuit breaker (opens after repeated blocks) → robots.txt (RFC 9309, cached; unreachable = disallow) → per-host limiter with crawl delay, aware of the session deadline → fetch with the honest User-Agent `LuggageTrackerBot/1.0 (+contact; …)` → block classifier (403/429/challenge/CAPTCHA = **BLOCKED**, never retried around) → every attempt recorded in `fetch_attempts`. Single-flight: one request per URL per 90 s, shared across sessions. |
| Adapters | `adapters/*` | `shopify_ucp` (Shopify Catalog MCP, CA context, minor units), `shopify_product_json` (`/products/x.json` + `.js` for availability), `html_structured` (JSON-LD / microdata / meta, plus the displayed price as a cross-check), `ebay_browse_api`, `amazon_creators_api` (behind a flag), `feed_import` (dealer CSV/JSON with an as-of date), `manual_entry`. Each returns raw offers or a status (`ok`, `not_found`, `blocked`, `not_permitted`, `not_configured`, `timeout`, `error`, `garbage`). |
| Validation | `validate/index.ts` | Confidence score; CAD only; link on the store's own domain; brand, size class and identity checks; price inside the luggage band; marketplace condition; displayed-price cross-check. Never changes a price; rejects or marks it low-confidence with reasons. |
| Category pack | `packs/luggage.ts` | Everything luggage-specific: brands and aliases, size classes (carry-on / medium / large / extra large / sets / bags / accessories), stated inches, colours, product-line words, model numbers (Samsonite group, TUMI, Delsey), query parsing. Another category would be another pack. |
| Identity | `identity/resolve.ts`, `identity/review.ts`, `/admin` → Review queue | GTIN → manufacturer model (same size) → brand + line + size class (+ stated inches) → otherwise a near-match goes to a human. Version numbers must agree (Omni 2 ≠ Omni 3.0), sizes never merge, "Expandable" / "International" / "Domestic" tell products apart. Products live in `catalog_products` / `catalog_variants` / `catalog_identifiers` (prefixed: `products` belongs to the tracking workflow). |
| Discovery | `discovery/index.ts` | Builds the listing index from product sitemaps of stores whose storefront we may read (one language per page; new URLs first, then stalest; a per-run fetch budget), UCP catalog search for agent-channel stores, and optional Tavily URL discovery (flag; URLs only, never prices). Brand-direct stores supply their own brand when titles omit it. |
| Research session | `research/session.ts`, `manager.ts`, `answer.ts`, `api.ts`, `follow.ts` | See below. |
| Scheduler | `cron.ts`, `jobs/verify-tracked.ts`, `bridge/tracked.ts` | Daily: retention (180 days), tracked products re-verified through the engine (stalest first, budgets), lowest verified price per store written to the tracking workflow's own tables through a bridge (`retailer_offers`, `price_history`), target-price alerts once per user/product/day, the existing daily report. Tavily covers only what the engine couldn't verify. |
| Admin | `admin-actions.ts`, `/admin`, `/api/admin/*` | Source health and block rates, recent failures and rejections, review queue, session timings, flags, dealer feed import, manual prices, discovery trigger. Admins are listed in `app_admins`. |

## A research session

1. `POST /api/research` validates input (zod), checks the per-user rate limit, creates a `research_sessions` row and returns **202** with its id. The work goes to the worker (signed) or runs inline after the response.
2. **Plan** (≈25 ms): parse the query with the pack; find candidate listings in the index (full-text, size wall, exact-size preference, stated inches); for every store, decide from the registry whether it can be checked now, or is **blocked**, **link only** (terms forbid automated access: Amazon, Walmart, Costco, eBay HTML, Best Buy, Canadian Tire/Sport Chek, London Drugs), or **not set up** (needs a key, a profile or a human terms read). The plan is the first event, so the UI shows every store's row at once.
3. **Store tasks run in parallel**, each through its best usable route, with one bounded alternate route on failure. Each verified price is emitted as soon as it is read (`store_offers`), so fast stores show first.
4. **Deadline** 11 s: whatever is still running is reported as "still checking"; results that arrive later are stored, not added to this answer. A store with nothing current shows its last observation labelled "Last seen …, not current".
5. **Answer**: offers grouped into products (catalog product, GTIN, model, or brand + line + size + inches), cheapest current price first, freshness on every price: `Verified live · time`, `Feed as of date`, `Manually checked date`, `Last seen …, not current`.

Events are persisted in `session_events` and pushed through Supabase Realtime, with an NDJSON stream as fallback; a reconnecting browser resumes from the last event. "Re-verify now" starts a child session for the same products.

## Data

Migrations `004_price_engine.sql` and `005_scheduler_alerts.sql` (additive, idempotent, tested twice on a fresh Postgres 17 by `npm run test:db`):

`sources`, `feature_flags`, `app_admins`, `catalog_products`, `catalog_variants`, `catalog_identifiers`, `listings` (GIN full-text index), `research_sessions`, `session_events`, `fetch_attempts`, `observations`, `price_ranges`, `identity_review`, `feed_imports`, `price_alerts_sent`, `engine_runs`, plus the `source_health` view and `engine_retention()`.

- RLS on every table. Users read only their own sessions and events; admins (via `app_admins`) manage review, flags and feeds; engine writes use the server-side `DATABASE_URL` (never exposed to the browser).
- `observations` and `fetch_attempts` are append-only (triggers); `price_ranges` collapses repeated identical prices into ranges.
- Retention: `fetch_attempts` and `session_events` older than 180 days are deleted daily.

## Security

- Secrets only in `.env.local` / host settings; `DATABASE_URL`, `WORKER_SHARED_SECRET`, API keys are server-only.
- Vercel → worker requests are HMAC-signed with a timestamp window and a nonce; the worker refuses unsigned or replayed requests and caps body size.
- Every user API route authenticates the caller; RLS decides what can be read. Admin routes additionally require `app_admins`.
- The fetcher can only reach registry `fetchHosts`, after DNS resolution to public addresses, re-checked on every redirect.
- Research never creates or imports tracked products; tracking stays in its own workflow (`/api/track`).

## What the engine will not do

No stealth browsers, fingerprint or TLS spoofing, rotating or residential proxies, CAPTCHA solving, or retries around a block. No HTML from stores whose terms forbid automated access. No paid APIs. No price from a search-engine snippet. No guessed price, ever: a store we can't read gets a link and a reason.
