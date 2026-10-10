/* ------------------------------------------------------------------ */
/*  Research manager: runs sessions in this process                   */
/*                                                                     */
/*  Used by the worker (the normal path) and by the Next.js server in   */
/*  inline mode (no worker configured). Caps concurrent sessions,       */
/*  shares one single-flight cache across them (90 s window), lets       */
/*  in-process subscribers follow a session's events, and cancels       */
/*  either through the controller or when the session row says so.     */
/* ------------------------------------------------------------------ */

import { EventEmitter } from "node:events";
import type { AdapterResult } from "../adapters";
import { SingleFlight } from "../politeness/singleflight";
import type { EngineRuntime } from "../recorder";
import type { CategoryPack, ResearchAnswer, SessionEvent } from "../types";
import { runResearchSession, type SessionRunDeps } from "./session";

export class ResearchManager {
  private readonly bus = new EventEmitter();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Map<string, Promise<ResearchAnswer | null>>();
  private readonly waiting: (() => void)[] = [];
  private activeCount = 0;
  readonly shared: SingleFlight<AdapterResult>;

  constructor(
    private readonly rt: EngineRuntime,
    private readonly pack: CategoryPack,
    private readonly opts: {
      maxConcurrent: number;
      onError?: (sessionId: string, err: unknown) => void;
      /** Web estimates for stores we can't read live (R3); absent = none. */
      estimates?: SessionRunDeps["estimates"];
    } = { maxConcurrent: 4 },
  ) {
    this.bus.setMaxListeners(200);
    this.shared = new SingleFlight<AdapterResult>(rt.config.singleFlightMs);
  }

  active(): number {
    return this.activeCount;
  }

  /** Start (or join) a session. Resolves with its answer (null if cancelled/failed). */
  start(sessionId: string): Promise<ResearchAnswer | null> {
    const existing = this.running.get(sessionId);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(sessionId, controller);
    const p = this.slot()
      .then(() =>
        runResearchSession(sessionId, {
          rt: this.rt,
          pack: this.pack,
          shared: this.shared,
          signal: controller.signal,
          onEvent: (e) => this.bus.emit(sessionId, e),
          isCancelled: async () =>
            (await this.rt.store.getSession(sessionId))?.status === "cancelled",
          estimates: this.opts.estimates,
        }),
      )
      .catch((err: unknown) => {
        this.opts.onError?.(sessionId, err);
        return null;
      })
      .finally(() => {
        this.activeCount--;
        this.controllers.delete(sessionId);
        this.running.delete(sessionId);
        this.waiting.shift()?.();
      });
    this.running.set(sessionId, p);
    return p;
  }

  /** Abort a session running here. Returns false if it isn't running in this process. */
  cancel(sessionId: string): boolean {
    const c = this.controllers.get(sessionId);
    if (!c) return false;
    c.abort();
    return true;
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  subscribe(sessionId: string, cb: (e: SessionEvent) => void): () => void {
    this.bus.on(sessionId, cb);
    return () => this.bus.off(sessionId, cb);
  }

  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.running.values()]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  private slot(): Promise<void> {
    if (this.activeCount < this.opts.maxConcurrent) {
      this.activeCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) =>
      this.waiting.push(() => {
        this.activeCount++;
        resolve();
      }),
    );
  }
}
