/* ------------------------------------------------------------------ */
/*  npm run engine:resize [-- --apply]                                 */
/*                                                                     */
/*  v5 F2.1: the inches table changed (30" is now Large, was Extra     */
/*  Large). Listings store the size class they were read with, so a    */
/*  listing whose title now reads as another class is updated, and if  */
/*  its product has the old class it is unlinked and resolved again    */
/*  (sizes never mix inside a product). Dry run by default: prints     */
/*  what would change. Deletes nothing; review decisions are kept.     */
/* ------------------------------------------------------------------ */

import { resolveListing } from "../../src/lib/engine/identity/resolve";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { PgEngineStore } from "../../src/lib/engine/store/pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const apply = process.argv.includes("--apply");
  const store = new PgEngineStore(url, 2);
  const { rows } = await store.pool.query<{
    id: string;
    title: string;
    size_class: string | null;
    product_id: string | null;
    product_size: string | null;
  }>(
    `SELECT l.id, l.title, l.size_class, l.product_id, p.size_class AS product_size
       FROM listings l LEFT JOIN catalog_products p ON p.id = l.product_id
      WHERE l.active`,
  );
  const changes = rows
    .map((r) => ({ ...r, now: luggagePack.sizeClassOf(r.title) }))
    .filter((r) => r.now !== r.size_class);
  const relink = new Set(
    changes.filter((r) => r.product_id && r.product_size !== r.now).map((r) => r.id),
  );
  console.log(
    `${changes.length} active listings read as another size now; ${relink.size} of them sit on a product of the old size`,
  );
  for (const r of changes.slice(0, 15)) console.log(`  ${r.size_class} → ${r.now}  ${r.title}`);
  if (!apply) {
    console.log("dry run: nothing changed (add -- --apply)");
    await store.close();
    return;
  }
  const methods: Record<string, number> = {};
  for (const r of changes) {
    await store.pool.query("UPDATE listings SET size_class = $2 WHERE id = $1", [r.id, r.now]);
    if (!relink.has(r.id)) continue;
    await store.linkListing(r.id, null, null);
    const listing = await store.getListing(r.id);
    if (!listing) continue;
    const res = await resolveListing(store, luggagePack, listing);
    methods[res.method] = (methods[res.method] ?? 0) + 1;
  }
  const { rows: mixed } = await store.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM listings l JOIN catalog_products p ON p.id = l.product_id
      WHERE l.active AND l.size_class IS NOT NULL AND p.size_class IS NOT NULL AND l.size_class <> p.size_class`,
  );
  console.log(
    `updated ${changes.length}; re-resolved ${relink.size}: ${JSON.stringify(methods)}; listings whose size differs from their product: ${mixed[0].n}`,
  );
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
