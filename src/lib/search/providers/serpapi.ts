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

  for (let attempt = 0; attempt < 2; attempt++) {
    // Never wait longer than the budget allows, and always leave a little
    // for parsing the response.
    // Two separate questions, previously conflated: is there enough budget
    // left to bother trying, and how long may this attempt take?
    // SerpAPI scrapes Google live and rarely answers in under ~5s, so a
    // 3s window was never going to succeed — it just spent a search from
    // the allowance to fail. Don't start an attempt we can't finish.
    const MIN_USEFUL_ATTEMPT_MS = 10_000;
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
    const nextAttemptNeeds = BACKOFF_MS + 5_000;
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
      // `link` is the merchant's own page. `product_link` is Google's
      // aggregate page for the product and is only worth having when it
      // isn't actually a google.com URL — which, in practice, it is.
      const candidate = r.link || r.product_link || "";
      const price = typeof r.extracted_price === "number" ? r.extracted_price : 0;

      // Drop anything without the two things that make an offer real: a
      // price, and a retailer page we can send a buyer to and re-check
      // tomorrow.
      if (!isMerchantUrl(candidate)) return null;
      if (!price || price <= 0) return null;

      const url = candidate;

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
