/* ------------------------------------------------------------------ */
/*  Search domain types                                               */
/*                                                                     */
/*  INVARIANT: every Offer carries a real `url` it was fetched from.   */
/*  The LLM is used to interpret queries and to group offers into      */
/*  products. It never produces a price. A price with no verifiable    */
/*  source URL is dropped before it reaches the caller.                */
/* ------------------------------------------------------------------ */

/**
 * Price-research providers. Tavily is the only one in use; the others are
 * retired and kept only so old cached responses still type-check.
 */
export type ProviderName = "tavily" | "serper" | "serpapi" | "gemini-grounded";

/**
 * What the caller is asking for.
 *
 *   compare — "what does this bag cost, and where is it cheapest?"
 *             Colours of the same model and size are one product, so the
 *             card shows every retailer carrying it.
 *
 *   catalog — "show me what this brand actually sells."
 *             Colours are DIFFERENT products, because the point is to
 *             browse the range and pick a variant to track.
 */
export type SearchMode = "compare" | "catalog";

/** A single retailer listing for a product, as fetched from a provider. */
export type Offer = {
  /** Canonical retailer name when known, otherwise the raw source label. */
  retailer: string;
  /** Canonical retailer key, or null when this retailer isn't one we track. */
  retailerKey: string | null;
  /** Price in CAD. Always > 0. */
  price: number;
  currency: "CAD";
  /** Provenance. Required — an offer without a URL is not trustworthy. */
  url: string;
  inStock: boolean;
  /** The listing title exactly as the retailer published it. */
  title: string;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  /** ISO timestamp of when this offer was fetched. */
  fetchedAt: string;
  /**
   * The exact words on the retailer's page the price was read from, e.g.
   * "…Sale Price $229.99 Add to cart…". Proof the number is real, and the
   * first thing to look at when a price seems wrong.
   */
  evidence?: string;
  /** Specs read from the same page, when it listed them. */
  details?: LuggageDetails;
  /** The colour this listing names, when its title names one. */
  colour?: string;
};

/**
 * Luggage specifications, read from retailer pages — never generated.
 * Every field is optional: a page only contributes what it actually says.
 */
export type LuggageDetails = {
  /** As written, e.g. "22 x 14 x 9 in" or "55 x 40 x 20 cm". */
  dimensions?: string;
  /** As written, e.g. "7.1 lb" or "3.2 kg". */
  weight?: string;
  /** e.g. "41 L". */
  capacity?: string;
  /** e.g. "Polycarbonate". */
  material?: string;
  /** e.g. "Spinner (4 wheels)" or "2 wheels". */
  wheels?: string;
  expandable?: boolean;
  tsaLock?: boolean;
  /** e.g. "10-year". */
  warranty?: string;
  /** Colours the page's variant picker offers, e.g. ["Black", "Ice Blue"]. */
  colours?: string[];
};

/** A distinct physical product with every offer we found for it. */
export type SearchProduct = {
  /** Stable slug derived from brand + model (+ colour). */
  key: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  /** e.g. "21 inch", "Carry-On", "Large Check-In". Empty when unknown. */
  size: string;
  upc: string | null;
  productType: string | null;
  imageUrl: string | null;
  /** Sorted ascending by price. Never empty. */
  offers: Offer[];
  lowestPrice: number;
  highestPrice: number;
  /** Number of distinct retailers carrying this product. */
  retailerCount: number;
  /** highest - lowest, rounded to cents. */
  spread: number;
  /** True when at least one offer is from a major Canadian retailer. */
  hasMajorRetailer: boolean;
  /** Specs merged from the offers' pages. Absent when no page listed any. */
  details?: LuggageDetails;
  /** Every colour seen for this product across its listings and pages. */
  colours?: string[];
  /**
   * How closely the product matches the words searched, 0–1. Products that
   * match every word are listed before partial matches.
   */
  relevance?: number;
};

/**
 * A retailer page for the product that we found but couldn't read a price
 * from. Shown as a link ("check price on Samsonite.ca"), never as a price.
 */
export type AlsoCheck = {
  retailer: string;
  url: string;
  title: string;
};

/** Structured interpretation of a natural-language query. */
export type SearchIntent = {
  /** Cleaned keyword string handed to the shopping engine. */
  terms: string;
  brand: string | null;
  model: string | null;
  productType: string | null;
  maxPrice: number | null;
  minPrice: number | null;
  features: string[];
  /** One short sentence explaining what was searched for, shown to the user. */
  explanation: string;
};

export type SearchResponse = {
  query: string;
  intent: SearchIntent;
  provider: ProviderName;
  products: SearchProduct[];
  /** Raw offer count before clustering — useful for diagnostics. */
  offersFound: number;
  /** Non-fatal problems worth surfacing (quota, degraded provider, etc). */
  warnings: string[];
  /**
   * Set when this response was served from cache rather than a fresh call.
   * Prices keep their original fetch time — a cached result never claims
   * to be newer than it is.
   */
  cached?: { fetchedAt: string; ageMinutes: number };
  /** Store pages found without a readable price — links only. */
  alsoCheck?: AlsoCheck[];
  /**
   * "partial" while store pages are still being read, "final" once done.
   * Streamed searches send a partial first so results appear sooner.
   */
  phase?: "partial" | "final";
  /** Research credits this search spent (0 when served from cache). */
  creditsUsed?: number;
};

/** Thrown when no price provider is usable. Surfaced to the user as-is. */
export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}
