/* ------------------------------------------------------------------ */
/*  npm run engine:discover -- [--source=<id>[,<id>…]] [--max=<n>]       */
/*                                                                     */
/*  Runs discovery for real (PoliteFetcher: honest UA, robots.txt,      */
/*  crawl delays) into DATABASE_URL, then prints what the index holds.  */
/*  Without --source it runs every store discovery may touch.           */
/* ------------------------------------------------------------------ */

import { discoverAll, discoverSource, type DiscoveryResult } from "../../src/lib/engine/discovery";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { createRuntime } from "../../src/lib/engine/recorder";
import { PgEngineStore } from "../../src/lib/engine/store/pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (npm run db:dev -- up prints one for local use)");
  const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const max = Number(arg("max") ?? 40);
  const ids = arg("source")?.split(",").filter(Boolean);

  const store = new PgEngineStore(url, 4);
  const rt = createRuntime(store, {}, (err) => console.error("attempt recording failed", err));
  console.log(`discovery as: ${rt.fetcher.userAgent}`);
  const started = Date.now();
  const results: DiscoveryResult[] = ids ? [] : await discoverAll(rt, luggagePack, { maxFetches: max });
  for (const id of ids ?? []) results.push(await discoverSource(rt, luggagePack, id, { maxFetches: max }));
  await rt.recorder.stop();

  for (const r of results) {
    const line = r.method === "skipped" ? `skipped — ${r.skippedReason}` : `${r.method}: ${r.productUrls} product URLs, ${r.newListings} new, ${r.enriched} enriched, ${r.deactivated} gone, ${r.requests} requests${r.errors.length ? `, errors: ${r.errors.join("; ")}` : ""}`;
    console.log(`  ${r.sourceId.padEnd(22)} ${line}`);
  }

  const q = async (sql: string) => (await store.pool.query(sql)).rows;
  const perSource = await q("SELECT source_id, count(*)::int AS listings, count(*) FILTER (WHERE identifiers <> '[]'::jsonb)::int AS with_ids FROM listings WHERE active GROUP BY source_id ORDER BY source_id");
  const products = await q("SELECT count(*)::int AS n FROM catalog_products WHERE status = 'active'");
  const cross = await q(`SELECT p.name, p.size_class, array_agg(DISTINCT l.source_id) AS stores
                         FROM catalog_products p JOIN listings l ON l.product_id = p.id
                         WHERE p.status = 'active' GROUP BY p.id HAVING count(DISTINCT l.source_id) > 1 LIMIT 20`);
  const reviews = await q("SELECT count(*)::int AS n FROM identity_review WHERE status = 'pending'");
  const sizesMixed = await q(`SELECT p.id FROM catalog_products p JOIN listings l ON l.product_id = p.id
                              WHERE l.size_class IS NOT NULL AND p.size_class IS NOT NULL AND l.size_class <> p.size_class LIMIT 5`);
  console.log(`\nindex: ${JSON.stringify(perSource)}`);
  console.log(`catalog products: ${products[0].n}; sold at 2+ stores: ${cross.length}; pending reviews: ${reviews[0].n}; listings whose size differs from their product: ${sizesMixed.length}`);
  for (const c of cross) console.log(`  same product at ${c.stores.join(" + ")}: ${c.name} (${c.size_class})`);
  console.log(`\ndone in ${Math.round((Date.now() - started) / 1000)} s`);
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
