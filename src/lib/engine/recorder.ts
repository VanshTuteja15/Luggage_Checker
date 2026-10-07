/* ------------------------------------------------------------------ */
/*  Engine runtime wiring                                             */
/*                                                                     */
/*  One PoliteFetcher per process (so the host limiter and robots cache */
/*  are shared by every session and job), its attempts buffered into    */
/*  fetch_attempts, its circuit state persisted on the source row, and  */
/*  the registry + flags cached briefly so a session doesn't hit the    */
/*  database for them on every request.                                 */
/* ------------------------------------------------------------------ */

import { engineConfig, type EngineConfig } from "./config";
import { resolveFlags, type FlagSet } from "./flags";
import { PoliteFetcher, type FetcherDeps } from "./politeness/fetcher";
import type { EngineStore } from "./store/port";
import type { FetchAttempt, SourceRecord } from "./types";

export class AttemptRecorder {
  private buffer: FetchAttempt[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: EngineStore,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  push(a: FetchAttempt): void {
    this.buffer.push(a);
    if (this.buffer.length >= 50) void this.flush();
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  flush(): Promise<void> {
    const batch = this.buffer.splice(0);
    if (batch.length === 0) return this.flushing;
    this.flushing = this.flushing
      .then(() => this.store.insertFetchAttempts(batch))
      .catch((err: unknown) => this.onError(err));
    return this.flushing;
  }
}

export type EngineRuntime = {
  store: EngineStore;
  fetcher: PoliteFetcher;
  recorder: AttemptRecorder;
  config: EngineConfig;
  sources(): Promise<SourceRecord[]>;
  flags(): Promise<FlagSet>;
  /** Forget cached registry/flags (after an admin change). */
  invalidate(): void;
};

export function createRuntime(store: EngineStore, deps: Omit<FetcherDeps, "health" | "onAttempt"> = {}, onError?: (err: unknown) => void): EngineRuntime {
  const recorder = new AttemptRecorder(store, onError);
  const fetcher = new PoliteFetcher({
    ...deps,
    health: { get: (id) => store.getHealth(id), save: (h) => store.saveHealth(h) },
    onAttempt: (a) => recorder.push(a),
  });

  let sourcesCache: { at: number; value: SourceRecord[] } | null = null;
  let flagsCache: { at: number; value: FlagSet } | null = null;
  const now = deps.now ?? Date.now;

  return {
    store,
    fetcher,
    recorder,
    config: engineConfig(),
    async sources() {
      if (sourcesCache && now() - sourcesCache.at < 60_000) return sourcesCache.value;
      const value = await store.listSources();
      sourcesCache = { at: now(), value };
      return value;
    },
    async flags() {
      if (flagsCache && now() - flagsCache.at < 30_000) return flagsCache.value;
      const value = resolveFlags(await store.listFlagRows());
      flagsCache = { at: now(), value };
      return value;
    },
    invalidate() {
      sourcesCache = null;
      flagsCache = null;
    },
  };
}
