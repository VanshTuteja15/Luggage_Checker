/* ------------------------------------------------------------------ */
/*  Engine persistence port                                           */
/*                                                                     */
/*  The database is the engine's memory: identity, known URLs,         */
/*  history, source intelligence. Two implementations:                 */
/*    • PgEngineStore    — Postgres (Supabase in production, Docker in  */
/*                         tests); used by the worker and the server   */
/*    • MemoryEngineStore — tests and local development without a DB   */
/*  Both must behave identically; tests/engine/store.test.ts runs the  */
/*  same contract against each.                                        */
/* ------------------------------------------------------------------ */

import type {
  CircuitState,
  FetchAttempt,
  IdentifierKind,
  ListingInput,
  ListingRecord,
  Observation,
  ObservationInput,
  ParsedQuery,
  ResearchSessionRecord,
  SessionEvent,
  SessionStatus,
  SourceHealth,
  SourceRecord,
} from "../types";

export type CatalogProduct = {
  id: string;
  category: string;
  brand: string | null;
  line: string | null;
  name: string;
  sizeClass: string | null;
  identityKey: string | null;
  status: "active" | "merged";
  mergedInto: string | null;
  attributes: Record<string, unknown>;
  createdAt: string;
};

export type CatalogVariant = {
  id: string;
  productId: string;
  colour: string | null;
  colourCode: string | null;
  title: string | null;
  imageUrl: string | null;
};

export type ProductInput = {
  category: string;
  brand: string | null;
  line: string | null;
  name: string;
  sizeClass: string | null;
  identityKey: string | null;
  attributes?: Record<string, unknown>;
};

export type ReviewItem = {
  id: string;
  listingId: string;
  listingTitle: string;
  listingUrl: string;
  sourceId: string;
  candidateProductId: string | null;
  candidateName: string | null;
  score: number | null;
  reasons: string[];
  status: "pending" | "approved" | "rejected" | "superseded";
  createdAt: string;
};

export type PriceRange = {
  listingId: string;
  price: number;
  availability: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
};

export type FlagRow = { key: string; enabled: boolean; description: string | null; updatedAt: string };

export type SessionInput = {
  userId: string;
  query: string;
  parentSessionId?: string | null;
  storeIds?: string[] | null;
  deadlineMs: number;
  mode: "worker" | "inline" | "cron" | "shadow";
};

export type SessionPatch = Partial<Pick<ResearchSessionRecord, "status" | "startedAt" | "finishedAt" | "answer" | "error">>;

export type SourceHealthStat = {
  sourceId: string;
  retailerLabel: string;
  liveClass: string;
  permission: string;
  circuit: CircuitState;
  circuitReason: string | null;
  attempts24h: number;
  ok24h: number;
  blocked24h: number;
  attempts7d: number;
  ok7d: number;
  blocked7d: number;
  lastOkAt: string | null;
  lastBlockAt: string | null;
};

export type FailureRow = {
  sourceId: string | null;
  adapter: string;
  url: string;
  status: number | null;
  outcome: string;
  error: string | null;
  startedAt: string;
};

export type RejectionRow = {
  sourceId: string;
  listingId: string;
  adapter: string;
  reasons: string[];
  fetchedAt: string;
};

export type SessionTiming = {
  id: string;
  query: string;
  status: SessionStatus;
  mode: string;
  createdAt: string;
  firstPriceMs: number | null;
  totalMs: number | null;
  deadlineHit: boolean | null;
  offers: number;
};

export type FeedImportInput = {
  sourceId: string;
  name: string;
  format: "csv" | "json";
  asOf: string;
  rowCount: number;
  accepted: number;
  rejected: number;
  importedBy: string | null;
};

export interface EngineStore {
  readonly kind: "memory" | "postgres";

  /* registry */
  listSources(): Promise<SourceRecord[]>;
  upsertSources(sources: SourceRecord[]): Promise<void>;
  setSourceEnabled(id: string, enabled: boolean): Promise<void>;
  getHealth(sourceId: string): Promise<SourceHealth>;
  saveHealth(h: SourceHealth): Promise<void>;
  /** Source ids that have feed / manual observations on file. */
  sourcesWithAdapter(adapter: "feed_import" | "manual_entry"): Promise<Set<string>>;

  /* flags */
  listFlagRows(): Promise<FlagRow[]>;
  setFlag(key: string, enabled: boolean, userId: string | null): Promise<void>;

  /* listings */
  upsertListing(input: ListingInput): Promise<ListingRecord>;
  getListing(id: string): Promise<ListingRecord | null>;
  findListingByUrl(sourceId: string, url: string): Promise<ListingRecord | null>;
  /** Full-text search over the listings index. Zero external requests. */
  searchListings(q: ParsedQuery, opts: { limit: number; sourceIds?: string[] }): Promise<ListingRecord[]>;
  listingsForProduct(productId: string): Promise<ListingRecord[]>;
  listingsBySource(sourceId: string, limit: number): Promise<ListingRecord[]>;
  countListingsBySource(): Promise<Record<string, number>>;
  linkListing(listingId: string, productId: string | null, variantId: string | null): Promise<void>;

  /* identity */
  createProduct(p: ProductInput): Promise<CatalogProduct>;
  getProduct(id: string): Promise<CatalogProduct | null>;
  findProductByIdentityKey(key: string): Promise<CatalogProduct | null>;
  /** Active products of one brand + size class (candidates for line matching). */
  candidateProducts(brand: string, sizeClass: string | null): Promise<CatalogProduct[]>;
  findProductsByIdentifier(kind: IdentifierKind, value: string, sourceId?: string): Promise<string[]>;
  addIdentifier(productId: string, variantId: string | null, kind: IdentifierKind, value: string, sourceId?: string): Promise<"added" | "exists" | "conflict">;
  findOrCreateVariant(productId: string, colour: string | null, colourCode: string | null, title: string | null, imageUrl: string | null): Promise<CatalogVariant>;
  enqueueReview(listingId: string, candidateProductId: string | null, score: number, reasons: string[]): Promise<void>;
  listReviews(status: ReviewItem["status"], limit: number): Promise<ReviewItem[]>;
  decideReview(id: string, decision: "approved" | "rejected", userId: string | null): Promise<ReviewItem | null>;
  /** Move everything of `fromId` onto `intoId` and retire `fromId`. */
  mergeProducts(fromId: string, intoId: string): Promise<void>;
  /** Detach a listing from its product into a new product of its own. */
  splitListing(listingId: string): Promise<CatalogProduct>;

  /* observations */
  insertObservation(o: ObservationInput): Promise<Observation>;
  latestObservation(listingId: string, opts?: { shownOnly?: boolean }): Promise<Observation | null>;
  priceRanges(listingId: string, limit: number): Promise<PriceRange[]>;

  /* fetch attempts */
  insertFetchAttempts(a: FetchAttempt[]): Promise<void>;

  /* research sessions */
  createSession(input: SessionInput): Promise<ResearchSessionRecord>;
  getSession(id: string): Promise<ResearchSessionRecord | null>;
  updateSession(id: string, patch: SessionPatch): Promise<void>;
  appendEvent(e: SessionEvent): Promise<void>;
  listEvents(sessionId: string, afterSeq: number): Promise<SessionEvent[]>;
  countSessionsSince(userId: string, sinceIso: string): Promise<number>;
  countActiveSessions(userId: string): Promise<number>;

  /* feeds */
  recordFeedImport(f: FeedImportInput): Promise<string>;

  /* admin / observability */
  sourceHealthStats(): Promise<SourceHealthStat[]>;
  recentFailures(limit: number): Promise<FailureRow[]>;
  recentRejections(limit: number): Promise<RejectionRow[]>;
  sessionTimings(limit: number): Promise<SessionTiming[]>;
  isAdmin(userId: string): Promise<boolean>;

  close(): Promise<void>;
}

export const EXTRACTOR_VERSION = "engine-extract/1";
export const VALIDATOR_VERSION = "engine-validate/1";
