/* ------------------------------------------------------------------ */
/*  Bridge to the tracking workflow's tables                           */
/*                                                                     */
/*  The tracked-products page, product page and daily report read       */
/*  products / retailer_offers / price_history. The engine feeds them   */
/*  verified prices the same way src/lib/db/refresh.ts does — upsert    */
/*  one offer per retailer, one history row per product, retailer and   */
/*  day — and never creates a product (MASTER_PROMPT rule 5). The        */
/*  workflow's own files are not touched.                               */
/* ------------------------------------------------------------------ */

import type { Pool } from "pg";

export type Watcher = {
  userId: string;
  targetPrice: number | null;
  alertEnabled: boolean;
  email: string | null;
};

export type TrackedItem = {
  productId: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string | null;
  offers: { retailer: string; url: string | null; price: number }[];
  lastCheckedAt: string | null;
  watchers: Watcher[];
};

export type BridgeOffer = {
  retailer: string;
  price: number;
  inStock: boolean;
  /** The three-state stock the store gave (R6); stored when migration 006 is in. */
  availability?: "in_stock" | "out_of_stock" | "unknown";
  url: string;
  title: string;
};

export interface TrackedBridge {
  /** Tracked products, least recently checked first. */
  listTracked(limit: number): Promise<TrackedItem[]>;
  writeOffers(productId: string, offers: BridgeOffer[], at: string): Promise<void>;
  /** true if this (user, product, day) alert was not sent before (and is now recorded). */
  recordAlert(
    userId: string,
    productId: string,
    retailer: string,
    price: number,
    target: number,
    day: string,
  ): Promise<boolean>;
  startRun(job: string, trigger: "cron" | "admin" | "worker" | "manual"): Promise<string>;
  finishRun(id: string, ok: boolean, stats: Record<string, unknown>): Promise<void>;
}

export class PgTrackedBridge implements TrackedBridge {
  /** Whether retailer_offers.availability exists (migration 006); checked once. */
  private availabilityColumn: Promise<boolean> | null = null;

  constructor(private readonly pool: Pool) {}

  private hasAvailabilityColumn(): Promise<boolean> {
    this.availabilityColumn ??= this.pool
      .query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'retailer_offers' AND column_name = 'availability'`,
      )
      .then((r) => (r.rowCount ?? 0) > 0)
      .catch(() => false);
    return this.availabilityColumn;
  }

  async listTracked(limit: number): Promise<TrackedItem[]> {
    const { rows } = await this.pool.query(
      `SELECT p.id, p.name, p.brand, p.model, p.color, p.upc, p.last_checked_at,
              COALESCE((SELECT json_agg(json_build_object('retailer', o.retailer, 'url', o.url, 'price', o.price))
                        FROM retailer_offers o WHERE o.product_id = p.id), '[]'::json) AS offers,
              COALESCE((SELECT json_agg(json_build_object('userId', t.user_id, 'targetPrice', t.target_price, 'alertEnabled', COALESCE(t.alert_enabled, true),
                                                          'email', COALESCE(s.report_email, s.admin_email, u.email)))
                        FROM tracked_products t
                        LEFT JOIN user_settings s ON s.user_id = t.user_id
                        LEFT JOIN auth.users u ON u.id = t.user_id
                        WHERE t.product_id = p.id), '[]'::json) AS watchers
       FROM products p
       WHERE EXISTS (SELECT 1 FROM tracked_products t WHERE t.product_id = p.id)
       ORDER BY p.last_checked_at NULLS FIRST
       LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      productId: r.id,
      name: r.name,
      brand: r.brand,
      model: r.model ?? "",
      color: r.color ?? "",
      upc: r.upc,
      offers: (r.offers as { retailer: string; url: string | null; price: number | string }[]).map(
        (o) => ({ ...o, price: Number(o.price) }),
      ),
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
      watchers: (r.watchers as Watcher[]).map((w) => ({
        ...w,
        targetPrice: w.targetPrice === null ? null : Number(w.targetPrice),
      })),
    }));
  }

  async writeOffers(productId: string, offers: BridgeOffer[], at: string): Promise<void> {
    const withAvailability = await this.hasAvailabilityColumn();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const o of offers) {
        if (withAvailability) {
          await client.query(
            `INSERT INTO retailer_offers (product_id, retailer, price, currency, in_stock, availability, url, title, last_checked_at)
             VALUES ($1, $2, $3, 'CAD', $4, $5, $6, $7, $8)
             ON CONFLICT (product_id, retailer) DO UPDATE SET price = EXCLUDED.price, in_stock = EXCLUDED.in_stock,
               availability = EXCLUDED.availability, url = EXCLUDED.url, title = EXCLUDED.title,
               last_checked_at = EXCLUDED.last_checked_at`,
            [
              productId,
              o.retailer,
              o.price,
              o.inStock,
              o.availability ?? null,
              o.url,
              o.title.slice(0, 300),
              at,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO retailer_offers (product_id, retailer, price, currency, in_stock, url, title, last_checked_at)
             VALUES ($1, $2, $3, 'CAD', $4, $5, $6, $7)
             ON CONFLICT (product_id, retailer) DO UPDATE SET price = EXCLUDED.price, in_stock = EXCLUDED.in_stock, url = EXCLUDED.url,
               title = EXCLUDED.title, last_checked_at = EXCLUDED.last_checked_at`,
            [productId, o.retailer, o.price, o.inStock, o.url, o.title.slice(0, 300), at],
          );
        }
        await client.query(
          `INSERT INTO price_history (product_id, retailer, price, currency, date) VALUES ($1, $2, $3, 'CAD', $4::date)
           ON CONFLICT (product_id, retailer, date) DO UPDATE SET price = EXCLUDED.price`,
          [productId, o.retailer, o.price, at.slice(0, 10)],
        );
      }
      await client.query("UPDATE products SET last_checked_at = $2 WHERE id = $1", [productId, at]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async recordAlert(
    userId: string,
    productId: string,
    retailer: string,
    price: number,
    target: number,
    day: string,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO price_alerts_sent (user_id, product_id, retailer, price, target_price, sent_on)
       VALUES ($1, $2, $3, $4, $5, $6::date) ON CONFLICT (user_id, product_id, sent_on) DO NOTHING`,
      [userId, productId, retailer, price, target, day],
    );
    return (rowCount ?? 0) > 0;
  }

  async startRun(job: string, trigger: "cron" | "admin" | "worker" | "manual"): Promise<string> {
    const { rows } = await this.pool.query(
      "INSERT INTO engine_runs (job, trigger) VALUES ($1, $2) RETURNING id",
      [job, trigger],
    );
    return String(rows[0].id);
  }

  async finishRun(id: string, ok: boolean, stats: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      "UPDATE engine_runs SET finished_at = now(), ok = $2, stats = $3::jsonb WHERE id = $1",
      [id, ok, JSON.stringify(stats)],
    );
  }
}

/** In-memory twin for tests. */
export class MemoryTrackedBridge implements TrackedBridge {
  readonly offers = new Map<string, Map<string, BridgeOffer & { at: string }>>();
  readonly history: { productId: string; retailer: string; price: number; date: string }[] = [];
  readonly alerts = new Set<string>();
  readonly runs: { id: string; job: string; ok: boolean | null; stats: Record<string, unknown> }[] =
    [];

  constructor(private readonly items: TrackedItem[]) {}

  async listTracked(limit: number): Promise<TrackedItem[]> {
    return [...this.items]
      .sort((a, b) => (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? ""))
      .slice(0, limit);
  }

  async writeOffers(productId: string, offers: BridgeOffer[], at: string): Promise<void> {
    const m = this.offers.get(productId) ?? new Map();
    for (const o of offers) {
      m.set(o.retailer, { ...o, at });
      const day = at.slice(0, 10);
      const i = this.history.findIndex(
        (h) => h.productId === productId && h.retailer === o.retailer && h.date === day,
      );
      if (i >= 0) this.history[i].price = o.price;
      else this.history.push({ productId, retailer: o.retailer, price: o.price, date: day });
    }
    this.offers.set(productId, m);
    const item = this.items.find((x) => x.productId === productId);
    if (item) item.lastCheckedAt = at;
  }

  async recordAlert(
    userId: string,
    productId: string,
    _retailer: string,
    _price: number,
    _target: number,
    day: string,
  ): Promise<boolean> {
    const key = `${userId}|${productId}|${day}`;
    if (this.alerts.has(key)) return false;
    this.alerts.add(key);
    return true;
  }

  async startRun(job: string): Promise<string> {
    const id = String(this.runs.length + 1);
    this.runs.push({ id, job, ok: null, stats: {} });
    return id;
  }

  async finishRun(id: string, ok: boolean, stats: Record<string, unknown>): Promise<void> {
    const r = this.runs.find((x) => x.id === id);
    if (r) Object.assign(r, { ok, stats });
  }
}
