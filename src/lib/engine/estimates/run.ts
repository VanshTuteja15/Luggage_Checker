/* ------------------------------------------------------------------ */
/*  Finding web estimates (R3)                                         */
/*                                                                     */
/*  One Tavily search (search results and snippets only: no page text, */
/*  no Tavily extract, no visit to the store) for the stores we can't  */
/*  read live. Every result goes through the R3.2 rules; accepted ones */
/*  become observations with adapter "web_estimate" and are shown as    */
/*  "Web estimate · found 9:01 a.m. · confirm on site"; rejected ones   */
/*  are stored with their reasons and never shown.                      */
/*                                                                     */
/*  Spending: the search result is cached (12 h for a named product,   */
/*  6 h for a free-text query), so a repeat costs nothing; otherwise    */
/*  the budget planner decides first, after reading the month's usage. */
/*                                                                     */
/*  The brand's own store (Samsonite.ca for a Samsonite) is always     */
/*  checked: when the combined search brings back nothing we accept    */
/*  from it, one more search covers that store's domain only, under    */
/*  the same budget, cap and cache rules (1 credit, cached per product */
/*  and store).                                                         */
/* ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import type { TavilyResult, TavilySearchRequest } from "@/lib/tavily";
import { cleanPageTitle } from "@/lib/search/extract";
import { DEFAULT_TIME_ZONE, localDate } from "@/lib/time/local";
import { canonicalUrl } from "../adapters/base";
import { sourceForUrl } from "../registry";
import type { EngineStore } from "../store/port";
import type { AnswerOffer, CategoryPack, ListingRecord, SourceRecord } from "../types";
import {
  allowance,
  daysLeftInMonth,
  estimateDailyBudget,
  remainingThisMonth,
  type EstimatePurpose,
} from "./budget";
import type { EstimateRejection, EstimateStore, SearchResultLite } from "./store";
import {
  ESTIMATE_VALIDATOR_VERSION,
  houseBrandStore,
  identityReasons,
  isProductPage,
  passesScreen,
  validateEstimates,
  type EstimateCandidate,
  type ExpectedProduct,
  type ReferencePrice,
} from "./validate";

export const PRODUCT_CACHE_MS = 12 * 3_600_000;
export const QUERY_CACHE_MS = 6 * 3_600_000;

export type EstimateDeps = {
  engine: EngineStore;
  estimates: EstimateStore;
  pack: CategoryPack;
  sources: SourceRecord[];
  /** Snippet-only web search. Must never return page text. */
  search: (
    req: TavilySearchRequest,
    timeoutMs: number,
  ) => Promise<{ results: TavilyResult[]; creditsUsed: number }>;
  /** The month's usage, read before any estimate work. null = web estimates not configured. */
  usage: () => Promise<{ cap: number; used: number } | null>;
  /** Credits the morning email needs per day (min of budget and products chosen). */
  emailDailyNeed: () => Promise<number>;
  /** Whether today's email prepare has already run. */
  emailDoneToday: () => Promise<boolean>;
  now: () => number;
  timeZone?: string;
};

export type EstimateRequest = {
  purpose: EstimatePurpose;
  /** The words searched: a person's query, or a tracked product's name. */
  query: string;
  expected: ExpectedProduct;
  /** Stores to estimate (those we can't read live). */
  stores: SourceRecord[];
  /** Prices we stand behind for the same brand + line; awaited after the search. */
  references: () => Promise<ReferencePrice[]>;
  timeoutMs?: number;
  sessionId?: string | null;
  /** Skip the planner (the caller already budgeted, e.g. the email's rotation). */
  preBudgeted?: boolean;
  /** Most credits this call may spend (the email's allowance left today). */
  maxCredits?: number;
};

export type EstimateSkip = "no_stores" | "not_configured" | "budget" | "cap" | "error";

/**
 * The brand's own store: "found" when the combined search already gave an
 * estimate from it, "searched"/"cached" for the targeted search, or why that
 * search wasn't made.
 */
export type BrandSearchOutcome = "found" | "searched" | "cached" | EstimateSkip;

export type EstimateResult = {
  offers: AnswerOffer[];
  accepted: number;
  rejected: number;
  credits: number;
  fromCache: boolean;
  skipped: EstimateSkip | null;
  /** null when the product's brand has no store of its own among the asked stores. */
  brandSearch: BrandSearchOutcome | null;
};

const empty = (skipped: EstimateSkip | null): EstimateResult => ({
  offers: [],
  accepted: 0,
  rejected: 0,
  credits: 0,
  fromCache: false,
  skipped,
  brandSearch: null,
});

/** Named products share a key across wordings; free text is keyed by its words. */
export function cacheKeyFor(query: string, e: ExpectedProduct): { key: string; ttlMs: number } {
  if (e.brand && e.line.length && e.sizeClass) {
    const id = [
      e.brand.toLowerCase(),
      [...e.line].sort().join(" "),
      e.sizeClass,
      e.inches ?? "",
    ].join("|");
    return {
      key: `p:${createHash("sha256").update(id).digest("hex").slice(0, 32)}`,
      ttlMs: PRODUCT_CACHE_MS,
    };
  }
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9.\s-]/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    ),
  ].sort();
  return {
    key: `q:${createHash("sha256").update(words.join(" ")).digest("hex").slice(0, 32)}`,
    ttlMs: QUERY_CACHE_MS,
  };
}

/** The brand-store search's cache entry: per product (or query) and store. */
export function brandCacheKey(key: string, sourceId: string): string {
  return `b:${createHash("sha256").update(`${key}|${sourceId}`).digest("hex").slice(0, 32)}`;
}

function searchText(query: string, e: ExpectedProduct): string {
  const named = [e.brand, ...e.line].filter(Boolean).join(" ");
  const base = named && e.sizeClass ? `${named} ${e.sizeClass.replace("_", "-")}` : query;
  return `${base} price`.slice(0, 200);
}

export async function findEstimates(
  req: EstimateRequest,
  deps: EstimateDeps,
): Promise<EstimateResult> {
  const stores = req.stores.filter((s) => s.allowedDomains.length > 0 && s.status === "active");
  if (stores.length === 0) return empty("no_stores");
  const tz = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = localDate(new Date(nowMs), tz);
  const { key, ttlMs } = cacheKeyFor(req.query, req.expected);

  const startedAt = Date.now();
  const timeLeft = () => Math.max(1_000, (req.timeoutMs ?? 8_000) - (Date.now() - startedAt));
  const words = searchText(req.query, req.expected);

  /* ── spending: the planner before every paid search ──────────────── */
  let credits = 0;
  let usage: { cap: number; used: number } | null | undefined;
  const maySpend = async (): Promise<EstimateSkip | null> => {
    if (usage === undefined) usage = await deps.usage().catch(() => null);
    if (!usage) return "not_configured";
    // This call's own searches count at once: the month's usage was read before them.
    const used = usage.used + credits;
    const overCall = req.maxCredits !== undefined && credits + 1 > req.maxCredits;
    if (req.preBudgeted) return used >= usage.cap ? "cap" : overCall ? "budget" : null;
    const [emailSpentToday, emailDailyNeed, emailDoneToday] = await Promise.all([
      deps.estimates.spentOn(today, "email").catch(() => 0),
      deps.emailDailyNeed().catch(() => 0),
      deps.emailDoneToday().catch(() => false),
    ]);
    const state = {
      cap: usage.cap,
      usedThisMonth: used,
      emailSpentToday,
      emailDailyNeed,
      daysLeftInMonth: daysLeftInMonth(today),
      emailDoneToday,
    };
    if (remainingThisMonth(state) < 1) return "cap";
    if (allowance(req.purpose, state, estimateDailyBudget()) < 1 || overCall) return "budget";
    return null;
  };

  /* ── results: cached, or one budgeted search ─────────────────────── */
  type Fetched = { results: SearchResultLite[]; foundAt: string; fresh: boolean };
  const fetchResults = async (
    cacheKey: string,
    includeDomains: string[],
    maxResults: number,
  ): Promise<Fetched | EstimateSkip> => {
    const cached = await deps.estimates.cachedSearch(cacheKey, nowIso).catch(() => null);
    if (cached) return { results: cached.results, foundAt: cached.searchedAt, fresh: false };
    const skip = await maySpend();
    if (skip) return skip;
    let results: SearchResultLite[];
    let spent: number;
    try {
      const res = await deps.search(
        {
          query: words,
          searchDepth: "basic",
          maxResults,
          includeDomains,
          country: "canada",
          // Snippets only: never the page text (R3).
          includeRawContent: false,
        },
        timeLeft(),
      );
      spent = res.creditsUsed;
      results = res.results.map((r) => ({ url: r.url, title: r.title, content: r.content }));
    } catch (err) {
      const quota = err instanceof Error && /cap|credit|quota|pay-as-you-go/i.test(err.message);
      return quota ? "cap" : "error";
    }
    credits += spent;
    await deps.estimates
      .saveSearch({
        key: cacheKey,
        query: req.query,
        purpose: req.purpose,
        results,
        credits: spent,
        searchedAt: nowIso,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      })
      .catch(() => undefined);
    await deps.estimates.addSpend(today, req.purpose, spent).catch(() => undefined);
    return { results, foundAt: nowIso, fresh: true };
  };

  const combined = await fetchResults(
    key,
    [...new Set(stores.flatMap((s) => s.allowedDomains))],
    15,
  );
  if (typeof combined === "string") return empty(combined);

  /* ── candidates for the asked stores only ───────────────────────── */
  const wanted = new Map(stores.map((s) => [s.id, s]));
  const candidates: EstimateCandidate[] = [];
  // Results of a search made now; a cached search's were stored when it was made.
  const fresh = new Set<EstimateCandidate>();
  const seen = new Set<string>();
  const collect = (f: Fetched, onlySourceId?: string) => {
    for (const r of f.results) {
      const source = sourceForUrl(r.url, deps.sources);
      if (!source || !wanted.has(source.id) || (onlySourceId && source.id !== onlySourceId))
        continue;
      if (seen.has(r.url)) continue; // the targeted search often repeats a result
      seen.add(r.url);
      const c: EstimateCandidate = {
        sourceId: source.id,
        url: r.url,
        title: r.title,
        snippet: r.content,
        query: req.query,
        foundAt: f.foundAt,
      };
      candidates.push(c);
      if (f.fresh) fresh.add(c);
    }
  };
  collect(combined);

  /* ── the brand's own store: always checked ───────────────────────── */
  const brandStore = houseBrandStore(req.expected.brand, stores);
  // (assigned inside searchBrandStore: a wide type keeps TypeScript from narrowing it)
  let brandSearch = (brandStore ? "found" : null) as BrandSearchOutcome | null;
  const searchBrandStore = async (store: SourceRecord) => {
    const got = await fetchResults(brandCacheKey(key, store.id), store.allowedDomains, 10);
    if (typeof got === "string") {
      brandSearch = got;
      return;
    }
    brandSearch = got.fresh ? "searched" : "cached";
    collect(got, store.id);
  };
  // Nothing from it passes the rules that don't need verified prices: search
  // its domain now, while those prices are still coming in.
  const early =
    brandStore &&
    !candidates.some(
      (c) => c.sourceId === brandStore.id && passesScreen(c, brandStore, req.expected, deps.pack),
    )
      ? searchBrandStore(brandStore)
      : null;
  const hadCandidates = candidates.length > 0;
  let [references] = await Promise.all([
    hadCandidates ? req.references().catch(() => []) : Promise.resolve([] as ReferencePrice[]),
    early,
  ]);
  if (candidates.length === 0) {
    return {
      ...empty(null),
      credits,
      fromCache: !combined.fresh && brandSearch !== "searched",
      brandSearch,
    };
  }
  if (!hadCandidates) references = await req.references().catch(() => []);
  let verdicts = validateEstimates(candidates, wanted, req.expected, references, deps.pack);
  if (
    brandStore &&
    !early &&
    !verdicts.some(
      (x) => x.candidate.sourceId === brandStore.id && x.verdict.outcome === "accepted",
    )
  ) {
    // Its result passed those rules but not the price check: its own domain may hold the right page.
    await searchBrandStore(brandStore);
    verdicts = validateEstimates(candidates, wanted, req.expected, references, deps.pack);
  }
  const fromCache = !combined.fresh && brandSearch !== "searched";

  /* ── store and shape ──────────────────────────────────────────────── */
  const canonical = (u: string) => {
    try {
      return canonicalUrl(u);
    } catch {
      return u;
    }
  };
  // A listing-page price links to the product's own page when a result shows it.
  const productPageOf = (source: SourceRecord): string | null => {
    const hit = candidates.find(
      (c) =>
        c.sourceId === source.id &&
        !isProductPage(source, c.url) &&
        identityReasons(c, source, req.expected, deps.pack).length === 0,
    );
    return hit ? canonical(hit.url) : null;
  };
  // A product page's estimate beats a listing tile; one tile per store at most.
  const pageAccepted = new Set(
    verdicts
      .filter((x) => x.verdict.outcome === "accepted" && !x.verdict.tile)
      .map((x) => x.candidate.sourceId),
  );
  const tileShown = new Set<string>();

  const offers: AnswerOffer[] = [];
  const rejections: EstimateRejection[] = [];
  const shownPages = new Set<string>();
  for (const { candidate: c, verdict: v } of verdicts) {
    const source = wanted.get(c.sourceId)!;
    const isFresh = fresh.has(c);
    if (v.outcome === "rejected" || v.price === null) {
      if (!isFresh) continue;
      rejections.push({
        sourceId: c.sourceId,
        query: c.query,
        url: c.url,
        title: c.title,
        snippet: v.excerpt || c.snippet.slice(0, 300),
        price: v.price,
        reasons: v.reasons,
        foundAt: c.foundAt,
      });
      continue;
    }
    let url: string;
    // Where the observation is kept: one listing per page, and per product on a listing page.
    let listingUrl: string;
    if (v.tile) {
      if (pageAccepted.has(c.sourceId) || tileShown.has(c.sourceId)) continue;
      tileShown.add(c.sourceId);
      const product = productPageOf(source);
      // A listing page keeps its query (?q=…): without it the link goes nowhere.
      url = product ?? c.url;
      listingUrl = product ?? `${c.url.split("#")[0]}#tile=${tileSlug(v.tile)}`;
    } else {
      url = canonical(c.url);
      listingUrl = url;
    }
    if (shownPages.has(url)) continue;
    shownPages.add(url);
    const title = v.tile ?? (cleanPageTitle(c.title).name || c.title);
    const brand = deps.pack.brandOf(title) ?? source.identityQuality.houseBrand ?? null;
    let listing: ListingRecord | null = null;
    let observationId: string | null = null;
    // A cached search was stored when it was first made: only new results are written.
    if (isFresh) {
      listing = await deps.engine
        .upsertListing({
          sourceId: source.id,
          url: listingUrl,
          externalId: null,
          title,
          brand,
          sizeClass: deps.pack.sizeClassOf(title),
          colour: deps.pack.colourOf(title),
          identifiers: [],
          imageUrl: null,
          discoveredVia: "tavily",
          lastmod: null,
          active: true,
        })
        .catch(() => null);
      if (listing) {
        const obs = await deps.engine
          .insertObservation({
            listingId: listing.id,
            sourceId: source.id,
            adapter: "web_estimate",
            price: v.price,
            listPrice: null,
            currency: "CAD",
            availability: "unknown",
            seller: null,
            condition: null,
            validation: {
              outcome: "accepted",
              confidence: v.singleSource ? 0.5 : 0.7,
              reasons: v.reasons,
            },
            evidence: {
              query: c.query,
              resultUrl: c.url,
              snippet: v.excerpt.slice(0, 300),
              foundAt: c.foundAt,
              singleSource: v.singleSource,
            },
            extractorVersion: ESTIMATE_VALIDATOR_VERSION,
            validatorVersion: ESTIMATE_VALIDATOR_VERSION,
            fetchedAt: c.foundAt,
            asOf: null,
            sessionId: req.sessionId ?? null,
          })
          .catch(() => null);
        observationId = obs?.id ?? null;
      }
    } else {
      listing = await deps.engine.findListingByUrl(source.id, listingUrl).catch(() => null);
    }
    offers.push({
      sourceId: source.id,
      retailer: source.retailerLabel,
      url,
      title,
      brand,
      sizeClass: deps.pack.sizeClassOf(title),
      identifiers: [],
      imageUrl: null,
      reasons: v.reasons,
      price: v.price,
      listPrice: null,
      currency: "CAD",
      availability: "unknown",
      colour: deps.pack.colourOf(title),
      freshness: { kind: "estimate", foundAt: c.foundAt },
      confidence: v.singleSource ? 0.5 : 0.7,
      lowConfidence: false,
      method: "web_estimate",
      observationId,
      listingId: listing?.id ?? null,
      productId: listing?.productId ?? null,
      evidence: v.excerpt.slice(0, 300),
    });
  }
  if (rejections.length) await deps.estimates.recordRejections(rejections).catch(() => undefined);

  return {
    offers,
    accepted: offers.length,
    rejected: rejections.length,
    credits,
    fromCache,
    skipped: null,
    brandSearch,
  };
}

function tileSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/**
 * Prices we stand behind for the same brand and line, any size, from the
 * engine's records (last 30 days): live readings, staff-checked and dealer
 * prices. Never estimates. Used for rule d.
 */
export async function referencePrices(
  engine: EngineStore,
  pack: CategoryPack,
  e: ExpectedProduct,
  extra: AnswerOffer[] = [],
  nowMs = Date.now(),
): Promise<ReferencePrice[]> {
  const out: ReferencePrice[] = extra
    .filter(
      (o) =>
        o.freshness.kind === "live" || o.freshness.kind === "feed" || o.freshness.kind === "manual",
    )
    .map((o) => ({ price: o.price, sizeClass: o.sizeClass, inches: pack.inchesOf(o.title) }));
  if (!e.brand || e.line.length === 0) return out;
  const parsed = pack.parseQuery([e.brand, ...e.line].join(" "));
  const listings = await engine.searchListings(
    { ...parsed, sizeClass: null, inches: null },
    { limit: 60 },
  );
  const since = nowMs - 30 * 86_400_000;
  for (const l of listings.slice(0, 40)) {
    const obs = await engine.latestObservation(l.id, { shownOnly: true });
    if (!obs || obs.adapter === "web_estimate" || obs.adapter === "tracked_record") continue;
    if (Date.parse(obs.fetchedAt) < since && obs.adapter !== "feed_import") continue;
    out.push({
      price: obs.price,
      sizeClass: l.sizeClass ?? pack.sizeClassOf(l.title),
      inches: pack.inchesOf(l.title),
    });
  }
  return out;
}
