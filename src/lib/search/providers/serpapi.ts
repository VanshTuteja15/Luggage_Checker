/* ------------------------------------------------------------------ */
/*  Provider: SerpAPI Google Shopping (Canada)                        */
/*                                                                     */
/*  Highest-quality source. Every result is a real merchant listing    */
/*  with a link and an extracted numeric price.                        */
/* ------------------------------------------------------------------ */

import { displayRetailer, matchRetailer } from "@/lib/retailers";
import type { Offer, SearchIntent } from "../types";

const SERPAPI_BASE = "https://serpapi.com/search.json";
const TIMEOUT_MS = 20_000;

type ShoppingResult = {
  title?: string;
  link?: string;
  product_link?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  snippet?: string;
  delivery?: string;
  second_hand_condition?: string;
};

export function serpApiConfigured(): boolean {
  return !!process.env.SERPAPI_KEY;
}

/**
 * Fetch shopping offers from Google Shopping Canada.
 *
 * Returns every usable listing — filtering to specific retailers happens
 * later in the pipeline so we can report how many were found overall.
 */
export async function fetchOffers(
  intent: SearchIntent,
  opts: { apiKey?: string; limit?: number } = {},
): Promise<Offer[]> {
  const key = opts.apiKey || process.env.SERPAPI_KEY;
  if (!key) throw new Error("SERPAPI_KEY is not configured");

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: intent.terms,
    gl: "ca",
    hl: "en",
    google_domain: "google.ca",
    currency: "CAD",
    num: String(opts.limit ?? 60),
    api_key: key,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${SERPAPI_BASE}?${params}`, {
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("SerpAPI request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    // 401/403 almost always means a bad or exhausted key — say so plainly.
    if (res.status === 401 || res.status === 403) {
      throw new Error("SerpAPI rejected the API key (invalid or out of quota)");
    }
    throw new Error(`SerpAPI error ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as {
    shopping_results?: ShoppingResult[];
    error?: string;
  };

  if (data.error) throw new Error(`SerpAPI: ${data.error}`);

  const fetchedAt = new Date().toISOString();

  return (data.shopping_results ?? [])
    .map((r): Offer | null => {
      const url = r.link || r.product_link || "";
      const price = typeof r.extracted_price === "number" ? r.extracted_price : 0;

      // Drop anything without the two things that make an offer real.
      if (!url || !url.startsWith("http")) return null;
      if (!price || price <= 0) return null;

      const source = r.source ?? "";
      const key = matchRetailer(source, url);

      return {
        retailer: displayRetailer(source, url),
        retailerKey: key,
        price: Math.round(price * 100) / 100,
        currency: "CAD",
        url,
        // Google Shopping only lists purchasable items; treat used listings
        // as in stock too, but they're flagged by title downstream.
        inStock: true,
        title: (r.title ?? "").trim(),
        thumbnail: r.thumbnail,
        rating: typeof r.rating === "number" ? r.rating : undefined,
        reviews: typeof r.reviews === "number" ? r.reviews : undefined,
        fetchedAt,
      };
    })
    .filter((o): o is Offer => o !== null && o.title.length > 0);
}
