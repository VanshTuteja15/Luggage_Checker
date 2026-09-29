/* ------------------------------------------------------------------ */
/*  Search pipeline orchestrator                                      */
/*                                                                     */
/*    natural language query                                           */
/*      → cache lookup          (free)                                 */
/*      → parse intent          (plain queries skip the LLM)           */
/*      → web research          (2 Tavily searches in parallel)        */
/*      → first results         (streamed to the page right away)      */
/*      → read store pages      (product pages that had no price)      */
/*      → group into products   (instant heuristic; AI opt-in)         */
/*      → filter + rank         (best match first, then lowest price)  */
/*      → cache + return top N                                         */
/*                                                                     */
/*  Prices only ever come from retailer pages the research step read,  */
/*  and each keeps the words it was read from as evidence.             */
/*                                                                     */
/*  Read-only: this module never creates or imports products. Tracking */
/*  a result is a separate workflow (/api/track).                      */
/* ------------------------------------------------------------------ */

import type { SupabaseClient } from "@supabase/supabase-js";
import { RETAILER_INFO, retailerRank } from "@/lib/retailers";
import { broadenLadder, broadenedNotice } from "./broaden";
import { clusterOffers } from "./cluster";
import { isAccessoryTitle, queryMatch } from "./extract";
import { parseQuery } from "./parse";
import * as tavilyProvider from "./providers/tavily";
import type { TavilyExtractResponse, TavilySearchRequest, TavilySearchResponse } from "@/lib/tavily";
import { Deadline, type Meter } from "./deadline";
import { ProviderError } from "./errors";
import {
  QuotaExhaustedError,
  adjustCall,
  cacheKey,
  readCache,
  refundCall,
  reserveCall,
  writeCache,
} from "./quota";
import {
  NoProviderError,
  type AlsoCheck,
  type LuggageDetails,
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
  if (Number.isFinite(raw) && raw >= 1) return Math.min(raw, 3);
  // The original query plus at most one broader one — and the broader one
  // only runs when the first returned no pages at all.
  return 2;
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
  /**
   * Diagnostics only: called with the raw research request and response.
   * Lets the live smoke test show exactly what the app received, without
   * a second (billable) call.
   */
  onResearch?: (info: { request: TavilySearchRequest; response: TavilySearchResponse }) => void;
  /** Diagnostics only: the page-reading request and what came back. */
  onExtract?: (info: { urls: string[]; response: TavilyExtractResponse }) => void;
  /**
   * Called with the first results while store pages are still being read,
   * so the page can show them immediately. Not called for cache hits or
   * when there's nothing left to read.
   */
  onPartial?: (response: SearchResponse) => void;
  /**
   * "full" (default): general search + major-chains search + page reading.
   * "lite": one search and at most 3 pages read — for scheduled price
   * checks, where every tracked product costs credits every day.
   */
  depth?: "full" | "lite";
};

/**
 * Research providers in preference order. Tavily is the only one: SerpAPI
 * and Serper are retired for product research, and Gemini grounding needs
 * a billing-enabled Google project, which the $0 budget rules out.
 */
const PROVIDER_ORDER: ProviderName[] = ["tavily"];

export function providerConfigured(provider: ProviderName): boolean {
  switch (provider) {
    case "tavily":
      return tavilyProvider.tavilyProviderConfigured();
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
    case "tavily":
      return "Live web research";
    case "serper":
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

type ProviderResult = {
  offers: Offer[];
  warnings: string[];
  /** Raw pages/listings returned. 0 means "nothing found", not "nothing usable". */
  resultCount: number;
  creditsUsed: number;
  /** Store product pages found without a price in their excerpt. */
  unread: tavilyProvider.UnreadPage[];
};

async function fetchFromProvider(
  provider: ProviderName,
  intent: SearchIntent,
  ctx: {
    deadline: Deadline;
    meter: Meter;
    bypassCache?: boolean;
    onResearch?: SearchOptions["onResearch"];
    sweep?: boolean;
    maxReads?: number;
  },
): Promise<ProviderResult> {
  switch (provider) {
    case "tavily":
      // Meters itself per HTTP attempt, in credits, and reconciles with the
      // cost Tavily reports.
      return tavilyProvider.fetchOffers(intent, ctx);
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
 * Rank products for display: the products that match what was searched
 * come first, and within those the LOWEST PRICE leads. Accessories that
 * merely mention the model ("… luggage cover") and partial matches follow.
 */
function rankProducts(products: SearchProduct[], terms: string): SearchProduct[] {
  const wantsAccessory = isAccessoryTitle(terms);
  const tier = (p: SearchProduct): number => {
    const accessory = !wantsAccessory && isAccessoryTitle(p.name);
    const full = (p.relevance ?? 1) >= 0.99;
    return accessory ? 2 : full ? 0 : 1;
  };

  return [...products].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (a.lowestPrice !== b.lowestPrice) return a.lowestPrice - b.lowestPrice;
    if (a.retailerCount !== b.retailerCount) return b.retailerCount - a.retailerCount;
    return a.name.localeCompare(b.name);
  });
}

/** How well a product's name (and brand) covers the searched words. */
function withRelevance(product: SearchProduct, terms: string): SearchProduct {
  return {
    ...product,
    relevance: Math.round(queryMatch(`${product.brand} ${product.name}`, terms) * 100) / 100,
  };
}

/**
 * Drop prices that can't belong to the same product as the rest.
 *
 * Reading prices from open-web pages occasionally picks up an accessory's
 * price or a whole set's. With three or more retailers for one product, a
 * price under 40% or over 250% of the median is far more likely a
 * misreading than a real deal — and a fake "lowest price" is the worst
 * thing this tool could show.
 */
function dropPriceOutliers(product: SearchProduct): SearchProduct {
  if (product.offers.length < 3) return product;

  const sorted = product.offers.map((o) => o.price).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const kept = product.offers.filter((o) => o.price >= median * 0.4 && o.price <= median * 2.5);
  return kept.length === product.offers.length || kept.length === 0
    ? product
    : withRecomputedSummary({ ...product, offers: kept });
}

/**
 * Merge the specs each retailer page listed into one set for the product.
 * The brand's own store is trusted first, then majors, then everyone else;
 * a field is only filled from a page that stated it.
 */
function attachDetails(product: SearchProduct): SearchProduct {
  const ordered = [...product.offers].sort(
    (a, b) => detailTrust(a) - detailTrust(b),
  );

  const merged: LuggageDetails = {};
  for (const o of ordered) {
    if (!o.details) continue;
    for (const [k, v] of Object.entries(o.details) as [keyof LuggageDetails, unknown][]) {
      if (merged[k] === undefined && v !== undefined) {
        (merged as Record<string, unknown>)[k] = v;
      }
    }
  }
  return Object.keys(merged).length > 0 ? { ...product, details: merged } : product;
}

function detailTrust(o: Offer): number {
  const category = o.retailerKey ? RETAILER_INFO[o.retailerKey]?.category : undefined;
  if (category === "specialty") return 0; // brand-direct: Samsonite.ca, TUMI…
  if (category === "major") return 1;
  return 2;
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
      "No research provider is configured. Add TAVILY_API_KEY to .env.local (free: 1,000 credits a month, no card) and restart the dev server.",
    );
  }

  const timer = new StageTimer();

  // ── Cache first: a repeat search should cost nothing ─────────
  const mode: SearchMode = opts.mode ?? "compare";

  // Mode changes the grouping, so it has to be part of the cache identity —
  // otherwise a compare search would serve its merged rows to a catalog one.
  const lite = opts.depth === "lite";
  const key = cacheKey(`${trimmed} ::mode:${mode}${lite ? " ::lite" : ""}`, allowedRetailers, limit);

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

  // ── Research ─────────────────────────────────────────────────
  //
  // Within a provider, the query is retried in a broader form ONLY when the
  // first found no pages at all. Pages found but no price readable is a
  // different problem, and a broader query would just spend a credit on
  // similar pages.
  const ladder = broadenLadder(intent.terms);
  const attemptLimit = Math.min(maxQueryAttempts(), ladder.length);

  let offers: Offer[] = [];
  let unread: tavilyProvider.UnreadPage[] = [];
  let resultCount = 0;
  let creditsUsed = 0;
  let usedMeter: Meter | undefined;
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
      beforeAttempt: async (units = 1) => {
        try {
          await reserveCall(opts.db, provider, units);
        } catch (err) {
          if (err instanceof QuotaExhaustedError) quotaError = err;
          throw err;
        }
      },
      refundAttempt: async (units = 1) => refundCall(opts.db, provider, units),
      reconcile: async (delta) => adjustCall(opts.db, provider, delta),
    };

    try {
      let result: ProviderResult = { offers: [], warnings: [], resultCount: 0, creditsUsed: 0, unread: [] };

      for (let rung = 0; rung < attemptLimit; rung++) {
        const terms = ladder[rung];

        result = await fetchFromProvider(provider, { ...intent, terms }, {
          deadline,
          meter,
          bypassCache: opts.bypassCache,
          onResearch: opts.onResearch,
          ...(lite ? { sweep: false, maxReads: 3 } : {}),
        });
        creditsUsed += result.creditsUsed;

        if (result.offers.length > 0 || result.unread.length > 0) {
          usedTerms = terms;
          // Say so plainly. A price comparison the client didn't ask for is
          // worse than no result if they don't realise the words changed.
          if (rung > 0) warnings.push(broadenedNotice(intent.terms, terms));
          break;
        }

        // Pages were found, just no readable price: a broader query would
        // find similar pages and cost another credit. Stop here.
        if (result.resultCount > 0) break;

        // Genuinely nothing. Widen — but only while there's time and a rung.
        if (rung + 1 >= attemptLimit) break;
        if (!deadline.hasAtLeast(MIN_MS_FOR_ANOTHER_ATTEMPT)) break;
      }

      offers = result.offers;
      unread = result.unread;
      resultCount = result.resultCount;
      usedMeter = meter;
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

  timer.lap("search");

  if (!usedProvider) {
    timer.report(trimmed, `FAILED: ${failures[0] ?? "no provider"}`);
    // One clear sentence, not a concatenation of every provider's failure.
    throw new NoProviderError(failures[0] ?? "The research service couldn't be reached.");
  }

  // Mention any provider we had to skip past, so a silent downgrade
  // (or an exhausted allowance) is visible rather than mysterious.
  if (failures.length > 0) warnings.unshift(...failures);

  const finishOpts = {
    allowedRetailers,
    limit,
    deadline,
    mode,
    broadestTried: ladder[Math.min(attemptLimit, ladder.length) - 1] ?? usedTerms,
  };
  const provider = usedProvider;

  // ── First results, then read the pages that had no price ─────
  let alsoCheckPages = unread;
  if (unread.length > 0) {
    if (opts.onPartial && offers.length > 0) {
      const partial = await finish(trimmed, intent, provider, offers, [...warnings], finishOpts);
      opts.onPartial({ ...partial, phase: "partial", creditsUsed });
    }

    const read = await tavilyProvider.readPages(unread, {
      deadline,
      meter: usedMeter,
      bypassCache: opts.bypassCache,
      onExtract: opts.onExtract,
    });
    offers = [...offers, ...read.offers];
    creditsUsed += read.creditsUsed;
    alsoCheckPages = read.stillUnread;
    timer.lap("read");
  }

  if (offers.length === 0 && resultCount > 0) {
    warnings.push(
      `Found ${resultCount} pages, but none showed a clear Canadian price for this item. ` +
        "Try the exact model name (for example “Samsonite Freeform 21”).",
    );
  }

  const response: SearchResponse = {
    ...(await finish(trimmed, intent, provider, offers, warnings, finishOpts)),
    alsoCheck: alsoCheckLinks(alsoCheckPages, intent.terms),
    phase: "final",
    creditsUsed,
  };

  timer.lap("group");

  // Cache writes are pure optimisation for the NEXT search. Awaiting one on
  // a slow connection made the user wait seconds for a result already
  // computed, so it runs in the background and its failure is ignored.
  //
  // Empty answers are cached too, briefly: otherwise every server instance
  // (and every scheduled run) would pay again for the same dead end.
  const ttl = response.products.length > 0 ? opts.cacheTtlMinutes : 30;
  void writeCache(opts.db, key, { ...response, creditsUsed: 0 }, ttl).catch(() => undefined);

  timer.report(
    trimmed,
    `${provider} credits=${creditsUsed} offers=${response.offersFound} products=${response.products.length} read=${unread.length}`,
  );

  return response;
}

/**
 * Store pages for the product that we couldn't read a price from — shown
 * as links, never as prices. Known stores only, closest matches first.
 */
function alsoCheckLinks(pages: tavilyProvider.UnreadPage[], terms: string): AlsoCheck[] {
  const seen = new Set<string>();
  const out: AlsoCheck[] = [];
  for (const u of pages) {
    if (!u.retailerKey || seen.has(u.retailer)) continue;
    if (queryMatch(`${u.retailer} ${u.page.title}`, terms) < 0.99) continue;
    seen.add(u.retailer);
    out.push({ retailer: u.retailer, url: u.page.url, title: u.page.title.slice(0, 120) });
    if (out.length >= 4) break;
  }
  return out;
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
    // The provider may already have explained (e.g. "found 12 pages, none
    // with a clear price"). Don't stack a second, contradictory hint on top.
    if (warnings.length === 0) warnings.push(
      suggestion
        ? `No Canadian retailer prices found for "${intent.terms}". Try just the brand and model — for example "${suggestion}".`
        : `No Canadian retailer prices found for "${intent.terms}".`,
    );
    return { query, intent, provider, products: [], offersFound: 0, warnings };
  }

  // ── Group into products ──────────────────────────────────────
  // The heuristic is instant. AI grouping (opt-in) gets at most 6s before
  // the heuristic takes over.
  let products = await clusterOffers(offers, {
    timeoutMs: opts.deadline.budget(6_000, 1_500),
    mode: opts.mode,
    brandHint: intent.brand ? titleCase(intent.brand) : null,
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

  // ── Sanity, specs, rank and trim ─────────────────────────────
  products = products
    .map(dropPriceOutliers)
    .map(attachDetails)
    .map((p) => withRelevance(p, intent.terms));

  products = rankProducts(products, intent.terms)
    .slice(0, opts.limit)
    .map((p) => withRecomputedSummary({ ...p, offers: sortOffers(capOffers(p.offers)) }));

  return { query, intent, provider, products, offersFound, warnings };
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export { getBudget, getAllBudgets, QuotaExhaustedError } from "./quota";
export type { ProviderBudget } from "./quota";
export type { SearchProduct, SearchResponse, SearchIntent, Offer } from "./types";
export { NoProviderError } from "./types";
