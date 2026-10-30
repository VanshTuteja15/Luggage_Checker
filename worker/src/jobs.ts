/* ------------------------------------------------------------------ */
/*  Job handlers. Each one is a thin shell around shared engine code,  */
/*  so the same logic can also run inline (dev) or from the cron route. */
/* ------------------------------------------------------------------ */

import {
  AI_TASKS,
  MemoryAiCache,
  PgAiCache,
  aiAllowed,
  aiJobOptions,
  createAiClient,
  matchJudgeTask,
  runAiTask,
  taskCacheKey,
  type AiCache,
  type AiTask,
  type AiTaskName,
} from "@/lib/engine/ai";
import { setReviewAdvisor } from "@/lib/engine/identity/match";
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

/**
 * Which AI lanes this worker serves (AI_LANES="ai.small" on the always-on
 * worker, "ai.large" on the laptop). Default none: a worker without it
 * behaves exactly as before.
 */
export function aiLanes(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ("ai.small" | "ai.large")[] {
  return (env.AI_LANES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is "ai.small" | "ai.large" => s === "ai.small" || s === "ai.large");
}

export async function registerJobs(queue: JobQueue, rt: EngineRuntime): Promise<void> {
  await queue.work(
    "sources.health",
    async (data, job) => {
      const started = Date.now();
      const rows = await checkSourceHealth(rt, {
        sourceIds: stringArray(data.sourceIds),
        signal: job.signal,
      });
      log("info", "sources.health done", {
        jobId: job.id,
        ms: Date.now() - started,
        checked: rows.length,
        rows,
      });
      return { checked: rows.length, rows };
    },
    { concurrency: 1 },
  );

  const maxFetches = (v: unknown) =>
    typeof v === "number" && v >= 0 && v <= 10_000 ? Math.floor(v) : undefined;

  await queue.work(
    "discover.source",
    async (data, job) => {
      if (typeof data.sourceId !== "string") throw new Error("discover.source needs a sourceId");
      const r = await discoverSource(rt, luggagePack, data.sourceId, {
        maxFetches: maxFetches(data.maxFetches),
        signal: job.signal,
      });
      log("info", "discover.source done", { jobId: job.id, ...r });
      return r;
    },
    { concurrency: 2 },
  );

  await queue.work(
    "verify.tracked",
    async (data, job) => {
      if (!(rt.store instanceof PgEngineStore)) {
        log(
          "warn",
          "verify.tracked skipped: needs DATABASE_URL (tracked products live in Postgres)",
          { jobId: job.id },
        );
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
      const results = await discoverAll(rt, luggagePack, {
        maxFetches: maxFetches(data.maxFetches),
        signal: job.signal,
      });
      log("info", "discover.refresh done", {
        jobId: job.id,
        results: results.map((r) => ({
          sourceId: r.sourceId,
          method: r.method,
          newListings: r.newListings,
          enriched: r.enriched,
          skipped: r.skippedReason,
        })),
      });
      return { results };
    },
    { concurrency: 1 },
  );

  // AI lanes: the same task runner as everywhere (flags off by default, rules on any
  // failure, evidence on every value); answers land in ai_cache for the next reader.
  const lanes = aiLanes();
  if (lanes.length) {
    const client = createAiClient(rt.config);
    const cache: AiCache =
      rt.store instanceof PgEngineStore ? new PgAiCache(rt.store.pool) : new MemoryAiCache();
    for (const lane of lanes) {
      await queue.work(
        lane,
        async (data, job) => {
          const name = typeof data.task === "string" ? data.task : "";
          if (!Object.prototype.hasOwnProperty.call(AI_TASKS, name))
            throw new Error(`${lane}: unknown task`);
          if (!data.input || typeof data.input !== "object")
            throw new Error(`${lane}: input must be an object`);
          const task = AI_TASKS[name as AiTaskName] as unknown as AiTask<unknown, unknown>;
          const out = await runAiTask(task, data.input, { flags: await rt.flags(), client, cache });
          log("info", `${lane} done`, {
            jobId: job.id,
            task: name,
            source: out.source,
            fallback: out.fallback,
            dropped: out.dropped.length,
            ms: out.ms,
          });
          return { source: out.source, fallback: out.fallback, dropped: out.dropped.length };
        },
        { concurrency: 1 },
      );
    }
    log("info", "AI lanes served", { lanes, model: client ? client.model : null });
  }

  // v4 A5.3: a near-match review asks the judge on the ai.small lane. Advice only
  // (it lands in ai_cache beside the review; nothing merges). Flags are read per
  // review, so this stays silent until both ai.enabled and ai.match_judge are on.
  setReviewAdvisor(async (input) => {
    if (!aiAllowed(await rt.flags(), matchJudgeTask)) return;
    const key = taskCacheKey(matchJudgeTask, rt.config.ai.model, input);
    await queue.send("ai.small", { task: "match_judge", input }, aiJobOptions("ai.small", key));
  });

  await queue.work(
    "digest.tick",
    async (_data, job) => {
      const r = await callTick();
      if (r.skipped) log("warn", "digest.tick skipped", { jobId: job.id, reason: r.skipped });
      else if (r.status !== 200)
        log("warn", "digest.tick: the app answered", { jobId: job.id, status: r.status });
      return r;
    },
    { concurrency: 1 },
  );
}
