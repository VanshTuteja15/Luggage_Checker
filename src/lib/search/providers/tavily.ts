/* ------------------------------------------------------------------ */
/*  Provider: Tavily web research (Canada)                            */
/*                                                                     */
/*  One lookup = two searches sent AT THE SAME TIME (so no slower than */
/*  one), then one page-reading call for store pages that came back    */
/*  without a price:                                                   */
/*                                                                     */
/*    1. general    — every Canadian store, registry domains ranked    */
/*                    first. Tends to be led by the brand's own store. */
/*    2. major sweep — restricted to the big Canadian chains (Amazon,  */
/*                    Walmart, Costco, The Bay, Best Buy…), so they    */
/*                    can't be crowded out of the results.             */
/*    3. read pages — product pages whose search excerpt had no price  */
/*                    are read in full (1 credit per 5 pages read).    */
/*                                                                     */
/*  Typical cost: 2 credits for the searches + 1–2 for reading, all    */
/*  inside the same free-plan cap. Repeat searches are served from     */
/*  cache for free.                                                    */
/*                                                                     */
/*  Nothing here creates, imports or stores products. It returns       */
/*  offers; tracking a product is a separate workflow (/api/track).    */
/* ------------------------------------------------------------------ */

import {
  tavilyConfigured,
  tavilyExtract,
  tavilySearch,
  type TavilyDepth,
  type TavilyExtractResponse,
  type TavilyResult,
  type TavilySearchRequest,
  type TavilySearchResponse,
} from "@/lib/tavily";
import {
  RESEARCH_EXCLUDED_DOMAINS,
  RETAILER_INFO,
  hostOf,
  majorResearchDomains,
  preferredResearchDomains,
} from "@/lib/retailers";
import type { Deadline, Meter } from "../deadline";
import { ProviderError } from "../errors";
import {
  analyzePage,
  cleanPageTitle,
  extractListingTiles,
  looksLikeProductUrl,
  queryMatch,
  queryTokens,
  type PageAnalysis,
  type PageInput,
} from "../extract";
import type { Offer, SearchIntent } from "../types";

export function tavilyProviderConfigured(): boolean {
  return tavilyConfigured();
}

/**
 * Search depth. "basic" (1 credit) is the default and is enough here: the
 * page text carries the detail. "advanced" doubles the cost, so it has to
 * be chosen deliberately via TAVILY_SEARCH_DEPTH.
 */
function searchDepth(): TavilyDepth {
  const raw = (process.env.TAVILY_SEARCH_DEPTH ?? "").trim().toLowerCase();
  return raw === "advanced" || raw === "fast" ? raw : "basic";
}

/** Full page text. On by default — it's how one call yields price AND specs. */
function rawContentEnabled(): boolean {
  return process.env.TAVILY_INCLUDE_RAW_CONTENT !== "false";
}

/** The second, major-chains-only search. On unless SEARCH_RETAILER_SWEEP=false. */
function sweepEnabled(): boolean {
  return process.env.SEARCH_RETAILER_SWEEP !== "false";
}

/** Most store pages read per search (0 turns page reading off). Max 20. */
export function maxPagesToRead(): number {
  const raw = process.env.TAVILY_EXTRACT_MAX_PAGES;
  if (raw === undefined || raw.trim() === "") return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(20, Math.floor(n)) : 10;
}

function researchQuery(terms: string): string {
  const t = terms.trim();
  // "price" steers the search toward shop pages rather than reviews.
  return /\bprice\b|\bprix\b/i.test(t) ? t : `${t} price`;
}

/** Search 1: every Canadian store, registry domains ranked first. */
export function buildLuggageRequest(intent: SearchIntent): TavilySearchRequest {
  return {
    query: researchQuery(intent.terms),
    searchDepth: searchDepth(),
    maxResults: 20,
    chunksPerSource: 3,
    includeRawContent: rawContentEnabled() ? "text" : false,
    includeDomains: preferredResearchDomains(),
    includeDomainsMode: "prefer",
    excludeDomains: RESEARCH_EXCLUDED_DOMAINS,
    country: "canada",
    topic: "general",
  };
}

/** Search 2: only the big Canadian chains. */
export function buildRetailerSweepRequest(intent: SearchIntent): TavilySearchRequest | null {
  const domains = majorResearchDomains();
  if (domains.length === 0) return null;
  return {
    query: researchQuery(intent.terms),
    searchDepth: searchDepth(),
    maxResults: 20,
    chunksPerSource: 3,
    includeRawContent: rawContentEnabled() ? "text" : false,
    includeDomains: domains,
    includeDomainsMode: "restrict",
    // No country boost: every domain listed is already Canadian, and the
    // one live run with both set came back empty.
    topic: "general",
  };
}

/**
 * The major-chains search costs a credit whether or not it finds anything.
 * If it comes back empty three searches in a row, stop sending it for a day
 * rather than keep paying for nothing.
 */
let sweepEmptyStreak = 0;
let sweepPausedUntil = 0;
const SWEEP_EMPTY_LIMIT = 3;
const SWEEP_PAUSE_MS = 24 * 60 * 60_000;

function sweepAvailable(): boolean {
  return Date.now() >= sweepPausedUntil;
}

function recordSweep(response: TavilySearchResponse): void {
  if (response.cached) return;
  if (response.results.length > 0) {
    sweepEmptyStreak = 0;
    return;
  }
  sweepEmptyStreak++;
  if (sweepEmptyStreak >= SWEEP_EMPTY_LIMIT) {
    sweepPausedUntil = Date.now() + SWEEP_PAUSE_MS;
    sweepEmptyStreak = 0;
    console.warn("[research] the major-chains search came back empty 3 times in a row — paused for 24h to save credits.");
  }
}

/** For tests. */
export function resetSweepState(): void {
  sweepEmptyStreak = 0;
  sweepPausedUntil = 0;
}

/** Every result, analysed — offers where possible, reasons where not. */
export function analyzeResults(results: TavilyResult[], fetchedAt = new Date().toISOString()): PageAnalysis[] {
  const seen = new Set<string>();
  const out: PageAnalysis[] = [];

  for (const r of results) {
    const canonical = canonicalUrl(r.url);
    if (seen.has(canonical)) continue;
    seen.add(canonical);

    out.push(
      analyzePage(
        { url: r.url, title: r.title, content: r.content, rawContent: r.rawContent },
        fetchedAt,
      ),
    );
  }
  return out;
}

/** The same page can come back twice with tracking parameters. */
function canonicalUrl(url: string): string {
  return url.split("#")[0].replace(/[?&](?:utm_[^&]+|ref=[^&]+)/g, "");
}

/** A store product page found without a readable price. */
export type UnreadPage = {
  page: PageInput;
  retailer: string;
  retailerKey: string | null;
};

/**
 * Which pages are worth paying to read in full: Canadian product pages
 * about the searched product whose excerpt had no clear price. The brand's
 * own store first, then the big chains, then everyone else.
 */
export function pagesWorthReading(
  analysed: PageAnalysis[],
  pages: Map<string, PageInput>,
  terms: string,
  max = maxPagesToRead(),
): UnreadPage[] {
  if (max <= 0) return [];
  const wanted = queryTokens(terms);
  // At least the model words must be on the page title — a page that only
  // shares the brand is another product.
  const minMatch = wanted.length <= 1 ? 1 : Math.min(1, 2 / wanted.length);

  const candidates = analysed
    .filter((a) => a.offer === null && a.reason === "no clear price on the page")
    .map((a) => ({ a, page: pages.get(a.url) }))
    .filter((x): x is { a: PageAnalysis; page: PageInput } => !!x.page)
    // A brand store's titles leave out the brand ("Outline Pro Spinner" on
    // samsonite.ca), so the store's name counts toward the match.
    .filter(({ a, page }) => queryMatch(`${a.retailer} ${page.title}`, terms) >= minMatch)
    // Product pages first, then anything else that named the product.
    .sort((x, y) => Number(looksLikeProductUrl(y.a.url)) - Number(looksLikeProductUrl(x.a.url)));

  const rank = (retailer: string): number => {
    const category = RETAILER_INFO[retailer]?.category;
    return category === "specialty" ? 0 : category === "major" ? 1 : 2;
  };

  // Stable sort: keeps product-pages-first within each retailer tier.
  return candidates
    .sort((x, y) => rank(x.a.retailer) - rank(y.a.retailer))
    .slice(0, max)
    .map(({ a, page }) => ({
      page,
      retailer: a.retailer,
      retailerKey: RETAILER_INFO[a.retailer] ? a.retailer : null,
    }));
}

type ResearchHook = (info: { request: TavilySearchRequest; response: TavilySearchResponse }) => void;

export type TavilyOffersResult = {
  offers: Offer[];
  warnings: string[];
  /** Pages Tavily returned, before any were rejected. 0 means "no results". */
  resultCount: number;
  creditsUsed: number;
  /** Product pages worth reading in full (no price in their excerpt). */
  unread: UnreadPage[];
};

export async function fetchOffers(
  intent: SearchIntent,
  opts: {
    deadline?: Deadline;
    meter?: Meter;
    bypassCache?: boolean;
    /** Diagnostics hook: sees each exact request and raw response. */
    onResearch?: ResearchHook;
    /** Run the major-chains search too (default: SEARCH_RETAILER_SWEEP). */
    sweep?: boolean;
    /** Most pages to read afterwards (default: TAVILY_EXTRACT_MAX_PAGES). */
    maxReads?: number;
  } = {},
): Promise<TavilyOffersResult> {
  const requests: TavilySearchRequest[] = [buildLuggageRequest(intent)];
  if ((opts.sweep ?? sweepEnabled()) && sweepAvailable()) {
    const sweep = buildRetailerSweepRequest(intent);
    if (sweep) requests.push(sweep);
  }

  // Sent together: two searches take as long as one.
  const settled = await Promise.allSettled(requests.map((r) => tavilySearch(r, opts)));

  const results: TavilyResult[] = [];
  const warnings: string[] = [];
  let creditsUsed = 0;
  let firstError: unknown = null;
  let succeeded = 0;

  settled.forEach((s, i) => {
    if (s.status === "fulfilled") {
      succeeded++;
      opts.onResearch?.({ request: requests[i], response: s.value });
      if (requests[i].includeDomainsMode === "restrict") recordSweep(s.value);
      results.push(...s.value.results);
      creditsUsed += s.value.creditsUsed;
    } else if (!firstError) {
      firstError = s.reason;
    }
  });

  if (succeeded === 0) throw firstError ?? new ProviderError("tavily", "unknown", "Research failed");
  if (firstError && requests.length > 1) {
    warnings.push(
      firstError instanceof ProviderError && firstError.kind === "quota"
        ? firstError.userMessage
        : "One of the two searches didn't complete, so fewer stores may be listed.",
    );
  }

  const fetchedAt = new Date().toISOString();
  const analysed = analyzeResults(results, fetchedAt);
  const pageOffers = analysed.map((a) => a.offer).filter((o): o is Offer => o !== null);

  const pages = new Map<string, PageInput>();
  for (const r of results) {
    if (!pages.has(r.url)) {
      pages.set(r.url, { url: r.url, title: r.title, content: r.content, rawContent: r.rawContent });
    }
  }

  // Collection pages the store's own product pages didn't price — the
  // brand store is often only readable this way.
  const tileOffers = listingTileOffers(analysed, pages, pageOffers, intent.terms, fetchedAt);
  const offers = [...pageOffers, ...tileOffers];

  // A product page whose price a tile already gave needn't be paid to read.
  const priced = new Set(offers.map((o) => canonicalUrl(o.url)));
  const unread = pagesWorthReading(
    analysed,
    pages,
    intent.terms,
    Math.min(maxPagesToRead(), opts.maxReads ?? Number.POSITIVE_INFINITY),
  ).filter((u) => !priced.has(canonicalUrl(u.page.url)));

  return {
    offers,
    warnings,
    resultCount: results.length,
    creditsUsed,
    unread,
  };
}

/** Word set of a product name, order- and punctuation-free. */
function nameKey(name: string): string {
  return [...new Set(name.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean))].sort().join(" ");
}

/**
 * Offers from listing tiles ("name → price" on collection pages), for
 * Canadian stores whose pages yielded no offer. Each is linked to the
 * store's own product page when one with the same name was found, else to
 * the listing page. Never duplicates an offer a product page already gave.
 */
export function listingTileOffers(
  analysed: PageAnalysis[],
  pages: Map<string, PageInput>,
  existing: Offer[],
  terms: string,
  fetchedAt: string,
): Offer[] {
  const taken = new Set(existing.map((o) => `${o.retailer}|${nameKey(o.title)}`));
  const out: Offer[] = [];

  // Product pages by host, for linking a tile to its own page.
  const productPages = new Map<string, { url: string; key: string }[]>();
  for (const page of pages.values()) {
    if (!looksLikeProductUrl(page.url)) continue;
    const host = hostOf(page.url);
    const list = productPages.get(host) ?? [];
    list.push({ url: page.url, key: nameKey(cleanPageTitle(page.title).name) });
    productPages.set(host, list);
  }

  for (const a of analysed) {
    if (a.offer) continue;
    if (/not a Canadian storefront|not a retailer page|no title/.test(a.reason ?? "")) continue;
    const page = pages.get(a.url);
    if (!page) continue;

    const info = RETAILER_INFO[a.retailer];
    const brand = info?.category === "specialty" ? a.retailer.replace(/\.(?:ca|com)$/i, "") : null;

    for (const text of [page.content, page.rawContent ?? ""]) {
      for (const tile of extractListingTiles(text, terms)) {
        const title = brand && !tile.name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${tile.name}` : tile.name;
        const key = `${a.retailer}|${nameKey(title)}`;
        if (taken.has(key)) continue;
        taken.add(key);

        const own = (productPages.get(a.host) ?? []).find((p) => p.key === nameKey(title) || p.key === nameKey(tile.name));
        out.push({
          retailer: a.retailer,
          retailerKey: info ? a.retailer : null,
          price: tile.price,
          currency: "CAD",
          inStock: true,
          url: own?.url ?? a.url,
          title,
          fetchedAt,
          evidence: tile.evidence,
        });
      }
    }
  }
  return out;
}

export type ReadPagesResult = {
  offers: Offer[];
  /** Pages still without a price after reading (or that couldn't be read). */
  stillUnread: UnreadPage[];
  creditsUsed: number;
};

/**
 * Most pages given a second, "advanced" read per search (0 turns it off).
 * Advanced reading loads pages more like a browser and gets through more
 * often on stores that block basic readers. Pages it can't read cost
 * nothing; pages it reads cost 2 credits per 5.
 */
export function maxAdvancedRereads(): number {
  const raw = process.env.TAVILY_ADVANCED_RETRY_PAGES;
  if (raw === undefined || raw.trim() === "") return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(10, Math.floor(n)) : 5;
}

/** Enough time left to be worth an advanced read (it's slower). */
const MIN_MS_FOR_ADVANCED = 6_000;

type ReadOpts = {
  deadline?: Deadline;
  meter?: Meter;
  bypassCache?: boolean;
  onExtract?: (info: { urls: string[]; depth: "basic" | "advanced"; response: TavilyExtractResponse }) => void;
  /** Give blocked pages a second try with the advanced reader. Default: on. */
  advancedRetry?: boolean;
};

/** One read pass: which pages yielded an offer, which were blocked, which had no price. */
async function readPass(
  pages: UnreadPage[],
  depth: "basic" | "advanced",
  opts: ReadOpts,
): Promise<{ offers: Offer[]; blocked: UnreadPage[]; noPrice: UnreadPage[]; other: UnreadPage[]; credits: number }> {
  const urls = pages.map((u) => u.page.url);
  let response: TavilyExtractResponse;
  try {
    response = await tavilyExtract({ urls, depth, format: "text" }, opts);
  } catch {
    return { offers: [], blocked: [], noPrice: [], other: pages, credits: 0 };
  }
  opts.onExtract?.({ urls, depth, response });

  const text = new Map(response.results.map((r) => [canonicalUrl(r.url), r.rawContent]));
  const retryable = new Set(response.failed.filter((f) => f.retryable).map((f) => canonicalUrl(f.url)));
  const fetchedAt = new Date().toISOString();
  const out = { offers: [] as Offer[], blocked: [] as UnreadPage[], noPrice: [] as UnreadPage[], other: [] as UnreadPage[], credits: response.creditsUsed };

  for (const u of pages) {
    const key = canonicalUrl(u.page.url);
    const raw = text.get(key);
    if (!raw) {
      (retryable.has(key) ? out.blocked : out.other).push(u);
      continue;
    }
    const analysis = analyzePage({ ...u.page, rawContent: raw }, fetchedAt);
    if (analysis.offer) out.offers.push(analysis.offer);
    else out.noPrice.push(u);
  }
  return out;
}

/**
 * Read store pages in full and try again for a price. Never throws: this
 * only ever adds offers to a search that already has results.
 *
 *   1. basic read of every page (1 credit per 5 pages read)
 *   2. pages a store blocked, or that loaded without a price, get ONE
 *      advanced read — known stores only, brand store first, capped per
 *      search (2 credits per 5 pages read; blocked again = free)
 */
export async function readPages(unread: UnreadPage[], opts: ReadOpts = {}): Promise<ReadPagesResult> {
  if (unread.length === 0) return { offers: [], stillUnread: [], creditsUsed: 0 };

  const first = await readPass(unread, "basic", opts);
  let offers = first.offers;
  let creditsUsed = first.credits;
  let stillUnread = [...first.blocked, ...first.noPrice, ...first.other];

  const limit = opts.advancedRetry === false ? 0 : maxAdvancedRereads();
  if (limit > 0 && (!opts.deadline || opts.deadline.hasAtLeast(MIN_MS_FOR_ADVANCED))) {
    // Blocked pages first (the reason this exists), then pages that loaded
    // but showed no price — both only from stores we know, keeping the
    // brand-store-first order the pages arrived in.
    const known = (u: UnreadPage) => u.retailerKey !== null;
    const retry = [...first.blocked.filter(known), ...first.noPrice.filter(known)]
      .sort((a, b) => unread.indexOf(a) - unread.indexOf(b))
      .sort((a, b) => Number(first.noPrice.includes(a)) - Number(first.noPrice.includes(b)))
      .slice(0, limit);

    if (retry.length > 0) {
      const second = await readPass(retry, "advanced", opts);
      offers = [...offers, ...second.offers];
      creditsUsed += second.credits;
      const nowPriced = new Set(second.offers.map((o) => canonicalUrl(o.url)));
      stillUnread = stillUnread.filter((u) => !nowPriced.has(canonicalUrl(u.page.url)));
    }
  }

  return { offers, stillUnread, creditsUsed };
}
