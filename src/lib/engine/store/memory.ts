/* ------------------------------------------------------------------ */
/*  In-memory EngineStore                                             */
/*                                                                     */
/*  For tests and for local development without a database. Behaves    */
/*  like PgEngineStore (same contract tests); nothing persists past    */
/*  the process.                                                       */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import type {
  FetchAttempt,
  IdentifierKind,
  ListingInput,
  ListingRecord,
  Observation,
  ObservationInput,
  ParsedQuery,
  ResearchSessionRecord,
  SessionEvent,
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
import { haystackFor, matchScore } from "./terms";

const now = () => new Date().toISOString();
const BLOCKED = new Set(["blocked", "challenge", "rate_limited"]);

type IdentifierRow = { productId: string; variantId: string | null; kind: IdentifierKind; value: string; scope: string };
type RangeRow = PriceRange & { id: number };

export class MemoryEngineStore implements EngineStore {
  readonly kind = "memory" as const;

  private sources = new Map<string, SourceRecord>();
  private health = new Map<string, SourceHealth>();
  private flags = new Map<string, FlagRow>();
  private listings = new Map<string, ListingRecord>();
  private products = new Map<string, CatalogProduct>();
  private variants = new Map<string, CatalogVariant>();
  private identifiers: IdentifierRow[] = [];
  private reviews = new Map<string, ReviewItem>();
  private observations: Observation[] = [];
  private ranges: RangeRow[] = [];
  private attempts: FetchAttempt[] = [];
  private sessions = new Map<string, ResearchSessionRecord & { mode: string }>();
  private events = new Map<string, SessionEvent[]>();
  private admins = new Set<string>();
  private obsSeq = 0;
  private rangeSeq = 0;

  constructor(seed: SourceRecord[] = []) {
    for (const s of seed) this.sources.set(s.id, structuredClone(s));
  }

  /** Test helper: make a user an admin. */
  grantAdmin(userId: string): void {
    this.admins.add(userId);
  }

  /* ── registry ───────────────────────────────────────────────────── */

  async listSources(): Promise<SourceRecord[]> {
    return [...this.sources.values()].map((s) => structuredClone(s));
  }

  async upsertSources(sources: SourceRecord[]): Promise<void> {
    for (const s of sources) {
      const prev = this.sources.get(s.id);
      this.sources.set(s.id, { ...structuredClone(s), enabled: prev ? prev.enabled : s.enabled });
    }
  }

  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    const s = this.sources.get(id);
    if (s) s.enabled = enabled;
  }

  async getHealth(sourceId: string): Promise<SourceHealth> {
    return (
      this.health.get(sourceId) ?? { sourceId, circuit: "closed", circuitOpenedAt: null, circuitReason: null, consecutiveFailures: 0 }
    );
  }

  async saveHealth(h: SourceHealth): Promise<void> {
    this.health.set(h.sourceId, { ...h });
  }

  async sourcesWithAdapter(adapter: "feed_import" | "manual_entry"): Promise<Set<string>> {
    return new Set(this.observations.filter((o) => o.adapter === adapter && o.validation.outcome !== "rejected").map((o) => o.sourceId));
  }

  /* ── flags ──────────────────────────────────────────────────────── */

  async listFlagRows(): Promise<FlagRow[]> {
    return [...this.flags.values()];
  }

  async setFlag(key: string, enabled: boolean): Promise<void> {
    const prev = this.flags.get(key);
    this.flags.set(key, { key, enabled, description: prev?.description ?? null, updatedAt: now() });
  }

  /* ── listings ───────────────────────────────────────────────────── */

  async upsertListing(input: ListingInput): Promise<ListingRecord> {
    const existing = [...this.listings.values()].find((l) => l.sourceId === input.sourceId && l.url === input.url);
    const t = now();
    if (existing) {
      const next: ListingRecord = {
        ...existing,
        ...input,
        // Same rules as the Postgres upsert: links only change via linkListing,
        // and a thinner re-read never erases what we already knew.
        productId: input.productId ?? existing.productId,
        variantId: input.variantId ?? existing.variantId,
        externalId: input.externalId ?? existing.externalId,
        brand: input.brand ?? existing.brand,
        sizeClass: input.sizeClass ?? existing.sizeClass,
        colour: input.colour ?? existing.colour,
        lastmod: input.lastmod ?? existing.lastmod,
        discoveredVia: existing.discoveredVia,
        identifiers: input.identifiers.length ? input.identifiers : existing.identifiers,
        imageUrl: input.imageUrl ?? existing.imageUrl,
        firstSeenAt: existing.firstSeenAt,
        lastSeenAt: t,
      };
      this.listings.set(existing.id, next);
      return structuredClone(next);
    }
    const rec: ListingRecord = {
      ...input,
      id: randomUUID(),
      productId: input.productId ?? null,
      variantId: input.variantId ?? null,
      firstSeenAt: t,
      lastSeenAt: t,
    };
    this.listings.set(rec.id, rec);
    return structuredClone(rec);
  }

  async getListing(id: string): Promise<ListingRecord | null> {
    const l = this.listings.get(id);
    return l ? structuredClone(l) : null;
  }

  async findListingByUrl(sourceId: string, url: string): Promise<ListingRecord | null> {
    const l = [...this.listings.values()].find((x) => x.sourceId === sourceId && x.url === url);
    return l ? structuredClone(l) : null;
  }

  async searchListings(q: ParsedQuery, opts: { limit: number; sourceIds?: string[] }): Promise<ListingRecord[]> {
    const scored: { l: ListingRecord; score: number }[] = [];
    for (const l of this.listings.values()) {
      if (!l.active) continue;
      if (opts.sourceIds && !opts.sourceIds.includes(l.sourceId)) continue;
      const score = matchScore(q, haystackFor(l), l.sizeClass);
      if (score > 0) scored.push({ l, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.l.title.localeCompare(b.l.title))
      .slice(0, opts.limit)
      .map((x) => structuredClone(x.l));
  }

  async listingsForProduct(productId: string): Promise<ListingRecord[]> {
    return [...this.listings.values()].filter((l) => l.productId === productId && l.active).map((l) => structuredClone(l));
  }

  async listingsBySource(sourceId: string, limit: number): Promise<ListingRecord[]> {
    return [...this.listings.values()]
      .filter((l) => l.sourceId === sourceId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
      .slice(0, limit)
      .map((l) => structuredClone(l));
  }

  async countListingsBySource(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const l of this.listings.values()) if (l.active) out[l.sourceId] = (out[l.sourceId] ?? 0) + 1;
    return out;
  }

  async linkListing(listingId: string, productId: string | null, variantId: string | null): Promise<void> {
    const l = this.listings.get(listingId);
    if (l) {
      l.productId = productId;
      l.variantId = variantId;
    }
  }

  /* ── identity ───────────────────────────────────────────────────── */

  async createProduct(p: ProductInput): Promise<CatalogProduct> {
    if (p.identityKey) {
      const clash = await this.findProductByIdentityKey(p.identityKey);
      if (clash) return clash;
    }
    const rec: CatalogProduct = {
      id: randomUUID(),
      category: p.category,
      brand: p.brand,
      line: p.line,
      name: p.name,
      sizeClass: p.sizeClass,
      identityKey: p.identityKey,
      status: "active",
      mergedInto: null,
      attributes: p.attributes ?? {},
      createdAt: now(),
    };
    this.products.set(rec.id, rec);
    return { ...rec };
  }

  async getProduct(id: string): Promise<CatalogProduct | null> {
    const p = this.products.get(id);
    return p ? { ...p } : null;
  }

  async findProductByIdentityKey(key: string): Promise<CatalogProduct | null> {
    const p = [...this.products.values()].find((x) => x.status === "active" && x.identityKey === key);
    return p ? { ...p } : null;
  }

  async candidateProducts(brand: string, sizeClass: string | null): Promise<CatalogProduct[]> {
    return [...this.products.values()]
      .filter((p) => p.status === "active" && p.brand === brand && p.sizeClass === sizeClass)
      .map((p) => ({ ...p }));
  }

  async findProductsByIdentifier(kind: IdentifierKind, value: string, sourceId?: string): Promise<string[]> {
    const scope = sourceId ?? "";
    const ids = this.identifiers.filter((i) => i.kind === kind && i.value === value && i.scope === scope).map((i) => i.productId);
    return [...new Set(ids)].filter((id) => this.products.get(id)?.status === "active");
  }

  async addIdentifier(
    productId: string,
    variantId: string | null,
    kind: IdentifierKind,
    value: string,
    sourceId?: string,
  ): Promise<"added" | "exists" | "conflict"> {
    const scope = sourceId ?? "";
    const hit = this.identifiers.find((i) => i.kind === kind && i.value === value && i.scope === scope);
    if (hit) return hit.productId === productId ? "exists" : "conflict";
    this.identifiers.push({ productId, variantId, kind, value, scope });
    return "added";
  }

  async findOrCreateVariant(
    productId: string,
    colour: string | null,
    colourCode: string | null,
    title: string | null,
    imageUrl: string | null,
  ): Promise<CatalogVariant> {
    const key = (v: CatalogVariant) => (colourCode && v.colourCode ? v.colourCode === colourCode : (v.colour ?? "").toLowerCase() === (colour ?? "").toLowerCase());
    const hit = [...this.variants.values()].find((v) => v.productId === productId && key(v));
    if (hit) return { ...hit };
    const rec: CatalogVariant = { id: randomUUID(), productId, colour, colourCode, title, imageUrl };
    this.variants.set(rec.id, rec);
    return { ...rec };
  }

  async enqueueReview(listingId: string, candidateProductId: string | null, score: number, reasons: string[]): Promise<void> {
    const dup = [...this.reviews.values()].find(
      (r) => r.listingId === listingId && r.candidateProductId === candidateProductId && r.status === "pending",
    );
    if (dup) return;
    const l = this.listings.get(listingId);
    const c = candidateProductId ? this.products.get(candidateProductId) : null;
    const rec: ReviewItem = {
      id: randomUUID(),
      listingId,
      listingTitle: l?.title ?? "",
      listingUrl: l?.url ?? "",
      sourceId: l?.sourceId ?? "",
      candidateProductId,
      candidateName: c?.name ?? null,
      score,
      reasons,
      status: "pending",
      createdAt: now(),
    };
    this.reviews.set(rec.id, rec);
  }

  async listReviews(status: ReviewItem["status"], limit: number): Promise<ReviewItem[]> {
    return [...this.reviews.values()].filter((r) => r.status === status).slice(0, limit).map((r) => ({ ...r }));
  }

  async decideReview(id: string, decision: "approved" | "rejected"): Promise<ReviewItem | null> {
    const r = this.reviews.get(id);
    if (!r || r.status !== "pending") return null;
    r.status = decision;
    return { ...r };
  }

  async mergeProducts(fromId: string, intoId: string): Promise<void> {
    if (fromId === intoId) throw new Error("cannot merge a product into itself");
    const from = this.products.get(fromId);
    const into = this.products.get(intoId);
    if (!from || !into) throw new Error("unknown product");
    if (from.sizeClass !== into.sizeClass) throw new Error("size classes differ: products of different sizes are never merged");
    for (const v of this.variants.values()) if (v.productId === fromId) v.productId = intoId;
    for (const i of this.identifiers) if (i.productId === fromId) i.productId = intoId;
    for (const l of this.listings.values()) if (l.productId === fromId) l.productId = intoId;
    from.status = "merged";
    from.mergedInto = intoId;
    from.identityKey = null;
  }

  async splitListing(listingId: string): Promise<CatalogProduct> {
    const l = this.listings.get(listingId);
    if (!l) throw new Error("unknown listing");
    const old = l.productId ? this.products.get(l.productId) : null;
    const p = await this.createProduct({
      category: old?.category ?? "luggage",
      brand: l.brand,
      line: old?.line ?? null,
      name: l.title,
      sizeClass: l.sizeClass,
      identityKey: null,
    });
    l.productId = p.id;
    l.variantId = null;
    return p;
  }

  /* ── observations ───────────────────────────────────────────────── */

  async insertObservation(o: ObservationInput): Promise<Observation> {
    // Same mapping as Postgres: a rejected reading without a price reads back as 0.
    const rec: Observation = { ...structuredClone(o), price: o.price ?? 0, id: String(++this.obsSeq) };
    this.observations.push(rec);
    if (rec.validation.outcome !== "rejected") this.collapse(rec);
    return structuredClone(rec);
  }

  private collapse(o: Observation): void {
    const latest = this.ranges
      .filter((r) => r.listingId === o.listingId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.id - a.id)[0];
    if (latest && o.fetchedAt < latest.lastSeenAt) return;
    if (latest && latest.price === o.price && latest.availability === o.availability) {
      latest.lastSeenAt = o.fetchedAt;
      latest.observationCount += 1;
      return;
    }
    this.ranges.push({
      id: ++this.rangeSeq,
      listingId: o.listingId,
      price: o.price,
      availability: o.availability,
      firstSeenAt: o.fetchedAt,
      lastSeenAt: o.fetchedAt,
      observationCount: 1,
    });
  }

  async latestObservation(listingId: string, opts: { shownOnly?: boolean } = {}): Promise<Observation | null> {
    const list = this.observations
      .filter((o) => o.listingId === listingId && (!opts.shownOnly || o.validation.outcome !== "rejected"))
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || Number(b.id) - Number(a.id));
    return list[0] ? structuredClone(list[0]) : null;
  }

  async priceRanges(listingId: string, limit: number): Promise<PriceRange[]> {
    return this.ranges
      .filter((r) => r.listingId === listingId)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || b.id - a.id)
      .slice(0, limit)
      .map((r) => ({
        listingId: r.listingId,
        price: r.price,
        availability: r.availability,
        firstSeenAt: r.firstSeenAt,
        lastSeenAt: r.lastSeenAt,
        observationCount: r.observationCount,
      }));
  }

  /* ── fetch attempts ─────────────────────────────────────────────── */

  async insertFetchAttempts(a: FetchAttempt[]): Promise<void> {
    this.attempts.push(...a.map((x) => ({ ...x })));
  }

  /** Test helper. */
  allAttempts(): FetchAttempt[] {
    return this.attempts.map((a) => ({ ...a }));
  }

  /* ── sessions ───────────────────────────────────────────────────── */

  async createSession(input: SessionInput): Promise<ResearchSessionRecord> {
    const rec = {
      id: randomUUID(),
      userId: input.userId,
      query: input.query,
      status: "queued" as const,
      parentSessionId: input.parentSessionId ?? null,
      storeIds: input.storeIds ?? null,
      deadlineMs: input.deadlineMs,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      answer: null,
      error: null,
      mode: input.mode,
    };
    this.sessions.set(rec.id, rec);
    this.events.set(rec.id, []);
    const { mode: _mode, ...out } = rec;
    void _mode;
    return structuredClone(out);
  }

  async getSession(id: string): Promise<ResearchSessionRecord | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    const { mode: _mode, ...out } = s;
    void _mode;
    return structuredClone(out);
  }

  async updateSession(id: string, patch: SessionPatch): Promise<void> {
    const s = this.sessions.get(id);
    if (s) Object.assign(s, structuredClone(patch));
  }

  async appendEvent(e: SessionEvent): Promise<void> {
    const list = this.events.get(e.sessionId);
    if (!list) throw new Error("unknown session");
    if (list.some((x) => x.seq === e.seq)) throw new Error(`duplicate event seq ${e.seq}`);
    list.push(structuredClone(e));
  }

  async listEvents(sessionId: string, afterSeq: number): Promise<SessionEvent[]> {
    return (this.events.get(sessionId) ?? []).filter((e) => e.seq > afterSeq).sort((a, b) => a.seq - b.seq).map((e) => structuredClone(e));
  }

  async countSessionsSince(userId: string, sinceIso: string): Promise<number> {
    return [...this.sessions.values()].filter((s) => s.userId === userId && s.createdAt >= sinceIso).length;
  }

  async countActiveSessions(userId: string): Promise<number> {
    return [...this.sessions.values()].filter((s) => s.userId === userId && (s.status === "queued" || s.status === "running")).length;
  }

  /* ── feeds ──────────────────────────────────────────────────────── */

  private feedImports: (FeedImportInput & { id: string })[] = [];

  async recordFeedImport(f: FeedImportInput): Promise<string> {
    const id = randomUUID();
    this.feedImports.push({ ...f, id });
    return id;
  }

  /* ── admin ──────────────────────────────────────────────────────── */

  async sourceHealthStats(): Promise<SourceHealthStat[]> {
    const day = Date.now() - 86_400_000;
    const week = Date.now() - 7 * 86_400_000;
    return [...this.sources.values()].map((s) => {
      const mine = this.attempts.filter((a) => a.sourceId === s.id);
      const in24 = mine.filter((a) => Date.parse(a.startedAt) > day);
      const in7 = mine.filter((a) => Date.parse(a.startedAt) > week);
      const h = this.health.get(s.id);
      const lastOk = mine.filter((a) => a.outcome === "ok").map((a) => a.startedAt).sort().pop() ?? null;
      const lastBlock = mine.filter((a) => BLOCKED.has(a.outcome)).map((a) => a.startedAt).sort().pop() ?? null;
      return {
        sourceId: s.id,
        retailerLabel: s.retailerLabel,
        liveClass: s.liveClass,
        permission: s.permission,
        circuit: h?.circuit ?? "closed",
        circuitReason: h?.circuitReason ?? null,
        attempts24h: in24.length,
        ok24h: in24.filter((a) => a.outcome === "ok").length,
        blocked24h: in24.filter((a) => BLOCKED.has(a.outcome)).length,
        attempts7d: in7.length,
        ok7d: in7.filter((a) => a.outcome === "ok").length,
        blocked7d: in7.filter((a) => BLOCKED.has(a.outcome)).length,
        lastOkAt: lastOk,
        lastBlockAt: lastBlock,
      };
    });
  }

  async recentFailures(limit: number): Promise<FailureRow[]> {
    return this.attempts
      .filter((a) => a.outcome !== "ok")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map((a) => ({ sourceId: a.sourceId, adapter: a.adapter, url: a.url, status: a.status, outcome: a.outcome, error: a.error, startedAt: a.startedAt }));
  }

  async recentRejections(limit: number): Promise<RejectionRow[]> {
    return this.observations
      .filter((o) => o.validation.outcome === "rejected")
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt))
      .slice(0, limit)
      .map((o) => ({ sourceId: o.sourceId, listingId: o.listingId, adapter: o.adapter, reasons: o.validation.reasons, fetchedAt: o.fetchedAt }));
  }

  async sessionTimings(limit: number): Promise<SessionTiming[]> {
    return [...this.sessions.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((s) => ({
        id: s.id,
        query: s.query,
        status: s.status,
        mode: s.mode,
        createdAt: s.createdAt,
        firstPriceMs: s.answer?.firstPriceMs ?? null,
        totalMs: s.answer?.totalMs ?? null,
        deadlineHit: s.answer?.deadlineHit ?? null,
        offers: s.answer ? s.answer.products.reduce((n, p) => n + p.offers.length, 0) : 0,
      }));
  }

  async isAdmin(userId: string): Promise<boolean> {
    return this.admins.has(userId);
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
