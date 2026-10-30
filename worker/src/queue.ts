/* ------------------------------------------------------------------ */
/*  Job queue on Postgres (pg-boss), with an in-memory twin for tests  */
/*  and for running the worker without a database.                     */
/* ------------------------------------------------------------------ */

import { PgBoss } from "pg-boss";
import { poolConfig } from "@/lib/engine/store/pg";
import { log } from "./log";

export const JOB_NAMES = ["sources.health", "discover.source", "discover.refresh", "verify.tracked", "research.run", "digest.tick", "ai.small", "ai.large"] as const;
export type JobName = (typeof JOB_NAMES)[number];

export function isJobName(v: unknown): v is JobName {
  return typeof v === "string" && (JOB_NAMES as readonly string[]).includes(v);
}

export type SendOptions = {
  /** At most one queued/active job with this key. */
  singletonKey?: string;
  retryLimit?: number;
  expireInSeconds?: number;
  priority?: number;
};

export type JobHandler = (data: Record<string, unknown>, job: { id: string; name: JobName; signal: AbortSignal }) => Promise<unknown>;

export interface JobQueue {
  readonly kind: "pg-boss" | "memory";
  start(): Promise<void>;
  stop(): Promise<void>;
  send(name: JobName, data: Record<string, unknown>, opts?: SendOptions): Promise<string | null>;
  work(name: JobName, handler: JobHandler, opts?: { concurrency?: number }): Promise<void>;
  /** Run a job on a cron schedule, evaluated in a time zone (one schedule per name). */
  schedule(name: JobName, cron: string, opts: { tz: string }): Promise<void>;
  stats(): Promise<Record<string, { queued: number; active: number }>>;
}

/* ── pg-boss ───────────────────────────────────────────────────────── */

export class PgBossQueue implements JobQueue {
  readonly kind = "pg-boss" as const;
  private boss: PgBoss;
  private created = new Set<string>();

  constructor(connectionString: string) {
    const cfg = poolConfig(connectionString, 4);
    this.boss = new PgBoss({ connectionString: cfg.connectionString, ssl: cfg.ssl, max: 4, schema: "pgboss", application_name: "luggage-tracker-worker" });
    this.boss.on("error", (err: unknown) => log("error", "queue error", { err }));
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }

  private async ensure(name: JobName): Promise<void> {
    if (this.created.has(name)) return;
    await this.boss.createQueue(name);
    this.created.add(name);
  }

  async send(name: JobName, data: Record<string, unknown>, opts: SendOptions = {}): Promise<string | null> {
    await this.ensure(name);
    // pg-boss validates every key it's given, so only pass what's set.
    return this.boss.send(name, data, {
      retryLimit: opts.retryLimit ?? 2,
      expireInSeconds: opts.expireInSeconds ?? 900,
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts.priority !== undefined ? { priority: Math.round(opts.priority) } : {}),
    });
  }

  async work(name: JobName, handler: JobHandler, opts: { concurrency?: number } = {}): Promise<void> {
    await this.ensure(name);
    await this.boss.work<Record<string, unknown>>(
      name,
      { batchSize: 1, pollingIntervalSeconds: 2, localConcurrency: opts.concurrency ?? 1 },
      async (jobs) => {
        for (const job of jobs) {
          await handler(job.data ?? {}, { id: job.id, name, signal: job.signal });
        }
      },
    );
  }

  async schedule(name: JobName, cron: string, opts: { tz: string }): Promise<void> {
    await this.ensure(name);
    // A missed occurrence (worker down) is not replayed: the tick catches up by itself.
    await this.boss.schedule(name, cron, {}, { tz: opts.tz, singletonKey: `${name}:schedule`, retryLimit: 0, expireInSeconds: 600 });
  }

  async stats(): Promise<Record<string, { queued: number; active: number }>> {
    const out: Record<string, { queued: number; active: number }> = {};
    for (const name of this.created) {
      const q = await this.boss.getQueue(name);
      const r = (q ?? {}) as { queuedCount?: number; activeCount?: number };
      out[name] = { queued: r.queuedCount ?? 0, active: r.activeCount ?? 0 };
    }
    return out;
  }
}

/* ── in-memory ─────────────────────────────────────────────────────── */

type MemJob = { id: string; name: JobName; data: Record<string, unknown>; opts: SendOptions; attempts: number };

export class MemoryQueue implements JobQueue {
  readonly kind = "memory" as const;
  private queued: MemJob[] = [];
  private active = new Map<string, MemJob>();
  private handlers = new Map<JobName, { handler: JobHandler; concurrency: number; running: number }>();
  private seq = 0;
  private running = false;
  private idleWaiters: (() => void)[] = [];
  readonly completed: { id: string; name: JobName; result: unknown }[] = [];
  readonly failed: { id: string; name: JobName; error: string }[] = [];

  async start(): Promise<void> {
    this.running = true;
    this.pump();
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(name: JobName, data: Record<string, unknown>, opts: SendOptions = {}): Promise<string | null> {
    if (opts.singletonKey) {
      const dup = [...this.queued, ...this.active.values()].some((j) => j.name === name && j.opts.singletonKey === opts.singletonKey);
      if (dup) return null;
    }
    const job: MemJob = { id: `mem-${++this.seq}`, name, data, opts, attempts: 0 };
    this.queued.push(job);
    queueMicrotask(() => this.pump());
    return job.id;
  }

  async work(name: JobName, handler: JobHandler, opts: { concurrency?: number } = {}): Promise<void> {
    this.handlers.set(name, { handler, concurrency: opts.concurrency ?? 1, running: 0 });
    queueMicrotask(() => this.pump());
  }

  /** Schedules are recorded, not run: tests call the job directly. */
  readonly schedules: { name: JobName; cron: string; tz: string }[] = [];

  async schedule(name: JobName, cron: string, opts: { tz: string }): Promise<void> {
    this.schedules.push({ name, cron, tz: opts.tz });
  }

  async stats(): Promise<Record<string, { queued: number; active: number }>> {
    const out: Record<string, { queued: number; active: number }> = {};
    for (const name of JOB_NAMES) {
      out[name] = { queued: this.queued.filter((j) => j.name === name).length, active: [...this.active.values()].filter((j) => j.name === name).length };
    }
    return out;
  }

  /** Test helper: resolves when nothing is queued or running. */
  async idle(): Promise<void> {
    if (this.queued.length === 0 && this.active.size === 0) return;
    await new Promise<void>((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    if (!this.running) return;
    for (let i = 0; i < this.queued.length; i++) {
      const job = this.queued[i];
      const h = this.handlers.get(job.name);
      if (!h || h.running >= h.concurrency) continue;
      this.queued.splice(i--, 1);
      this.active.set(job.id, job);
      h.running++;
      job.attempts++;
      const controller = new AbortController();
      h.handler(job.data, { id: job.id, name: job.name, signal: controller.signal })
        .then((result) => this.completed.push({ id: job.id, name: job.name, result }))
        .catch((err: unknown) => {
          if (job.attempts <= (job.opts.retryLimit ?? 2)) this.queued.push(job);
          else this.failed.push({ id: job.id, name: job.name, error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => {
          h.running--;
          this.active.delete(job.id);
          this.pump();
          if (this.queued.length === 0 && this.active.size === 0) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }
}
