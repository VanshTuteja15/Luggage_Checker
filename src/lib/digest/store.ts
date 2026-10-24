/* ------------------------------------------------------------------ */
/*  Morning email: settings, chosen products and the run log           */
/*                                                                     */
/*  Postgres through the engine's server-side connection (the same     */
/*  database as the tracking tables). It bypasses row-level security,  */
/*  so every query names the signed-in user's id, which the API routes */
/*  take from the verified session, never from the request body. RLS   */
/*  still guards the tables for any other client (migration 006).      */
/*  The memory twin backs unit tests.                                  */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { DEFAULT_TIME_ZONE, formatClock, parseClock } from "@/lib/time/local";

export type DigestSettings = {
  userId: string;
  enabled: boolean;
  /** "09:00" */
  sendTime: string;
  timeZone: string;
  recipients: string[];
  updatedAt: string;
};

export type SettingsPatch = Partial<Pick<DigestSettings, "enabled" | "sendTime" | "timeZone" | "recipients">>;

/** A tracked product as the email page lists it. */
export type TrackedChoice = {
  productId: string;
  trackedProductId: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string | null;
  imageUrl: string | null;
  targetPrice: number | null;
  /** Chosen for the email, and where in the email (0 = first). */
  chosen: boolean;
  position: number | null;
  /** Store pages it was tracked from, to find its engine listings. */
  knownUrls: string[];
};

export type RunRecipient = {
  address: string;
  status: "sent" | "failed";
  providerId: string | null;
  /** A plain sentence; never a stack trace or a provider code. */
  error: string | null;
  attempts: number;
  at: string;
};

export type RunStatus =
  | "claimed"
  | "preparing"
  | "sending"
  | "sent"
  | "partial"
  | "failed"
  | "missed"
  | "skipped";

export type RunSnapshot = { subject: string; summary: string[]; products: string[] };

export type DigestRun = {
  id: string;
  userId: string;
  localDate: string;
  kind: "daily" | "test";
  status: RunStatus;
  claimedAt: string;
  preparedAt: string | null;
  sentAt: string | null;
  recipients: RunRecipient[];
  productCount: number;
  snapshot: RunSnapshot | null;
  error: string | null;
  notes: string[];
};

export type RunPatch = Partial<
  Pick<
    DigestRun,
    "status" | "preparedAt" | "sentAt" | "recipients" | "productCount" | "snapshot" | "error" | "notes"
  >
>;

export interface DigestStore {
  getSettings(userId: string): Promise<DigestSettings | null>;
  /** The settings row, created on first use with `seedRecipients` (R1.14). */
  ensureSettings(userId: string, seedRecipients: string[]): Promise<DigestSettings>;
  updateSettings(userId: string, patch: SettingsPatch): Promise<DigestSettings>;
  /** The old daily report's address (user_settings), for the first-load migration. */
  legacyReportEmail(userId: string): Promise<string | null>;
  /** Stores chosen in Settings (user_settings.retailers), raw. */
  savedStores(userId: string): Promise<string[] | null>;

  listTracked(userId: string): Promise<TrackedChoice[]>;
  /** Replace the selection with these products, in this order. Returns how many were kept. */
  setChosen(userId: string, productIds: string[]): Promise<number>;
  /** Add one product at the end. False when the user doesn't track it. */
  addChosen(userId: string, productId: string): Promise<boolean>;
  removeChosen(userId: string, productId: string): Promise<void>;

  insertRun(run: Omit<DigestRun, "id">): Promise<DigestRun>;
  /** Claim today's daily run (INSERT … ON CONFLICT DO NOTHING). null = already claimed. */
  claimDaily(userId: string, localDate: string, claimedAt: string, notes: string[]): Promise<DigestRun | null>;
  updateRun(id: string, patch: RunPatch): Promise<void>;
  getDailyRun(userId: string, localDate: string): Promise<DigestRun | null>;
  listRuns(userId: string, sinceLocalDate: string): Promise<DigestRun[]>;
  /** Emails attempted by every account since this instant (the provider's daily limit). */
  emailsSentSince(sinceIso: string): Promise<number>;
  testSendsSince(userId: string, sinceIso: string): Promise<number>;
  /** Accounts with the email switched on (the scheduler's work list). */
  enabledAccounts(): Promise<DigestSettings[]>;
}

/* ── Helpers ───────────────────────────────────────────────────────── */

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const ymd = (v: unknown): string =>
  v instanceof Date
    ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
    : String(v).slice(0, 10);

function toSettings(r: Row): DigestSettings {
  return {
    userId: String(r.user_id),
    enabled: r.enabled !== false,
    sendTime: formatClock(parseClock(String(r.send_time ?? "09:00")) ?? 540),
    timeZone: String(r.timezone ?? DEFAULT_TIME_ZONE),
    recipients: Array.isArray(r.recipients) ? (r.recipients as string[]) : [],
    updatedAt: iso(r.updated_at),
  };
}

function toRun(r: Row): DigestRun {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    localDate: ymd(r.local_date),
    kind: r.kind as DigestRun["kind"],
    status: r.status as RunStatus,
    claimedAt: iso(r.claimed_at),
    preparedAt: isoOrNull(r.prepared_at),
    sentAt: isoOrNull(r.sent_at),
    recipients: (r.recipients as RunRecipient[] | null) ?? [],
    productCount: Number(r.product_count ?? 0),
    snapshot: (r.snapshot as RunSnapshot | null) ?? null,
    error: (r.error as string | null) ?? null,
    notes: (r.notes as string[] | null) ?? [],
  };
}

/* ── Postgres ──────────────────────────────────────────────────────── */

export class PgDigestStore implements DigestStore {
  constructor(private readonly pool: Pool) {}

  private async q(text: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.pool.query(text, params)).rows as Row[];
  }

  async getSettings(userId: string): Promise<DigestSettings | null> {
    const [r] = await this.q("SELECT * FROM email_digest_settings WHERE user_id = $1", [userId]);
    return r ? toSettings(r) : null;
  }

  async ensureSettings(userId: string, seedRecipients: string[]): Promise<DigestSettings> {
    await this.q(
      `INSERT INTO email_digest_settings (user_id, recipients) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, seedRecipients.slice(0, 10)],
    );
    return (await this.getSettings(userId))!;
  }

  async updateSettings(userId: string, patch: SettingsPatch): Promise<DigestSettings> {
    await this.ensureSettings(userId, []);
    const [r] = await this.q(
      `UPDATE email_digest_settings SET
         enabled    = COALESCE($2, enabled),
         send_time  = COALESCE($3::time, send_time),
         timezone   = COALESCE($4, timezone),
         recipients = COALESCE($5, recipients),
         updated_at = now()
       WHERE user_id = $1 RETURNING *`,
      [
        userId,
        patch.enabled ?? null,
        patch.sendTime ?? null,
        patch.timeZone ?? null,
        patch.recipients ?? null,
      ],
    );
    return toSettings(r);
  }

  async legacyReportEmail(userId: string): Promise<string | null> {
    const [r] = await this.q(
      "SELECT NULLIF(btrim(report_email), '') AS email FROM user_settings WHERE user_id = $1",
      [userId],
    ).catch(() => []);
    return (r?.email as string | null) ?? null;
  }

  async savedStores(userId: string): Promise<string[] | null> {
    const [r] = await this.q("SELECT retailers FROM user_settings WHERE user_id = $1", [
      userId,
    ]).catch(() => []);
    return Array.isArray(r?.retailers) ? (r.retailers as string[]) : null;
  }

  async listTracked(userId: string): Promise<TrackedChoice[]> {
    const rows = await this.q(
      `SELECT t.id AS tracked_id, p.id AS product_id, p.name, p.brand, p.model, p.color, p.upc, p.image_url,
              t.target_price, d.position,
              COALESCE((SELECT array_agg(o.url) FROM retailer_offers o WHERE o.product_id = p.id AND o.url IS NOT NULL), '{}') AS urls
         FROM tracked_products t
         JOIN products p ON p.id = t.product_id
         LEFT JOIN email_digest_products d ON d.user_id = t.user_id AND d.tracked_product_id = t.id
        WHERE t.user_id = $1
        ORDER BY d.position NULLS LAST, p.name`,
      [userId],
    );
    return rows.map((r) => ({
      productId: String(r.product_id),
      trackedProductId: String(r.tracked_id),
      name: String(r.name),
      brand: String(r.brand ?? ""),
      model: String(r.model ?? ""),
      color: String(r.color ?? ""),
      upc: (r.upc as string | null) ?? null,
      imageUrl: (r.image_url as string | null) ?? null,
      targetPrice: r.target_price == null ? null : Number(r.target_price),
      chosen: r.position != null,
      position: r.position == null ? null : Number(r.position),
      knownUrls: (r.urls as string[]) ?? [],
    }));
  }

  async setChosen(userId: string, productIds: string[]): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM email_digest_products WHERE user_id = $1", [userId]);
      const { rowCount } = await client.query(
        `INSERT INTO email_digest_products (user_id, tracked_product_id, position)
         SELECT $1, t.id, x.ord - 1
           FROM unnest($2::uuid[]) WITH ORDINALITY AS x(product_id, ord)
           JOIN tracked_products t ON t.product_id = x.product_id AND t.user_id = $1
         ON CONFLICT DO NOTHING`,
        [userId, productIds],
      );
      await client.query("COMMIT");
      return rowCount ?? 0;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async addChosen(userId: string, productId: string): Promise<boolean> {
    const rows = await this.q(
      `INSERT INTO email_digest_products (user_id, tracked_product_id, position)
       SELECT $1, t.id, COALESCE((SELECT max(position) + 1 FROM email_digest_products WHERE user_id = $1), 0)
         FROM tracked_products t WHERE t.user_id = $1 AND t.product_id = $2
       ON CONFLICT (user_id, tracked_product_id) DO UPDATE SET position = email_digest_products.position
       RETURNING tracked_product_id`,
      [userId, productId],
    );
    return rows.length > 0;
  }

  async removeChosen(userId: string, productId: string): Promise<void> {
    await this.q(
      `DELETE FROM email_digest_products d USING tracked_products t
        WHERE d.user_id = $1 AND d.tracked_product_id = t.id AND t.product_id = $2`,
      [userId, productId],
    );
  }

  async insertRun(run: Omit<DigestRun, "id">): Promise<DigestRun> {
    const [r] = await this.q(
      `INSERT INTO email_digest_runs (user_id, local_date, kind, status, claimed_at, prepared_at, sent_at,
                                      recipients, product_count, snapshot, error, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12::jsonb) RETURNING *`,
      [
        run.userId,
        run.localDate,
        run.kind,
        run.status,
        run.claimedAt,
        run.preparedAt,
        run.sentAt,
        JSON.stringify(run.recipients),
        run.productCount,
        run.snapshot ? JSON.stringify(run.snapshot) : null,
        run.error,
        JSON.stringify(run.notes),
      ],
    );
    return toRun(r);
  }

  async claimDaily(
    userId: string,
    localDate: string,
    claimedAt: string,
    notes: string[],
  ): Promise<DigestRun | null> {
    const [r] = await this.q(
      `INSERT INTO email_digest_runs (user_id, local_date, kind, status, claimed_at, notes)
       VALUES ($1, $2, 'daily', 'claimed', $3, $4::jsonb)
       ON CONFLICT (user_id, local_date) WHERE kind = 'daily' DO NOTHING
       RETURNING *`,
      [userId, localDate, claimedAt, JSON.stringify(notes)],
    );
    return r ? toRun(r) : null;
  }

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.preparedAt !== undefined) add("prepared_at", patch.preparedAt);
    if (patch.sentAt !== undefined) add("sent_at", patch.sentAt);
    if (patch.recipients !== undefined) add("recipients", JSON.stringify(patch.recipients), "::jsonb");
    if (patch.productCount !== undefined) add("product_count", patch.productCount);
    if (patch.snapshot !== undefined)
      add("snapshot", patch.snapshot ? JSON.stringify(patch.snapshot) : null, "::jsonb");
    if (patch.error !== undefined) add("error", patch.error);
    if (patch.notes !== undefined) add("notes", JSON.stringify(patch.notes), "::jsonb");
    if (sets.length === 0) return;
    await this.q(`UPDATE email_digest_runs SET ${sets.join(", ")} WHERE id = $1`, params);
  }

  async getDailyRun(userId: string, localDate: string): Promise<DigestRun | null> {
    const [r] = await this.q(
      "SELECT * FROM email_digest_runs WHERE user_id = $1 AND local_date = $2 AND kind = 'daily'",
      [userId, localDate],
    );
    return r ? toRun(r) : null;
  }

  async listRuns(userId: string, sinceLocalDate: string): Promise<DigestRun[]> {
    const rows = await this.q(
      `SELECT * FROM email_digest_runs WHERE user_id = $1 AND local_date >= $2
        ORDER BY local_date DESC, claimed_at DESC LIMIT 200`,
      [userId, sinceLocalDate],
    );
    return rows.map(toRun);
  }

  async emailsSentSince(sinceIso: string): Promise<number> {
    const [r] = await this.q(
      `SELECT COALESCE(sum(GREATEST((x->>'attempts')::int, 1)), 0)::int AS n
         FROM email_digest_runs, jsonb_array_elements(recipients) AS x
        WHERE claimed_at >= $1::timestamptz - interval '1 day' AND (x->>'at')::timestamptz >= $1`,
      [sinceIso],
    );
    return Number(r?.n ?? 0);
  }

  async testSendsSince(userId: string, sinceIso: string): Promise<number> {
    const [r] = await this.q(
      "SELECT count(*)::int AS n FROM email_digest_runs WHERE user_id = $1 AND kind = 'test' AND claimed_at >= $2",
      [userId, sinceIso],
    );
    return Number(r?.n ?? 0);
  }

  async enabledAccounts(): Promise<DigestSettings[]> {
    const rows = await this.q("SELECT * FROM email_digest_settings WHERE enabled ORDER BY user_id");
    return rows.map(toSettings);
  }
}

/* ── Memory (tests) ────────────────────────────────────────────────── */

export type MemoryTracked = Omit<TrackedChoice, "chosen" | "position"> & { userId: string };

export class MemoryDigestStore implements DigestStore {
  readonly settings = new Map<string, DigestSettings>();
  readonly chosen = new Map<string, string[]>(); // userId → productIds in order
  readonly runs: DigestRun[] = [];
  legacy = new Map<string, string>();
  stores = new Map<string, string[]>();

  constructor(
    readonly tracked: MemoryTracked[] = [],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async getSettings(userId: string): Promise<DigestSettings | null> {
    const s = this.settings.get(userId);
    return s ? structuredClone(s) : null;
  }

  async ensureSettings(userId: string, seedRecipients: string[]): Promise<DigestSettings> {
    if (!this.settings.has(userId))
      this.settings.set(userId, {
        userId,
        enabled: true,
        sendTime: "09:00",
        timeZone: DEFAULT_TIME_ZONE,
        recipients: seedRecipients.slice(0, 10),
        updatedAt: this.clock().toISOString(),
      });
    return (await this.getSettings(userId))!;
  }

  async updateSettings(userId: string, patch: SettingsPatch): Promise<DigestSettings> {
    const s = await this.ensureSettings(userId, []);
    const next = { ...s, ...patch, updatedAt: this.clock().toISOString() };
    this.settings.set(userId, next);
    return structuredClone(next);
  }

  async legacyReportEmail(userId: string): Promise<string | null> {
    return this.legacy.get(userId) ?? null;
  }

  async savedStores(userId: string): Promise<string[] | null> {
    return this.stores.get(userId) ?? null;
  }

  async listTracked(userId: string): Promise<TrackedChoice[]> {
    const order = this.chosen.get(userId) ?? [];
    return this.tracked
      .filter((t) => t.userId === userId)
      .map((t) => {
        const i = order.indexOf(t.productId);
        const choice: TrackedChoice = {
          productId: t.productId,
          trackedProductId: t.trackedProductId,
          name: t.name,
          brand: t.brand,
          model: t.model,
          color: t.color,
          upc: t.upc,
          imageUrl: t.imageUrl,
          targetPrice: t.targetPrice,
          chosen: i >= 0,
          position: i >= 0 ? i : null,
          knownUrls: t.knownUrls,
        };
        return choice;
      })
      .sort(
        (a, b) =>
          (a.position ?? Infinity) - (b.position ?? Infinity) || a.name.localeCompare(b.name),
      );
  }

  private owns(userId: string, productId: string): boolean {
    return this.tracked.some((t) => t.userId === userId && t.productId === productId);
  }

  async setChosen(userId: string, productIds: string[]): Promise<number> {
    const kept = [...new Set(productIds)].filter((id) => this.owns(userId, id));
    this.chosen.set(userId, kept);
    return kept.length;
  }

  async addChosen(userId: string, productId: string): Promise<boolean> {
    if (!this.owns(userId, productId)) return false;
    const list = this.chosen.get(userId) ?? [];
    if (!list.includes(productId)) this.chosen.set(userId, [...list, productId]);
    return true;
  }

  async removeChosen(userId: string, productId: string): Promise<void> {
    this.chosen.set(
      userId,
      (this.chosen.get(userId) ?? []).filter((id) => id !== productId),
    );
  }

  /** Untracking cascades to the email (R1.3). */
  untrack(userId: string, productId: string): void {
    const i = this.tracked.findIndex((t) => t.userId === userId && t.productId === productId);
    if (i >= 0) this.tracked.splice(i, 1);
    void this.removeChosen(userId, productId);
  }

  async insertRun(run: Omit<DigestRun, "id">): Promise<DigestRun> {
    const r = { ...structuredClone(run), id: randomUUID() };
    this.runs.push(r);
    return structuredClone(r);
  }

  async claimDaily(
    userId: string,
    localDate: string,
    claimedAt: string,
    notes: string[],
  ): Promise<DigestRun | null> {
    if (this.runs.some((r) => r.userId === userId && r.localDate === localDate && r.kind === "daily"))
      return null;
    return this.insertRun({
      userId,
      localDate,
      kind: "daily",
      status: "claimed",
      claimedAt,
      preparedAt: null,
      sentAt: null,
      recipients: [],
      productCount: 0,
      snapshot: null,
      error: null,
      notes,
    });
  }

  async updateRun(id: string, patch: RunPatch): Promise<void> {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, structuredClone(patch));
  }

  async getDailyRun(userId: string, localDate: string): Promise<DigestRun | null> {
    const r = this.runs.find(
      (x) => x.userId === userId && x.localDate === localDate && x.kind === "daily",
    );
    return r ? structuredClone(r) : null;
  }

  async listRuns(userId: string, sinceLocalDate: string): Promise<DigestRun[]> {
    return this.runs
      .filter((r) => r.userId === userId && r.localDate >= sinceLocalDate)
      .sort(
        (a, b) => b.localDate.localeCompare(a.localDate) || b.claimedAt.localeCompare(a.claimedAt),
      )
      .map((r) => structuredClone(r));
  }

  async emailsSentSince(sinceIso: string): Promise<number> {
    return this.runs
      .flatMap((r) => r.recipients)
      .filter((x) => x.at >= sinceIso)
      .reduce((n, x) => n + Math.max(1, x.attempts), 0);
  }

  async testSendsSince(userId: string, sinceIso: string): Promise<number> {
    return this.runs.filter((r) => r.userId === userId && r.kind === "test" && r.claimedAt >= sinceIso)
      .length;
  }

  async enabledAccounts(): Promise<DigestSettings[]> {
    return [...this.settings.values()].filter((s) => s.enabled).map((s) => structuredClone(s));
  }
}
