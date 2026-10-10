/* ------------------------------------------------------------------ */
/*  Web-estimate persistence: search cache, daily spend, rejections    */
/*                                                                     */
/*  Accepted estimates are observations (adapter "web_estimate") on     */
/*  listings, like any price. This store keeps what isn't a price:      */
/*  the search results we paid for (so a repeat within the TTL costs    */
/*  nothing, R3.4), credits spent per day and purpose (R3.6), and the   */
/*  results we rejected with their reasons (Store status → Technical    */
/*  details, R3.2).                                                     */
/* ------------------------------------------------------------------ */

import type { Pool } from "pg";
import type { EstimatePurpose } from "./budget";

export type SearchResultLite = { url: string; title: string; content: string };

export type CachedEstimateSearch = {
  key: string;
  query: string;
  purpose: EstimatePurpose;
  results: SearchResultLite[];
  credits: number;
  searchedAt: string;
  expiresAt: string;
};

export type EstimateRejection = {
  sourceId: string | null;
  query: string;
  url: string;
  title: string;
  snippet: string;
  price: number | null;
  reasons: string[];
  foundAt: string;
};

export interface EstimateStore {
  cachedSearch(key: string, nowIso: string): Promise<CachedEstimateSearch | null>;
  saveSearch(entry: CachedEstimateSearch): Promise<void>;
  spentOn(localDate: string, purpose: EstimatePurpose): Promise<number>;
  addSpend(localDate: string, purpose: EstimatePurpose, credits: number): Promise<void>;
  recordRejections(rows: EstimateRejection[]): Promise<void>;
  recentRejections(limit: number): Promise<EstimateRejection[]>;
}

export class MemoryEstimateStore implements EstimateStore {
  private searches = new Map<string, CachedEstimateSearch>();
  private spend = new Map<string, number>();
  readonly rejections: EstimateRejection[] = [];

  async cachedSearch(key: string, nowIso: string): Promise<CachedEstimateSearch | null> {
    const hit = this.searches.get(key);
    return hit && hit.expiresAt > nowIso ? structuredClone(hit) : null;
  }
  async saveSearch(entry: CachedEstimateSearch): Promise<void> {
    this.searches.set(entry.key, structuredClone(entry));
  }
  async spentOn(localDate: string, purpose: EstimatePurpose): Promise<number> {
    return this.spend.get(`${localDate}|${purpose}`) ?? 0;
  }
  async addSpend(localDate: string, purpose: EstimatePurpose, credits: number): Promise<void> {
    const k = `${localDate}|${purpose}`;
    this.spend.set(k, (this.spend.get(k) ?? 0) + Math.max(0, credits));
  }
  async recordRejections(rows: EstimateRejection[]): Promise<void> {
    this.rejections.push(...structuredClone(rows));
  }
  async recentRejections(limit: number): Promise<EstimateRejection[]> {
    return structuredClone(this.rejections.slice(-limit).reverse());
  }
}

export class PgEstimateStore implements EstimateStore {
  constructor(private readonly pool: Pool) {}

  async cachedSearch(key: string, nowIso: string): Promise<CachedEstimateSearch | null> {
    const { rows } = await this.pool.query(
      `SELECT cache_key, query, purpose, results, credits, searched_at, expires_at
         FROM web_estimate_searches WHERE cache_key = $1 AND expires_at > $2`,
      [key, nowIso],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      key: r.cache_key,
      query: r.query,
      purpose: r.purpose,
      results: r.results as SearchResultLite[],
      credits: r.credits,
      searchedAt: new Date(r.searched_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
    };
  }

  async saveSearch(e: CachedEstimateSearch): Promise<void> {
    await this.pool.query(
      `INSERT INTO web_estimate_searches (cache_key, query, purpose, results, credits, searched_at, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (cache_key) DO UPDATE SET query = EXCLUDED.query, purpose = EXCLUDED.purpose,
         results = EXCLUDED.results, credits = EXCLUDED.credits, searched_at = EXCLUDED.searched_at,
         expires_at = EXCLUDED.expires_at`,
      [
        e.key,
        e.query.slice(0, 300),
        e.purpose,
        JSON.stringify(e.results),
        e.credits,
        e.searchedAt,
        e.expiresAt,
      ],
    );
  }

  async spentOn(localDate: string, purpose: EstimatePurpose): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT credits FROM web_estimate_spend WHERE local_date = $1 AND purpose = $2",
      [localDate, purpose],
    );
    return rows[0] ? Number(rows[0].credits) : 0;
  }

  async addSpend(localDate: string, purpose: EstimatePurpose, credits: number): Promise<void> {
    if (credits <= 0) return;
    await this.pool.query(
      `INSERT INTO web_estimate_spend (local_date, purpose, credits) VALUES ($1, $2, $3)
       ON CONFLICT (local_date, purpose) DO UPDATE SET credits = web_estimate_spend.credits + EXCLUDED.credits`,
      [localDate, purpose, credits],
    );
  }

  async recordRejections(rows: EstimateRejection[]): Promise<void> {
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO web_estimate_rejections (source_id, query, url, title, snippet, price, reasons, found_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          r.sourceId,
          r.query.slice(0, 300),
          r.url.slice(0, 2000),
          r.title.slice(0, 300),
          r.snippet.slice(0, 300),
          r.price,
          JSON.stringify(r.reasons),
          r.foundAt,
        ],
      );
    }
  }

  async recentRejections(limit: number): Promise<EstimateRejection[]> {
    const { rows } = await this.pool.query(
      `SELECT source_id, query, url, title, snippet, price, reasons, found_at
         FROM web_estimate_rejections ORDER BY found_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      sourceId: r.source_id,
      query: r.query,
      url: r.url,
      title: r.title ?? "",
      snippet: r.snippet ?? "",
      price: r.price === null ? null : Number(r.price),
      reasons: r.reasons as string[],
      foundAt: new Date(r.found_at).toISOString(),
    }));
  }
}
