/* ------------------------------------------------------------------ */
/*  v4 review: one product, three channels. Compares the bulk           */
/*  /products.json price (no currency field) with the same product's     */
/*  /products/<handle>.json (states price_currency) and .js (storefront  */
/*  cents), read now through the PoliteFetcher.                          */
/*                                                                     */
/*  node scripts/run-ts.mjs scripts/bench/currency-check.ts <sourceId>   */
/*       <handle> <bulkFile>                                             */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { PoliteFetcher } from "../../src/lib/engine/politeness/fetcher";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";
import type { FetchAttempt } from "../../src/lib/engine/types";

type Json = Record<string, unknown>;

async function main(): Promise<void> {
  const [sourceId, handle, bulkFile] = process.argv.slice(2);
  const source = SOURCE_SEED.find((s) => s.id === sourceId);
  if (!source?.marketHost || !handle || !bulkFile)
    throw new Error("usage: currency-check.ts <sourceId> <handle> <bulkFile>");
  const attempts: FetchAttempt[] = [];
  const fetcher = new PoliteFetcher({ onAttempt: (a) => attempts.push(a) });

  const bulk = (JSON.parse(readFileSync(bulkFile, "utf8")) as { products: Json[] }).products.find(
    (p) => p.handle === handle,
  );
  const bulkVariants = ((bulk?.variants as Json[]) ?? []).map((v) => ({
    id: String(v.id),
    price: v.price,
    compareAt: v.compare_at_price,
  }));
  console.log(`bulk:  ${JSON.stringify(bulkVariants)}`);

  const base = `https://${source.marketHost}/products/${handle}`;
  for (const ext of [".json", ".js"]) {
    const res = await fetcher.fetch({
      source,
      url: `${base}${ext}`,
      adapter: "shopify_product_json",
      headers: { Accept: "application/json" },
    });
    if (res.outcome !== "ok") {
      console.log(`${ext}: ${res.outcome} ${res.status}`);
      continue;
    }
    const body = JSON.parse(res.body) as Json;
    const p = (ext === ".json" ? body.product : body) as Json;
    const vs = ((p.variants as Json[]) ?? []).map((v) => ({
      id: String(v.id),
      price: v.price,
      compareAt: v.compare_at_price,
      currency: v.price_currency ?? null,
    }));
    console.log(`${ext.padEnd(5)}: ${JSON.stringify(vs)}`);
  }
  console.log(`network attempts: ${attempts.length}`);
  for (const a of attempts)
    console.log(`  ${a.startedAt} ${a.adapter} ${a.status} ${a.outcome} ${a.url}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
