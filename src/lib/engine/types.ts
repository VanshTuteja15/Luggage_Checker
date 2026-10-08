/* ------------------------------------------------------------------ */
/*  Price engine: shared domain types                                 */
/*                                                                     */
/*  Category-agnostic. Luggage-specific knowledge (size classes, lines, */
/*  colour codes) lives in a "category pack" (packs/luggage) and plugs  */
/*  in through the CategoryPack interface at the bottom of this file.   */
/*                                                                     */
/*  INVARIANT: a price reaches a user only as an Observation that was   */
/*  fetched from a registry source and passed validation, and it always */
/*  carries a Freshness label. Nothing in this module invents a price.  */
/* ------------------------------------------------------------------ */

/* ── Sources (the registry) ───────────────────────────────────────── */

export type AdapterId =
  | "shopify_ucp"
  | "shopify_product_json"
  | "html_structured"
  | "ebay_browse_api"
  | "amazon_creators_api"
  | "feed_import"
  | "manual_entry";

export const ADAPTER_IDS: readonly AdapterId[] = [
  "shopify_ucp",
  "shopify_product_json",
  "html_structured",
  "ebay_browse_api",
  "amazon_creators_api",
  "feed_import",
  "manual_entry",
];

/** How a store's live price can be verified (from the audit + probe). */
export type LiveClass =
  | "official_api"
  | "direct_http"
  | "needs_js"
  | "blocked"
  | "not_permitted"
  | "none"
  | "unknown"
  | "defunct";

/** Our standing to read the store automatically. */
export type PermissionStatus =
  /** The store publishes a channel for agents (agents.md / official API). */
  | "sanctioned"
  /** robots.txt allows us and the terms say nothing against it. */
  | "allowed"
  /** robots allows us but nobody has read the terms yet (⚖). */
  | "unclear"
  /** Terms restrict scraping: only the store's own agent channel. */
  | "restricted"
  /** Terms forbid automated access: official API / feed / link only. */
  | "forbidden"
  /** No online prices, or the store is gone. */
  | "not_applicable";

export type TermsStance = "silent" | "restricts" | "prohibits" | "unknown" | "sanctions_json";

export type SourceCategory =
  "brand_direct" | "specialty_retailer" | "major_retailer" | "marketplace";

export type SourceStatus = "active" | "inactive" | "defunct";

export type RouteSpec = {
  rank: number;
  adapter: AdapterId;
  /**
   * Feature flag that must be on for this route to be used, e.g.
   * "source.unluggage.product_json" (off until a human reads the terms).
   */
  flag?: string;
  /** Used only to cross-check another route's price, never on its own. */
  crossCheckOnly?: boolean;
  note?: string;
};

export type VisitWindow = { start: string; end: string; timeZone: string };

export type IdentityQuality = {
  barcode: "yes" | "partial" | "no" | "unknown";
  /** The manufacturer model number appears in the store SKU. */
  modelInSku: boolean;
  notes?: string;
  /**
   * Brand-direct stores: the brand every product belongs to. Their titles
   * usually leave it out ("CHATELET AIR 2.0 | 26-Inch…" on Delsey.ca), so it
   * fills in when the title names no brand.
   */
  houseBrand?: string;
};

export type SourceRecord = {
  id: string;
  name: string;
  /** Label shown in the UI and written to retailer_offers.retailer. */
  retailerLabel: string;
  category: SourceCategory;
  status: SourceStatus;
  platform: string;
  /** Exact hosts a listing URL for this store may use. Look-alikes never match. */
  allowedDomains: string[];
  /**
   * Exact hosts our fetcher may contact for this store (the SSRF guard's
   * allowlist). Stores whose terms forbid automated access list only their
   * official API host here, or nothing at all, so their HTML can never be
   * fetched even by mistake (MASTER_PROMPT rule 2).
   */
  fetchHosts: string[];
  /** Host that serves CAD prices (e.g. ca.monos.com, not monos.com). */
  marketHost: string | null;
  /** Path prefix of the Canadian market, e.g. "/en-ca" for Away. */
  marketPathPrefix: string | null;
  currency: "CAD";
  liveClass: LiveClass;
  permission: PermissionStatus;
  terms: { stance: TermsStance; url: string | null; clause: string | null };
  robots: { summary: string; crawlDelaySec: number | null; sitemaps: string[] };
  /** Minimum spacing between our requests to this store, in seconds. */
  crawlDelaySec: number;
  visitWindow: VisitWindow | null;
  ucpEndpoint: string | null;
  identityQuality: IdentityQuality;
  routes: RouteSpec[];
  /** For stores we can't read: a search link the user can open themselves. */
  linkOnlySearchUrl: string | null;
  domainWarnings: string[];
  /** What the P0 probe saw. */
  evidence: { probedAt: string | null; summary: string };
  /** Seed-level enable switch (admin can also disable at runtime). */
  enabled: boolean;
};

export type CircuitState = "closed" | "open" | "half_open";

export type SourceHealth = {
  sourceId: string;
  circuit: CircuitState;
  circuitOpenedAt: string | null;
  circuitReason: string | null;
  consecutiveFailures: number;
};

/* ── Fetching ─────────────────────────────────────────────────────── */

export type FetchOutcome =
  | "ok"
  | "not_found"
  | "blocked"
  | "challenge"
  | "rate_limited"
  | "timeout"
  | "error"
  | "robots_disallowed"
  | "not_permitted"
  | "circuit_open"
  | "outside_visit_window"
  | "ssrf_rejected"
  | "garbage";

/** True when the outcome means the store is refusing us (not a bug on our side). */
export function isBlockOutcome(o: FetchOutcome): boolean {
  return o === "blocked" || o === "challenge" || o === "rate_limited";
}

export type FetchAttempt = {
  sourceId: string;
  adapter: AdapterId | "robots" | "sitemap";
  url: string;
  method: string;
  status: number | null;
  outcome: FetchOutcome;
  durationMs: number;
  bytes: number;
  error: string | null;
  startedAt: string;
  sessionId: string | null;
  /** Response freshness headers worth keeping (Age, Last-Modified…). */
  cacheAgeSec: number | null;
};

/* ── Listings, identity ───────────────────────────────────────────── */

export type IdentifierKind = "gtin" | "mpn" | "model" | "store_sku";

export type Identifier = {
  kind: IdentifierKind;
  value: string;
  /** Store SKUs are only unique within one store. */
  sourceId?: string;
};

/** One store's page for one product (or one variant of it). */
export type ListingRecord = {
  id: string;
  sourceId: string;
  /** Canonical product URL on an allowed domain. */
  url: string;
  /** Store-side id: Shopify product id, eBay item id, SFCC master id… */
  externalId: string | null;
  title: string;
  brand: string | null;
  sizeClass: string | null;
  colour: string | null;
  identifiers: Identifier[];
  imageUrl: string | null;
  productId: string | null;
  variantId: string | null;
  discoveredVia: "sitemap" | "ucp" | "feed" | "tavily" | "manual" | "live_search" | "seed";
  lastmod: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  active: boolean;
};

export type ListingInput = Omit<
  ListingRecord,
  "id" | "firstSeenAt" | "lastSeenAt" | "productId" | "variantId"
> & {
  productId?: string | null;
  variantId?: string | null;
};

/* ── Offers, validation, observations ─────────────────────────────── */

export type Availability = "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown";

/**
 * What an adapter read from a source, before validation. Every field is
 * exactly what the source said; nothing is inferred except unit conversion
 * (minor units → dollars), which is recorded in `evidence`.
 */
export type RawOffer = {
  sourceId: string;
  adapter: AdapterId;
  /** The listing page a customer would open. */
  url: string;
  externalId: string | null;
  variantExternalId: string | null;
  title: string;
  brand: string | null;
  identifiers: Identifier[];
  colour: string | null;
  /** Raw option values (colour, size…) as the store lists them. */
  options: string[];
  price: number | null;
  /** Compare-at / list / strikethrough price, when the source gives one. */
  listPrice: number | null;
  currency: string | null;
  availability: Availability;
  /** Marketplaces only. */
  seller: string | null;
  condition: string | null;
  imageUrl: string | null;
  /** Second reading of the price from a different part of the same source. */
  displayedPrice: number | null;
  /** Kind of page the price was read from. */
  pageType: "product" | "listing" | "api" | "feed" | "manual" | "unknown";
  /** Proof: field paths, raw values, request URL. */
  evidence: Record<string, unknown>;
  fetchedAt: string;
  /** CDN age of the response, if the source said. */
  cacheAgeSec: number | null;
  /** Feeds and manual entries: the date the price was valid. */
  asOf: string | null;
};

export type ValidationOutcome = "accepted" | "low_confidence" | "rejected";

export type ValidationResult = {
  outcome: ValidationOutcome;
  /** 0–1. */
  confidence: number;
  reasons: string[];
};

export type FreshnessKind = "live" | "feed" | "manual" | "stale";

/** Every price on screen carries one of these. There is no unlabelled price. */
export type Freshness =
  | { kind: "live"; fetchedAt: string }
  | { kind: "feed"; asOf: string }
  | { kind: "manual"; checkedAt: string }
  | { kind: "stale"; lastSeenAt: string };

export type Observation = {
  id: string;
  listingId: string;
  sourceId: string;
  adapter: AdapterId;
  /** Always > 0 on shown readings; 0 only on a rejected reading that had no price. */
  price: number;
  listPrice: number | null;
  /** "CAD" on every shown reading; rejected readings keep the source's currency. */
  currency: string;
  availability: Availability;
  seller: string | null;
  condition: string | null;
  validation: ValidationResult;
  evidence: Record<string, unknown>;
  extractorVersion: string;
  validatorVersion: string;
  fetchedAt: string;
  asOf: string | null;
  sessionId: string | null;
};

/**
 * A rejected reading is still evidence: it keeps the source's own currency
 * (e.g. USD) and may have no price at all. Shown readings are CAD with a price.
 */
export type ObservationInput = Omit<Observation, "id" | "price" | "currency"> & {
  price: number | null;
  currency: string;
};

/* ── Queries and research sessions ────────────────────────────────── */

export type ParsedQuery = {
  raw: string;
  /** Lower-cased significant words. */
  tokens: string[];
  brand: string | null;
  /** Product line words (e.g. ["outline", "pro"]). */
  line: string[];
  sizeClass: string | null;
  /** Size in inches when the query states one ("28\"", "28-inch", "(28)"). */
  inches: number | null;
  colour: string | null;
  gtin: string | null;
  model: string | null;
  maxPrice: number | null;
};

export type SessionStatus = "queued" | "running" | "done" | "cancelled" | "failed";

export type StoreTaskState =
  | "pending"
  | "running"
  | "verified"
  | "no_match"
  | "blocked"
  | "not_permitted"
  | "not_configured"
  | "timed_out"
  | "error"
  | "link_only";

/** One price in a research answer. */
export type AnswerOffer = {
  sourceId: string;
  retailer: string;
  url: string;
  title: string;
  brand: string | null;
  sizeClass: string | null;
  identifiers: Identifier[];
  imageUrl: string | null;
  /** Validation caveats a low-confidence price is shown with. */
  reasons: string[];
  price: number;
  listPrice: number | null;
  currency: "CAD";
  availability: Availability;
  colour: string | null;
  freshness: Freshness;
  confidence: number;
  lowConfidence: boolean;
  method: AdapterId;
  observationId: string | null;
  listingId: string | null;
  /** Catalog product the listing resolved to, when known. */
  productId: string | null;
  evidence: string | null;
};

export type AnswerProduct = {
  key: string;
  productId: string | null;
  name: string;
  brand: string | null;
  sizeClass: string | null;
  identifiers: Identifier[];
  imageUrl: string | null;
  offers: AnswerOffer[];
  lowestPrice: number | null;
};

export type StoreStatusRow = {
  sourceId: string;
  retailer: string;
  state: StoreTaskState;
  message: string;
  /** For link-only / couldn't-verify rows: a link the user can open. */
  url: string | null;
  durationMs: number | null;
};

export type ResearchAnswer = {
  query: string;
  parsed: ParsedQuery;
  products: AnswerProduct[];
  stores: StoreStatusRow[];
  startedAt: string;
  finishedAt: string;
  /** ms from session start to first verified price; null if none. */
  firstPriceMs: number | null;
  totalMs: number;
  deadlineHit: boolean;
  notes: string[];
};

export type SessionEventType =
  | "session_started"
  | "plan"
  | "store_started"
  | "store_offers"
  | "store_done"
  | "session_done"
  | "session_failed"
  | "session_cancelled";

export type SessionEvent = {
  sessionId: string;
  seq: number;
  type: SessionEventType;
  sourceId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ResearchSessionRecord = {
  id: string;
  userId: string;
  query: string;
  status: SessionStatus;
  /** Re-verify: the session whose listings this one re-checks. */
  parentSessionId: string | null;
  storeIds: string[] | null;
  deadlineMs: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  answer: ResearchAnswer | null;
  error: string | null;
};

/* ── Category pack ────────────────────────────────────────────────── */

export type CategoryPack = {
  id: string;
  /** Plausible price band in CAD for a single item of this category. */
  priceBand: { min: number; max: number };
  parseQuery(raw: string): ParsedQuery;
  /** Size class from a title/options, e.g. "carry_on". null when unknown. */
  sizeClassOf(text: string): string | null;
  /**
   * Stated size in inches, null when the title gives none. Two stated sizes
   * that differ are two products even within one size class (Samsonite Nexis
   * Large 28 vs 31).
   */
  inchesOf(text: string): number | null;
  colourOf(text: string): string | null;
  brandOf(text: string): string | null;
  /** Significant product-line words (brand, size, colour, filler removed). */
  lineOf(text: string, brand: string | null): string[];
  /** Manufacturer model number (+ colour code) found in a SKU or title. */
  modelOf(text: string, brand: string | null): { model: string; colourCode: string | null } | null;
  /** True for accessories/non-items that must never match a main product. */
  isAccessory(title: string): boolean;
  /**
   * Line words that tell products apart when a store names them, but that a
   * person's short name for the bag often leaves out ("Omni 3.0 Large" for the
   * "Omni 3.0 Expandable Large Spinner"). A name that omits one still matches.
   */
  optionalLineWords: ReadonlySet<string>;
};
