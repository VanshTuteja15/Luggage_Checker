/* ------------------------------------------------------------------ */
/*  v4 review: does the bulk /products.json price agree with the price  */
/*  the engine read from the same variant's /products/<handle>.json     */
/*  (which states price_currency)? Read-only against the dev DB.        */
/*                                                                     */
/*  DATABASE_URL=postgres://postgres:dev@127.0.0.1:54331/postgres \     */
/*  node scripts/run-ts.mjs scripts/bench/bulk-vs-observed.ts <rawDir>  */
/* ------------------------------------------------------------------ */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";

type Variant = { id: number; price: string; compare_at_price: string | null; available: boolean };
type Product = { handle: string; variants: Variant[] };

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: bulk-vs-observed.ts <rawDir>");
  const db = new Client({
    connectionString:
      process.env.DATABASE_URL ?? "postgres://postgres:dev@127.0.0.1:54331/postgres",
  });
  await db.connect();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const sourceId = file.split("__")[0];
    const source = SOURCE_SEED.find((s) => s.id === sourceId);
    if (!source?.marketHost) continue;
    const products = (JSON.parse(readFileSync(join(dir, file), "utf8")) as { products: Product[] })
      .products;
    let compared = 0;
    let samePrice = 0;
    let sameList = 0;
    let sameStock = 0;
    const diffs: string[] = [];
    for (const p of products) {
      const base = `https://${source.marketHost}/products/${p.handle}`;
      for (const v of p.variants) {
        const url = p.variants.length > 1 ? `${base}?variant=${v.id}` : base;
        const r = await db.query<{
          price: string;
          list_price: string | null;
          availability: string;
          fetched_at: Date;
        }>(
          `select o.price, o.list_price, o.availability, o.fetched_at from observations o
             join listings l on l.id = o.listing_id
            where l.source_id = $1 and l.url = $2 and o.outcome <> 'rejected' and o.adapter = 'shopify_product_json'
            order by o.fetched_at desc limit 1`,
          [sourceId, url],
        );
        const o = r.rows[0];
        if (!o) continue;
        compared++;
        const bulk = Number(v.price);
        const bulkList =
          v.compare_at_price !== null && Number(v.compare_at_price) > bulk
            ? Number(v.compare_at_price)
            : null;
        if (Math.abs(bulk - Number(o.price)) < 0.005) samePrice++;
        else if (diffs.length < 8)
          diffs.push(
            `${p.handle} v${v.id}: bulk ${bulk} vs observed ${o.price} (${o.fetched_at.toISOString().slice(0, 10)})`,
          );
        if (
          (bulkList === null && o.list_price === null) ||
          (bulkList !== null &&
            o.list_price !== null &&
            Math.abs(bulkList - Number(o.list_price)) < 0.005)
        )
          sameList++;
        if ((v.available ? "in_stock" : "out_of_stock") === o.availability) sameStock++;
      }
    }
    console.log(
      `${file}: variants with an earlier per-product reading: ${compared}; same price ${samePrice}; same list price ${sameList}; same stock ${sameStock}`,
    );
    for (const d of diffs) console.log(`  differs: ${d}`);
  }
  await db.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
