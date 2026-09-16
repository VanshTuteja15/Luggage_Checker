/* ------------------------------------------------------------------ */
/*  Search pipeline orchestrator                                      */
/*                                                                     */
/*    natural language query                                           */
/*      → cache lookup          (free)                                 */
/*      → parse intent          (LLM)                                  */
/*      → fetch real offers     (serper → serpapi → grounded Gemini)   */
/*      → cluster into products (LLM)                                  */
/*      → filter + rank         (deterministic)                        */
/*      → cache + return top N                                         */
/*                                                                     */
/*  Prices only ever come from the fetch step.                         */
/* ------------------------------------------------------------------ */

import type { SupabaseClient } from "@supabase/supabase-js";
import { RETAILER_INFO, retailerRank } from "@/lib/retailers";
import { broadenLadder, broadenedNotice } from "./broaden";
import { clusterOffers } from "./cluster";
import { parseQuery } from "./parse";
import * as geminiProvider from "./providers/gemini-grounded";
import * as serpProvider from "./providers/serpapi";
import * as serperProvider from "./providers/serper";
import { Deadline, NO_METER, type Meter } from "./deadline";
import { ProviderError } from "./errors";
import {
  QuotaExhaustedError,
  cacheKey,
  readCache,
  refundCall,
  reserveCall,
  writeCache,
} from "./quota";
import {
  NoProviderError,
  type Offer,
  type ProviderName,
  type SearchIntent,
  type SearchMode,
  type SearchProduct,
  type SearchResponse,
} from "./types";

/** Max offers kept per product. Majors are protected from this cap. */
const MAX_OFFERS_PER_PRODUCT = 10;

/** Default number of products returned. */
const DEFAULT_LIMIT = 10;

/**
 * Total wall-clock budget for one search.
 *
 * The route allows 60s — but that 60s covers the WHOLE request, and this
 * budget only starts once search() is entered. Authenticating the caller
 * happens first, and on a slow Supabase connection that alone was taking
 * 5-11 seconds. A 50s budget plus 11s of auth is 61s: over the ceiling,
 * killed mid-flight, after the provider had already been billed.
 *
 * 38s leaves real headroom for auth before and serialising the response
 * after. Raise it with SEARCH_BUDGET_MS if your Supabase is fast.
 */
function searchBudgetMs(): number {
  const raw = Number(process.env.SEARCH_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 38_000;
}

/**
 * How many provider calls one search may spend widening the query.
 *
 * Each rung costs one call from a small free allowance, so this is
 * deliberately tight: the original query, plus at most two broader ones.
 * In practice the second rung almost always lands, because the usual
 * reason for an empty result is a colour or a size word in the title.
 */
function maxQueryAttempts(): number {
  const raw = Number(process.env.SEARCH_MAX_ATTEMPTS);
  if (Number.isFinite(raw) && raw >= 1) return Math.min(raw, 5);
  return 3;
}

/** Enough time left to be worth spending another call on a broader query. */
const MIN_MS_FOR_ANOTHER_ATTEMPT = 12_000;


/* ------------------------------------------------------------------ */
/*  Stage timing                                                      */
/*                                                                     */
/*  When a search fails slowly, the only question that matters is      */
/*  WHICH STAGE ate the time — and from a screenshot of a red banner   */
/*  that is unknowable. So every search logs its own breakdown:        */
/*                                                                     */
/*    [search] "samsonite luggage" cache=2503ms parse=1840ms           */
/*             fetch=24110ms cluster=9900ms total=38353ms  serpapi     */
/*                                                                     */
/*  One line, server-side, every time. No guessing.                    */
/* ------------------------------------------------------------------ */

class StageTimer {
  private readonly startedAt = Date.now();
  private readonly stages: [string, number][] = [];
  private mark = Date.now();

  /** Record the time spent since the previous stage ended. */
  lap(name: string): void {
    const now = Date.now();
    this.stages.push([name, now - this.mark]);
    this.mark = now;
  }

  get totalMs(): number {
    return Date.now() - this.startedAt;
  }

  report(query: string, extra = ""): void {
    const parts = this.stages
      .filter(([, ms]) => ms >= 1)
      .map(([name, ms]) => `${name}=${ms}ms`)
      .join(" ");
    console.info(
      `[search] ${JSON.stringify(query)} ${parts} total=${this.totalMs}ms${extra ? ` ${extra}` : ""}`,
    );
  }
}

export type SearchOptions = {
  /** Restrict results to these canonical retailer names. Empty = all. */
  allowedRetailers?: string[];
  /** How many products to return. */
  limit?: number;
  /** Supabase handle for caching and quota metering. Omit to disable both. */
  db?: SupabaseClient;
  /** Skip the cache and force a fresh provider call. */
  bypassCache?: boolean;
  /** Override the cache lifetime for this search. */
  cacheTtlMinutes?: number;
  /**
   * "compare" (default) groups colours of one model together to show where
   * it is cheapest. "catalog" keeps each colour separate, for browsing a
   * brand's range and picking a variant to track.
   */
  mode?: SearchMode;
};

/**
 * Providers in preference order.
 *
 * Serper first: its free allowance is an order of magnitude larger, so
 * spending it before SerpAPI's small recurring one leaves the renewable
 * source intact for the long run.
 */
const PROVIDER_ORDER: ProviderName[] = ["serper", "serpapi", "gemini-grounded"];

export function providerConfigured(provider: ProviderName): boolean {
  switch (provider) {
    case "serper":
      return serperProvider.serperConfigured();
    case "serpapi":
      return serpProvider.serpApiConfigured();
    case "gemini-grounded":
      // Opt-in only. Grounding needs a billing-enabled Google project, so on
      // a free key it fails every single time. Leaving it in the chain by
      // default meant every transient SerpAPI blip produced a compound error
      // ending in a paragraph about Google billing the user doesn't need.
      return (
        process.env.ENABLE_GEMINI_GROUNDED_SEARCH === "true" &&
        geminiProvider.geminiGroundedConfigured()
      );
    default:
      return false;
  }
}

/** Every provider that has a key configured, in preference order. */
export function configuredProviders(): ProviderName[] {
  return PROVIDER_ORDER.filter(providerConfigured);
}

/** The provider that would serve a search right now. */
export function activeProvider(): ProviderName | null {
  return configuredProviders()[0] ?? null;
}

export function providerLabel(p: ProviderName): string {
  switch (p) {
    case "serper":
      return "Google Shopping";
    case "serpapi":
      return "Google Shopping";
    case "gemini-grounded":
      return "AI web search";
    default:
      return p;
  }
}

/* ------------------------------------------------------------------ */
/*  Fetching                                                          */
/* ------------------------------------------------------------------ */

async function fetchFromProvider(
  provider: ProviderName,
  intent: SearchIntent,
  ctx: { deadline: Deadline; meter: Meter },
): Promise<{ offers: Offer[]; warnings: string[] }> {
  switch (provider) {
    case "serper":
      // Serper has no internal retry, so the caller's single reservation is
      // already exact.
      await ctx.meter.beforeAttempt();
      return { offers: await serperProvider.fetchOffers(intent), warnings: [] };
    case "serpapi":
      // Meters itself per HTTP attempt, because it retries internally.
      return {
        offers: await serpProvider.fetchOffers(intent, {
          deadline: ctx.deadline,
          meter: ctx.meter,
        }),
        warnings: [],
      };
    case "gemini-grounded":
      await ctx.meter.beforeAttempt();
      return geminiProvider.fetchOffers(intent);
    default:
      throw new NoProviderError(`Unknown provider: ${provider}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Ranking                                                           */
/* ------------------------------------------------------------------ */

/**
 * Trim a product's offer list without ever dropping a major retailer.
 * The client explicitly wants Amazon / Walmart / Costco / Samsonite etc.
 * represented whenever they carry the item.
 */
function capOffers(offers: Offer[]): Offer[] {
  if (offers.length <= MAX_OFFERS_PER_PRODUCT) return offers;

  const majors = offers.filter(
    (o) => o.retailerKey && RETAILER_INFO[o.retailerKey]?.category === "major",
  );
  const rest = offers.filter((o) => !majors.includes(o));

  const kept = [...majors, ...rest.slice(0, Math.max(0, MAX_OFFERS_PER_PRODUCT - majors.length))];
  return kept.sort((a, b) => a.price - b.price);
}

/**
 * Recompute a product's headline numbers from the offers it actually shows.
 *
 * `capOffers` can remove offers after `buildProduct` has already computed
 * the summary, which left cards claiming "12 retailers, $189–$549" above a
 * list of 10 offers topping out at $420. On a price-comparison tool the
 * headline number IS the product, so it has to be derived from what's on
 * screen, not from what was on screen earlier.
 */
function withRecomputedSummary(product: SearchProduct): SearchProduct {
  const prices = product.offers.map((o) => o.price);
  if (prices.length === 0) return product;

  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);

  return {
    ...product,
    lowestPrice: lowest,
    highestPrice: highest,
    retailerCount: product.offers.length,
    spread: Math.round((highest - lowest) * 100) / 100,
    hasMajorRetailer: product.offers.some(
      (o) => o.retailerKey !== null && RETAILER_INFO[o.retailerKey]?.category === "major",
    ),
  };
}

function applyRetailerFilter(products: SearchProduct[], allowed: string[]): SearchProduct[] {
  if (allowed.length === 0) return products;
  const set = new Set(allowed);

  return products
    .map((p) => {
      // Keep offers from retailers outside our registry: the user disabled
      // named retailers, not ones we can't identify. Filtering those out too
      // turned "38 listings found" into "no products" whenever a search hit
      // mostly independent Canadian sellers.
      const offers = p.offers.filter((o) => o.retailerKey === null || set.has(o.retailerKey));
      if (offers.length === 0) return null;
      const prices = offers.map((o) => o.price);
      const lowest = Math.min(...prices);
      const highest = Math.max(...prices);
      return {
        ...p,
        offers,
        lowestPrice: lowest,
        highestPrice: highest,
        retailerCount: offers.length,
        spread: Math.round((highest - lowest) * 100) / 100,
        hasMajorRetailer: offers.some(
          (o) => o.retailerKey !== null && RETAILER_INFO[o.retailerKey]?.category === "major",
        ),
      };
    })
    .filter((p): p is SearchProduct => p !== null);
}

function applyPriceFilter(products: SearchProduct[], intent: SearchIntent): SearchProduct[] {
  const { minPrice, maxPrice } = intent;
  if (minPrice === null && maxPrice === null) return products;

  return products.filter((p) => {
    if (maxPrice !== null && p.lowestPrice > maxPrice) return false;
    if (minPrice !== null && p.lowestPrice < minPrice) return false;
    return true;
  });
}

/**
 * Rank products for display.
 *
 * A product carried by a major retailer outranks one that isn't; among
 * those, wider retailer coverage wins (that's what makes a price
 * comparison useful); then the lowest price.
 */
function rankProducts(products: SearchProduct[]): SearchProduct[] {
  return [...products].sort((a, b) => {
    if (a.hasMajorRetailer !== b.hasMajorRetailer) return a.hasMajorRetailer ? -1 : 1;
    if (a.retailerCount !== b.retailerCount) return b.retailerCount - a.retailerCount;
    if (a.lowestPrice !== b.lowestPrice) return a.lowestPrice - b.lowestPrice;
    return a.name.localeCompare(b.name);
  });
}

/**
 * The shortest sensible query to show a user whose search found nothing:
 * brand plus the model line. Returns "" when the query is already that short.
 */
function suggestShorterQuery(terms: string): string {
  const ladder = broadenLadder(terms);
  const shortest = ladder[ladder.length - 1];
  return shortest && shortest.toLowerCase() !== terms.toLowerCase() ? shortest : "";
}

/** Order a product's offers: cheapest first, majors breaking ties. */
function sortOffers(offers: Offer[]): Offer[] {
  return [...offers].sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    return retailerRank(a.retailer) - retailerRank(b.retailer);
  });
}

/* ------------------------------------------------------------------ */
/*  Entry point                                                       */
/* ------------------------------------------------------------------ */

export async function search(query: string, opts: SearchOptions = {}): Promise<SearchResponse> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Search query is empty");

  const allowedRetailers = opts.allowedRetailers ?? [];
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const available = configuredProviders();
  if (available.length === 0) {
    throw new NoProviderError(
      "No price source is configured. Add a SERPER_API_KEY (2,500 free searches) or SERPAPI_KEY (250 free per month) to search live retailer prices.",
    );
  }

  const timer = new StageTimer();

  // ── Cache first: a repeat search should cost nothing ─────────
  const mode: SearchMode = opts.mode ?? "compare";

  // Mode changes the grouping, so it has to be part of the cache identity —
  // otherwise a compare search would serve its merged rows to a catalog one.
  const key = cacheKey(`${trimmed}::${mode}`, allowedRetailers, limit);

  if (!opts.bypassCache) {
    const hit = await readCache(opts.db, key);
    timer.lap("cache");
    if (hit) {
      timer.report(trimmed, "CACHE HIT");
      return {
        ...hit.response,
        cached: { fetchedAt: hit.fetchedAt, ageMinutes: hit.ageMinutes },
      };
    }
  }

  const warnings: string[] = [];

  // One shared clock for the whole pipeline.
  const deadline = Deadline.in(searchBudgetMs());

  // Query parsing is a nicety — never let it eat the fetch's time.
  //
  // Reserve is deliberately large: the shopping call is the only step that
  // produces prices, and it needs a real window (25s, plus room to widen
  // the query if Google has no match). Parsing gets whatever is left over
  // up to 6s, and falls back to the regex parser when that isn't enough.
  const intent = await parseQuery(trimmed, {
    timeoutMs: deadline.budget(6_000, 40_000),
  });
  timer.lap("parse");

  // ── Try each configured provider in order ────────────────────
  //
  // Within a provider, the query itself is retried in progressively
  // broader forms: Google returning nothing for a retailer's full product
  // title is normal, not an error, and the bag is usually right there
  // under a shorter name.
  const ladder = broadenLadder(intent.terms);
  const attemptLimit = Math.min(maxQueryAttempts(), ladder.length);

  let offers: Offer[] = [];
  let usedProvider: ProviderName | null = null;
  let usedTerms = intent.terms;
  const failures: string[] = [];

  for (const provider of available) {
    if (deadline.expired) {
      failures.push("The search took too long. Try again.");
      break;
    }

    // Meters every billable HTTP attempt, not just one per provider —
    // a provider that retries internally spends two searches, and the
    // counter has to reflect that.
    let quotaError: QuotaExhaustedError | null = null;
    const meter: Meter = {
      beforeAttempt: async () => {
        try {
          await reserveCall(opts.db, provider);
        } catch (err) {
          if (err instanceof QuotaExhaustedError) quotaError = err;
          throw err;
        }
      },
      refundAttempt: async () => refundCall(opts.db, provider),
    };

    try {
      let result: { offers: Offer[]; warnings: string[] } = { offers: [], warnings: [] };

      for (let rung = 0; rung < attemptLimit; rung++) {
        const terms = ladder[rung];

        result = await fetchFromProvider(provider, { ...intent, terms }, { deadline, meter });

        if (result.offers.length > 0) {
          usedTerms = terms;
          // Say so plainly. A price comparison the client didn't ask for is
          // worse than no result if they don't realise the words changed.
          if (rung > 0) warnings.push(broadenedNotice(intent.terms, terms));
          break;
        }

        // Empty, not failed. Widen — but only while there is genuinely
        // time and another rung left worth paying for.
        if (rung + 1 >= attemptLimit) break;
        if (!deadline.hasAtLeast(MIN_MS_FOR_ANOTHER_ATTEMPT)) break;
      }

      offers = result.offers;
      warnings.push(...result.warnings);
      usedProvider = provider;
      break;
    } catch (err) {
      // A call that never reached the provider must not cost the user a
      // search. ProviderError knows which failures are billable; anything
      // unclassified is assumed billable, so we don't undercount.
      if (quotaError) {
        failures.push((quotaError as QuotaExhaustedError).message);
      } else if (err instanceof ProviderError) {
        // The provider already refunded its own non-billable attempts.
        failures.push(err.userMessage);
      } else if (err instanceof QuotaExhaustedError) {
        failures.push(err.message);
      } else {
        failures.push(
          `${providerLabel(provider)}: ${err instanceof Error ? err.message : "failed"}`,
        );
      }
      // Try the next provider rather than failing the whole search.
    }
  }

  timer.lap("fetch");

  if (!usedProvider) {
    timer.report(trimmed, `FAILED: ${failures[0] ?? "no provider"}`);
    // Lead with the fix, not the symptom.
    //
    // Gemini grounding needs a billing-enabled project, so on a free key it
    // always fails. If it was the only provider available, the useful message
    // is "add a shopping key" — not a paragraph about Google billing, which
    // sends people off to enable billing they don't need.
    const hasShoppingProvider = available.some(
      (p) => p === "serper" || p === "serpapi",
    );

    if (!hasShoppingProvider) {
      throw new NoProviderError(
        "No shopping price source is configured. Add SERPER_API_KEY (2,500 free searches) " +
          "or SERPAPI_KEY (250 free per month) to .env.local and restart the dev server — " +
          "note that Next.js only reads .env.local at startup, so a restart is required. " +
          "Both are free and neither needs a credit card.",
      );
    }

    // One clear sentence, not a concatenation of every provider's failure.
    throw new NoProviderError(failures[0] ?? "The price service couldn't be reached.");
  }

  // Mention any provider we had to skip past, so a silent downgrade
  // (or an exhausted allowance) is visible rather than mysterious.
  if (failures.length > 0) warnings.unshift(...failures);

  const response = await finish(trimmed, intent, usedProvider, offers, warnings, {
    allowedRetailers,
    limit,
    deadline,
    mode,
    broadestTried: ladder[Math.min(attemptLimit, ladder.length) - 1] ?? usedTerms,
  });

  timer.lap("cluster");

  // Cache writes are pure optimisation for the NEXT search. Awaiting one on
  // a slow connection made the user wait seconds for a result already
  // computed, so it runs in the background and its failure is ignored.
  if (response.products.length > 0) {
    void writeCache(opts.db, key, response, opts.cacheTtlMinutes).catch(() => undefined);
  }

  timer.report(
    trimmed,
    `${usedProvider} offers=${response.offersFound} products=${response.products.length}`,
  );

  return response;
}

async function finish(
  query: string,
  intent: SearchIntent,
  provider: ProviderName,
  offers: Offer[],
  warnings: string[],
  opts: {
    allowedRetailers: string[];
    limit: number;
    deadline: Deadline;
    mode: SearchMode;
    broadestTried: string;
  },
): Promise<SearchResponse> {
  const offersFound = offers.length;

  if (offersFound === 0) {
    // Nothing found even after widening. This is an ordinary outcome, not a
    // failure — so say what was tried and what to type instead, rather than
    // surfacing a provider error string the client can do nothing with.
    const suggestion = suggestShorterQuery(intent.terms);
    warnings.push(
      suggestion
        ? `No Canadian retailer listings found for "${intent.terms}" (we also tried "${opts.broadestTried}"). Try just the brand and model — for example "${suggestion}".`
        : `No Canadian retailer listings found for "${intent.terms}".`,
    );
    return { query, intent, provider, products: [], offersFound: 0, warnings };
  }

  // ── Cluster into products ────────────────────────────────────
  // Whatever time is left is the clustering budget. If it runs out the
  // heuristic grouping takes over, so we still return real prices rather
  // than nothing.
  // Grouping is the last step and the least essential: the prices are
  // already in hand, and the heuristic grouping is instant. 22s of budget
  // meant a hanging Gemini could add 22 seconds to a search that had
  // everything it needed — so keep this short and fall back quickly.
  let products = await clusterOffers(offers, {
    timeoutMs: opts.deadline.budget(12_000, 1_500),
    mode: opts.mode,
  });

  // ── Filter ───────────────────────────────────────────────────
  const beforeRetailerFilter = products.length;
  products = applyRetailerFilter(products, opts.allowedRetailers);
  if (beforeRetailerFilter > 0 && products.length === 0) {
    warnings.push(
      "Every result was filtered out by your retailer settings. Enable more retailers in Settings to see them.",
    );
  }

  const beforePriceFilter = products.length;
  products = applyPriceFilter(products, intent);
  if (beforePriceFilter > 0 && products.length === 0 && intent.maxPrice !== null) {
    warnings.push(`Nothing found under $${intent.maxPrice.toFixed(2)}.`);
  }

  // ── Rank and trim ────────────────────────────────────────────
  products = rankProducts(products)
    .slice(0, opts.limit)
    .map((p) => withRecomputedSummary({ ...p, offers: sortOffers(capOffers(p.offers)) }));

  return { query, intent, provider, products, offersFound, warnings };
}

export { getBudget, getAllBudgets, QuotaExhaustedError } from "./quota";
export type { ProviderBudget } from "./quota";
export type { SearchProduct, SearchResponse, SearchIntent, Offer } from "./types";
export { NoProviderError } from "./types";
