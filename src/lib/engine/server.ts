/* ------------------------------------------------------------------ */
/*  The engine inside the Next.js server (API routes only)            */
/*                                                                     */
/*  One store + runtime + manager per server process (kept on          */
/*  globalThis so dev hot-reloads don't open new pools). With          */
/*  DATABASE_URL the engine talks to Supabase Postgres directly        */
/*  (service-role equivalent: server-side only); without it, an        */
/*  in-memory store for local development.                             */
/*                                                                     */
/*  Vercel only orchestrates: research is dispatched to the worker      */
/*  with a signed request. With no worker configured (or if it doesn't */
/*  answer), the session runs inline in this process instead.          */
/* ------------------------------------------------------------------ */

import { engineConfig } from "./config";
import { luggagePack } from "./packs/luggage";
import { createRuntime, type EngineRuntime } from "./recorder";
import { SOURCE_SEED } from "./registry";
import { ResearchManager } from "./research/manager";
import { SIGNATURE_HEADER, signRequest } from "./signing";
import { MemoryEngineStore } from "./store/memory";
import { PgEngineStore } from "./store/pg";

type Engine = { rt: EngineRuntime; manager: ResearchManager };

const g = globalThis as unknown as { __luggageEngine?: Engine };

export function getEngine(): Engine {
  if (g.__luggageEngine) return g.__luggageEngine;
  const cfg = engineConfig();
  const store = cfg.databaseUrl
    ? new PgEngineStore(cfg.databaseUrl, 3)
    : new MemoryEngineStore(SOURCE_SEED);
  if (store instanceof PgEngineStore)
    void store.warm(3).catch((err: unknown) => console.error("engine: pool warm-up failed", err));
  const rt = createRuntime(store, {}, (err) =>
    console.error("engine: could not record fetch attempts", err),
  );
  rt.recorder.start();
  const manager = new ResearchManager(rt, luggagePack, {
    maxConcurrent: 4,
    onError: (id, err) => console.error(`engine: session ${id} crashed`, err),
  });
  g.__luggageEngine = { rt, manager };
  return g.__luggageEngine;
}

/** True when session events land in Supabase, so the browser can use Realtime. */
export function realtimeAvailable(): boolean {
  const url = engineConfig().databaseUrl;
  if (!url) return false;
  try {
    return (
      /\.supabase\.(co|com)$/.test(new URL(url).hostname) && !!process.env.NEXT_PUBLIC_SUPABASE_URL
    );
  } catch {
    return false;
  }
}

/** POST a signed request to the worker. Returns the HTTP status, or null if unreachable. */
export async function callWorker(
  path: "/v1/research" | "/v1/jobs",
  body: Record<string, unknown>,
  timeoutMs = 3_000,
): Promise<number | null> {
  const worker = engineConfig().worker;
  if (!worker) return null;
  const text = JSON.stringify(body);
  try {
    const res = await fetch(`${worker.url}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signRequest(worker.secret, "POST", path, text),
      },
      body: text,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Hand a session to the worker; fall back to running it here. Returns where
 * it runs. In inline mode the caller keeps the request alive with after().
 */
export async function dispatchSession(
  sessionId: string,
): Promise<{ mode: "worker" | "inline"; run: Promise<unknown> | null }> {
  const status = await callWorker("/v1/research", { sessionId });
  if (status === 202) return { mode: "worker", run: null };
  if (status !== null)
    console.warn(`engine: worker answered ${status}; running session ${sessionId} inline`);
  return { mode: "inline", run: getEngine().manager.start(sessionId) };
}
