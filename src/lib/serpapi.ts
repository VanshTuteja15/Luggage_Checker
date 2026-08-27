/* ------------------------------------------------------------------ */
/*  SerpAPI Google Shopping integration — Canada-focused              */
/* ------------------------------------------------------------------ */

import { RETAILER_INFO } from "./data";

const SERPAPI_BASE = "https://serpapi.com/search.json";

export type ShoppingResult = {
  title: string;
  link: string;
  source: string;
  price: string;
  extracted_price: number;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  snippet?: string;
};

export type PriceFetchResult = {
  retailer: string;
  price: number;
  url: string;
  inStock: boolean;
  title: string;
  thumbnail?: string;
};

/** A live web search result — any retailer, not just our known 15. */
export type WebSearchResult = {
  title: string;
  source: string;
  price: number;
  url: string;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  snippet?: string;
  /** If this source maps to one of our 15 known retailers. */
  knownRetailer: string | null;
};

/**
 * Map SerpAPI "source" field to our retailer names.
 */
const SOURCE_MAP: Record<string, string> = {
  "Amazon.ca": "Amazon.ca",
  "Costco.ca": "Costco.ca",
  "Walmart.ca": "Walmart.ca",
  "eBay.ca": "eBay.ca",
  "Samsonite.ca": "Samsonite.ca",
  "TUMI.ca": "TUMI.ca",
  "Amazon Canada": "Amazon.ca",
  "Amazon - Canada": "Amazon.ca",
  "Walmart Canada": "Walmart.ca",
  "Walmart - Canada": "Walmart.ca",
  "Costco Canada": "Costco.ca",
  "Costco Wholesale Canada": "Costco.ca",
  "Hudson's Bay": "Hudson's Bay",
  "TheBay.com": "Hudson's Bay",
  "The Bay": "Hudson's Bay",
  "Canadian Tire": "Canadian Tire",
  "CanadianTire.ca": "Canadian Tire",
  "Bentley": "Bentley",
  "Bentley Leathers": "Bentley",
  "Best Buy Canada": "Best Buy Canada",
  "Best Buy": "Best Buy Canada",
  "BestBuy.ca": "Best Buy Canada",
  "London Drugs": "London Drugs",
  "LondonDrugs.com": "London Drugs",
  "Samsonite": "Samsonite.ca",
  "Samsonite Canada": "Samsonite.ca",
  "TUMI": "TUMI.ca",
  "Tumi": "TUMI.ca",
  "Away": "Away",
  "Away Travel": "Away",
  "Travelpro": "Travelpro",
  "Travelpro.com": "Travelpro",
  "Monos": "Monos",
  "Monos.com": "Monos",
  "Briggs & Riley": "Briggs & Riley",
  "Briggs and Riley": "Briggs & Riley",
  "eBay": "eBay.ca",
};

/**
 * Try to map a Google Shopping "source" to one of our known retailers.
 * Returns null if no match found.
 */
export function matchRetailer(source: string, url: string): string | null {
  if (SOURCE_MAP[source]) return SOURCE_MAP[source];

  const lower = source.toLowerCase();
  for (const [key, value] of Object.entries(SOURCE_MAP)) {
    if (key.toLowerCase() === lower) return value;
  }

  if (url) {
    const urlLower = url.toLowerCase();
    for (const [name, info] of Object.entries(RETAILER_INFO)) {
      if (urlLower.includes(info.domain)) return name;
    }
  }

  return null;
}

/**
 * Fetch ALL shopping results for a query from Google Shopping Canada.
 * Returns every result (not just known retailers) so the search
 * works like a proper search engine.
 */
export async function searchWeb(
  query: string,
  apiKey?: string,
): Promise<WebSearchResult[]> {
  const key = apiKey || process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY is not configured");

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl: "ca",
    hl: "en",
    google_domain: "google.ca",
    num: "40",
    api_key: key,
  });

  const res = await fetch(`${SERPAPI_BASE}?${params}`, {
    next: { revalidate: 0 },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const results: ShoppingResult[] = data.shopping_results ?? [];

  return results
    .filter((r) => r.extracted_price && r.extracted_price > 0)
    .map((r) => ({
      title: r.title,
      source: r.source,
      price: r.extracted_price,
      url: r.link,
      thumbnail: r.thumbnail,
      rating: r.rating,
      reviews: r.reviews,
      snippet: r.snippet,
      knownRetailer: matchRetailer(r.source, r.link),
    }));
}

/**
 * Fetch current prices for a product — filtered to known retailers only.
 * Used by the cron job for tracked products.
 */
export async function fetchPrices(
  query: string,
  apiKey?: string,
): Promise<PriceFetchResult[]> {
  const allResults = await searchWeb(query, apiKey);

  // Filter to known retailers only, de-duplicate (keep cheapest per retailer)
  const byRetailer = new Map<string, PriceFetchResult>();

  for (const r of allResults) {
    if (!r.knownRetailer) continue;

    const existing = byRetailer.get(r.knownRetailer);
    if (!existing || r.price < existing.price) {
      byRetailer.set(r.knownRetailer, {
        retailer: r.knownRetailer,
        price: r.price,
        url: r.url,
        inStock: true,
        title: r.title,
        thumbnail: r.thumbnail,
      });
    }
  }

  return Array.from(byRetailer.values()).sort((a, b) => a.price - b.price);
}

/**
 * Build a search query optimised for finding a specific product.
 */
export function buildSearchQuery(product: {
  name: string;
  brand: string;
  upc?: string | null;
}): string {
  return `${product.brand} ${product.name} luggage Canada`;
}
