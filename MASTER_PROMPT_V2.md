# MASTER PROMPT V2: LuggageTracker, client-ready release

You are the senior engineer finishing **LuggageTracker** for **Luggage Depot Inc.** (Calgary, multi-location luggage retailer). Work in this repository (`D:\luggage-watch-main`) on branch `feat/client-ready` created from `feat/price-engine`. Follow this document from start to finish. Do not stop at a plan; build, test, and verify every phase. Where something needs a human (accounts, keys, legal, domains, money), do everything up to that point, record it in `docs/HUMAN_ACTIONS.md`, and keep going.

Read these first, in this order, and treat them as binding context:

1. this file;
2. `docs/CLIENT_REVIEW.md` (why each change exists, with sources);
3. `AGENTS.md`;
4. `MASTER_PROMPT.md` (V1 rules still apply unless changed here);
5. `docs/PROGRESS.md`, `docs/ARCHITECTURE.md`, `docs/RUNBOOK.md`, `docs/HUMAN_ACTIONS.md`.

Track your work in `docs/PROGRESS_V2.md` (a phase table with status and evidence). Update it after every phase so a stopped session can resume by reading it. If `docs/PROGRESS_V2.md` already exists, **resume from it**: do not redo completed phases.

---

## 0. Client decisions (fixed, do not re-open)

| Decision | Value |
|---|---|
| Budget | **$0**. No paid APIs, no paid plans, nothing that can create a charge automatically. Tavily stays on the free plan with pay-as-you-go off. |
| Users | **One shared business login.** That account is also the admin. Public sign-up must be off. |
| Own price | **Not wanted.** Do not build "our price" or price-position features. |
| Graphs | **Not wanted.** No charts, sparklines or plots anywhere in the UI or email. Use tables, numbers, arrows and plain sentences. |
| Morning email | The client **chooses products**; **every day at 09:00 America/Edmonton** (DST-correct) an email goes to **the addresses the client enters**. It shows the chosen products' prices. |
| Prices | Show the **lowest price first** and **prices from other stores as numbers**, not just links, wherever an honest source exists. Links only when nothing else exists. |

## 1. Non-negotiable rules

1. **Inspect before changing.** Read the existing code for a feature before editing it. Extend what works; do not rewrite working modules. If a rewrite is truly needed, write the reason in `PROGRESS_V2.md` first.
2. **Protected files: the Add New Product workflow.** Never edit these:
   - `src/app/tracked/page.tsx`
   - `src/app/api/track/route.ts`
   - `src/lib/db/products.ts`

   You may *call* their exported functions or the `/api/track` endpoint from new code.
3. **No anti-bot evasion.** No stealth browsers, TLS or fingerprint spoofing, proxies, CAPTCHA solving, or fetching hosts the source registry forbids. A blocked store stays blocked.
4. **No fake data in the product.** No mock prices, placeholder screens, demo rows, or buttons that do nothing. Test fixtures live only under `tests/` and `scripts/fixtures/`.
5. **Every price carries its source and time.** Each label is one of:
   - "Verified live · 9:02 a.m."
   - "Web estimate · found 9:01 a.m. · confirm on site"
   - "Staff-checked · Oct 9"
   - "Dealer list · as of Oct 1"
   - "Last seen · Oct 8"

   Nothing older than today may look like today's price.
6. **Secrets.**
   - Never print, log, commit or echo secrets.
   - Never edit `.env*` files or `.github/`; list needed variables in `.env.example` and `docs/HUMAN_ACTIONS.md`.
   - Do not write to `.env.local`.
7. **Git: the owner commits.** Never run `git commit`, `push`, `merge`, `rebase`, `reset` or `stash`. Work on `feat/client-ready`. At the end of each step, leave the changes uncommitted and give a "Ready to commit" list (files + suggested message), then wait for the owner. See `AGENTS.md`.
8. **$0 guardrails.**
   - Keep the Tavily monthly cap (`TAVILY_MONTHLY_CREDIT_CAP`, default 950) and the PAYGO refusal.
   - Add no new paid service.
   - Any new free service must sit behind a switch that the app tolerates being off.
9. **Plain English for the client.** The client sees every screen, because there is one login. No internal identifiers (adapter names, env-var names, flag keys, table names) on any screen outside a collapsed "Technical details" area.
10. **Honesty over coverage.** If a price can't be defended, don't show it. If a requirement can't be met at $0, implement the best honest version and document the gap.

---

## 2. What exists today (verified facts; check them yourself before relying on them)

- **Stack.** Supporting libraries:
  - Next.js 15 App Router, React 19, TypeScript, Tailwind v4, shadcn/ui, TanStack Query;
  - Supabase (Postgres, Auth, RLS);
  - Resend (`src/lib/email.ts`), Tavily (`src/lib/tavily.ts`), Gemini (`src/lib/gemini.ts`), recharts.
- **Price engine** (`src/lib/engine/**`, migrations `004`/`005`):
  - source registry (24 stores) and politeness layer;
  - adapters: Shopify product JSON, UCP, structured data, eBay API, Amazon Creators API (flag), feed import, manual entry;
  - validation, identity resolution and review queue, research sessions with NDJSON streaming;
  - tracked-product verification (`jobs/verify-tracked.ts`) and a bridge into the tracking tables (`bridge/tracked.ts`).
  - Worker: `worker/` (Node 22, pg-boss).
- **Verified coverage today:** Canada Luggage Depot and Delsey.ca only.
  - Samsonite.ca, TUMI.ca, Sporting Life and Simons are blocked.
  - Amazon, Walmart, Best Buy, Costco, Canadian Tire and London Drugs forbid automated access (link-only).
  - The UCP stores wait on a published agent profile.
- **Search UI:**
  - `src/app/search/page.tsx` has two modes ("Verified prices" via `src/components/research/ResearchResults.tsx`, and "Web research" via the Tavily path in `src/lib/search/**`).
  - Uncommitted changes from 2026-10-10 hide the "Couldn't verify" reasons from shoppers (`ResearchResults.tsx`, `registry/index.ts`) and fix `scripts/db/dev-db.ts`. **Review, test and commit them first** (Phase Q0).
- **Daily report:** `src/app/api/cron/daily-report/route.ts` + `vercel.json` cron `0 15 * * *` (UTC). All tracked products, one recipient, top-5 lowest. The `user_settings.timezone` column is unused.
- **Graphs:**
  - `/history` (recharts LineChart + Sparkline);
  - `/products/[productId]` (chart);
  - `src/components/Sparkline.tsx`, used by `ProductCard.tsx`;
  - `src/components/ui/chart.tsx`.
- **AI chat:** `src/components/AiChat.tsx` + `src/app/api/chat/route.ts` (Gemini; context is tracked products only).
- **Login:** `src/app/page.tsx` has a public "Create Account" tab (`supabase.auth.signUp`).
- **Quality gates:**
  - `npx tsc --noEmit` (root + worker), `npm run lint`, `npx next build`;
  - `npm run verify:search`, `npm test`;
  - `npm run test:db` (needs Docker running), `npm run worker:build`, `npm run test:worker`, `npm run test:worker:e2e`;
  - `npm run probe:sources -- --selftest`.
  - Local engine database: `npm run db:dev -- up` (Docker), then `DATABASE_URL=postgres://postgres:dev@127.0.0.1:54331/postgres`.

Known errors to fix: E1–E20 in `docs/CLIENT_REVIEW.md` §1.

---

## 3. Requirements and acceptance criteria

Each requirement has an ID. Reference the IDs in commits, tests and `PROGRESS_V2.md`.

### R1. Morning email (P0, the client's headline requirement)

**Behaviour**

- R1.1 A new page **Morning Email** (`/email`, in the left menu) lets the client:
  - turn the email on or off;
  - set the **send time** (default 09:00) and **time zone** (default `America/Edmonton`; list the Canadian zones);
  - add, edit or remove **recipients** (1–10 valid addresses; duplicates refused; each shows "last delivered" or "last error");
  - **choose products**:
    - a list of all tracked products with a checkbox each, search/filter, and filter by group (R7);
    - "Select all" and "Clear";
    - a count "12 products chosen";
  - optionally set each chosen product's **order** (drag or up/down);
  - **Preview** the exact email that would be sent now (rendered in the page, real data);
  - **Send test now** to one chosen recipient (real send; does not count as the daily send);
  - see the **send log**: the last 30 days, with date, time sent, products, recipients delivered/failed, and error text in plain English.
- R1.2 Search results get an **"Add to morning email"** action per product.
  - If the product isn't tracked yet, track it through the existing `/api/track` flow (do not modify that route), then add it to the email selection.
  - Show a toast with Undo.
- R1.3 Removing a tracked product removes it from the email selection (FK cascade).

**Delivery and timing**

- R1.4 The email is sent **once per local calendar day**, between `send_time` and `send_time + 15 min` local time. It must work across the **DST changes** (2026-11-01 and 2027-03-14 in America/Edmonton). Missed windows (app down) are caught up the same day until 12:00 local, then logged as "missed" and never sent late in the afternoon.
- R1.5 **Fresh prices.** At `send_time − 60 min` a **prepare** run re-checks every chosen product:
  - the engine first (verified routes);
  - then web estimates (R3) within the Tavily budget (R3.6).

  The send uses the newest data. A store not re-checked today shows its last price with its date ("Last seen Oct 8"); it is never shown as today's.
- R1.6 **Idempotency.** A `email_digest_runs` row with a unique key on (`account`, `local_date`) is claimed before sending (`INSERT … ON CONFLICT DO NOTHING RETURNING`). Retries and parallel ticks never send twice. Per-recipient status is recorded.
- R1.7 **Failure visibility.**
  - If a run fails or partly fails, the app shows a red banner on Dashboard and Morning Email ("Today's 9:00 email didn't reach 1 of 3 people: <reason>").
  - The next email starts with a short note.
  - If no tick arrived by `send_time + 30 min`, the next tick logs "late scheduler".

**Content** (HTML + plain-text part, mobile-friendly, no images required, no charts)

- R1.8 Subject: `Luggage prices · Fri Oct 10 · 3 drops · 2 targets hit` (counts from the data).
- R1.9 The top summary is three lines:
  - drops since yesterday;
  - increases;
  - targets hit, and stores that couldn't be checked today (by name, plain wording, no technical reasons).
- R1.10 One block per chosen product, in the chosen order:
  - name, brand, size, colour(s);
  - **lowest price now**: big, with the store, the label (R0 rule 5) and a link;
  - a table of **every store we have a price for**, lowest first, one row per store. Columns: store, price, change vs yesterday (▼ $35 / −7% in green, ▲ in red, "—" unchanged), stock (In stock / Out of stock / Unknown), label, link;
  - the line "Lowest in 30 days: $X at Store (Oct 3)", or "This is the lowest in 30 days";
  - "Target $Y reached" when it applies.
- R1.11 Footer:
  - "Prices are each store's listed price in CAD before GST/HST and shipping, as read at the time shown";
  - a link to the app;
  - "Change products or recipients" (link to `/email`);
  - the send time and time zone.
- R1.12 All text is HTML-escaped (reuse `esc()`), and links use the store's own URL. No tracking pixels.

**Email provider ($0)**

- R1.13 Create `src/lib/mailer.ts` with `EMAIL_PROVIDER=resend|smtp`.
  - `resend` uses the existing SDK and `REPORT_FROM_EMAIL`, which must be on a domain verified in Resend. The `resend.dev` sender only reaches the Resend account owner.
  - `smtp` uses `nodemailer` with `SMTP_HOST/PORT/USER/PASS/FROM` (for example a Luggage Depot Gmail with an app password).
  - On start, `/email` shows whether the provider is configured. If the sender is `*@resend.dev`, warn: "Only the Resend account owner will receive this; verify your domain."
  - Keep the free-plan limit (Resend 100/day) enforced in code: refuse a send that would exceed `EMAIL_DAILY_LIMIT` (default 90).
- R1.14 Retire the old daily report:
  - `/api/cron/daily-report` keeps working for one release but delegates to the new digest for the same account;
  - migrate existing `user_settings.report_email` into the recipients on first load;
  - remove its `vercel.json` entry only after the new scheduler is documented.

**Scheduler ($0, not dependent on Vercel Hobby precision)**

- R1.15 Create a single endpoint `POST /api/cron/tick`.
  - Auth: header `x-cron-secret: CRON_SECRET`, constant-time compare.
  - Each call decides what is due for the account, and is safe to call every minute:
    - prepare at `send_time − 60`;
    - send at `send_time`;
    - daily engine jobs (existing `/api/cron/fetch-prices` logic);
    - retention.
  - It returns JSON with what ran.
- R1.16 Primary trigger: **Supabase `pg_cron` + `pg_net`** calling the tick every 15 minutes (`*/15 * * * *`, UTC).
  - Ship `supabase/scheduler/schedule.sql` with placeholders for the app URL and secret, read from **Supabase Vault**, never hard-coded.
  - Add an unschedule script and the steps in `HUMAN_ACTIONS.md`.
- R1.17 Fallbacks:
  - (a) the worker schedules the same tick with pg-boss `schedule()` using `tz: 'America/Edmonton'`;
  - (b) the `vercel.json` daily crons stay as a last resort (imprecise; documented).

  Idempotency (R1.6) makes multiple triggers safe.

**Acceptance**

- A1.1 With a fake clock, tests prove exactly one send per local day. They cover:
  - 08:59 → nothing; 09:00–09:14 → one send; repeated ticks → no duplicate;
  - 2026-11-01 and 2027-03-14 DST days → sent at 09:00 local;
  - a missed window caught up by 11:59, skipped at 12:00.
- A1.2 An integration test with a capturing mail provider checks that:
  - the chosen products only, in order, with every store row, lowest first;
  - labels and dates are correct;
  - stale prices are marked;
  - the plain-text part is present;
  - no `<script>` and no chart elements.
- A1.3 A manual real send to the owner's address succeeds (record the provider message id in `PROGRESS_V2.md`, not the address).
- A1.4 The UI flow works with the keyboard and on a 375 px wide screen.

### R2. One search, lowest price first, every store with a number (P0)

- R2.1 Remove the separate "Web research" mode and toggle (and its localStorage key). There is **one search**: the engine research session, enriched with web estimates (R3), staff-checked prices and dealer-feed prices.
- R2.2 Sort products by the lowest **current** price. Inside a product, show **one row per store** (that store's lowest current price), with:
  - colour chips ("Black · Stone Grey · Midnight Navy");
  - "+1 more page" when the store has twin pages, which expands to show both URLs.
- R2.3 The **headline price** of a product is the lowest current price of any label, but:
  - a **web estimate** can be the headline only if it passed R3 validation;
  - its label stays visible next to the number ("Web estimate · confirm on site");
  - when the lowest verified price differs from a lower estimate, show both lines:
    - "Lowest verified: $434.95 at Canada Luggage Depot"
    - "Possibly lower: $419.99 at Amazon.ca (web estimate)"
- R2.4 Stores with no number at all appear in a compact "Also compare at" row of store-name links (no reasons, no "couldn't verify" wording).
- R2.5 Progressive loading:
  - the first verified price streams in; estimates fill in as they arrive;
  - a visible "Checking 3 more stores…" line;
  - **never a blank or crashed page**.
  - On engine failure, show cached last-known prices with dates, and a friendly retry.
  - Add an error boundary to the search route.
- R2.6 Stock status per row when the store gives it (In stock / Out of stock / Unknown). Out-of-stock rows sort after in-stock ones at the same price and never become the headline unless nothing is in stock (then say "Out of stock everywhere we checked").
- R2.7 Remove overclaiming copy:
  - search subtitle → "Lowest prices first. Every price shows where and when it was found.";
  - login page "15+ Canadian retailers" → "Compare luggage prices across Canadian stores".
  - Store chips must come from the registry (no Hudson's Bay).
- **Acceptance:**
  - A2.1 `Samsonite Paralux Medium` shows Canada Luggage Depot $434.95 verified, plus any validated estimates, lowest first, with one row per store.
  - A2.2 `Aluminum Carry-On` shows no non-luggage items.
  - A2.3 A forced engine error shows cached prices or a friendly message, never an exception page.
  - A2.4 E1/E2 regression fixtures produce **no** wrong price (see R3).

### R3. Web estimates that are safe to show (P0)

The goal is real numbers for Amazon.ca, Walmart.ca, Best Buy, Costco, Canadian Tire, Samsonite.ca and others at $0, **without** fetching their pages (rule 3). Use the existing Tavily search path (search results and snippets only; **no Tavily extract of forbidden/blocked hosts**).

- R3.1 Represent an estimate as an offer with `freshness.kind = "estimate"`.
  - Extend `FreshnessKind` and `freshnessLabel`.
  - Store it in `observations` with adapter `web_estimate`, plus evidence: query, result URL, snippet excerpt ≤ 300 chars, and found-at time.
  - Estimates never update verified `price_ranges` as "live".
- R3.2 Accept an estimate only if **all** of these hold:
  - (a) the result URL is on the store's own registry domain and is a **product page**, not a search, category or listing page;
  - (b) identity matches the product: brand, product line, size class, and stated inches if any;
    - version numbers must agree (reuse `identity/` rules);
    - a UPC in the snippet must equal the product's UPC when both exist;
  - (c) the price text contains `$` (or `CAD`/`C$`), is not a model or version number, and is not a "from", range, monthly-payment or "save $X" amount;
  - (d) price plausibility:
    - when a verified price exists for the same product, the estimate is within **0.6× to 1.5×** of the verified median;
    - otherwise it is within 0.6×–1.5× of the median of ≥ 2 independent estimates;
    - otherwise it is within the category band **and** marked "single source";
  - (e) not an accessory, part, cover or other non-bag item when the query is a bag (reuse `isAccessoryTitle`).

  Rejected estimates are stored with reasons (visible in Store status → Technical details) and never shown.
- R3.3 Regression fixtures from real failures (E1, E2) live in `scripts/fixtures/`:
  - Paralux Large $150 at Samsonite.ca must be rejected (ratio vs Medium/verified, size mismatch);
  - the domino set and pigeon rings must be rejected for "Aluminum Carry-On".
- R3.4 Estimates are cached per (product identity, store) for 12 h and per query for 6 h. Repeated searches never re-spend credits inside the TTL.
- R3.5 Where the old `src/lib/search/**` extraction is reused, keep `npm run verify:search` green and add the new cases.
- R3.6 **Tavily budget planner.**
  - Before any estimate work, read the month's usage.
  - Reserve credits: prepare runs for the morning email get priority, up to `ESTIMATE_DAILY_BUDGET` (default 20 credits/day); interactive searches get the rest.
  - When the budget is short, rotate which email products get new estimates (the oldest first), and mark the others "Last seen <date>".
  - At the cap, the app keeps working with verified, staff and feed prices plus links.
  - Show remaining credits in Store status in plain words: "Web estimates left this month: 412".
- **Acceptance:**
  - A3.1 Unit tests for every rule in R3.2, including both fixtures.
  - A3.2 No code path calls Tavily extract on a host whose registry permission is forbidden or blocked (test with a spy).
  - A3.3 Budget tests: the cap is never exceeded; the email has priority; rotation works.

### R4. No graphs: readable history (P0)

- R4.1 Remove every chart:
  - `/history` LineChart;
  - `/products/[productId]` chart;
  - `Sparkline` usages and the component;
  - `src/components/ui/chart.tsx` if it becomes unused.

  Remove `recharts` from `package.json` if nothing imports it. `tracked/page.tsx` is protected: if it imports a chart, leave it and document it.
- R4.2 **Price History page** (`/history`) shows:
  - a "Changes" table: date, product, store, old → new, change $ and %, arrows ▼ green / ▲ red;
  - filters 7 / 30 / 90 days, product, store and group;
  - "Biggest drops this week" as a simple ranked list.
- R4.3 **Product page:**
  - a "Daily lowest price" table (last 30 days: date, lowest price, store, ▼▲ vs previous day);
  - a "By store" table (store, today, yesterday, 7 days ago, 30-day lowest, 30-day highest);
  - badges "Lowest in 30 days" / "Highest in 30 days".
- R4.4 Plain-sentence summaries at the top of each product: "Down $35 (7%) since last week. Lowest price in 30 days."
- **Acceptance:**
  - A4.1 `grep -r "recharts\|LineChart\|AreaChart\|Sparkline" src` returns nothing (except the protected file, if documented).
  - A4.2 Tables read correctly at 375 px (stacked cards on mobile).

### R5. One shared login, plain English, safe (P0)

- R5.1 **Disable public sign-up.**
  - Hide the "Create Account" tab behind `NEXT_PUBLIC_ALLOW_SIGNUP` (default false).
  - The server rejects sign-up when false.
  - `HUMAN_ACTIONS.md` tells the owner to turn off "Allow new users to sign up" in Supabase Auth.
  - Keep "Forgot password".
- R5.2 The single account is the admin (`app_admins`). Rename the **Admin** menu to **Store status**. Default tabs, in plain words:
  - "Stores": name, what we can get there (Verified live / Web estimate / Dealer list / Link only), last successful check, problems in one sentence;
  - "Products to review": the identity review queue with "Same product" / "Different product" buttons and a one-line explanation;
  - "Data entry": staff-checked price, dealer list import;
  - "Usage": web estimates left this month, emails sent today/this month vs limits.

  The existing technical tabs (failures, sessions, flags) move under a collapsed **Technical details**.
- R5.3 Settings page:
  - the retailer list comes from the registry (remove stale names);
  - the time zone is used by the email;
  - remove any setting that does nothing.
- R5.4 **AI chat.**
  - Turn it off by default (`chat.enabled` flag, false).
  - If kept, it may only answer from stored prices with store and time cited, must say "I don't know; run a search" otherwise, and must never state a price without a source line.
  - Add a test that a question with no data returns no number.
- R5.5 Error messages everywhere use plain sentences plus a retry. Log the technical detail server-side only.
- **Acceptance:**
  - A5.1 A sign-up attempt fails server-side with the flag off.
  - A5.2 No screen outside "Technical details" contains `adapter`, `UCP_`, `_URL`, `source.`, `engine.` or snake_case identifiers (add a test that scans rendered text for these patterns on the main pages).

### R6. Stock status (P0)

Persist `availability` from adapters (in stock / out of stock / unknown) through observations and the bridge. Show it in search, tracked product details (read-only, outside the protected file), history and email. Acceptance: tests for each adapter's availability mapping with recorded fixtures.

### R7. P1 features (after all P0 pass)

- R7.1 **Export:** "Download CSV" and "Download Excel (.xlsx)" on Morning Email (chosen products) and History (current filter).
  - Columns: product, brand, size, store, price, label, checked at, stock, URL.
  - Use a small, maintained library (for example `exceljs`) or plain CSV if adding a dependency is not justified.
- R7.2 **Product groups:**
  - table `product_groups` + `product_group_members`;
  - create, rename and delete groups;
  - assign products from the Morning Email list;
  - filter by group in Email, History and Search results.
- R7.3 **CSV batch import** of products to track (name or UPC, optional size, colour, target price, group):
  - preview with match results;
  - confirm, which creates tracked products by calling the existing track flow;
  - rows that can't be matched go to a "Couldn't match" list with a reason.
- R7.4 **Broken-link detection:** when a known product URL returns 404/410 twice in a row, mark the listing "Link broken" and show it in Store status. Mention it in the email summary ("1 store link stopped working").
- R7.5 **Dashboard "Today" panel:**
  - drops and increases since yesterday (numbers + list);
  - targets hit;
  - the email status ("Sent 9:01 a.m. to 3 people" / failure banner);
  - stores not checked today;
  - products to review.

### R8. P2 (human-dependent; implement only the code side if missing)

- UCP agent profile URL;
- eBay keys;
- terms reads (U.N. Luggage, Bentley);
- Samsonite dealer list import (already supported by feed import);
- an accessories price band switch (`pack.priceBand` per category) if the client asks.

---

## 4. Architecture

```
Browser (Next.js pages)
  └─ /search  → POST /api/research (session) ─┬─ engine adapters (verified)      ─┐
                                              ├─ web estimates (Tavily search,  │→ validate → observations
                                              │   snippets only, R3 rules)      │   (append-only, labelled)
                                              └─ staff / dealer-feed prices     ─┘
  └─ /email   → /api/email/* (settings, products, preview, test, log)
  └─ /history, /products/[id] → tables from observations + price_history
Scheduler: Supabase pg_cron (*/15) ─→ POST /api/cron/tick ─→ prepare | send | daily jobs | retention
           (fallbacks: worker pg-boss schedule tz=America/Edmonton; vercel.json daily)
Mailer: src/lib/mailer.ts → Resend (verified domain) | SMTP (nodemailer)
```

- **Time zone logic** lives in one module (`src/lib/time/local.ts`) using `Intl.DateTimeFormat` with `timeZone`. Do not hand-roll DST offsets. Unit-test the 2026-11-01 and 2027-03-14 transitions.
- **Digest builder** (`src/lib/digest/build.ts`) is a pure function: (chosen products + latest observations + yesterday's + 30-day stats) → a view model. Renderers (`html.ts`, `text.ts`) are pure. The same view model drives the preview, test and daily send.
- **Run controller** (`src/lib/digest/run.ts`): claim run row → (prepare done?) → build → send per recipient with retry (2 tries, backoff) → record → banner state.
- Keep the engine as the single source of current prices; the old `src/lib/search/**` code is used only as the estimate extractor inside R3.

## 5. Database changes (migration `supabase/migrations/006_client_ready.sql`)

Additive and idempotent, with RLS on every table (owner = `auth.uid()`; service role for jobs). Write it, run it twice in `npm run test:db`, and extend the test suite.

- `email_digest_settings`:
  - `user_id uuid pk references auth.users on delete cascade`;
  - `enabled bool default true`;
  - `send_time time default '09:00'`;
  - `timezone text default 'America/Edmonton'` (validated against `Intl.supportedValuesOf('timeZone')` in the API);
  - `recipients text[] not null default '{}'` (check: `cardinality <= 10`);
  - `updated_at`.
- `email_digest_products`:
  - `user_id`, `tracked_product_id uuid references tracked_products(id) on delete cascade`, `position int`, `created_at`;
  - primary key (`user_id`, `tracked_product_id`).
- `email_digest_runs`:
  - `id`, `user_id`, `local_date date`;
  - `kind text check in ('daily','test')`;
  - `status text check in ('claimed','preparing','sending','sent','partial','failed','missed','skipped')`;
  - `claimed_at`, `prepared_at`, `sent_at`;
  - `recipients jsonb` (per address: status, provider id, error);
  - `product_count int`, `snapshot jsonb` (what was sent), `error text`;
  - **unique (`user_id`, `local_date`) where kind = 'daily'** (partial unique index).
- `product_groups` (`id`, `user_id`, `name`, unique (`user_id`, lower(`name`))) and `product_group_members` (`group_id`, `tracked_product_id`), for R7.2.
- `observations`: allow the adapter `web_estimate` and freshness `estimate`, plus `availability` if missing; add `evidence jsonb` if missing. Keep append-only triggers.
- `listings`: `link_status text default 'ok'` and `link_failures int default 0` (R7.4).
- `supabase/scheduler/schedule.sql` (not a migration; run manually):
  - enables `pg_cron`/`pg_net` if absent;
  - reads `app_url` and `cron_secret` from Vault;
  - schedules `luggagetracker-tick` every 15 minutes;
  - includes an `unschedule` statement.

## 6. Roles and permissions

- One business account = owner + admin (`app_admins`). No other roles.
- All user tables: RLS `user_id = auth.uid()`.
- Cron, worker and scheduler use the service role only on the server.
- API routes:
  - zod-validate input;
  - check the session;
  - rate-limit research (existing) and test sends (5/hour).
- Recipients may only be set by the signed-in owner. The test send goes only to an address already in the list.

## 7. UI/UX guidelines

- Keep the existing design system (shadcn/ui, Tailwind tokens, Outfit font, light/dark).
- Wording:
  - Canadian English; prices like `$1,234.95`; times like `9:02 a.m.`; dates like `Fri, Oct 10`;
  - plain words, short sentences.
- Labels (exact text):
  - "Verified live · {time}"
  - "Web estimate · confirm on site"
  - "Staff-checked · {date}"
  - "Dealer list · as of {date}"
  - "Last seen · {date}"
  - "Out of stock"
- No charts. Numbers, arrows (▼ green = cheaper, ▲ red = more expensive), "Lowest in 30 days" badges, and tables that become stacked cards under 640 px.
- Every async action has a loading state, success toast and error message with retry. Empty states say what to do next ("No products chosen yet. Tick products below or use 'Add to morning email' on search results.").
- Accessibility:
  - labels on every input;
  - focus rings;
  - `aria-live` for streaming results;
  - colour is never the only signal (arrows + text);
  - WCAG AA contrast.
- Navigation: Dashboard · Search · Tracked Products · **Morning Email** · Price History · **Store status** · Settings.

## 8. Business workflows to validate end to end

1. **Morning routine:**
   - (a) 8:00 prepare;
   - (b) 9:00 email to all recipients;
   - (c) the manager opens the email, clicks a store link, and sees the same price on the store page;
   - (d) a failure shows a banner in the app.
2. **Find a price for a customer:** search → lowest first → open the store link → optionally "Add to morning email".
3. **Choose email products:**
   - tick products on `/email`, or use "Add to morning email" from search;
   - preview;
   - send a test.
4. **Weekly review:** History "Changes" (30 days) → export CSV → products to review (approve/reject).
5. **Staff-checked price:** a salesperson sees a competitor price in a flyer or store → Store status → Data entry → saved with date → appears as "Staff-checked · Oct 9".
6. **Dealer list:** import a CSV with an as-of date → prices show "Dealer list · as of …".

## 9. Error handling

- Server:
  - typed errors;
  - no stack traces to the client;
  - JSON `{ error: "<plain sentence>" }` with the right status;
  - log with a request id.
- Engine/store failures degrade to last-known prices with dates. Tavily failures or cap degrade to "no estimates", never to an error page.
- Mail failures:
  - per-recipient retry ×2;
  - recorded;
  - banner;
  - the next email mentions them.
- Scheduler gaps: "late scheduler" recorded; catch-up rules per R1.4.
- Client: React error boundaries on `/search`, `/email`, `/history` and `/products/[id]`, with a friendly retry.

## 10. Security

- Rotate the exposed secrets (Resend key, CRON_SECRET, SerpAPI key; remove `SERPAPI_KEY`). This is a human action; list it first in `HUMAN_ACTIONS.md`.
- `CRON_SECRET` compared in constant time; tick endpoint POST only; Vault for pg_cron secrets.
- Sign-up off (R5.1). Supabase RLS on all new tables, tested as owner/other/anon in `test:db`.
- Email:
  - escape all dynamic text;
  - validate addresses (zod email + max 10);
  - no open relay (recipients only from settings).
- Never log recipients' full addresses (mask as `v***@gmail.com`) or secrets.
- Keep the SSRF guard and the registry `fetchHosts` rules. Estimates never fetch store pages.

## 11. Testing strategy

- **Unit (Vitest):**
  - time-zone/DST scheduler;
  - digest builder;
  - HTML/text renderers (snapshot);
  - estimate validator (every R3.2 rule + E1/E2 fixtures);
  - budget planner;
  - row collapsing;
  - stock mapping;
  - CSV export/import parsing;
  - sign-up guard;
  - chat refusal.
- **Integration:**
  - tick endpoint with a fake clock + capturing mailer + local Postgres (`db:dev`): prepare → send → idempotency → partial failure → banner;
  - research session with stubbed adapters + estimates.
- **Database:** `npm run test:db` extended for migration 006 (applied twice; RLS; unique daily run; cascade on untrack).
- **End-to-end:**
  - Playwright against `npm run dev` + local DB, with a test user created in the **local** database only;
  - flows: search → add to email → `/email` preview → test send (capturing mailer) → history table → export download;
  - run at 1280 px and 375 px.
  - If Playwright can't be added at $0 or doesn't run here, document it and do a scripted manual check instead.
- **Real-world checks (record evidence in `PROGRESS_V2.md`):**
  - one real research session per verified store;
  - one estimate run on 5 well-known products, comparing each accepted estimate against the store page opened **by a human** (list it in `HUMAN_ACTIONS.md`; do not fetch forbidden pages yourself);
  - one real test email.
- **All existing gates must stay green.** Before every phase is marked done, run:
  - `npx tsc --noEmit` (root + worker);
  - `npm run lint`;
  - `npx next build`;
  - `npm run verify:search`;
  - `npm test`;
  - `npm run test:db`;
  - `npm run test:worker`;
  - `npm run probe:sources -- --selftest`.

## 12. Phases (do them in order; each ends with its checks passing and a "Ready to commit" hand-off to the owner)

| Phase | Work | Done when |
|---|---|---|
| **Q0 Inspect** | Read the files in §2; run all gates; review and commit the uncommitted 2026-10-10 changes (`ResearchResults.tsx`, `registry/index.ts`, `dev-db.ts`) after tests; create `PROGRESS_V2.md` with the findings and any differences from §2 | Gates green; baseline recorded |
| **Q1 Safety** | R5.1 sign-up off; R5.4 chat off; R2.7 honest copy; R5.3 settings list from the registry | A5.1 passes; copy updated |
| **Q2 Search** | R2 + R6 (one search, row collapsing, stock, error boundary) | A2.1–A2.3 pass |
| **Q3 Estimates** | R3 (validator, fixtures, storage, budget planner, labels) | A2.4, A3.1–A3.3 pass |
| **Q4 Email core** | Migration 006, mailer, time module, digest builder/renderers, `/email` page, preview, test send, log | A1.2, A1.4 pass; preview shows real data |
| **Q5 Scheduler** | `/api/cron/tick`, prepare/send, idempotency, catch-up, banner, `schedule.sql`, worker pg-boss fallback, old report delegation | A1.1 passes; integration test green |
| **Q6 No graphs** | R4 tables, remove recharts | A4.1–A4.2 pass |
| **Q7 Plain English** | R5.2 Store status, R5.5 messages, rendered-text scan test | A5.2 passes |
| **Q8 P1 features** | R7.1–R7.5 | Each has tests; works in the UI |
| **Q9 Verify like a client** | Run §8 workflows end to end; real test email (A1.3); 375 px pass; fix everything found | Evidence in `PROGRESS_V2.md` |
| **Q10 Docs and handover** | Update README, SETUP, ARCHITECTURE, RUNBOOK, HUMAN_ACTIONS (ordered go-live), `.env.example`; write `docs/FINAL_REPORT_V2.md` | Docs match the code |

Inside each phase:

1. Inspect the existing code for that area.
2. Write or adjust tests first where practical.
3. Implement.
4. Run the phase checks and all gates.
5. Fix failures.
6. Stop with a "Ready to commit" list (files + suggested message, e.g. `feat(email): … [R1.4]`). The owner commits; continue after he says so.
7. Update `PROGRESS_V2.md`.

If you discover a missing requirement, add it to §15 of `PROGRESS_V2.md` with the reason, implement it if it's clearly in scope and $0, otherwise list it as an open question.

## 13. Coding standards

- TypeScript strict; no `any` without a comment explaining why; zod at every API boundary.
- Small pure modules for logic (time, digest, validation, budget). Side effects at the edges (routes, jobs).
- Reuse existing utilities (`esc`, `usd`, `freshnessLabel`, retailer colours, identity rules, the Tavily credit reservation). Don't duplicate them.
- Prettier config of the repo; ESLint clean (the 4 known warnings in the protected file are allowed).
- Comments explain *why*. Keep names in the codebase's style.
- New dependencies:
  - only if needed, maintained, MIT/Apache-licensed and free;
  - pin versions;
  - note them in `PROGRESS_V2.md`.

## 14. Deployment (document; human executes)

The code must run on **both**:

- (a) Vercel (current);
- (b) a plain Node host with `next build && next start` or the Dockerfile, behind Cloudflare Tunnel on the office PC or an Oracle Always Free VM, next to the worker.

Write `docs/DEPLOY.md` covering both, and state plainly:

- Vercel Hobby is limited to non-commercial personal use, and its cron fires anywhere within the hour.
- The scheduler uses Supabase pg_cron so either host gets an on-time 9:00 email.
- Supabase Free pauses after 7 days of low activity. The daily jobs create activity, but the owner should check Store status weekly.

Environment variables: add every new one to `.env.example` with a comment:

- `EMAIL_PROVIDER`, `SMTP_*`;
- `EMAIL_DAILY_LIMIT`, `ESTIMATE_DAILY_BUDGET`;
- `NEXT_PUBLIC_ALLOW_SIGNUP`;
- `APP_URL` if missing.

## 15. Final acceptance (the client's checklist; all must be true)

1. The client signs in with the single business login. Nobody can create a new account from the login page.
2. Searching a bag shows the **lowest price first**, and **every store we have a number for**, one row per store, each with a clear label and time. No junk items. No prices like E1. No technical words.
3. The client ticks products on **Morning Email**, adds 1–10 addresses, previews and sends a test. **The next morning at 9:00 Calgary time** (±15 min), every address gets one email with those products' prices at every store, lowest first, with changes since yesterday, stock, and "Lowest in 30 days".
4. If the email fails, the app shows it.
5. There are **no graphs** anywhere. History is readable as tables and sentences.
6. Store status explains in plain words which stores give verified prices, which give estimates, and which are links only, and how many free web estimates are left this month.
7. All quality gates pass. `docs/PROGRESS_V2.md` and `docs/FINAL_REPORT_V2.md` list:
   - what was verified, with evidence;
   - what wasn't;
   - every assumption and limitation;
   - the ordered human actions.
8. Nothing costs money. No paid plan or pay-as-you-go was enabled by the code.

## 16. Known limitations and open questions (keep honest; do not hide)

- **At $0, Amazon, Walmart, Best Buy, Costco, Canadian Tire and London Drugs can never be "verified live".**
  - At best they show validated web estimates (when search results contain their product page and price), staff-checked prices, or a link.
  - Samsonite.ca and TUMI.ca need the dealer list for reliable prices.
- Web estimates depend on Tavily's free credits (≈950/month cap in the app) and on what search results contain. Some products will have no estimate on some days.
- Verified coverage grows only through human actions: the UCP profile, terms reads, eBay keys, dealer feeds.
- Not verified at the time of writing:
  - Tavily free-plan commercial-use terms;
  - Gemini free-tier data use;
  - Gmail SMTP daily limits;
  - whether Walmart/Best Buy/Samsonite Canada affiliate programs provide price feeds to a retailer.

  List each in `HUMAN_ACTIONS.md` with how to check.

## 17. Finish

When every phase is done:

1. Run all gates one last time.
2. Update `docs/PROGRESS_V2.md` (final gate table) and write `docs/FINAL_REPORT_V2.md`, covering:
   - what changed per requirement ID;
   - evidence;
   - coverage per store;
   - limitations;
   - the human go-live checklist in order.
3. Stop and give a 10-line summary.

Do not merge or push unless the owner asks.
