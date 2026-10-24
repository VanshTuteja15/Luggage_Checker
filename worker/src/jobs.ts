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

/**
 * The morning email's fallback trigger (R1.17a): the worker calls the app's
 * /api/cron/tick on its own schedule. Needs APP_URL and CRON_SECRET; without
 * them it does nothing (Supabase pg_cron is the primary trigger).
 */
export async function callTick(
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<{ status: number | null; skipped?: string }> {
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");
  const secret = env.CRON_SECRET?.trim();
  if (!appUrl || !secret) return { status: null, skipped: "APP_URL or CRON_SECRET not set" };
  const res = await fetcher(`${appUrl}/api/cron/tick`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": secret },
    body: "{}",
    signal: AbortSignal.timeout(295_000),
  });
  return { status: res.status };
}

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
        // The morning email's prepare run sends the chosen products.
        productIds: stringArray(data.productIds),
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

  await queue.work(
    "digest.tick",
    async (_data, job) => {
      const r = await callTick();
      if (r.skipped) log("warn", "digest.tick skipped", { jobId: job.id, reason: r.skipped });
      else if (r.status !== 200) log("warn", "digest.tick: the app answered", { jobId: job.id, status: r.status });
      return r;
    },
    { concurrency: 1 },
  );
}
