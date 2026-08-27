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

/**
 * Map SerpAPI "source" field to our retailer names.
 * Google Shopping returns things like "Amazon.ca", "Walmart Canada",
 * "Costco Canada", etc. — we normalise these to our retailer keys.
 */
const SOURCE_MAP: Record<string, string> = {
  // Exact matches
  "Amazon.ca": "Amazon.ca",
  "Costco.ca": "Costco.ca",
  "Walmart.ca": "Walmart.ca",
  "eBay.ca": "eBay.ca",
  "Samsonite.ca": "Samsonite.ca",
  "TUMI.ca": "TUMI.ca",
  // Common variations Google uses
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
 * First checks the explicit map, then does a domain-based fuzzy match.
 */
function matchRetailer(source: string, url: string): string | null {
  // Exact/known mapping
  if (SOURCE_MAP[source]) return SOURCE_MAP[source];

  // Try case-insensitive
  const lower = source.toLowerCase();
  for (const [key, value] of Object.entries(SOURCE_MAP)) {
    if (key.toLowerCase() === lower) return value;
  }

  // Domain-based matching: check if the URL contains a known retailer domain
  if (url) {
    const urlLower = url.toLowerCase();
    for (const [name, info] of Object.entries(RETAILER_INFO)) {
      if (urlLower.includes(info.domain)) return name;
    }
  }

  return null;
}

/**
 * Fetch current prices for a product from Google Shopping Canada.
 * Returns matched retailer prices sorted lowest-first.
 */
export async function fetchPrices(
  query: string,
  apiKey?: string,
): Promise<PriceFetchResult[]> {
  const key = apiKey || process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY is not configured");

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl: "ca",       // Canada
    hl: "en",
    google_domain: "google.ca",
    num: "40",       // Get more results for better retailer coverage
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

  // Match results to known retailers, de-duplicate (keep cheapest per retailer)
  const byRetailer = new Map<string, PriceFetchResult>();

  for (const r of results) {
    if (!r.extracted_price || r.extracted_price <= 0) continue;

    const retailer = matchRetailer(r.source, r.link);
    if (!retailer) continue; // Skip unknown retailers

    const existing = byRetailer.get(retailer);
    if (!existing || r.extracted_price < existing.price) {
      byRetailer.set(retailer, {
        retailer,
        price: r.extracted_price,
        url: r.link,
        inStock: true, // Google Shopping generally only shows in-stock items
        title: r.title,
        thumbnail: r.thumbnail,
      });
    }
  }

  return Array.from(byRetailer.values()).sort((a, b) => a.price - b.price);
}

/**
 * Build a search query optimised for finding a specific product.
 * Combines name + brand + UPC for best matching.
 */
export function buildSearchQuery(product: {
  name: string;
  brand: string;
  upc?: string | null;
}): string {
  // For luggage, name + brand usually gets good results.
  // Append "Canada" to bias towards Canadian retailers.
  return `${product.brand} ${product.name} luggage Canada`;
}
