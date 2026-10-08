# Runbook

Day-to-day operation of the price engine. Architecture: [`ARCHITECTURE.md`](./ARCHITECTURE.md). One-time steps only a human can do: [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md).

Golden rules while operating: never work around a block, never fetch HTML from a store whose terms forbid it, never enable a paid plan, never type a price you didn't see on the store's page.

---

## 1. Deploy the app (Vercel)

1. **Database first.** Supabase → SQL Editor: run `supabase/migrations/004_price_engine.sql`, then `005_scheduler_alerts.sql` (each is idempotent; re-running is safe). Then `npm run db:seed` locally and run the generated `supabase/seed/sources.sql` (or `npm run db:seed -- --apply` with `DATABASE_URL` set). Add admins: `insert into app_admins (user_id, note) values ('<user id>', 'owner');`
2. **Environment** (Vercel → Project → Settings → Environment Variables). Required for the engine: `DATABASE_URL` (Supabase **session pooler** string), `CRON_SECRET`. Recommended: `CRAWLER_CONTACT`, `UCP_AGENT_PROFILE_URL` (after the first deploy: `https://<app>/.well-known/ucp-agent`), `WORKER_URL` + `WORKER_SHARED_SECRET` once a worker runs. Every variable is described in `.env.example`.
3. **Deploy** the branch (Vercel builds with `next build`). The schedule is `vercel.json`: `/api/cron/fetch-prices` at 13:00 UTC, `/api/cron/daily-report` at 15:00 UTC. GitHub workflows are manual-only; don't add schedules there (it would double every store's daily requests).
4. **Build the index**: from a machine with `DATABASE_URL` pointing at Supabase, `npm run engine:discover` (honest UA, robots, crawl delays; about 50 requests per store per run). Or trigger *Discovery* in `/admin` → Data entry.
5. **Check**: `/admin` → Sources lists 24 stores; a search with *Verified prices* shows Canada Luggage Depot / Delsey rows labelled "Verified live".

**Rollback:** flip `engine.default_search` off in `/admin` → Flags (the search page goes back to Web research by default), or redeploy the previous build in Vercel. Migrations are additive, so the old app keeps working with the new tables present.

## 2. Deploy or move the worker

The worker is optional (research runs inline on Vercel without it) but recommended: long jobs, many parallel reads, a stable egress IP. Steps and both $0 options (office PC + Cloudflare Tunnel, or Oracle Cloud Always Free VM) are in [`worker/README.md`](../worker/README.md). In short:

```bash
docker build -f worker/Dockerfile -t luggage-tracker-worker .
docker run -d --restart unless-stopped --name lt-worker --env-file worker/.env -p 8787:8787 luggage-tracker-worker
```

`worker/.env` needs `DATABASE_URL`, `WORKER_SHARED_SECRET` (same value as Vercel) and optionally `CRAWLER_CONTACT`, `UCP_AGENT_PROFILE_URL`, eBay keys. Then set `WORKER_URL` in Vercel and redeploy.

**Check:** `https://<worker>/health` shows `"store":"postgres"` and a pg-boss queue. A search shows the same rows as before, faster under load.

**New egress IP?** Re-run `npm run probe:sources` from the new machine first: blocks are per network, and P0's evidence is only valid for the network it ran from.

## 3. Rotate keys

Rotate on a schedule, after anyone leaves, or immediately if a key was pasted anywhere (chat, issue, commit).

| Secret | Where to rotate | Then update |
|---|---|---|
| `WORKER_SHARED_SECRET` | `openssl rand -hex 32` | Vercel **and** `worker/.env` at the same time (requests fail closed in between), restart the worker, redeploy Vercel. |
| Database password (`DATABASE_URL`) | Supabase → Settings → Database → Reset password | Vercel, `worker/.env`, anyone's local `.env.local`. |
| Supabase service role / JWT secret | Supabase → Settings → API | Vercel (`SUPABASE_SERVICE_ROLE_KEY`), `.env.local`. |
| `CRON_SECRET` | `openssl rand -hex 32` | Vercel, plus the GitHub repository secret used by the manual workflows. |
| `TAVILY_API_KEY`, `RESEND_API_KEY`, `GEMINI_API_KEY` | each provider's dashboard | Vercel, `.env.local`. |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` | developer.ebay.com → Application Keys | Vercel, `worker/.env`. |

Never print secrets in logs or paste them in chat; `.env.local` is edited by a person, never committed.

## 4. Add a store

1. **Evidence first.** Read its robots.txt and terms of use. Note whether the terms forbid automated access (then the store is *link only*: only an official API or feed, never its HTML). Find its official channels: Shopify (`/products/<handle>.json`, UCP at `/.well-known/ucp`), public API, affiliate feed.
2. **Probe** from the worker's network: add a target to `scripts/probe/main.ts` and run `npm run probe:sources -- --only=<id>`. It records accessible / reliable / permitted per channel, with an honest UA and robots.txt honoured.
3. **Registry**: add an entry to `src/lib/engine/registry/seed.ts`: permission and terms stance from step 1, `allowedDomains`, `fetchHosts` (only hosts we may contact; none for a forbidden storefront), crawl delay (robots value, at least 1 s), routes in order, `houseBrand` for a brand's own store, link-only search URL, evidence summary. Bump `SEED_VERSION`.
4. **Fixtures and tests**: record real responses with `npm run fixtures:record` (extend it for the store), add adapter tests for prices, sale prices, variants, currency, availability and block/404 cases, run `npm test`.
5. **Ship**: `npm run db:seed` and apply the SQL in Supabase, deploy, run discovery for the store (`npm run engine:discover -- --source=<id>`), and check it in `/admin` → Sources.
6. If the terms are unclear, keep its routes behind a `source.<id>.…` flag (off) and add a terms-read item to `HUMAN_ACTIONS.md`.

## 5. Handle a block

Signs: `/admin` → Sources shows a high 24 h block rate or an open circuit; Failures lists `blocked` / `challenge` / `rate_limited` for one store; research rows say "Couldn't verify: blocked".

1. **Do not work around it.** No other User-Agent, no proxy, no headless browser, no retry loop. The circuit breaker already stops requests after repeated blocks and cools down for 30 minutes before one trial request.
2. **Confirm** from the worker's network: `npm run probe:sources -- --only=<id>`. A challenge on robots.txt itself means the whole site is behind bot protection.
3. **Check what changed**: robots.txt (new Disallow or crawl delay?) and terms. If either now forbids us, set the store's permission accordingly in the registry (`restricted` / `forbidden`) so it becomes link-only, and deploy.
4. **If it persists** with no rule change: set the registry entry's `liveClass` to `blocked` (and turn its HTML flag off if it has one), deploy, and write to the store from the contact in our User-Agent asking for an official channel (feed, API or allow-listing). Until then the store shows as blocked with a link, and the last good price, if any, is labelled "Last seen …, not current".
5. **Prefer official channels**: Shopify stores via UCP once the agent profile is published; brands via dealer feeds (`/admin` → Data entry → Feed import, with the feed's as-of date).

## 6. Routine checks

- **Daily (2 min):** `/admin` → Sources (any store red?), Failures (new error types?), Review queue (approve/reject near-matches; nothing merges without you).
- **Weekly:** Sessions tab: first-price p50 under 3 s and total under 12 s for known products; deadline hits rare. Settings → Tavily budget well under the cap.
- **After changing identity rules** (`packs/luggage.ts`, `identity/*`): run `npm test`, then `npm run shadow:run -- --engine-only` against a local copy of the index and compare with `docs/shadow/results.json`.
- **Retention** runs daily with the cron (180 days of fetch attempts and session events). To run it by hand: `select engine_retention(180);` in the SQL Editor.

## 7. Quick diagnosis

| Symptom | Look at | Usual cause |
|---|---|---|
| Every store "still checking" at the deadline | `/admin` → Sessions; worker `/health` | Worker down or unreachable, database pool exhausted, or the worker host's network is down. |
| First price slow (> 3 s) everywhere | Worker logs, `fetch_attempts` durations | Cold database connections (the pool warms at start), a store's crawl delay, or DNS issues on the worker host. |
| A store suddenly shows no prices | Failures tab for that store | Block (section 5), site redesign (adapter returns `garbage` / `not_found`: update the adapter with a new fixture), or terms change. |
| Wrong product grouped with another | Review queue, the product's listings | Identity rule gap: split the listing in `/admin`, add the case to `tests/engine/identity.test.ts`, fix the pack. |
| Cron didn't run | Vercel → Cron Jobs logs | `CRON_SECRET` mismatch (401), or the function hit its time limit (lower `ENGINE_CRON_MAX_PRODUCTS`). |
