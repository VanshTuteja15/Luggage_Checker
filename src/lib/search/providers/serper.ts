/* ------------------------------------------------------------------ */
/*  Provider: Serper.dev Google Shopping                              */
/*                                                                     */
/*  Real Google Shopping listings. Chosen as the default provider      */
/*  because its free allowance (2,500 queries, no card) is an order    */
/*  of magnitude larger than the alternatives — though it is one-time  */
/*  rather than recurring, which is why SerpAPI sits behind it as the  */
/*  sustaining source.                                                */
/* ------------------------------------------------------------------ */

import { displayRetailer, isMerchantUrl, matchRetailer } from "@/lib/retailers";
import type { Offer, SearchIntent } from "../types";

const SERPER_SHOPPING_URL = "https://google.serper.dev/shopping";
const TIMEOUT_MS = 20_000;

type SerperShoppingResult = {
  title?: string;
  source?: string;
  link?: string;
  price?: string;
  delivery?: string;
  imageUrl?: string;
  rating?: number;
  ratingCount?: number;
  offers?: string;
  productId?: string;
  position?: number;
};

export function serperConfigured(): boolean {
  return !!process.env.SERPER_API_KEY;
}

/**
 * Serper returns price as a display string ("CA$249.99", "$1,129.00").
 * Parse conservatively — a misparsed price is worse than a dropped one.
 */
function parsePrice(raw: string | undefined): number {
  if (!raw) return 0;
  // Strip currency words/symbols and thousands separators, keep digits + dot.
  const cleaned = raw.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value * 100) / 100;
}

export async function fetchOffers(
  intent: SearchIntent,
  opts: { apiKey?: string; limit?: number } = {},
): Promise<Offer[]> {
  const key = opts.apiKey || process.env.SERPER_API_KEY;
  if (!key) throw new Error("SERPER_API_KEY is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(SERPER_SHOPPING_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: intent.terms,
        gl: "ca",
        hl: "en",
        location: "Canada",
        num: opts.limit ?? 40,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Serper request timed out");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error("Serper rejected the API key (invalid or out of credits)");
    }
    if (res.status === 429) {
      throw new Error("Serper rate limit or credit allowance reached");
    }
    throw new Error(`Serper error ${res.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await res.json()) as { shopping?: SerperShoppingResult[] };
  const fetchedAt = new Date().toISOString();

  return (data.shopping ?? [])
    .map((r): Offer | null => {
      const url = (r.link ?? "").trim();
      const price = parsePrice(r.price);
      const title = (r.title ?? "").trim();

      // The things that make an offer real: a price, a title, and a
      // retailer page we can send a buyer to and re-check tomorrow.
      // Google's own aggregate pages satisfy none of the last point.
      if (!isMerchantUrl(url) || price <= 0 || !title) return null;

      const source = r.source ?? "";

      return {
        retailer: displayRetailer(source, url),
        retailerKey: matchRetailer(source, url),
        price,
        currency: "CAD",
        url,
        inStock: true,
        title,
        thumbnail: r.imageUrl,
        rating: typeof r.rating === "number" ? r.rating : undefined,
        reviews: typeof r.ratingCount === "number" ? r.ratingCount : undefined,
        fetchedAt,
      };
    })
    .filter((o): o is Offer => o !== null);
}
