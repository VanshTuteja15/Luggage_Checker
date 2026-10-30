/* ------------------------------------------------------------------ */
/*  AI result cache                                                    */
/*                                                                     */
/*  Keyed by everything that decides an answer: task, model, prompt    */
/*  version, schema version and the exact input. A store that edits its */
/*  text gets a new key, so an old extraction can't be served for new   */
/*  text. Only evidence-checked values are stored, and never prices.    */
/*  Memory twin for tests and dev; Postgres table ai_cache (007).       */
/* ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type AiCacheEntry = { task: string; model: string; value: unknown; createdAt: string };

export interface AiCache {
  get(key: string): Promise<AiCacheEntry | null>;
  set(key: string, entry: Omit<AiCacheEntry, "createdAt">, ttlMs: number): Promise<void>;
}

/** JSON with object keys sorted at every depth, so equal inputs hash equally. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function aiCacheKey(parts: {
  task: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  input: unknown;
}): string {
  return createHash("sha256").update(stable(parts)).digest("hex");
}

export class MemoryAiCache implements AiCache {
  private readonly m = new Map<string, AiCacheEntry & { expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<AiCacheEntry | null> {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.m.delete(key);
      return null;
    }
    return { task: e.task, model: e.model, value: e.value, createdAt: e.createdAt };
  }

  async set(key: string, entry: Omit<AiCacheEntry, "createdAt">, ttlMs: number): Promise<void> {
    this.m.set(key, {
      ...entry,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: this.now() + ttlMs,
    });
  }

  get size(): number {
    return this.m.size;
  }
}

export class PgAiCache implements AiCache {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<AiCacheEntry | null> {
    const r = await this.pool.query<{
      task: string;
      model: string;
      value: unknown;
      created_at: Date;
    }>(
      "SELECT task, model, value, created_at FROM ai_cache WHERE key = $1 AND expires_at > now()",
      [key],
    );
    const row = r.rows[0];
    return row
      ? {
          task: row.task,
          model: row.model,
          value: row.value,
          createdAt: row.created_at.toISOString(),
        }
      : null;
  }

  async set(key: string, entry: Omit<AiCacheEntry, "createdAt">, ttlMs: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO ai_cache (key, task, model, value, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5::text || ' milliseconds')::interval)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, model = EXCLUDED.model,
         created_at = now(), expires_at = EXCLUDED.expires_at`,
      [key, entry.task, entry.model, JSON.stringify(entry.value), String(Math.round(ttlMs))],
    );
  }
}
