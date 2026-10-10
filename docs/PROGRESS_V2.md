# Client-ready release (V2): Progress

Branch: `feat/client-ready`, created from `feat/price-engine` (no force-push, no history rewrite, no merge to `main`).
Plan and rules: [`MASTER_PROMPT_V2.md`](../MASTER_PROMPT_V2.md) (V1 rules in [`MASTER_PROMPT.md`](../MASTER_PROMPT.md) still apply unless changed there). Why each change exists: [`CLIENT_REVIEW.md`](./CLIENT_REVIEW.md). Human-only steps: [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md).

A stopped session resumes here: the first phase not marked ✅ is next.

| Phase | Status | Evidence / reason |
|---|---|---|
| **Q0 Inspect** | ✅ done | All gates green on `feat/client-ready` (table below). Uncommitted 2026-10-10 changes reviewed, one test updated to the new shopper wording, committed as `40f16b3`. §2 facts checked; differences listed below. |
| **Q1 Safety** | ☐ next | R5.1 sign-up off, R5.4 chat off, R2.7 honest copy, R5.3 settings retailer list from the registry |
| **Q2 Search** | ☐ | R2 + R6 |
| **Q3 Estimates** | ☐ | R3 |
| **Q4 Email core** | ☐ | Migration 006, mailer, time module, digest builder/renderers, `/email` |
| **Q5 Scheduler** | ☐ | `/api/cron/tick`, prepare/send, idempotency, catch-up, banner, `schedule.sql`, worker fallback |
| **Q6 No graphs** | ☐ | R4 |
| **Q7 Plain English** | ☐ | R5.2, R5.5, rendered-text scan |
| **Q8 P1 features** | ☐ | R7.1–R7.5 |
| **Q9 Verify like a client** | ☐ | §8 workflows, A1.3, 375 px |
| **Q10 Docs and handover** | ☐ | README, SETUP, ARCHITECTURE, RUNBOOK, HUMAN_ACTIONS, DEPLOY, `.env.example`, FINAL_REPORT_V2 |

## Q0 baseline: quality gates

Run on 2026-10-10 (Node 24.15, Windows 11, Docker 29.8 with local Postgres 17), at `f7b1002`.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` (root + worker) | ✅ both exit 0 |
| `npm run lint` | ✅ 0 errors; the 4 known `react-hooks/exhaustive-deps` warnings in the protected `src/app/tracked/page.tsx` |
| `npx next build` | ✅ 32 routes |
| `npm run verify:search` | ✅ 341/341 |
| `npm test` | ✅ 159/159 + 1 Postgres-only skip. Before the fix: 1 failure (`research.test.ts` expected the Travelpro row to mention "agent profile"; the 2026-10-10 change now says "not connected yet" on shopper rows, by design, E12). The test now asserts the plain wording and that no shopper row carries an env-style or flag-style identifier. |
| `npm run test:db` | ✅ 48/48 (+ store contract 19/19) |
| `npm run worker:build`, `test:worker`, `test:worker:e2e` | ✅ bundle OK; 6/6 (+1 skip); 7/7 on real Postgres + pg-boss |
| `npm run probe:sources -- --selftest` | ✅ 36/36 |

## Q0 findings: differences from MASTER_PROMPT_V2 §2

All §2 statements were checked against the code. They hold, with these additions and corrections:

1. **Git status.** The session snapshot said "clean", but the working tree had exactly the three modified files §2 names (`dev-db.ts`, `ResearchResults.tsx`, `registry/index.ts`) plus the untracked `MASTER_PROMPT_V2.md` and `docs/CLIENT_REVIEW.md`. All are now committed.
2. **Charts and the protected file.** `src/app/tracked/page.tsx` imports no chart directly, but it renders `TrackedProductCard` from `src/components/ProductCard.tsx`, which draws a `Sparkline`. `ProductCard.tsx` is not protected, so R4 can remove the sparkline there without touching the protected page.
3. **`esc()` is private** to `src/lib/email.ts` (not exported). R1.12 says reuse it, so it will be exported rather than copied.
4. **The daily report compares `CRON_SECRET` with `===`** (not constant time) and accepts GET. The new tick endpoint uses a constant-time compare and POST only (§10); the old route is delegated in Q5.
5. **`observations` already has `availability` and `evidence` columns, and `adapter` is free text** (no check constraint). There is no `freshness` column: freshness is derived when reading (live, feed, manual, stale). Migration 006 therefore needs no column for these; what it must change is the `price_ranges` collapse trigger, so a `web_estimate` observation never extends verified history (R3.1).
6. **Untracking** goes through `DELETE /api/products/[id]` and `DELETE /api/track`, both deleting the `tracked_products` row. An FK from `email_digest_products.tracked_product_id` to `tracked_products(id) ON DELETE CASCADE` meets R1.3 with no change to protected files.
7. **The retailer list** in Settings comes from the `user_settings.retailers` default in `000_complete_setup.sql` (includes Hudson's Bay, RIMOWA, CALPAK), as §2/E13 say.

## Decisions (with reasons)

| What | Why |
|---|---|
| `research.test.ts` expectation changed instead of reverting the 2026-10-10 change | The change is the intended fix for E12 (shoppers must not see setup identifiers). Admin still shows the detailed reason (`admin.test.ts` checks it). |
| `MASTER_PROMPT_V2.md` and `docs/CLIENT_REVIEW.md` committed | They are the binding plan and its sources; a resumed session needs them in the branch. |

## New dependencies

None yet.

## §15 Missing requirements found during the work

None yet.
