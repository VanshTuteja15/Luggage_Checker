/* ------------------------------------------------------------------ */
/*  LuggageTracker worker                                              */
/*                                                                     */
/*  The engine runs here; Vercel only orchestrates. Configuration is    */
/*  environment-only (see worker/README.md). Without DATABASE_URL the   */
/*  worker runs on an in-memory store and queue: fine for trying it,    */
/*  nothing persists.                                                   */
/* ------------------------------------------------------------------ */

import { engineConfig } from "@/lib/engine/config";
import { createRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { PgEngineStore } from "@/lib/engine/store/pg";
import type { EngineStore } from "@/lib/engine/store/port";
import { createWorkerServer } from "./http";
import { registerJobs } from "./jobs";
import { log } from "./log";
import { MemoryQueue, PgBossQueue, type JobQueue } from "./queue";

const VERSION = "1.0.0";

async function main(): Promise<void> {
  const cfg = engineConfig();
  const secret = process.env.WORKER_SHARED_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    log("error", "WORKER_SHARED_SECRET must be set (at least 32 characters) — refusing to start");
    process.exit(1);
  }

  let store: EngineStore;
  let queue: JobQueue;
  if (cfg.databaseUrl) {
    store = new PgEngineStore(cfg.databaseUrl, 6);
    queue = new PgBossQueue(cfg.databaseUrl);
  } else {
    log("warn", "DATABASE_URL not set: in-memory store and queue (nothing persists)");
    store = new MemoryEngineStore(SOURCE_SEED);
    queue = new MemoryQueue();
  }

  const rt = createRuntime(store, {}, (err) => log("error", "could not record fetch attempts", { err }));
  rt.recorder.start();
  await queue.start();
  await registerJobs(queue, rt);

  const server = createWorkerServer({ secret, queue, version: VERSION, storeKind: store.kind });
  const port = Number(process.env.PORT ?? 8787);
  server.listen(port, () => log("info", "worker listening", { port, store: store.kind, queue: queue.kind, version: VERSION }));

  // Warm the robots cache and record a heartbeat per source at start-up.
  void queue.send("sources.health", {}, { singletonKey: "sources.health:startup" });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { signal });
    server.close();
    await queue.stop().catch((err: unknown) => log("error", "queue stop failed", { err }));
    await rt.recorder.stop();
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log("error", "worker failed to start", { err });
  process.exit(1);
});
