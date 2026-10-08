/* ------------------------------------------------------------------ */
/*  npm run engine:reresolve                                           */
/*                                                                     */
/*  Local dev database only. After a change to the identity rules       */
/*  (luggage pack line words, resolver), rebuild the catalog: unlink     */
/*  every listing, clear catalog products and the review queue, then     */
/*  resolve the listings that were linked before, oldest first. Never   */
/*  run against Supabase: admins' review decisions live there.          */
/* ------------------------------------------------------------------ */

import { resolveListing } from "../../src/lib/engine/identity/resolve";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { PgEngineStore } from "../../src/lib/engine/store/pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !/@(localhost|127\.0\.0\.1)[:/]/.test(url))
    throw new Error("set DATABASE_URL to the local dev database (npm run db:dev -- up)");
  const store = new PgEngineStore(url, 2);
  const { rows } = await store.pool.query<{ id: string }>(
    "SELECT id FROM listings WHERE product_id IS NOT NULL AND active ORDER BY first_seen_at, id",
  );
  const client = await store.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE listings SET product_id = NULL, variant_id = NULL");
    await client.query("DELETE FROM identity_review");
    await client.query("DELETE FROM catalog_products");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  const methods: Record<string, number> = {};
  for (const { id } of rows) {
    const listing = await store.getListing(id);
    if (!listing) continue;
    const r = await resolveListing(store, luggagePack, listing);
    methods[r.method] = (methods[r.method] ?? 0) + 1;
  }
  const { rows: summary } = await store.pool.query<{ products: number; reviews: number }>(
    `SELECT (SELECT count(*)::int FROM catalog_products WHERE merged_into IS NULL) AS products,
            (SELECT count(*)::int FROM identity_review WHERE status = 'pending') AS reviews`,
  );
  console.log(`re-resolved ${rows.length} listings: ${JSON.stringify(methods)}`);
  console.log(`catalog products: ${summary[0].products}; pending reviews: ${summary[0].reviews}`);
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
