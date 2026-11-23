/* ------------------------------------------------------------------ */
/*  npm run coverage [-- --max-credits=30 --max-requests=130]          */
/*                                                                     */
/*  v5 F1.3: how many stores show a number for the searches the        */
/*  client cares about. Runs REAL research sessions (live stores via   */
/*  the PoliteFetcher, web estimates via Tavily's free credits) on the */
/*  local dev database only, then writes docs/COVERAGE_REPORT.md and   */
/*  docs/coverage/latest.json.                                          */
/*                                                                     */
/*  Per query: stores with a number for the top product (verified vs   */
/*  web estimate vs staff/dealer), every accepted estimate's URL for   */
/*  the owner to spot-check, and an identity re-check of each estimate */
/*  against the query (0 wrong-identity offers is the target).         */
/*                                                                     */
/*  Budgets are hard stops: the run stops spending web credits once    */
/*  the next query could pass --max-credits (each query can use 2: the */
/*  combined search and the brand-store search), and stops altogether  */
/*  once live store requests reach --max-requests.                     */
/* ------------------------------------------------------------------ */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { engineConfig } from "../../src/lib/engine/config";
import { createEstimateFinder, tavilyUsage } from "../../src/lib/engine/estimates/deps";
import { expectedFromQuery, identityReasons } from "../../src/lib/engine/estimates/validate";
import { luggagePack as pack } from "../../src/lib/engine/packs/luggage";
import { createRuntime } from "../../src/lib/engine/recorder";
import { freshnessLabel } from "../../src/lib/engine/research/answer";
import { createSession } from "../../src/lib/engine/research/api";
import { ResearchManager } from "../../src/lib/engine/research/manager";
import { PgEngineStore } from "../../src/lib/engine/store/pg";
import type { AnswerOffer, AnswerProduct, Freshness } from "../../src/lib/engine/types";

/**
 * The 15 queries (ids in scripts/bench/sets/queries.json): Samsonite, TUMI,
 * Travelpro, Delsey, Briggs & Riley, carry-on, large spinner, under $300.
 */
export const COVERAGE_IDS = [
  "q01", // Samsonite Omni 3.0 Large (large spinner)
  "q04", // samsonite paralux medium
  "q14", // Nexis Large 28
  "q03", // Samsonite carry-on black (carry-on)
  "q07", // TUMI 19 Degree International Expandable carry-on
  "q47", // tumi 19 degree lite medium
  "q09", // Travelpro Platinum Elite 21
  "q39", // travelpro maxlite 5 22 inch
  "q05", // Delsey Chatelet Air 2.0 26 inch
  "q36", // Delsey ALU'R 28
  "q10", // briggs and riley baseline global carry on
  "q46", // briggs riley baseline medium
  "q43", // american tourister airconic large spinner navy (large spinner)
  "q37", // aluminum carry-on (carry-on)
  "q02", // cheapest 24 inch hard spinner under $300 (under $300)
] as const;

const CREDITS_PER_QUERY = 2;

type Kind = "verified" | "estimate" | "staff_or_dealer" | "last_seen";

function kindOf(f: Freshness): Kind {
  if (f.kind === "live") return "verified";
  if (f.kind === "estimate") return "estimate";
  if (f.kind === "stale") return "last_seen";
  return "staff_or_dealer";
}

type StoreNumber = {
  store: string;
  sourceId: string;
  price: number;
  kind: Kind;
  label: string;
  url: string;
  title: string;
};

type QueryRow = {
  id: string;
  query: string;
  sessionId: string;
  firstPriceMs: number | null;
  totalMs: number;
  deadlineHit: boolean;
  estimatesRun: boolean;
  estimates: Record<string, unknown> | null;
  credits: number;
  requests: number;
  products: number;
  top: { name: string; sizeClass: string | null; lowest: number | null } | null;
  /** One row per store (its lowest current price) for the top product. */
  topStores: StoreNumber[];
  /** Distinct stores with a current number for any product in the answer. */
  anyProductStores: number;
  /** Accepted estimates that fail the identity rules against the query (should be none). */
  wrongIdentity: { url: string; title: string; reasons: string[] }[];
};

function arg(name: string, fallback: number): number {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  const n = a ? Number(a.split("=")[1]) : fallback;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The top product's stores: each store's lowest current price (last-seen prices don't count). */
function storesFor(p: AnswerProduct): StoreNumber[] {
  const best = new Map<string, AnswerOffer>();
  for (const o of p.offers) {
    if (o.freshness.kind === "stale") continue;
    const prev = best.get(o.sourceId);
    if (!prev || o.price < prev.price) best.set(o.sourceId, o);
  }
  return [...best.values()]
    .sort((a, b) => a.price - b.price)
    .map((o) => ({
      store: o.retailer,
      sourceId: o.sourceId,
      price: o.price,
      kind: kindOf(o.freshness),
      label: freshnessLabel(o.freshness),
      url: o.url,
      title: o.title,
    }));
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const money = (n: number) =>
  `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !/localhost|127\.0\.0\.1/.test(url))
    throw new Error("set DATABASE_URL to the local dev database (npm run db:dev -- up)");
  const maxCredits = arg("max-credits", 30);
  const maxRequests = arg("max-requests", 130);

  const items = (
    JSON.parse(readFileSync("scripts/bench/sets/queries.json", "utf8")) as {
      items: { id: string; query: string }[];
    }
  ).items;
  const queries = COVERAGE_IDS.map((id) => {
    const it = items.find((x) => x.id === id);
    if (!it) throw new Error(`query ${id} is not in scripts/bench/sets/queries.json`);
    return it;
  });

  const store = new PgEngineStore(url, 4);
  await store.warm(4);
  const { rows: users } = await store.pool.query(
    `INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-00000000c11c', 'research-cli@localhost.test')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
  );
  const rt = createRuntime(store);
  const withEstimates = new ResearchManager(rt, pack, {
    maxConcurrent: 2,
    estimates: createEstimateFinder(rt, pack),
  });
  const verifiedOnly = new ResearchManager(rt, pack, { maxConcurrent: 2 });

  const usageBefore = await tavilyUsage().catch(() => null);
  const runStart = new Date();
  const spentSince = async (since: Date) =>
    Number(
      (
        await store.pool.query(
          "SELECT coalesce(sum(credits), 0)::int AS n FROM web_estimate_searches WHERE searched_at >= $1",
          [since],
        )
      ).rows[0].n,
    );
  const requestsSince = async (since: Date) =>
    Number(
      (
        await store.pool.query(
          "SELECT count(*)::int AS n FROM fetch_attempts WHERE started_at >= $1",
          [since],
        )
      ).rows[0].n,
    );

  const out: QueryRow[] = [];
  const skipped: string[] = [];
  for (const q of queries) {
    const requestsSoFar = await requestsSince(runStart);
    if (requestsSoFar >= maxRequests) {
      skipped.push(`${q.id} (live request budget reached: ${requestsSoFar})`);
      continue;
    }
    const creditsSoFar = await spentSince(runStart);
    const estimatesRun = creditsSoFar + CREDITS_PER_QUERY <= maxCredits;
    const manager = estimatesRun ? withEstimates : verifiedOnly;
    const created = await createSession(
      store,
      users[0].id,
      { query: q.query },
      engineConfig(),
      "inline",
    );
    if (!created.ok) throw new Error(created.error);
    let estimates: Record<string, unknown> | null = null;
    manager.subscribe(created.session.id, (e) => {
      if (e.type === "estimates_done") estimates = e.payload as Record<string, unknown>;
    });
    const t = new Date();
    const answer = await manager.start(created.session.id);
    // Estimates that arrive after the answer are stored, not shown: give them a moment to land.
    await new Promise((r) => setTimeout(r, 1_500));
    if (!answer) throw new Error(`session for "${q.query}" ended without an answer`);

    const top = answer.products[0] ?? null;
    const expected = expectedFromQuery(pack.parseQuery(q.query));
    const sources = await rt.sources();
    const wrongIdentity: QueryRow["wrongIdentity"] = [];
    for (const p of answer.products)
      for (const o of p.offers) {
        if (o.method !== "web_estimate") continue;
        const source = sources.find((s) => s.id === o.sourceId);
        if (!source) continue;
        const reasons = identityReasons(
          {
            sourceId: o.sourceId,
            url: o.url,
            title: o.title,
            snippet: "",
            query: q.query,
            foundAt: "",
          },
          source,
          expected,
          pack,
        ).filter((r) => r !== "size mismatch: the text describes another size");
        if (reasons.length) wrongIdentity.push({ url: o.url, title: o.title, reasons });
      }
    const any = new Set(
      answer.products.flatMap((p) =>
        p.offers.filter((o) => o.freshness.kind !== "stale").map((o) => o.sourceId),
      ),
    );
    const row: QueryRow = {
      id: q.id,
      query: q.query,
      sessionId: created.session.id,
      firstPriceMs: answer.firstPriceMs,
      totalMs: answer.totalMs,
      deadlineHit: answer.deadlineHit,
      estimatesRun,
      estimates,
      credits: await spentSince(t),
      requests: await requestsSince(t),
      products: answer.products.length,
      top: top ? { name: top.name, sizeClass: top.sizeClass, lowest: top.lowestPrice } : null,
      topStores: top ? storesFor(top) : [],
      anyProductStores: any.size,
      wrongIdentity,
    };
    out.push(row);
    const by = (k: Kind) => row.topStores.filter((s) => s.kind === k).length;
    console.log(
      `${q.id} "${q.query}": ${row.topStores.length} stores (verified ${by("verified")}, estimate ${by("estimate")}, staff/dealer ${by("staff_or_dealer")}) · ${row.totalMs} ms · ${row.credits} credits · ${row.requests} requests${estimatesRun ? "" : " · estimates not run (credit budget)"}`,
    );
  }
  const usageAfter = await tavilyUsage().catch(() => null);

  const counts = out.map((r) => r.topStores.length);
  const verifiedCounts = out.map(
    (r) => r.topStores.filter((s) => s.kind === "verified" || s.kind === "staff_or_dealer").length,
  );
  const summary = {
    date: runStart.toISOString(),
    queries: out.length,
    skipped,
    medianStoresWithNumber: median(counts),
    medianStoresBefore: median(verifiedCounts),
    queriesWithThreeOrMore: counts.filter((n) => n >= 3).length,
    estimatesShown: out.reduce(
      (n, r) => n + r.topStores.filter((s) => s.kind === "estimate").length,
      0,
    ),
    wrongIdentityOffers: out.reduce((n, r) => n + r.wrongIdentity.length, 0),
    credits: await spentSince(runStart),
    requests: await requestsSince(runStart),
    tavilyUsedBefore: usageBefore?.used ?? null,
    tavilyUsedAfter: usageAfter?.used ?? null,
    totalMsMax: Math.max(...out.map((r) => r.totalMs)),
    firstPriceMsMedian: median(
      out.map((r) => r.firstPriceMs).filter((x): x is number => x !== null),
    ),
  };

  mkdirSync("docs/coverage", { recursive: true });
  writeFileSync("docs/coverage/latest.json", `${JSON.stringify({ summary, rows: out }, null, 2)}\n`);
  writeFileSync("docs/COVERAGE_REPORT.md", report(summary, out));
  console.log(`\n${JSON.stringify(summary, null, 2)}`);

  await rt.recorder.stop();
  await store.close();
}

function report(s: Record<string, unknown> & { skipped: string[] }, rows: QueryRow[]): string {
  const kindName: Record<Kind, string> = {
    verified: "Verified live",
    estimate: "Web estimate",
    staff_or_dealer: "Staff / dealer",
    last_seen: "Last seen",
  };
  const lines = [
    "# Coverage report (v5 F1.3)",
    "",
    `Generated by \`npm run coverage\` on ${String(s.date).slice(0, 16).replace("T", " ")} UTC against the local dev database: real research sessions (live store reads through the PoliteFetcher, web estimates from Tavily search snippets on the free plan). "Stores with a number" counts, for the **top product** of each search, the stores showing a current price (verified live, web estimate, staff-checked or dealer list); "last seen" prices don't count.`,
    "",
    "## Summary",
    "",
    "| Measure | Value | Target |",
    "|---|---|---|",
    `| Queries run | ${s.queries} of ${rows.length + s.skipped.length} | 15 |`,
    `| Median stores with a number (top product) | **${s.medianStoresWithNumber}** | ≥ 3 |`,
    `| Same, verified/staff/dealer only (what search showed without estimates) | ${s.medianStoresBefore} | |`,
    `| Queries with ≥ 3 stores | ${s.queriesWithThreeOrMore} | |`,
    `| Web estimates shown on top products | ${s.estimatesShown} | |`,
    `| Wrong-identity offers (automatic re-check) | **${s.wrongIdentityOffers}** | 0 |`,
    `| Web credits spent | ${s.credits} | ≤ 30 |`,
    `| Live store requests | ${s.requests} | ≤ 200 for the night |`,
    `| Slowest search, complete | ${s.totalMsMax} ms | ≤ 8,000 ms |`,
    `| First price, median | ${s.firstPriceMsMedian} ms | ≤ 1,500 ms |`,
    "",
    ...(s.skipped.length ? ["Skipped: " + s.skipped.join("; "), ""] : []),
    "## Per query",
    "",
    "| # | Query | Top product | Stores with a number | Verified | Estimate | Staff/dealer | Complete |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => {
      const by = (k: Kind) => r.topStores.filter((x) => x.kind === k).length;
      return `| ${r.id} | ${r.query} | ${r.top ? `${r.top.name}${r.top.sizeClass ? ` (${r.top.sizeClass.replace("_", "-")})` : ""}` : "nothing found"} | ${r.topStores.length} | ${by("verified")} | ${by("estimate")} | ${by("staff_or_dealer")} | ${(r.totalMs / 1000).toFixed(1)} s |`;
    }),
    "",
    "## Every price on the top products (owner spot-check list)",
    "",
    "Open each web estimate's link in a browser and compare the price. A web estimate is read from the search result, never from the store's page, so the store may have changed it since.",
    "",
    ...rows.flatMap((r) => [
      `### ${r.id} ${r.query}`,
      "",
      r.topStores.length
        ? "| Store | Price | Label | Link |\n|---|---|---|---|\n" +
          r.topStores
            .map(
              (x) =>
                `| ${x.store} | ${money(x.price)} | ${kindName[x.kind]}: ${x.label} | ${x.url} |`,
            )
            .join("\n")
        : "No current price.",
      "",
      ...(r.wrongIdentity.length
        ? [
            "**Identity re-check flagged:**",
            ...r.wrongIdentity.map((w) => `- ${w.title} (${w.url}): ${w.reasons.join("; ")}`),
            "",
          ]
        : []),
    ]),
  ];
  return `${lines.join("\n")}\n`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
