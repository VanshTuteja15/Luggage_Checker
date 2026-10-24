# Human Actions

Things the engine cannot (and must not) do for itself: accounts, keys, publishing, legal reads, database changes in the live project, and hosting choices. Each item says **what it unlocks**, **the exact steps**, and **how to check it worked**. Until an item is done, the feature behind it shows a clear "not configured" state; nothing is faked.

Secrets go **only** in `.env.local` (local) or the host's environment settings (Vercel / worker host). Never paste them in chat, commits or issues.

_The ordered go-live checklist is at the end._

## Client-ready release (V2) actions

Added by the V2 work on `feat/client-ready` ([`MASTER_PROMPT_V2.md`](../MASTER_PROMPT_V2.md)). The final ordering is in the go-live checklist.

### V2-1. Turn off public sign-up in Supabase (5 min) → one shared login

The app hides "Create account" and its server refuses new accounts while `NEXT_PUBLIC_ALLOW_SIGNUP` is unset (the default). Supabase's public key could still be used to sign up directly, so switch it off at the source too:

1. Supabase dashboard → **Authentication** → **Sign In / Providers** (older dashboards: Authentication → Settings).
2. Turn **off** "Allow new users to sign up". Keep the Email provider on (the business login and "Forgot password" use it).
3. **Check:** on the login page there is no "Create account" tab; `curl -X POST https://<app>/api/auth/signup -H 'content-type: application/json' -d '{"email":"x@example.com","password":"12345678!"}'` answers 403.

### V2-2. Run migration 006 in Supabase (5 min) → morning email, estimates, stock, groups

1. Supabase dashboard → **SQL Editor** → paste all of `supabase/migrations/006_client_ready.sql` → **Run**. It only adds tables and columns and is safe to run again.
2. **Check:** Table Editor lists `email_digest_settings`, `email_digest_products`, `email_digest_runs`, `product_groups`, `web_estimate_searches`. Opening **Morning Email** in the app shows the page (not "needs the price database").

### V2-3. Connect a free email sender (15 min) → the morning email can be sent

Pick one. Nothing here costs money; stay on the free plans.

**Option A: Resend (recommended).** The free plan sends 100 emails a day; the app stops at 90 (`EMAIL_DAILY_LIMIT`).
1. resend.com → **Domains** → **Add domain** → the business domain (e.g. `luggagedepot.ca`) → add the DNS records it shows at the domain host → wait for "Verified".
2. Vercel (and `.env.local` for local use): `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=<new key>`, `REPORT_FROM_EMAIL=LuggageTracker <prices@luggagedepot.ca>` (an address **on the verified domain**). With the shared `onboarding@resend.dev` sender, only the Resend account owner receives mail; the Morning Email page warns about this.

**Option B: a Gmail account (SMTP).** Gmail's own sending limit applies (not verified for this account; check Google's current limit for personal accounts before relying on it).
1. Google account → **Security** → turn on 2-Step Verification → **App passwords** → create one for "LuggageTracker".
2. Vercel: `EMAIL_PROVIDER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER=<the Gmail address>`, `SMTP_PASS=<the app password>`, `SMTP_FROM=LuggageTracker <the Gmail address>`.

Also set `APP_URL=https://<your app address>` so the links in the email work.

**Check:** Morning Email says "Email is set up. It's sent from …". Add your address, tick a product, press **Send test now**; the email arrives within a minute and the send log shows "Sent".

## 1. Publish the UCP agent profile → unlocks 6–10 Shopify stores

Shopify's Catalog MCP requires every call to carry the URL of a public JSON profile describing our agent.

- **Option A (once the app is deployed):** the app serves the profile itself at `https://<your-app-domain>/.well-known/ucp-agent` (the route ships in this branch). Set `UCP_AGENT_PROFILE_URL=https://<your-app-domain>/.well-known/ucp-agent`.
- **Option B (before deploying):** follow `docs/PROBE_SETUP.md` §1 (public GitHub repo + jsDelivr URL).
- **Check:** open the URL in a browser and see the JSON. Then run `npm run probe:sources -- --only=canadaluggagedepot,travelpro-ca`: the `ucp` line should read `accessible YES`.

## 2. Set a monitored contact for the crawler

The User-Agent always carries a contact. Today it's the project's public issue tracker. A business email is better for store operators.

- Set `CRAWLER_CONTACT=<an email Luggage Depot monitors>` in Vercel and on the worker host.

## 3. eBay Browse API keys (free) → unlocks eBay.ca

1. developer.ebay.com → sign in → Application Keys → create a **Production** keyset.
2. Set `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`.
3. **Check:** `npm run probe:sources -- --only=ebay` shows a token and CAD results.

## 4. Read the terms of three stores (⚖, 15 min each)

| Store | Terms | If they allow automated reading of public product data |
|---|---|---|
| U.N. Luggage | https://unluggage.com/policies/terms-of-service | turn on flag `source.unluggage.product_json` |
| Bentley | robots.txt disallows `/policies`, so open it in a browser yourself | turn on `source.bentley.product_json` |
| JP Grimard | not found online: ask the store | add routes after permission |

Flip flags in `/admin` (Flags) or with SQL: `insert into feature_flags(key, enabled) values ('source.unluggage.product_json', true) on conflict (key) do update set enabled = excluded.enabled;`

## 5. Legal sign-off (⚖): UCP on stores whose terms carry an anti-scrape clause

Travelpro, Briggs & Riley, Heys, Monos and Away publish a UCP agent channel and invite agents in robots.txt/agents.md, but their terms keep Shopify's generic "spider, crawl, or scrape" clause. The engine uses **only** their published agent channel, at low volume, under flag `policy.ucp_on_restricted_stores` (on by default per the audit's position). Luggage City is off (`source.luggagecity.ucp`) until reviewed.
- Get a legal read, or short written permission from priority stores, before launch. If the answer is no, turn the flag off.

## 6. Dealer feeds (Samsonite, TUMI, others)

Samsonite.ca and TUMI.ca block automated requests (PerimeterX CAPTCHA). Their prices can only come from a dealer price list.
- Ask the Samsonite Canada rep for the dealer price list / EDI catalog (also covers TUMI and American Tourister). Upload it through `/admin` → Data entry → Feed import once received, with the date the price list is valid from (columns are listed on that page). Prices then show as "Feed as of <date>".

## 7. Run the new database migrations in Supabase

The engine's tables don't exist in the live project until you run these. Each file is additive and idempotent (tested twice on a fresh Postgres 17 by `npm run test:db`), so running one again is safe.

1. Supabase dashboard → SQL Editor → New query.
2. If not done before: paste and run `supabase/migrations/003_search_cache_and_quota.sql`.
3. Paste and run `supabase/migrations/004_price_engine.sql`. The last statement lists 14 tables, each with `rls_enabled = true`.
4. Run `npm run db:seed`, then paste and run the generated `supabase/seed/sources.sql` (24 stores + default flags).
5. Make yourself an admin (for `/admin`): find your user id under Authentication → Users, then run
   `insert into app_admins (user_id, note) values ('<your-user-id>', 'owner');`
6. Paste and run `supabase/migrations/005_scheduler_alerts.sql` (alerts sent once per day, engine run log). Later migrations are run the same way, in number order.

**Check:** `select count(*) from sources;` returns 24.

## 8. Choose where the worker runs, and connect it

Both options are $0; steps are in `worker/README.md`.
- **A. Office PC + Cloudflare Tunnel** (recommended: the P0 probe ran from this network).
- **B. Oracle Cloud Always Free VM** (re-run `npm run probe:sources` from the VM first).

Then set the same `WORKER_SHARED_SECRET` (`openssl rand -hex 32`) on both sides, `WORKER_URL` in Vercel, and `DATABASE_URL` (Supabase **session pooler** string) on the worker and in Vercel. **Check:** `https://<worker>/health` shows `"store":"postgres"` and `"queue":{"kind":"pg-boss"…}`.

Until a worker is connected, research runs inline on Vercel (slower but works) and the daily jobs run inside the cron route with their caps.

## 9. Rotate the credentials that were pasted into chat earlier

The project brief records that the Supabase secret key and the SerpAPI key were once pasted into a chat. Rotate both in their dashboards and update `.env.local` / Vercel.

## 10. Look at the new screens once, signed in (10 min)

The engine was checked end to end without a browser session (real research runs from the CLI, HTTP checks of every route), because signing in means typing your password, which the assistant must not do. One look from you closes that gap.

1. After items 7 (migrations + seed + `app_admins`) and, ideally, 1 and 8: open the deployed app (or `npm run dev`) and sign in.
2. **Search** → switch to **Verified prices** → search `Samsonite Omni 3.0 Large`. Expect, within a few seconds:
   - Canada Luggage Depot rows labelled "Verified live · <time>" with a source link;
   - "Couldn't verify" rows for Samsonite.ca, TUMI.ca, Sporting Life and Simons (blocked), and "Link only" rows for Amazon, Walmart, Costco, Best Buy, Canadian Tire, London Drugs and eBay (until item 3).
3. Press **Re-verify now** once; the times update.
4. Open **Admin** (left menu). Check that **Sources** lists 24 stores with health, **Failures** shows the blocked stores' challenge responses, and **Flags** shows `engine.default_search` on (search opens on Verified prices) and `discovery.tavily` off.
5. On a phone (or a narrow browser window) repeat step 2: rows stack, nothing scrolls sideways.

**Local tip:** with the local dev database use `127.0.0.1`, not `localhost`, in `DATABASE_URL` (`npm run db:dev -- up` prints the right one). On Windows each new connection to "localhost" tries IPv6 first and cost ~1 s in our measurements. For a local sign-in, the signed-in user's id must exist in the local `auth.users` table (insert it once), because research sessions reference it.

## 11. Review the privacy summary and terms pages (⚖, 20 min)

The app now has public `/privacy` and `/terms` pages (linked from the sign-in page). They describe what the code actually does (data kept, processors, 180-day log retention, no trackers, prices before GST/HST), but they are plain-language summaries, not legal advice.
- Have them reviewed, and add the contact address Luggage Depot wants people to use for data requests (the pages currently say "contact Luggage Depot Inc.").

---

## Go-live checklist (in order)

Each line links to its section above. Items marked ⚖ need a person with authority to decide.

1. ☐ **Rotate the leaked keys** (§9). Do this first; everything below uses the new values.
2. ☐ **Database:** run migrations 004 and 005, the registry seed, and add yourself to `app_admins` (§7).
3. ☐ **Vercel environment:** `DATABASE_URL` (session pooler), `CRON_SECRET`, `CRAWLER_CONTACT` (§2), existing Supabase/Tavily/Resend/Gemini keys. See `.env.example`.
4. ☐ **Deploy** the `feat/price-engine` branch to a preview, then merge to `main` when the checks below pass.
5. ☐ **Build the index:** `npm run engine:discover` with the production `DATABASE_URL` (or `/admin` → Data entry → Discovery).
6. ☐ **Publish the UCP agent profile:** set `UCP_AGENT_PROFILE_URL=https://<app>/.well-known/ucp-agent`, redeploy (§1).
7. ☐ ⚖ **UCP legal read** for the stores with an anti-scrape clause, or turn `policy.ucp_on_restricted_stores` off (§5).
8. ☐ **Look at the screens once, signed in** (§10): verified search, Re-verify, `/admin`, phone width.
9. ☐ **Worker** (recommended): choose office PC or Oracle VM, set `WORKER_URL` + `WORKER_SHARED_SECRET`, check `/health` (§8). Re-run `npm run probe:sources` from that host first.
10. ☐ **Free extra coverage when ready:** eBay keys (§3), three terms reads (§4), dealer feeds (§6).
11. ☐ ⚖ **Privacy/terms review** and a contact address (§11).
12. ☐ **Keep Tavily on the free plan with pay-as-you-go off** (it stays as the optional Web research mode).

After launch: the daily routine in [`RUNBOOK.md`](./RUNBOOK.md) §6 (two minutes in `/admin`).
