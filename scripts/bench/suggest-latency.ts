/* ------------------------------------------------------------------ */
/*  npm run bench:suggest                                              */
/*                                                                     */
/*  v5 F2.5 acceptance: autocomplete p95 < 100 ms on the dev database  */
/*  with the full index. Times what GET /api/search/suggest does after */
/*  sign-in (popular searches from research_sessions + the in-memory   */
/*  vocabulary) for every 2–12 letter prefix of 40 real searches.      */
/*  Reads only; no store is contacted.                                  */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { ensureVocabulary } from "../../src/lib/engine/query/load";
import { suggestFor } from "../../src/lib/engine/query/suggest";
import { PgEngineStore } from "../../src/lib/engine/store/pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !/localhost|127\.0\.0\.1/.test(url))
    throw new Error("set DATABASE_URL to the local dev database (npm run db:dev -- up)");
  const store = new PgEngineStore(url, 2);
  await store.warm(2);
  await ensureVocabulary(store);
  const queries = (
    JSON.parse(readFileSync("scripts/bench/sets/queries.json", "utf8")) as {
      items: { query: string }[];
    }
  ).items
    .map((i) => i.query)
    .slice(0, 40);
  const prefixes = queries.flatMap((q) =>
    Array.from({ length: Math.min(11, q.length - 1) }, (_, i) => q.slice(0, i + 2)),
  );
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const times: number[] = [];
  let shown = 0;
  for (const p of prefixes) {
    const t0 = performance.now();
    const popular = await store.popularQueries(p, { sinceIso: since, limit: 4 });
    const s = suggestFor(p, popular);
    times.push(performance.now() - t0);
    if (s.length) shown++;
  }
  times.sort((a, b) => a - b);
  const pct = (x: number) => times[Math.min(times.length - 1, Math.floor((times.length - 1) * x))];
  console.log(
    JSON.stringify({
      prefixes: prefixes.length,
      withSuggestions: shown,
      p50Ms: Math.round(pct(0.5) * 10) / 10,
      p95Ms: Math.round(pct(0.95) * 10) / 10,
      maxMs: Math.round(times[times.length - 1] * 10) / 10,
    }),
  );
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
