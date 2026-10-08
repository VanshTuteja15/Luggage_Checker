/* ------------------------------------------------------------------ */
/*  Job handlers. Each one is a thin shell around shared engine code,  */
/*  so the same logic can also run inline (dev) or from the cron route. */
/* ------------------------------------------------------------------ */

import { discoverAll, discoverSource } from "@/lib/engine/discovery";
import { checkSourceHealth } from "@/lib/engine/jobs/health";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { PgTrackedBridge } from "@/lib/engine/bridge/tracked";
import { verifyTracked } from "@/lib/engine/jobs/verify-tracked";
import { PgEngineStore } from "@/lib/engine/store/pg";
import { sendPriceAlert } from "@/lib/email";
import type { EngineRuntime } from "@/lib/engine/recorder";
import { log } from "./log";
import type { JobQueue } from "./queue";

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

export async function registerJobs(queue: JobQueue, rt: EngineRuntime): Promise<void> {
  await queue.work(
    "sources.health",
    async (data, job) => {
      const started = Date.now();
      const rows = await checkSourceHealth(rt, { sourceIds: stringArray(data.sourceIds), signal: job.signal });
      log("info", "sources.health done", { jobId: job.id, ms: Date.now() - started, checked: rows.length, rows });
      return { checked: rows.length, rows };
    },
    { concurrency: 1 },
  );

  const maxFetches = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 10_000 ? Math.floor(v) : undefined);

  await queue.work(
    "discover.source",
    async (data, job) => {
      if (typeof data.sourceId !== "string") throw new Error("discover.source needs a sourceId");
      const r = await discoverSource(rt, luggagePack, data.sourceId, { maxFetches: maxFetches(data.maxFetches), signal: job.signal });
      log("info", "discover.source done", { jobId: job.id, ...r });
      return r;
    },
    { concurrency: 2 },
  );

  await queue.work(
    "verify.tracked",
    async (data, job) => {
      if (!(rt.store instanceof PgEngineStore)) {
        log("warn", "verify.tracked skipped: needs DATABASE_URL (tracked products live in Postgres)", { jobId: job.id });
        return { skipped: true };
      }
      const { stats } = await verifyTracked(rt, luggagePack, new PgTrackedBridge(rt.store.pool), {
        maxProducts: maxFetches(data.maxProducts),
        maxFetches: maxFetches(data.maxFetches),
        sendAlert: sendPriceAlert,
        signal: job.signal,
        trigger: "worker",
      });
      log("info", "verify.tracked done", { jobId: job.id, ...stats });
      return stats;
    },
    { concurrency: 1 },
  );

  await queue.work(
    "discover.refresh",
    async (data, job) => {
      const results = await discoverAll(rt, luggagePack, { maxFetches: maxFetches(data.maxFetches), signal: job.signal });
      log("info", "discover.refresh done", { jobId: job.id, results: results.map((r) => ({ sourceId: r.sourceId, method: r.method, newListings: r.newListings, enriched: r.enriched, skipped: r.skippedReason })) });
      return { results };
    },
    { concurrency: 1 },
  );
}
