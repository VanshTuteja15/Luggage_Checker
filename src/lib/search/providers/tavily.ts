/* ------------------------------------------------------------------ */
/*  Provider: Tavily web research (Canada)                            */
/*                                                                     */
/*  ONE search per lookup. That single call has to answer everything a */
/*  luggage lookup needs — which retailers sell it, at what price,     */
/*  whether it's in stock, and its specs — so it's built to:           */
/*                                                                     */
/*    • ask for 20 results (the cost is per call, not per result)      */
/*    • include each page's text, so price AND specs come from the     */
/*      same pages instead of separate searches per field              */
/*    • rank Canadian retailer domains first ("prefer", not "restrict" */
/*      — independent Canadian shops still come through)               */
/*    • exclude domains that can't carry a Canadian price (US stores,  */
/*      social, video, forums) so no result slot is wasted             */
/*    • target Canada with Tavily's country setting                    */
/*                                                                     */
/*  Nothing here creates, imports or stores products. It returns       */
/*  offers; tracking a product is a separate workflow (/api/track).    */
/* ------------------------------------------------------------------ */

import {
  tavilyConfigured,
  tavilySearch,
  type TavilyDepth,
  type TavilyResult,
  type TavilySearchRequest,
  type TavilySearchResponse,
} from "@/lib/tavily";
import { RESEARCH_EXCLUDED_DOMAINS, preferredResearchDomains } from "@/lib/retailers";
import type { Deadline, Meter } from "../deadline";
import { analyzePage, type PageAnalysis } from "../extract";
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

/** The single request that answers a luggage lookup. */
export function buildLuggageRequest(intent: SearchIntent): TavilySearchRequest {
  const terms = intent.terms.trim();
  // "price" steers the search toward shop pages rather than reviews.
  const query = /\bprice\b|\bprix\b/i.test(terms) ? terms : `${terms} price`;

  return {
    query,
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

/** Every result, analysed — offers where possible, reasons where not. */
export function analyzeResults(results: TavilyResult[], fetchedAt = new Date().toISOString()): PageAnalysis[] {
  const seen = new Set<string>();
  const out: PageAnalysis[] = [];

  for (const r of results) {
    // The same page can come back twice with tracking parameters.
    const canonical = r.url.split("#")[0].replace(/[?&](?:utm_[^&]+|ref=[^&]+)/g, "");
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

export type TavilyOffersResult = {
  offers: Offer[];
  warnings: string[];
  /** Pages Tavily returned, before any were rejected. 0 means "no results". */
  resultCount: number;
  creditsUsed: number;
};

export async function fetchOffers(
  intent: SearchIntent,
  opts: {
    deadline?: Deadline;
    meter?: Meter;
    bypassCache?: boolean;
    /** Diagnostics hook: sees the exact request and raw response. */
    onResearch?: (info: { request: TavilySearchRequest; response: TavilySearchResponse }) => void;
  } = {},
): Promise<TavilyOffersResult> {
  const request = buildLuggageRequest(intent);
  const response = await tavilySearch(request, opts);
  opts.onResearch?.({ request, response });
  const analysed = analyzeResults(response.results);
  const offers = analysed.map((a) => a.offer).filter((o): o is Offer => o !== null);

  const warnings: string[] = [];
  if (response.results.length > 0 && offers.length === 0) {
    warnings.push(
      `Found ${response.results.length} pages, but none showed a clear Canadian price for this item. ` +
        "Try the exact model name (for example “Samsonite Freeform 21”).",
    );
  }

  return {
    offers,
    warnings,
    resultCount: response.results.length,
    creditsUsed: response.creditsUsed,
  };
}
