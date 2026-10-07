/* ------------------------------------------------------------------ */
/*  Postgres EngineStore                                              */
/*                                                                     */
/*  Server-side only (worker, API routes, scripts). Connects with      */
/*  DATABASE_URL — in production the Supabase pooler — which bypasses  */
/*  RLS like the service role does, so every user-scoped read here is */
/*  filtered by user id in SQL, and the API checks ownership first.    */
/*  All values travel as bind parameters; no string interpolation.    */
/* ------------------------------------------------------------------ */

import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import { registrySeedSql } from "../registry/sql";
import type {
  AdapterId,
  Availability,
  CircuitState,
  FetchAttempt,
  Identifier,
  IdentifierKind,
  ListingInput,
  ListingRecord,
  Observation,
  ObservationInput,
  ParsedQuery,
  ResearchAnswer,
  ResearchSessionRecord,
  SessionEvent,
  SessionEventType,
  SessionStatus,
  SourceHealth,
  SourceRecord,
} from "../types";
import type {
  CatalogProduct,
  CatalogVariant,
  EngineStore,
  FailureRow,
  FeedImportInput,
  FlagRow,
  PriceRange,
  ProductInput,
  RejectionRow,
  ReviewItem,
  SessionInput,
  SessionPatch,
  SessionTiming,
  SourceHealthStat,
} from "./port";
import { haystackFor, matchScore, tsQueryFor } from "./terms";

/* ── connection ───────────────────────────────────────────────────── */

/** SSL from env, never from the URL (pg lets ?sslmode override explicit options). */
export function poolConfig(connectionString: string, max = 5): PoolConfig {
  const url = new URL(connectionString);
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1", "::1", "postgres"].includes(url.hostname);
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n");
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  let ssl: PoolConfig["ssl"];
  if (mode === "off" || (local && !mode)) ssl = false;
  else if (ca) ssl = { ca, rejectUnauthorized: true };
  else if (mode === "no-verify") ssl = { rejectUnauthorized: false };
  else ssl = { rejectUnauthorized: true };
  return { connectionString: url.toString(), max, ssl, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 };
}

/* ── row mapping ──────────────────────────────────────────────────── */

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
const isoReq = (v: unknown): string => iso(v) ?? new Date(0).toISOString();
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

type Row = QueryResultRow;

function toSource(r: Row): SourceRecord {
  return {
    id: r.id,
    name: r.name,
    retailerLabel: r.retailer_label,
    category: r.category,
    status: r.status,
    platform: r.platform ?? "",
    allowedDomains: r.allowed_domains ?? [],
    fetchHosts: r.fetch_hosts ?? [],
    marketHost: r.market_host,
    marketPathPrefix: r.market_path_prefix,
    currency: "CAD",
    liveClass: r.live_class,
    permission: r.permission,
    terms: r.terms,
    robots: r.robots,
    crawlDelaySec: Number(r.crawl_delay_sec),
    visitWindow: r.visit_window,
    ucpEndpoint: r.ucp_endpoint,
    identityQuality: r.identity_quality,
    routes: r.routes,
    linkOnlySearchUrl: r.link_only_search_url,
    domainWarnings: r.domain_warnings ?? [],
    evidence: r.evidence,
    enabled: r.enabled,
  };
}

function toListing(r: Row): ListingRecord {
  return {
    id: r.id,
    sourceId: r.source_id,
    url: r.url,
    externalId: r.external_id,
    title: r.title,
    brand: r.brand,
    sizeClass: r.size_class,
    colour: r.colour,
    identifiers: (r.identifiers ?? []) as Identifier[],
    imageUrl: r.image_url,
    productId: r.product_id,
    variantId: r.variant_id,
    discoveredVia: r.discovered_via,
    lastmod: iso(r.lastmod),
    firstSeenAt: isoReq(r.first_seen_at),
    lastSeenAt: isoReq(r.last_seen_at),
    active: r.active,
  };
}

function toProduct(r: Row): CatalogProduct {
  return {
    id: r.id,
    category: r.category,
    brand: r.brand,
    line: r.line,
    name: r.name,
    sizeClass: r.size_class,
    identityKey: r.identity_key,
    status: r.status,
    mergedInto: r.merged_into,
    attributes: r.attributes ?? {},
    createdAt: isoReq(r.created_at),
  };
}

function toVariant(r: Row): CatalogVariant {
  return { id: r.id, productId: r.product_id, colour: r.colour, colourCode: r.colour_code, title: r.title, imageUrl: r.image_url };
}

function toObservation(r: Row): Observation {
  return {
    id: String(r.id),
    listingId: r.listing_id,
    sourceId: r.source_id,
    adapter: r.adapter as AdapterId,
    price: Number(r.price),
    listPrice: num(r.list_price),
    currency: "CAD",
    availability: r.availability as Availability,
    seller: r.seller,
    condition: r.condition,
    validation: { outcome: r.outcome, confidence: Number(r.confidence), reasons: (r.validation?.reasons ?? []) as string[] },
    evidence: r.evidence ?? {},
    extractorVersion: r.extractor_version,
    validatorVersion: r.validator_version,
    fetchedAt: isoReq(r.fetched_at),
    asOf: iso(r.as_of),
    sessionId: r.session_id,
  };
}

function toSession(r: Row): ResearchSessionRecord {
  return {
    id: r.id,
    userId: r.user_id,
    query: r.query,
    status: r.status as SessionStatus,
    parentSessionId: r.parent_session_id,
    storeIds: r.store_ids,
    deadlineMs: r.deadline_ms,
    createdAt: isoReq(r.created_at),
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    answer: (r.answer as ResearchAnswer | null) ?? null,
    error: r.error,
  };
}

function toReview(r: Row): ReviewItem {
  return {
    id: r.id,
    listingId: r.listing_id,
    listingTitle: r.listing_title ?? "",
    listingUrl: r.listing_url ?? "",
    sourceId: r.source_id ?? "",
    candidateProductId: r.candidate_product_id,
    candidateName: r.candidate_name ?? null,
    score: num(r.score),
    reasons: (r.reasons ?? []) as string[],
    status: r.status,
    createdAt: isoReq(r.created_at),
  };
}

/* ── store ────────────────────────────────────────────────────────── */

export class PgEngineStore implements EngineStore {
  readonly kind = "postgres" as const;
  readonly pool: Pool;

  constructor(connectionStringOrPool: string | Pool, max = 5) {
    this.pool = typeof connectionStringOrPool === "string" ? new Pool(poolConfig(connectionStringOrPool, max)) : connectionStringOrPool;
  }

  private async q<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query<T>(text, params);
    return res.rows;
  }

  private async tx<T>(fn: (q: (text: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(async (text, params = []) => (await client.query(text, params)).rows);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /* registry */

  async listSources(): Promise<SourceRecord[]> {
    return (await this.q("SELECT * FROM sources ORDER BY id")).map(toSource);
  }

  async upsertSources(sources: SourceRecord[]): Promise<void> {
    await this.pool.query(registrySeedSql(sources));
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    await this.q("UPDATE sources SET enabled = $2 WHERE id = $1", [id, enabled]);
  }

  async getHealth(sourceId: string): Promise<SourceHealth> {
    const [r] = await this.q("SELECT circuit_state, circuit_opened_at, circuit_reason, consecutive_failures FROM sources WHERE id = $1", [sourceId]);
    return {
      sourceId,
      circuit: (r?.circuit_state as CircuitState) ?? "closed",
      circuitOpenedAt: iso(r?.circuit_opened_at),
      circuitReason: r?.circuit_reason ?? null,
      consecutiveFailures: r?.consecutive_failures ?? 0,
    };
  }

  async saveHealth(h: SourceHealth): Promise<void> {
    await this.q(
      "UPDATE sources SET circuit_state = $2, circuit_opened_at = $3, circuit_reason = $4, consecutive_failures = $5 WHERE id = $1",
      [h.sourceId, h.circuit, h.circuitOpenedAt, h.circuitReason, h.consecutiveFailures],
    );
  }

  async sourcesWithAdapter(adapter: "feed_import" | "manual_entry"): Promise<Set<string>> {
    const rows = await this.q("SELECT DISTINCT source_id FROM observations WHERE adapter = $1 AND outcome <> 'rejected'", [adapter]);
    return new Set(rows.map((r) => r.source_id as string));
  }

  /* flags */

  async listFlagRows(): Promise<FlagRow[]> {
    const rows = await this.q("SELECT key, enabled, description, updated_at FROM feature_flags ORDER BY key");
    return rows.map((r) => ({ key: r.key, enabled: r.enabled, description: r.description, updatedAt: isoReq(r.updated_at) }));
  }

  async setFlag(key: string, enabled: boolean, userId: string | null): Promise<void> {
    await this.q(
      `INSERT INTO feature_flags (key, enabled, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, enabled, userId],
    );
  }

  /* listings */

  async upsertListing(input: ListingInput): Promise<ListingRecord> {
    const [r] = await this.q(
      `INSERT INTO listings (source_id, url, external_id, title, brand, size_class, colour, identifiers, image_url,
                             product_id, variant_id, discovered_via, lastmod, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (source_id, url) DO UPDATE SET
         external_id = COALESCE(EXCLUDED.external_id, listings.external_id),
         title       = EXCLUDED.title,
         brand       = COALESCE(EXCLUDED.brand, listings.brand),
         size_class  = COALESCE(EXCLUDED.size_class, listings.size_class),
         colour      = COALESCE(EXCLUDED.colour, listings.colour),
         identifiers = CASE WHEN jsonb_array_length(EXCLUDED.identifiers) > 0 THEN EXCLUDED.identifiers ELSE listings.identifiers END,
         image_url   = COALESCE(EXCLUDED.image_url, listings.image_url),
         product_id  = COALESCE(EXCLUDED.product_id, listings.product_id),
         variant_id  = COALESCE(EXCLUDED.variant_id, listings.variant_id),
         lastmod     = COALESCE(EXCLUDED.lastmod, listings.lastmod),
         active      = EXCLUDED.active,
         last_seen_at = now()
       RETURNING *`,
      [
        input.sourceId,
        input.url,
        input.externalId,
        input.title.slice(0, 500),
        input.brand,
        input.sizeClass,
        input.colour,
        JSON.stringify(input.identifiers),
        input.imageUrl,
        input.productId ?? null,
        input.variantId ?? null,
        input.discoveredVia,
        input.lastmod,
        input.active,
      ],
    );
    return toListing(r);
  }

  async getListing(id: string): Promise<ListingRecord | null> {
    const [r] = await this.q("SELECT * FROM listings WHERE id = $1", [id]);
    return r ? toListing(r) : null;
  }

  async findListingByUrl(sourceId: string, url: string): Promise<ListingRecord | null> {
    const [r] = await this.q("SELECT * FROM listings WHERE source_id = $1 AND url = $2", [sourceId, url]);
    return r ? toListing(r) : null;
  }

  async searchListings(q: ParsedQuery, opts: { limit: number; sourceIds?: string[] }): Promise<ListingRecord[]> {
    const tsq = tsQueryFor(q);
    if (!tsq) return [];
    const rows = await this.q(
      `SELECT l.* FROM listings l
       WHERE l.active
         AND l.search_tsv @@ to_tsquery('simple', $1)
         AND ($2::text[] IS NULL OR l.source_id = ANY($2::text[]))
         AND ($3::text IS NULL OR l.size_class IS NULL OR l.size_class = $3)
       ORDER BY ts_rank(l.search_tsv, to_tsquery('simple', $1)) DESC, l.title
       LIMIT $4`,
      [tsq, opts.sourceIds ?? null, q.sizeClass, Math.min(500, opts.limit * 3)],
    );
    // Final ordering uses the same scorer as the memory store.
    return rows
      .map(toListing)
      .map((l) => ({ l, s: matchScore(q, haystackFor(l), l.sizeClass) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.l.title.localeCompare(b.l.title))
      .slice(0, opts.limit)
      .map((x) => x.l);
  }

  async listingsForProduct(productId: string): Promise<ListingRecord[]> {
    return (await this.q("SELECT * FROM listings WHERE product_id = $1 AND active ORDER BY source_id", [productId])).map(toListing);
  }

  async listingsBySource(sourceId: string, limit: number): Promise<ListingRecord[]> {
    return (await this.q("SELECT * FROM listings WHERE source_id = $1 ORDER BY last_seen_at DESC LIMIT $2", [sourceId, limit])).map(toListing);
  }

  async countListingsBySource(): Promise<Record<string, number>> {
    const rows = await this.q("SELECT source_id, count(*)::int AS n FROM listings WHERE active GROUP BY source_id");
    return Object.fromEntries(rows.map((r) => [r.source_id, r.n]));
  }

  async linkListing(listingId: string, productId: string | null, variantId: string | null): Promise<void> {
    await this.q("UPDATE listings SET product_id = $2, variant_id = $3 WHERE id = $1", [listingId, productId, variantId]);
  }

  /* identity */

  async createProduct(p: ProductInput): Promise<CatalogProduct> {
    const rows = await this.q(
      `INSERT INTO catalog_products (category, brand, line, name, size_class, identity_key, attributes)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (identity_key) WHERE status = 'active' AND identity_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [p.category, p.brand, p.line, p.name.slice(0, 300), p.sizeClass, p.identityKey, JSON.stringify(p.attributes ?? {})],
    );
    if (rows[0]) return toProduct(rows[0]);
    const existing = p.identityKey ? await this.findProductByIdentityKey(p.identityKey) : null;
    if (!existing) throw new Error("createProduct: insert returned nothing");
    return existing;
  }

  async getProduct(id: string): Promise<CatalogProduct | null> {
    const [r] = await this.q("SELECT * FROM catalog_products WHERE id = $1", [id]);
    return r ? toProduct(r) : null;
  }

  async findProductByIdentityKey(key: string): Promise<CatalogProduct | null> {
    const [r] = await this.q("SELECT * FROM catalog_products WHERE identity_key = $1 AND status = 'active'", [key]);
    return r ? toProduct(r) : null;
  }

  async candidateProducts(brand: string, sizeClass: string | null): Promise<CatalogProduct[]> {
    const rows = await this.q(
      "SELECT * FROM catalog_products WHERE status = 'active' AND brand = $1 AND size_class IS NOT DISTINCT FROM $2 LIMIT 500",
      [brand, sizeClass],
    );
    return rows.map(toProduct);
  }

  async findProductsByIdentifier(kind: IdentifierKind, value: string, sourceId?: string): Promise<string[]> {
    const rows = await this.q(
      `SELECT DISTINCT i.product_id FROM catalog_identifiers i
       JOIN catalog_products p ON p.id = i.product_id AND p.status = 'active'
       WHERE i.kind = $1 AND i.value = $2 AND i.scope = $3`,
      [kind, value, sourceId ?? ""],
    );
    return rows.map((r) => r.product_id as string);
  }

  async addIdentifier(
    productId: string,
    variantId: string | null,
    kind: IdentifierKind,
    value: string,
    sourceId?: string,
  ): Promise<"added" | "exists" | "conflict"> {
    const ins = await this.q(
      `INSERT INTO catalog_identifiers (product_id, variant_id, kind, value, source_id)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (kind, value, scope) DO NOTHING RETURNING id`,
      [productId, variantId, kind, value, sourceId ?? null],
    );
    if (ins.length) return "added";
    const [r] = await this.q("SELECT product_id FROM catalog_identifiers WHERE kind = $1 AND value = $2 AND scope = $3", [kind, value, sourceId ?? ""]);
    return r?.product_id === productId ? "exists" : "conflict";
  }

  async findOrCreateVariant(
    productId: string,
    colour: string | null,
    colourCode: string | null,
    title: string | null,
    imageUrl: string | null,
  ): Promise<CatalogVariant> {
    const [hit] = await this.q(
      `SELECT * FROM catalog_variants WHERE product_id = $1 AND (
         ($2::text IS NOT NULL AND colour_code = $2) OR
         (($2::text IS NULL OR colour_code IS NULL) AND lower(coalesce(colour, '')) = lower(coalesce($3::text, '')))
       ) LIMIT 1`,
      [productId, colourCode, colour],
    );
    if (hit) return toVariant(hit);
    const [r] = await this.q(
      "INSERT INTO catalog_variants (product_id, colour, colour_code, title, image_url) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [productId, colour, colourCode, title, imageUrl],
    );
    return toVariant(r);
  }

  async enqueueReview(listingId: string, candidateProductId: string | null, score: number, reasons: string[]): Promise<void> {
    await this.q(
      "INSERT INTO identity_review (listing_id, candidate_product_id, score, reasons) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING",
      [listingId, candidateProductId, Math.round(score * 1000) / 1000, JSON.stringify(reasons)],
    );
  }

  async listReviews(status: ReviewItem["status"], limit: number): Promise<ReviewItem[]> {
    const rows = await this.q(
      `SELECT r.*, l.title AS listing_title, l.url AS listing_url, l.source_id, p.name AS candidate_name
       FROM identity_review r
       JOIN listings l ON l.id = r.listing_id
       LEFT JOIN catalog_products p ON p.id = r.candidate_product_id
       WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT $2`,
      [status, limit],
    );
    return rows.map(toReview);
  }

  async decideReview(id: string, decision: "approved" | "rejected", userId: string | null): Promise<ReviewItem | null> {
    const [r] = await this.q(
      `UPDATE identity_review SET status = $2, decided_by = $3, decided_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [id, decision, userId],
    );
    return r ? toReview(r) : null;
  }

  async mergeProducts(fromId: string, intoId: string): Promise<void> {
    if (fromId === intoId) throw new Error("cannot merge a product into itself");
    await this.tx(async (q) => {
      const rows = await q("SELECT id, size_class, status FROM catalog_products WHERE id = ANY($1::uuid[]) FOR UPDATE", [[fromId, intoId]]);
      const from = rows.find((r) => r.id === fromId);
      const into = rows.find((r) => r.id === intoId);
      if (!from || !into) throw new Error("unknown product");
      if (from.status !== "active" || into.status !== "active") throw new Error("both products must be active");
      if ((from.size_class ?? null) !== (into.size_class ?? null)) {
        throw new Error("size classes differ: products of different sizes are never merged");
      }
      await q("UPDATE catalog_variants SET product_id = $2 WHERE product_id = $1", [fromId, intoId]);
      await q("UPDATE catalog_identifiers SET product_id = $2 WHERE product_id = $1", [fromId, intoId]);
      await q("UPDATE listings SET product_id = $2 WHERE product_id = $1", [fromId, intoId]);
      await q("UPDATE identity_review SET candidate_product_id = $2 WHERE candidate_product_id = $1 AND status = 'pending'", [fromId, intoId]);
      await q("UPDATE catalog_products SET status = 'merged', merged_into = $2, identity_key = NULL WHERE id = $1", [fromId, intoId]);
    });
  }

  async splitListing(listingId: string): Promise<CatalogProduct> {
    return this.tx(async (q) => {
      const [l] = await q("SELECT * FROM listings WHERE id = $1 FOR UPDATE", [listingId]);
      if (!l) throw new Error("unknown listing");
      const [old] = l.product_id ? await q("SELECT category, line FROM catalog_products WHERE id = $1", [l.product_id]) : [];
      const [p] = await q(
        "INSERT INTO catalog_products (category, brand, line, name, size_class) VALUES ($1, $2, $3, $4, $5) RETURNING *",
        [old?.category ?? "luggage", l.brand, old?.line ?? null, l.title, l.size_class],
      );
      await q("UPDATE listings SET product_id = $2, variant_id = NULL WHERE id = $1", [listingId, p.id]);
      return toProduct(p);
    });
  }

  /* observations */

  async insertObservation(o: ObservationInput): Promise<Observation> {
    const [r] = await this.q(
      `INSERT INTO observations (listing_id, source_id, adapter, price, list_price, currency, availability, seller, condition,
                                 outcome, confidence, validation, evidence, extractor_version, validator_version, fetched_at, as_of, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        o.listingId,
        o.sourceId,
        o.adapter,
        o.price,
        o.listPrice,
        o.currency,
        o.availability,
        o.seller,
        o.condition,
        o.validation.outcome,
        o.validation.confidence,
        JSON.stringify({ reasons: o.validation.reasons }),
        JSON.stringify(o.evidence),
        o.extractorVersion,
        o.validatorVersion,
        o.fetchedAt,
        o.asOf,
        o.sessionId,
      ],
    );
    return toObservation(r);
  }

  async latestObservation(listingId: string, opts: { shownOnly?: boolean } = {}): Promise<Observation | null> {
    const [r] = await this.q(
      `SELECT * FROM observations WHERE listing_id = $1 AND ($2::boolean IS NOT TRUE OR outcome <> 'rejected')
       ORDER BY fetched_at DESC, id DESC LIMIT 1`,
      [listingId, opts.shownOnly ?? false],
    );
    return r ? toObservation(r) : null;
  }

  async priceRanges(listingId: string, limit: number): Promise<PriceRange[]> {
    const rows = await this.q("SELECT * FROM price_ranges WHERE listing_id = $1 ORDER BY last_seen_at DESC, id DESC LIMIT $2", [listingId, limit]);
    return rows.map((r) => ({
      listingId: r.listing_id,
      price: Number(r.price),
      availability: r.availability,
      firstSeenAt: isoReq(r.first_seen_at),
      lastSeenAt: isoReq(r.last_seen_at),
      observationCount: r.observation_count,
    }));
  }

  /* fetch attempts */

  async insertFetchAttempts(list: FetchAttempt[]): Promise<void> {
    if (list.length === 0) return;
    const cols = 12;
    const values: string[] = [];
    const params: unknown[] = [];
    list.forEach((a, i) => {
      const b = i * cols;
      values.push(`(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(", ")})`);
      params.push(
        a.sourceId,
        a.adapter,
        a.url.slice(0, 2000),
        a.method,
        a.status,
        a.outcome,
        a.durationMs,
        a.bytes,
        a.error?.slice(0, 500) ?? null,
        a.cacheAgeSec,
        a.sessionId,
        a.startedAt,
      );
    });
    await this.q(
      `INSERT INTO fetch_attempts (source_id, adapter, url, method, status, outcome, duration_ms, bytes, error, cache_age_sec, session_id, started_at)
       VALUES ${values.join(", ")}`,
      params,
    );
  }

  /* sessions */

  async createSession(input: SessionInput): Promise<ResearchSessionRecord> {
    const [r] = await this.q(
      `INSERT INTO research_sessions (user_id, query, parent_session_id, store_ids, deadline_ms, mode)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [input.userId, input.query, input.parentSessionId ?? null, input.storeIds ?? null, input.deadlineMs, input.mode],
    );
    return toSession(r);
  }

  async getSession(id: string): Promise<ResearchSessionRecord | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const [r] = await this.q("SELECT * FROM research_sessions WHERE id = $1", [id]);
    return r ? toSession(r) : null;
  }

  async updateSession(id: string, patch: SessionPatch): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown, cast = "") => {
      params.push(v);
      sets.push(`${col} = $${params.length}${cast}`);
    };
    if (patch.status !== undefined) add("status", patch.status);
    if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
    if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt);
    if (patch.answer !== undefined) add("answer", patch.answer === null ? null : JSON.stringify(patch.answer), "::jsonb");
    if (patch.error !== undefined) add("error", patch.error);
    if (sets.length === 0) return;
    await this.q(`UPDATE research_sessions SET ${sets.join(", ")} WHERE id = $1`, params);
  }

  async appendEvent(e: SessionEvent): Promise<void> {
    await this.q(
      "INSERT INTO session_events (session_id, seq, type, source_id, payload, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
      [e.sessionId, e.seq, e.type, e.sourceId, JSON.stringify(e.payload), e.createdAt],
    );
  }

  async listEvents(sessionId: string, afterSeq: number): Promise<SessionEvent[]> {
    const rows = await this.q("SELECT * FROM session_events WHERE session_id = $1 AND seq > $2 ORDER BY seq", [sessionId, afterSeq]);
    return rows.map((r) => ({
      sessionId: r.session_id,
      seq: r.seq,
      type: r.type as SessionEventType,
      sourceId: r.source_id,
      payload: r.payload ?? {},
      createdAt: isoReq(r.created_at),
    }));
  }

  async countSessionsSince(userId: string, sinceIso: string): Promise<number> {
    const [r] = await this.q("SELECT count(*)::int AS n FROM research_sessions WHERE user_id = $1 AND created_at >= $2", [userId, sinceIso]);
    return r?.n ?? 0;
  }

  async countActiveSessions(userId: string): Promise<number> {
    // A session stuck in queued/running for over a minute has died; it no longer counts.
    const [r] = await this.q(
      `SELECT count(*)::int AS n FROM research_sessions
       WHERE user_id = $1 AND status IN ('queued', 'running') AND created_at > now() - interval '60 seconds'`,
      [userId],
    );
    return r?.n ?? 0;
  }

  /* feeds */

  async recordFeedImport(f: FeedImportInput): Promise<string> {
    const [r] = await this.q(
      `INSERT INTO feed_imports (source_id, name, format, as_of, row_count, accepted, rejected, imported_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [f.sourceId, f.name, f.format, f.asOf, f.rowCount, f.accepted, f.rejected, f.importedBy],
    );
    return r.id as string;
  }

  /* admin */

  async sourceHealthStats(): Promise<SourceHealthStat[]> {
    const rows = await this.q("SELECT * FROM source_health ORDER BY source_id");
    return rows.map((r) => ({
      sourceId: r.source_id,
      retailerLabel: r.retailer_label,
      liveClass: r.live_class,
      permission: r.permission,
      circuit: r.circuit_state,
      circuitReason: r.circuit_reason,
      attempts24h: Number(r.attempts_24h),
      ok24h: Number(r.ok_24h),
      blocked24h: Number(r.blocked_24h),
      attempts7d: Number(r.attempts_7d),
      ok7d: Number(r.ok_7d),
      blocked7d: Number(r.blocked_7d),
      lastOkAt: iso(r.last_ok_at),
      lastBlockAt: iso(r.last_block_at),
    }));
  }

  async recentFailures(limit: number): Promise<FailureRow[]> {
    const rows = await this.q(
      "SELECT source_id, adapter, url, status, outcome, error, started_at FROM fetch_attempts WHERE outcome <> 'ok' ORDER BY started_at DESC LIMIT $1",
      [limit],
    );
    return rows.map((r) => ({
      sourceId: r.source_id,
      adapter: r.adapter,
      url: r.url,
      status: r.status,
      outcome: r.outcome,
      error: r.error,
      startedAt: isoReq(r.started_at),
    }));
  }

  async recentRejections(limit: number): Promise<RejectionRow[]> {
    const rows = await this.q(
      "SELECT source_id, listing_id, adapter, validation, fetched_at FROM observations WHERE outcome = 'rejected' ORDER BY fetched_at DESC LIMIT $1",
      [limit],
    );
    return rows.map((r) => ({
      sourceId: r.source_id,
      listingId: r.listing_id,
      adapter: r.adapter,
      reasons: (r.validation?.reasons ?? []) as string[],
      fetchedAt: isoReq(r.fetched_at),
    }));
  }

  async sessionTimings(limit: number): Promise<SessionTiming[]> {
    const rows = await this.q(
      `SELECT id, query, status, mode, created_at,
              (answer->>'firstPriceMs')::int AS first_price_ms,
              (answer->>'totalMs')::int AS total_ms,
              (answer->>'deadlineHit')::boolean AS deadline_hit,
              COALESCE((SELECT sum(jsonb_array_length(p->'offers')) FROM jsonb_array_elements(answer->'products') p), 0)::int AS offers
       FROM research_sessions ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      status: r.status,
      mode: r.mode,
      createdAt: isoReq(r.created_at),
      firstPriceMs: r.first_price_ms,
      totalMs: r.total_ms,
      deadlineHit: r.deadline_hit,
      offers: r.offers,
    }));
  }

  async isAdmin(userId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
    const rows = await this.q("SELECT 1 FROM app_admins WHERE user_id = $1", [userId]);
    return rows.length > 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
