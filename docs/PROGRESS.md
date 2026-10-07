# Price Engine: Progress

Branch: `feat/price-engine` (no force-push, no history rewrites; `main` untouched until merge).
Plan and rules: [`MASTER_PROMPT.md`](../MASTER_PROMPT.md). Things only a human can do: [`HUMAN_ACTIONS.md`](./HUMAN_ACTIONS.md).

| Phase | Status | Evidence / reason |
|---|---|---|
| **P0 Evidence** | ✅ done | Probe selftest 36/36. Live probe run (46 requests, honest UA, robots honoured). [`PROBE_REPORT.md`](./PROBE_REPORT.md). Registry seed `src/lib/engine/registry/seed.ts` updated from the evidence; 47 registry/pack tests pass. |
| P1 Schema | ⏳ next | |
| P2 Worker + queue + politeness | ⏳ | |
| P3 Adapters + extraction + validation | ⏳ | |
| P4 Research Session API + streaming UI | ⏳ | |
| P5 Discovery/indexing + identity + review queue | ⏳ | |
| P6 Scheduler + tracked verification + alerts + report | ⏳ | |
| P7 Admin/observability | ⏳ | |
| P8 Shadow mode + test set | ⏳ | |
| P9 Hardening + docs | ⏳ | |

## Quality gates (latest run)

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ 0 errors. 4 pre-existing `react-hooks/exhaustive-deps` warnings remain in `src/app/tracked/page.tsx`, which rule 5 forbids editing. |
| `npm run verify:search` | ✅ 339/339 |
| `npm run probe:sources -- --selftest` | ✅ 36/36 |
| `npm test` (Vitest) | ✅ 47/47 |
| `npx next build` | not yet run on this branch |

## P0 notes

- **Samsonite.ca and TUMI.ca are blocked** (PerimeterX CAPTCHA, HTTP 307) from our network with an honest UA, so the audit's "probably not blocked" is overturned. Sporting Life and Simons sit behind Cloudflare challenges even for `robots.txt`. All four are `blocked` in the registry; per rule 1 we do not work around them.
- The probe classifier logged the 307 CAPTCHA as a generic `error`. Fixed (`scripts/probe/http.ts` → `challenge`), with 6 new selftest cases.
- **Contact in the User-Agent:** no `PROBE_CONTACT` / `CRAWLER_CONTACT` was configured. The probe and engine use the project's public issue tracker (`https://github.com/VanshTuteja15/Luggage_Checker/issues`), so every request carries a working contact without exposing anyone's personal email. A monitored business address is better: see HUMAN_ACTIONS.
- **Coverage today, without any human action:** live prices from Canada Luggage Depot (product JSON sanctioned by its agents.md) and Delsey.ca (terms silent). Six more Shopify stores light up when the UCP agent profile is published; U.N. Luggage and Bentley when a human reads their terms; eBay with free API keys.

## Decisions and additions (MASTER_PROMPT §5)

| What | Why |
|---|---|
| New identity tables are prefixed `catalog_` (`catalog_products`, `catalog_variants`, `catalog_identifiers`) | A `products` table already exists and belongs to the tracking workflow (rule 5). Additive, no collision. |
| `fetchHosts` separate from `allowedDomains` in the registry | Makes rule 2 structural: stores whose terms forbid automated access have no storefront host the fetcher may contact, so a coding mistake can't fetch their HTML. |
| Worker targets **Node 22 LTS**, not Node 20 | Node 20 reached end-of-life in April 2026, and pg-boss 12 requires Node ≥ 22.12. |
| ESLint 9 + `eslint-config-next` installed, flat config added | `npm run lint` could not run at all: ESLint wasn't installed, so `next lint` would have prompted interactively. |
| Outfit font moved to `next/font` | Fixes a lint warning; the font is self-hosted, so visitors' browsers no longer call Google Fonts (privacy). |
| Vitest for new suites (`npm test`) | The existing `verify:search` harness stays as is; new engine suites use Vitest. |
