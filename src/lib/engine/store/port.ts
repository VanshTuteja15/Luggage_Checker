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

import type { VocabularyRow } from "../query/vocabulary";
import type {
  Availability,
  CircuitState,
  FetchAttempt,
  IdentifierKind,
  ListingInput,
  ListingRecord,
  Observation,
  ObservationInput,
  ParsedQuery,
  PriceMethod,
  ResearchSessionRecord,
  SessionEvent,
  SessionStatus,
  SourceHealth,
  SourceRecord,
} from "../types";

export type { VocabularyRow };

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

export type PricedProductFilter = {
  brand?: string | null;
  /** The catalogue product's line, exactly as stored. */
  line?: string | null;
  sizeClass?: string | null;
  /** Only prices strictly below this. */
  below?: number | null;
  excludeProductIds?: string[];
  /** Live readings older than this don't count (staff/dealer prices always do). */
  sinceIso: string;
  limit: number;
};

/** One product's lowest current price from the index (v5 F2.5 suggestions). */
export type PricedProduct = {
  productId: string;
  name: string;
  brand: string | null;
  line: string | null;
  sizeClass: string | null;
  /** The listing that holds the price. */
  title: string;
  url: string;
  sourceId: string;
  price: number;
  adapter: PriceMethod;
  /** When the price was last confirmed (reading or its event-storage range). */
  seenAt: string;
  asOf: string | null;
  availability: Availability;
};

export type CatalogVariant = {
  id: string;
  productId: string;
  colour: string | null;
  colourCode: string | null;
  title: string | null;
  imageUrl: string | null;
  /** v4 A4.1: field → StoredAttribute (`extract/attributes.ts`). */
  attributes: Record<string, unknown>;
};

/** v4 A4.2: a promotion the store itself states for one listing. Never a price source. */
export type PromotionInput = {
  kind: "percent_off" | "amount_off" | "sale_price" | "free_shipping" | "gift" | "code";
  /** Where the store stated it: Shopify compare-at, JSON-LD strikethrough, or offer text. */
  method: "compare_at" | "jsonld" | "page_text";
  percentOff: number | null;
  upTo: boolean;
  amountOff: number | null;
  salePrice: number | null;
  wasPrice: number | null;
  threshold: number | null;
  code: string | null;
  /** The end date exactly as the store wrote it, and our (approximate) reading of it. */
  endsText: string | null;
  endsAt: string | null;
  /** The exact field or text each value came from. */
  evidence: string[];
};

export type PromotionRecord = PromotionInput & {
  id: string;
  listingId: string;
  sourceId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationId: string | null;
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

export type ObservationWithPrevious = Observation & {
  previousPrice: number | null;
  previousAvailability: string | null;
};

export type PriceRange = {
  listingId: string;
  price: number;
  availability: string;
  firstSeenAt: string;
  lastSeenAt: string;
  observationCount: number;
};

export type FlagRow = {
  key: string;
  enabled: boolean;
  description: string | null;
  updatedAt: string;
};

export type SessionInput = {
  userId: string;
  query: string;
  parentSessionId?: string | null;
  storeIds?: string[] | null;
  deadlineMs: number;
  mode: "worker" | "inline" | "cron" | "shadow";
};

export type SessionPatch = Partial<
  Pick<ResearchSessionRecord, "status" | "startedAt" | "finishedAt" | "answer" | "error">
>;

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
  /**
   * v4 A6: insert or update a candidate store row (`discovery` set). Never
   * touches a curated store: false when `rec.id` belongs to one.
   */
  saveCandidate(rec: SourceRecord): Promise<boolean>;
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
  searchListings(
    q: ParsedQuery,
    opts: { limit: number; sourceIds?: string[] },
  ): Promise<ListingRecord[]>;
  listingsForProduct(productId: string): Promise<ListingRecord[]>;
  listingsBySource(sourceId: string, limit: number): Promise<ListingRecord[]>;
  countListingsBySource(): Promise<Record<string, number>>;
  /** v5 F2.2: brand + line families with active listing counts (the search vocabulary). */
  vocabularyRows(): Promise<VocabularyRow[]>;
  /**
   * v5 F2.5: each matching catalogue product's lowest current price we stand
   * behind (latest shown reading per active listing; live readings since
   * `sinceIso`, staff-checked and dealer prices any time; never estimates),
   * cheapest first. Index only: no store is contacted.
   */
  pricedProducts(filter: PricedProductFilter): Promise<PricedProduct[]>;
  /**
   * v5 F2.5 autocomplete: searches people ran at least twice since `sinceIso`
   * that start with (or, with pg_trgm installed, closely resemble) `prefix`.
   */
  popularQueries(
    prefix: string,
    opts: { sinceIso: string; limit: number },
  ): Promise<{ query: string; count: number }[]>;
  linkListing(listingId: string, productId: string | null, variantId: string | null): Promise<void>;

  /* identity */
  createProduct(p: ProductInput): Promise<CatalogProduct>;
  getProduct(id: string): Promise<CatalogProduct | null>;
  findProductByIdentityKey(key: string): Promise<CatalogProduct | null>;
  /** Active products of one brand + size class (candidates for line matching). */
  candidateProducts(brand: string, sizeClass: string | null): Promise<CatalogProduct[]>;
  findProductsByIdentifier(
    kind: IdentifierKind,
    value: string,
    sourceId?: string,
  ): Promise<string[]>;
  addIdentifier(
    productId: string,
    variantId: string | null,
    kind: IdentifierKind,
    value: string,
    sourceId?: string,
  ): Promise<"added" | "exists" | "conflict">;
  findOrCreateVariant(
    productId: string,
    colour: string | null,
    colourCode: string | null,
    title: string | null,
    imageUrl: string | null,
  ): Promise<CatalogVariant>;
  variantsForProduct(productId: string): Promise<CatalogVariant[]>;
  /**
   * v4 A4.1: merge evidence-backed attributes into a variant (rules in
   * `mergeAttributes`). false = nothing changed, nothing written.
   */
  mergeVariantAttributes(variantId: string, attrs: Record<string, unknown>): Promise<boolean>;
  enqueueReview(
    listingId: string,
    candidateProductId: string | null,
    score: number,
    reasons: string[],
  ): Promise<void>;
  listReviews(status: ReviewItem["status"], limit: number): Promise<ReviewItem[]>;
  decideReview(
    id: string,
    decision: "approved" | "rejected",
    userId: string | null,
  ): Promise<ReviewItem | null>;
  /**
   * v4 A5.3: retire a pending review the current rules no longer send to a
   * person (status `superseded`, `note` appended to its reasons). Nothing is
   * merged or deleted; false = it wasn't pending.
   */
  supersedeReview(id: string, note: string): Promise<boolean>;
  /** Move everything of `fromId` onto `intoId` and retire `fromId`. */
  mergeProducts(fromId: string, intoId: string): Promise<void>;
  /** Detach a listing from its product into a new product of its own. */
  splitListing(listingId: string): Promise<CatalogProduct>;

  /* observations */
  insertObservation(o: ObservationInput): Promise<Observation>;
  latestObservation(listingId: string, opts?: { shownOnly?: boolean }): Promise<Observation | null>;
  /** The latest shown (not rejected) reading of each listing, in one query. */
  latestObservations(listingIds: string[]): Promise<Observation[]>;
  priceRanges(listingId: string, limit: number): Promise<PriceRange[]>;
  /**
   * Event storage (v4 A3.4): when a reading repeats the latest price range
   * (same price and stock, not older), extend that range instead of storing
   * another observation. false = nothing to extend; the caller stores one.
   */
  touchPriceRange(
    listingId: string,
    price: number,
    availability: string,
    seenAt: string,
  ): Promise<boolean>;
  /** Verified price ranges of these listings last seen at or after `sinceIso`. */
  priceRangesSince(listingIds: string[], sinceIso: string): Promise<PriceRange[]>;
  /**
   * v4 A7 (Price Data API history / changes): shown readings stored at or after
   * `sinceIso` (only these listings, when given), newest first, each with the
   * price and stock of the same listing's shown reading before it.
   * `changesOnly`: just the readings whose price or stock differs from that
   * one (or that are a listing's first).
   */
  observationsSince(opts: {
    sinceIso: string;
    listingIds?: string[];
    changesOnly: boolean;
    limit: number;
  }): Promise<ObservationWithPrevious[]>;

  /* promotions (v4 A4.2) */
  /**
   * The promotions one shown reading of a listing stated. A repeat extends
   * its row (first/last seen); a new one opens a row. Nothing is written for
   * a reading without promotions: a promotion it no longer shows simply
   * stops being current (see `currentPromotions`).
   */
  recordPromotions(
    listingId: string,
    sourceId: string,
    seen: PromotionInput[],
    seenAt: string,
    observationId: string | null,
  ): Promise<{ opened: number; extended: number }>;
  /**
   * Promotions shown by their (active) listing's latest shown reading and
   * not past their own end date at `at`. Newest first.
   */
  currentPromotions(opts: {
    at: string;
    listingIds?: string[];
    sourceIds?: string[];
    limit: number;
  }): Promise<PromotionRecord[]>;

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
