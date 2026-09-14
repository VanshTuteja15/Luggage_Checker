/* ------------------------------------------------------------------ */
/*  Provider: SerpAPI Google Shopping (Canada)                        */
/*                                                                     */
/*  Real merchant listings with a link and an extracted numeric price. */
/* ------------------------------------------------------------------ */

import { displayRetailer, matchRetailer } from "@/lib/retailers";
import { ProviderError, classifyHttp } from "../errors";
import type { Offer, SearchIntent } from "../types";

const SERPAPI_BASE = "https://serpapi.com/search.json";

/**
 * SerpAPI scrapes Google Shopping live, so a cold request regularly takes
 * 15-30s — and longer on the first call against a brand-new key while the
 * account warms up. The old 20s ceiling turned normal latency into a
 * failure. The route allows 60s; leave headroom for one retry.
 */
const TIMEOUT_MS = Number(process.env.SERPAPI_TIMEOUT_MS ?? 25_000);

/** Results per request. Higher is slower; 40 is plenty to cluster from. */
const RESULT_COUNT = 40;

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
};

export function serpApiConfigured(): boolean {
  return !!process.env.SERPAPI_KEY;
}

async function requestOnce(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { signal: controller.signal, cache: "no-store" });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderError("serpapi", "timeout", `SerpAPI timed out after ${timeoutMs}ms`);
    }
    throw new ProviderError(
      "serpapi",
      "network",
      err instanceof Error ? err.message : "Network error reaching SerpAPI",
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch shopping offers from Google Shopping Canada.
 *
 * Retries once on a timeout or 5xx — those are transient often enough that
 * failing the whole search on the first one wastes the user's allowance for
 * nothing.
 */
export async function fetchOffers(
  intent: SearchIntent,
  opts: { apiKey?: string; limit?: number } = {},
): Promise<Offer[]> {
  const key = opts.apiKey || process.env.SERPAPI_KEY;
  if (!key) throw new ProviderError("serpapi", "auth", "SERPAPI_KEY is not configured");

  const params = new URLSearchParams({
    engine: "google_shopping",
    q: intent.terms,
    gl: "ca",
    hl: "en",
    google_domain: "google.ca",
    num: String(opts.limit ?? RESULT_COUNT),
    api_key: key,
  });

  const url = `${SERPAPI_BASE}?${params}`;

  let res: Response | null = null;
  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const candidate = await requestOnce(url, TIMEOUT_MS);

      if (candidate.ok) {
        res = candidate;
        break;
      }

      const detail = await candidate.text().catch(() => "");
      const kind = classifyHttp(candidate.status, detail);
      lastError = new ProviderError(
        "serpapi",
        kind,
        kind === "auth"
          ? "SerpAPI rejected the API key (invalid, or the account isn't activated yet)"
          : `SerpAPI error ${candidate.status}: ${detail.slice(0, 200)}`,
      );

      if (!lastError.retryable) throw lastError;
    } catch (err) {
      lastError = err instanceof ProviderError
        ? err
        : new ProviderError("serpapi", "unknown", err instanceof Error ? err.message : "SerpAPI failed");

      if (!lastError.retryable) throw lastError;
    }

    // Brief backoff before the single retry.
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }

  if (!res) throw lastError ?? new ProviderError("serpapi", "unknown", "SerpAPI failed");

  const data = (await res.json().catch(() => null)) as {
    shopping_results?: ShoppingResult[];
    error?: string;
  } | null;

  if (!data) throw new ProviderError("serpapi", "unknown", "SerpAPI returned an unreadable response");

  if (data.error) {
    const kind = /key|unauthor/i.test(data.error)
      ? "auth"
      : /run out|limit|plan/i.test(data.error)
        ? "quota"
        : "unknown";
    throw new ProviderError("serpapi", kind, `SerpAPI: ${data.error}`);
  }

  const fetchedAt = new Date().toISOString();

  return (data.shopping_results ?? [])
    .map((r): Offer | null => {
      const url = r.link || r.product_link || "";
      const price = typeof r.extracted_price === "number" ? r.extracted_price : 0;

      // Drop anything without the two things that make an offer real.
      if (!url || !url.startsWith("http")) return null;
      if (!price || price <= 0) return null;

      const source = r.source ?? "";

      return {
        retailer: displayRetailer(source, url),
        retailerKey: matchRetailer(source, url),
        price: Math.round(price * 100) / 100,
        currency: "CAD",
        inStock: true,
        url,
        title: (r.title ?? "").trim(),
        thumbnail: r.thumbnail,
        rating: typeof r.rating === "number" ? r.rating : undefined,
        reviews: typeof r.reviews === "number" ? r.reviews : undefined,
        fetchedAt,
      };
    })
    .filter((o): o is Offer => o !== null && o.title.length > 0);
}
