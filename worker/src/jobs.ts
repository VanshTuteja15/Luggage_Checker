/* ------------------------------------------------------------------ */
/*  Job handlers. Each one is a thin shell around shared engine code,  */
/*  so the same logic can also run inline (dev) or from the cron route. */
/* ------------------------------------------------------------------ */

import { checkSourceHealth } from "@/lib/engine/jobs/health";
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
}
