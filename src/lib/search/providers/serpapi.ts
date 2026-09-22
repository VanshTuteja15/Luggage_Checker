/* ------------------------------------------------------------------ */
/*  Provider: SerpAPI Google Shopping (Canada)                        */
/*                                                                     */
/*  Real merchant listings with a link and an extracted numeric price. */
/* ------------------------------------------------------------------ */

import { displayRetailer, isMerchantUrl, matchRetailer } from "@/lib/retailers";
import { Deadline, NO_METER, type Meter } from "../deadline";
import { ProviderError, classifyHttp } from "../errors";
import type { Offer, SearchIntent } from "../types";

const SERPAPI_BASE = "https://serpapi.com/search.json";

/**
 * SerpAPI scrapes Google Shopping live, so a cold request regularly takes
 * 15-30s — and longer on the first call against a brand-new key while the
 * account warms up. The old 20s ceiling turned normal latency into a
 * failure. The route allows 60s; leave headroom for one retry.
 */
function timeoutMs(): number {
  const raw = Number(process.env.SERPAPI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
}

/**
 * Results per request. SerpAPI scrapes live, so this is the single biggest
 * lever on latency — 40 results was a meaningful part of the timeouts.
 * 20 still gives plenty to cluster into 10 products.
 */
const RESULT_COUNT = 20;

/**
 * SerpAPI reports "no matches" through the same `error` field it uses for
 * real failures, with HTTP 200. These phrasings mean the search succeeded
 * and Google simply had nothing — the caller should broaden, not fail.
 */
function isNoResults(message: string): boolean {
  return /hasn'?t returned any results|no results (were )?found|didn'?t return any results/i.test(
    message,
  );
}

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

/**
 * A listing's price.
 *
 * `extracted_price` is the numeric field, but it is not always present —
 * Google's own markup varies by merchant, and SerpAPI passes that through.
 * When it's missing, the display string ("$229.99", "CA$1,129.00") still
 * carries the number, so parse it rather than discarding a real offer.
 */
function priceOf(r: ShoppingResult): number {
  if (typeof r.extracted_price === "number" && r.extracted_price > 0) {
    return r.extracted_price;
  }

  const raw = r.price ?? "";
  // Keep digits, dots and commas; drop currency words and symbols. Then
  // treat commas as thousands separators.
  const cleaned = raw.replace(/[^\d.,]/g, "").replace(/,/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0;
}

/**
 * The best URL we can offer for a listing, and whether it goes straight to
 * the merchant.
 *
 * Google Shopping rows come in several shapes and this has to handle all of
 * them, because rejecting a shape means throwing away a real price:
 *
 *   1. `link` is the merchant's product page          — ideal
 *   2. `link` is a Google redirect (/url?q=… , /aclk) — unwrap it
 *   3. only `product_link`, a Google Shopping page    — usable, not direct
 *
 * Case 3 used to be dropped outright. That was too strict: the price and
 * the retailer name are both real, and a link to Google's page for the
 * product is far better than showing the client nothing at all.
 */
export function resolveOfferUrl(r: ShoppingResult): { url: string; direct: boolean } | null {
  const candidates = [r.link, r.product_link].filter(
    (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
  );

  for (const candidate of candidates) {
    if (isMerchantUrl(candidate)) return { url: candidate, direct: true };

    // A Google redirect carries the real destination in a query parameter.
    try {
      const parsed = new URL(candidate);
      for (const param of ["q", "url", "adurl", "dest"]) {
        const inner = parsed.searchParams.get(param);
        if (inner && /^https?:\/\//i.test(inner) && isMerchantUrl(inner)) {
          return { url: inner, direct: true };
        }
      }
    } catch {
      // Unparseable — fall through.
    }
  }

  // Nothing direct. Keep a Google Shopping page as a last resort so the
  // listing still reaches the client.
  const fallback = candidates[0];
  return fallback ? { url: fallback, direct: false } : null;
}

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
  opts: {
    apiKey?: string;
    limit?: number;
    /** Shared time budget so a retry can't overrun the route's ceiling. */
    deadline?: Deadline;
    /** Counts every HTTP attempt, because SerpAPI bills per request. */
    meter?: Meter;
  } = {},
): Promise<Offer[]> {
  const key = opts.apiKey || process.env.SERPAPI_KEY;
  if (!key) throw new ProviderError("serpapi", "auth", "SERPAPI_KEY is not configured");

  const meter = opts.meter ?? NO_METER;
  const deadline = opts.deadline;

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

  const BACKOFF_MS = 1200;

  /**
   * SerpAPI scrapes Google live and rarely answers in under ~5s, so an
   * attempt with a smaller window than this is one we'd pay for and lose.
   */
  const MIN_USEFUL_ATTEMPT_MS = 10_000;

  for (let attempt = 0; attempt < 2; attempt++) {
    // Never wait longer than the budget allows, and always leave a little
    // for parsing the response.
    // Two separate questions, previously conflated: is there enough budget
    // left to bother trying, and how long may this attempt take?
    // Don't start an attempt we can't finish.
    if (deadline && !deadline.hasAtLeast(MIN_USEFUL_ATTEMPT_MS)) {
      throw (
        lastError ??
        new ProviderError(
          "serpapi",
          "budget",
          `Only ${deadline.remaining}ms of the search budget was left — too little to query SerpAPI, so no call was made.`,
        )
      );
    }

    const ceiling = timeoutMs();
    const timeout = deadline ? Math.max(1, Math.min(ceiling, deadline.budget(ceiling, 2_000))) : ceiling;

    // Claim the call BEFORE the request — this is the one that gets billed.
    // A QuotaExhaustedError from here propagates: no request, no charge.
    await meter.beforeAttempt();

    // Exactly one error path per attempt, so a failure can't be refunded
    // twice. (It could: `throw` inside the try was caught by its own catch.)
    let failure: ProviderError | null = null;
    let candidate: Response | null = null;

    try {
      candidate = await requestOnce(url, timeout);
    } catch (err) {
      failure =
        err instanceof ProviderError
          ? err
          : new ProviderError(
              "serpapi",
              "unknown",
              err instanceof Error ? err.message : "SerpAPI failed",
            );
    }

    if (candidate?.ok) {
      res = candidate;
      break;
    }

    if (candidate && !candidate.ok) {
      const detail = await candidate.text().catch(() => "");
      const kind = classifyHttp(candidate.status, detail);
      failure = new ProviderError(
        "serpapi",
        kind,
        kind === "auth"
          ? "SerpAPI rejected the API key (invalid, or the account isn't activated yet)"
          : `SerpAPI error ${candidate.status}: ${detail.slice(0, 200)}`,
      );
    }

    if (failure) {
      lastError = failure;
      if (!failure.consumedQuota) await meter.refundAttempt();
      if (!failure.retryable) throw failure;
    }

    // Only retry if there is genuinely time for another full attempt.
    // This has to match the guard at the top of the loop, or we sleep for
    // the backoff and then immediately give up — 1.2s spent for nothing.
    const nextAttemptNeeds = BACKOFF_MS + MIN_USEFUL_ATTEMPT_MS;
    if (attempt === 0) {
      if (deadline && !deadline.hasAtLeast(nextAttemptNeeds)) break;
      await new Promise((r) => setTimeout(r, BACKOFF_MS));
    }
  }

  if (!res) throw lastError ?? new ProviderError("serpapi", "unknown", "SerpAPI failed");

  const data = (await res.json().catch(() => null)) as {
    shopping_results?: ShoppingResult[];
    error?: string;
  } | null;

  if (!data) throw new ProviderError("serpapi", "unknown", "SerpAPI returned an unreadable response");

  if (data.error) {
    // "Google hasn't returned any results for this query." is not a failure.
    // It is a 200 response meaning Google Shopping Canada has nothing for
    // these exact words — which happens constantly with long, specific
    // product names ("Samsonite Rhapsody 360 Spinner Expandable Medium
    // Luggage Black"). Throwing here turned a normal empty result into a
    // red error and stopped the caller from retrying with broader terms.
    if (isNoResults(data.error)) return [];

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
      const resolved = resolveOfferUrl(r);
      const price = priceOf(r);

      // An offer needs a price and somewhere to send the buyer. Nothing
      // stricter — being stricter than this is how a 40-listing response
      // became an empty search page.
      if (!resolved) return null;
      if (price <= 0) return null;

      const url = resolved.url;

      const source = r.source ?? "";

      // Only let the URL identify the retailer when it IS the retailer's.
      // Otherwise a Google Shopping link would make the retailer read
      // "google.com" on the card.
      const identityUrl = resolved.direct ? url : "";

      return {
        retailer: displayRetailer(source, identityUrl),
        retailerKey: matchRetailer(source, identityUrl),
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
