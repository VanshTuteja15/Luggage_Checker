/* ------------------------------------------------------------------ */
/*  The daily engine run, triggered by Vercel Cron                     */
/*                                                                     */
/*  With a worker: hand it signed jobs (verify tracked products,       */
/*  refresh discovery, check source health) and return at once.        */
/*  Without one: verify tracked products here, inside a time limit and */
/*  the fetch budget, so the cron never outlives its function.          */
/* ------------------------------------------------------------------ */

import { sendPriceAlert } from "@/lib/email";
import { PgTrackedBridge } from "./bridge/tracked";
import { engineConfig } from "./config";
import { verifyTracked, type VerifyTrackedStats } from "./jobs/verify-tracked";
import { luggagePack } from "./packs/luggage";
import { callWorker, getEngine } from "./server";
import { PgEngineStore } from "./store/pg";

export type EngineCronResult =
  | { mode: "worker"; jobs: Record<string, number | null>; verifiedProductIds: string[] }
  | { mode: "inline"; stats: VerifyTrackedStats; verifiedProductIds: string[] }
  | { mode: "unavailable"; reason: string; verifiedProductIds: string[] };

export async function runScheduledEngine(opts: { timeLimitMs?: number } = {}): Promise<EngineCronResult> {
  const cfg = engineConfig();
  if (cfg.worker) {
    const jobs: Record<string, number | null> = {};
    for (const name of ["verify.tracked", "discover.refresh", "sources.health"]) {
      jobs[name] = await callWorker("/v1/jobs", { name, data: {} });
    }
    if (Object.values(jobs).every((s) => s === 202)) return { mode: "worker", jobs, verifiedProductIds: [] };
    // Worker unreachable: fall through and do the essential part here.
  }

  const { rt } = getEngine();
  if (!(rt.store instanceof PgEngineStore)) {
    return { mode: "unavailable", reason: "DATABASE_URL not set: the engine can't reach the tracked products", verifiedProductIds: [] };
  }
  const { stats, verifiedProductIds } = await verifyTracked(rt, luggagePack, new PgTrackedBridge(rt.store.pool), {
    sendAlert: sendPriceAlert,
    signal: AbortSignal.timeout(opts.timeLimitMs ?? 120_000),
    trigger: "cron",
  });
  return { mode: "inline", stats, verifiedProductIds };
}
