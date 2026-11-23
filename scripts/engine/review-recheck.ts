/* ------------------------------------------------------------------ */
/*  npm run engine:review-recheck [-- --apply]                         */
/*                                                                     */
/*  v4 A5.3: re-checks the pending identity review queue against the    */
/*  current rules (owner 2026-10-30: only real near matches). Without   */
/*  --apply it only counts. With --apply, items the rules no longer     */
/*  send to a person become "superseded" (the reason is appended to the */
/*  item); nothing is merged or deleted, and an admin's decisions are   */
/*  untouched. Undo on the database:                                    */
/*    UPDATE identity_review SET status = 'pending', decided_at = NULL  */
/*    WHERE status = 'superseded';                                      */
/* ------------------------------------------------------------------ */

import { recheckReviews } from "../../src/lib/engine/identity/review";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { PgEngineStore } from "../../src/lib/engine/store/pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("set DATABASE_URL (the local dev database: npm run db:dev -- up)");
  const apply = process.argv.includes("--apply");
  const store = new PgEngineStore(url, 2);
  try {
    const r = await recheckReviews(store, luggagePack, { apply });
    console.log(
      `${apply ? "applied" : "dry run"}: ${r.checked} pending checked; ${r.kept} stay; ` +
        `${r.superseded} ${apply ? "marked superseded" : "would be marked superseded"}`,
    );
    for (const [why, n] of Object.entries(r.why).sort((a, b) => b[1] - a[1]))
      console.log(`  ${String(n).padStart(4)}  ${why}`);
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
