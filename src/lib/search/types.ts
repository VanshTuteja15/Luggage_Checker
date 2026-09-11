/* ------------------------------------------------------------------ */
/*  Search domain types                                               */
/*                                                                     */
/*  INVARIANT: every Offer carries a real `url` it was fetched from.   */
/*  The LLM is used to interpret queries and to group offers into      */
/*  products. It never produces a price. A price with no verifiable    */
/*  source URL is dropped before it reaches the caller.                */
/* ------------------------------------------------------------------ */

export type ProviderName = "serper" | "serpapi" | "gemini-grounded";

/**
 * compare — Search Products: cheapest live listings across retailers.
 * catalog — Tracked Products: discover variants (type / size / colour) to add.
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
};

/** A distinct physical product with every offer we found for it. */
export type SearchProduct = {
  /** Stable slug derived from brand + model + size + colour. */
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
};

/** Thrown when no price provider is usable. Surfaced to the user as-is. */
export class NoProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoProviderError";
  }
}
