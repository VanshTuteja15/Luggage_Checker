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
};

export type EstimateSkip = "no_stores" | "not_configured" | "budget" | "cap" | "error";

export type EstimateResult = {
  offers: AnswerOffer[];
  accepted: number;
  rejected: number;
  credits: number;
  fromCache: boolean;
  skipped: EstimateSkip | null;
};

const empty = (skipped: EstimateSkip | null): EstimateResult => ({
  offers: [],
  accepted: 0,
  rejected: 0,
  credits: 0,
  fromCache: false,
  skipped,
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

  /* ── results: cached, or one budgeted search ─────────────────────── */
  let results: SearchResultLite[];
  let foundAt = nowIso;
  let credits = 0;
  let fromCache = false;
  const cached = await deps.estimates.cachedSearch(key, nowIso).catch(() => null);
  if (cached) {
    results = cached.results;
    foundAt = cached.searchedAt;
    fromCache = true;
  } else {
    const usage = await deps.usage().catch(() => null);
    if (!usage) return empty("not_configured");
    if (!req.preBudgeted) {
      const [emailSpentToday, emailDailyNeed, emailDoneToday] = await Promise.all([
        deps.estimates.spentOn(today, "email").catch(() => 0),
        deps.emailDailyNeed().catch(() => 0),
        deps.emailDoneToday().catch(() => false),
      ]);
      const state = {
        cap: usage.cap,
        usedThisMonth: usage.used,
        emailSpentToday,
        emailDailyNeed,
        daysLeftInMonth: daysLeftInMonth(today),
        emailDoneToday,
      };
      if (remainingThisMonth(state) < 1) return empty("cap");
      if (allowance(req.purpose, state, estimateDailyBudget()) < 1) return empty("budget");
    } else if (usage.used >= usage.cap) {
      return empty("cap");
    }
    try {
      const res = await deps.search(
        {
          query: searchText(req.query, req.expected),
          searchDepth: "basic",
          maxResults: 15,
          includeDomains: [...new Set(stores.flatMap((s) => s.allowedDomains))],
          country: "canada",
          // Snippets only: never the page text (R3).
          includeRawContent: false,
        },
        req.timeoutMs ?? 8_000,
      );
      credits = res.creditsUsed;
      results = res.results.map((r) => ({ url: r.url, title: r.title, content: r.content }));
    } catch (err) {
      const quota = err instanceof Error && /cap|credit|quota|pay-as-you-go/i.test(err.message);
      return empty(quota ? "cap" : "error");
    }
    await deps.estimates
      .saveSearch({
        key,
        query: req.query,
        purpose: req.purpose,
        results,
        credits,
        searchedAt: nowIso,
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
      })
      .catch(() => undefined);
    await deps.estimates.addSpend(today, req.purpose, credits).catch(() => undefined);
  }

  /* ── candidates for the asked stores only ───────────────────────── */
  const wanted = new Map(stores.map((s) => [s.id, s]));
  const candidates: EstimateCandidate[] = [];
  for (const r of results) {
    const source = sourceForUrl(r.url, deps.sources);
    if (!source || !wanted.has(source.id)) continue;
    candidates.push({
      sourceId: source.id,
      url: r.url,
      title: r.title,
      snippet: r.content,
      query: req.query,
      foundAt,
    });
  }
  if (candidates.length === 0) return { ...empty(null), credits, fromCache };

  const references = await req.references().catch(() => []);
  const verdicts = validateEstimates(candidates, wanted, req.expected, references, deps.pack);

  /* ── store and shape ──────────────────────────────────────────────── */
  const offers: AnswerOffer[] = [];
  const rejections: EstimateRejection[] = [];
  const shownPages = new Set<string>();
  for (const { candidate: c, verdict: v } of verdicts) {
    const source = wanted.get(c.sourceId)!;
    if (v.outcome === "rejected" || v.price === null) {
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
    let url = c.url;
    try {
      url = canonicalUrl(c.url);
    } catch {
      /* keep as is */
    }
    if (shownPages.has(url)) continue;
    shownPages.add(url);
    const title = cleanPageTitle(c.title).name || c.title;
    const brand = deps.pack.brandOf(title) ?? source.identityQuality.houseBrand ?? null;
    let listing: ListingRecord | null = null;
    let observationId: string | null = null;
    // A cached search was stored when it was first made: only new results are written.
    if (!fromCache) {
      listing = await deps.engine
        .upsertListing({
          sourceId: source.id,
          url,
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
      listing = await deps.engine.findListingByUrl(source.id, url).catch(() => null);
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
  if (!fromCache && rejections.length)
    await deps.estimates.recordRejections(rejections).catch(() => undefined);

  return {
    offers,
    accepted: offers.length,
    rejected: rejections.length,
    credits,
    fromCache,
    skipped: null,
  };
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
