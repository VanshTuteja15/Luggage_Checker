/* ------------------------------------------------------------------ */
/*  npm run engine:research -- "Samsonite Omni 3.0 Large"              */
/*                                                                     */
/*  One real research session (real stores, PoliteFetcher) against      */
/*  DATABASE_URL, printing the event timeline as it streams and the     */
/*  final answer. For local verification against the dev database:      */
/*  creates a local CLI user row there (never use it on Supabase).     */
/* ------------------------------------------------------------------ */

import { engineConfig } from "../../src/lib/engine/config";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { createRuntime } from "../../src/lib/engine/recorder";
import { freshnessLabel } from "../../src/lib/engine/research/answer";
import { createSession } from "../../src/lib/engine/research/api";
import { ResearchManager } from "../../src/lib/engine/research/manager";
import { PgEngineStore } from "../../src/lib/engine/store/pg";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || !/localhost|127\.0\.0\.1/.test(url))
    throw new Error("set DATABASE_URL to the local dev database (npm run db:dev -- up)");
  const query =
    process.argv
      .slice(2)
      .filter((a) => !a.startsWith("--"))
      .join(" ") || "Samsonite Omni 3.0 Large";
  const store = new PgEngineStore(url, 4);
  await store.warm(4);
  const { rows } = await store.pool.query(
    `INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-00000000c11c', 'research-cli@localhost.test')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
  );
  const rt = createRuntime(store);
  const manager = new ResearchManager(rt, luggagePack, { maxConcurrent: 2 });
  const created = await createSession(store, rows[0].id, { query }, engineConfig(), "inline");
  if (!created.ok) throw new Error(created.error);
  const t0 = Date.now();
  console.log(`session ${created.session.id} · "${query}" · UA ${rt.fetcher.userAgent}\n`);
  manager.subscribe(created.session.id, (e) => {
    const at = `${String(Date.now() - t0).padStart(6)} ms`;
    const p = e.payload as Record<string, unknown>;
    if (e.type === "store_offers") {
      const offers = p.offers as {
        price: number;
        retailer: string;
        colour: string | null;
        freshness: { kind: string };
      }[];
      console.log(
        `${at}  ${e.type.padEnd(14)} ${e.sourceId}: ${offers.map((o) => `$${o.price}${o.colour ? ` ${o.colour}` : ""} (${o.freshness.kind})`).join(", ")}`,
      );
    } else if (e.type === "store_done") {
      const r = p.row as { state: string; message: string; durationMs: number | null };
      console.log(
        `${at}  ${e.type.padEnd(14)} ${e.sourceId}: ${r.state} — ${r.message}${r.durationMs !== null ? ` (${r.durationMs} ms)` : ""}`,
      );
    } else if (e.type === "plan") {
      const stores = p.stores as { sourceId: string; state: string }[];
      const by = (s: string) => stores.filter((x) => x.state === s).map((x) => x.sourceId);
      console.log(
        `${at}  plan           checking: ${by("pending").join(", ") || "—"}\n${" ".repeat(25)}blocked: ${by("blocked").join(", ")}\n${" ".repeat(25)}link only: ${by("link_only").join(", ")}\n${" ".repeat(25)}not set up: ${by("not_configured").join(", ")}`,
      );
    } else if (e.type !== "session_done")
      console.log(`${at}  ${e.type}${e.sourceId ? ` ${e.sourceId}` : ""}`);
  });
  const answer = await manager.start(created.session.id);
  if (!answer) throw new Error("session ended without an answer");
  console.log(
    `\nfirst verified price ${answer.firstPriceMs} ms · complete ${answer.totalMs} ms · deadline hit ${answer.deadlineHit}`,
  );
  for (const p of answer.products.slice(0, 5)) {
    console.log(`\n• ${p.name} (${p.sizeClass ?? "size ?"})`);
    for (const o of p.offers.slice(0, 6))
      console.log(
        `    $${o.price.toFixed(2)}  ${o.retailer}${o.colour ? ` · ${o.colour}` : ""}  [${freshnessLabel(o.freshness)}]  ${o.url}`,
      );
  }
  await rt.recorder.stop();
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
