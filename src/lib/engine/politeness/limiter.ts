/* ------------------------------------------------------------------ */
/*  Per-host limiter                                                  */
/*                                                                     */
/*  One request in flight per host, and starts spaced by the store's    */
/*  crawl delay. A caller with a deadline is told up front when its     */
/*  turn would come too late, instead of queueing past the deadline.    */
/* ------------------------------------------------------------------ */

export class LimiterTimeout extends Error {
  constructor(readonly host: string) {
    super(`turn at ${host} would come after the deadline`);
    this.name = "LimiterTimeout";
  }
}

export class LimiterAborted extends Error {
  constructor() {
    super("aborted while waiting for a host slot");
    this.name = "LimiterAborted";
  }
}

type Clock = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> };

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new LimiterAborted());
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new LimiterAborted());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

export class HostLimiter {
  private tail = new Map<string, Promise<void>>();
  private lastStart = new Map<string, number>();
  private pending = new Map<string, number>();

  constructor(private readonly clock: Clock = realClock) {}

  /** Rough wait before a new request to `host` could start. */
  estimateWaitMs(host: string, spacingMs: number): number {
    const last = this.lastStart.get(host);
    const queued = this.pending.get(host) ?? 0;
    const sinceLast = last === undefined ? Infinity : this.clock.now() - last;
    const own = Math.max(0, spacingMs - sinceLast);
    return own + queued * spacingMs;
  }

  /**
   * Wait for our turn at `host`. Resolves with a release function that MUST
   * be called when the request finishes. Throws LimiterTimeout when the turn
   * would start after `deadlineAt`, LimiterAborted when `signal` fires.
   */
  async acquire(host: string, spacingMs: number, opts: { deadlineAt?: number; signal?: AbortSignal } = {}): Promise<() => void> {
    const prev = this.tail.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.tail.set(host, prev.then(() => mine));
    this.pending.set(host, (this.pending.get(host) ?? 0) + 1);

    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      release();
    };
    try {
      if (opts.deadlineAt !== undefined && this.clock.now() + this.estimateWaitMs(host, spacingMs) - spacingMs > opts.deadlineAt) {
        throw new LimiterTimeout(host);
      }
      await this.waitFor(prev, opts);
      const last = this.lastStart.get(host);
      const wait = last === undefined ? 0 : Math.max(0, last + spacingMs - this.clock.now());
      if (opts.deadlineAt !== undefined && this.clock.now() + wait > opts.deadlineAt) throw new LimiterTimeout(host);
      if (wait > 0) await this.clock.sleep(wait, opts.signal);
      this.lastStart.set(host, this.clock.now());
      return done;
    } catch (err) {
      // Never leave the chain blocked: later callers wait on `mine`.
      done();
      throw err;
    } finally {
      this.pending.set(host, Math.max(0, (this.pending.get(host) ?? 1) - 1));
    }
  }

  private async waitFor(prev: Promise<void>, opts: { deadlineAt?: number; signal?: AbortSignal }): Promise<void> {
    if (opts.deadlineAt === undefined && !opts.signal) return prev;
    const guards: Promise<never>[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    if (opts.deadlineAt !== undefined) {
      const ms = Math.max(0, opts.deadlineAt - this.clock.now());
      guards.push(new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new LimiterTimeout("queue")), ms))));
    }
    if (opts.signal) {
      const signal = opts.signal;
      guards.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) return reject(new LimiterAborted());
          onAbort = () => reject(new LimiterAborted());
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }
    try {
      await Promise.race([prev, ...guards]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}
