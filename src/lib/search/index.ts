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
import { PRIORITY_RETAILERS, isPriorityRetailer, retailerRank } from "@/lib/retailers";
import { clusterOffers } from "./cluster";
import { parseQuery } from "./parse";
import * as geminiProvider from "./providers/gemini-grounded";
import * as serpProvider from "./providers/serpapi";
import * as serperProvider from "./providers/serper";
import {
  QuotaExhaustedError,
  cacheKey,
  readCache,
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
   * compare (default): cheapest live listings — Search Products.
   * catalog: variant discovery (type / size / colour) — Tracked Products.
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
      return geminiProvider.geminiGroundedConfigured();
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
): Promise<{ offers: Offer[]; warnings: string[] }> {
  switch (provider) {
    case "serper":
      return { offers: await serperProvider.fetchOffers(intent), warnings: [] };
    case "serpapi":
      return { offers: await serpProvider.fetchOffers(intent), warnings: [] };
    case "gemini-grounded":
      return geminiProvider.fetchOffers(intent);
    default:
      throw new NoProviderError(`Unknown provider: ${provider}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Ranking                                                           */
/* ------------------------------------------------------------------ */

/**
 * Trim a product's offer list without ever dropping a priority retailer.
 * Amazon / Walmart / Costco / Samsonite etc. stay whenever they carry the item.
 */
function capOffers(offers: Offer[]): Offer[] {
  if (offers.length <= MAX_OFFERS_PER_PRODUCT) return offers;

  const protectedOffers = offers.filter(
    (o) => isPriorityRetailer(o.retailerKey) || isPriorityRetailer(o.retailer),
  );
  const rest = offers.filter((o) => !protectedOffers.includes(o));

  const kept = [
    ...protectedOffers,
    ...rest.slice(0, Math.max(0, MAX_OFFERS_PER_PRODUCT - protectedOffers.length)),
  ];
  return kept.sort((a, b) => a.price - b.price);
}

function applyRetailerFilter(products: SearchProduct[], allowed: string[]): SearchProduct[] {
  if (allowed.length === 0) return products;
  const set = new Set(allowed);

  return products
    .map((p) => {
      const offers = p.offers.filter((o) => o.retailerKey !== null && set.has(o.retailerKey));
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
          (o) => isPriorityRetailer(o.retailerKey) || isPriorityRetailer(o.retailer),
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
 * Rank products for the Search Products (compare) page.
 * Priority-retailer coverage first, then the lowest live price.
 */
function rankCompareProducts(products: SearchProduct[]): SearchProduct[] {
  return [...products].sort((a, b) => {
    if (a.hasMajorRetailer !== b.hasMajorRetailer) return a.hasMajorRetailer ? -1 : 1;
    if (a.lowestPrice !== b.lowestPrice) return a.lowestPrice - b.lowestPrice;
    if (a.retailerCount !== b.retailerCount) return b.retailerCount - a.retailerCount;
    return a.name.localeCompare(b.name);
  });
}

function sizeSortValue(size: string): number {
  const n = Number.parseFloat(size);
  if (Number.isFinite(n)) return n;
  if (/carry/i.test(size)) return 20;
  if (/medium/i.test(size)) return 25;
  if (/large|check/i.test(size)) return 28;
  if (/set/i.test(size)) return 90;
  return 50;
}

/** Rank variants for the Tracked catalog: family together, size then colour. */
function rankCatalogProducts(products: SearchProduct[]): SearchProduct[] {
  return [...products].sort((a, b) => {
    const brand = a.brand.localeCompare(b.brand);
    if (brand !== 0) return brand;
    const model = a.model.localeCompare(b.model);
    if (model !== 0) return model;
    const size = sizeSortValue(a.size) - sizeSortValue(b.size);
    if (size !== 0) return size;
    const color = a.color.localeCompare(b.color);
    if (color !== 0) return color;
    return a.lowestPrice - b.lowestPrice;
  });
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

  const mode: SearchMode = opts.mode ?? "compare";
  const limit = opts.limit ?? (mode === "catalog" ? 20 : DEFAULT_LIMIT);

  // Compare mode always keeps Amazon / Walmart / Samsonite etc. in play,
  // even if the user unchecked them in Settings.
  let allowedRetailers = opts.allowedRetailers ?? [];
  if (mode === "compare" && allowedRetailers.length > 0) {
    allowedRetailers = [...new Set([...allowedRetailers, ...PRIORITY_RETAILERS])];
  }

  const available = configuredProviders();
  if (available.length === 0) {
    throw new NoProviderError(
      "No price source is configured. Add a SERPER_API_KEY (2,500 free searches) or SERPAPI_KEY (250 free per month) to search live retailer prices.",
    );
  }

  // ── Cache first: a repeat search should cost nothing ─────────
  const key = cacheKey(trimmed, allowedRetailers, limit, mode);

  if (!opts.bypassCache) {
    const hit = await readCache(opts.db, key);
    if (hit) {
      return {
        ...hit.response,
        cached: { fetchedAt: hit.fetchedAt, ageMinutes: hit.ageMinutes },
      };
    }
  }

  const warnings: string[] = [];
  const intent = await parseQuery(trimmed, mode);

  // ── Try each configured provider in order ────────────────────
  let offers: Offer[] = [];
  let usedProvider: ProviderName | null = null;
  const failures: string[] = [];

  for (const provider of available) {
    // Respect the free allowance before spending a call.
    try {
      await reserveCall(opts.db, provider);
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        failures.push(err.message);
        continue;
      }
      throw err;
    }

    try {
      const result = await fetchFromProvider(provider, intent);
      offers = result.offers;
      warnings.push(...result.warnings);
      usedProvider = provider;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Provider failed";
      failures.push(`${providerLabel(provider)}: ${message}`);
      // Try the next provider rather than failing the whole search.
    }
  }

  if (!usedProvider) {
    throw new NoProviderError(
      failures.length > 0
        ? failures.join(" · ")
        : "Every configured price source failed.",
    );
  }

  // Mention any provider we had to skip past, so a silent downgrade
  // (or an exhausted allowance) is visible rather than mysterious.
  if (failures.length > 0) warnings.unshift(...failures);

  const response = await finish(trimmed, intent, usedProvider, offers, warnings, {
    allowedRetailers,
    limit,
    mode,
  });

  if (response.products.length > 0) {
    await writeCache(opts.db, key, response, opts.cacheTtlMinutes);
  }

  return response;
}

async function finish(
  query: string,
  intent: SearchIntent,
  provider: ProviderName,
  offers: Offer[],
  warnings: string[],
  opts: { allowedRetailers: string[]; limit: number; mode: SearchMode },
): Promise<SearchResponse> {
  const offersFound = offers.length;

  if (offersFound === 0) {
    return { query, intent, provider, products: [], offersFound: 0, warnings };
  }

  // ── Cluster into products ────────────────────────────────────
  let products = await clusterOffers(offers, opts.mode);

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
  const ranked =
    opts.mode === "catalog" ? rankCatalogProducts(products) : rankCompareProducts(products);

  products = ranked
    .slice(0, opts.limit)
    .map((p) => ({ ...p, offers: sortOffers(capOffers(p.offers)) }));

  return { query, intent, provider, products, offersFound, warnings };
}

export { getBudget, getAllBudgets, QuotaExhaustedError } from "./quota";
export type { ProviderBudget } from "./quota";
export type { SearchProduct, SearchResponse, SearchIntent, SearchMode, Offer } from "./types";
export { NoProviderError } from "./types";
