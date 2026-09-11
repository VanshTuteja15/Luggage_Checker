/* ------------------------------------------------------------------ */
/*  Provider: Gemini + Google Search grounding                        */
/*                                                                     */
/*  Fallback for when no SerpAPI key is configured. Gemini runs real   */
/*  Google searches and reports listings it retrieved.                 */
/*                                                                     */
/*  This provider is inherently less trustworthy than a shopping API,  */
/*  so it is deliberately paranoid:                                    */
/*                                                                     */
/*    1. An offer is only accepted if its URL is on a domain belonging */
/*       to a retailer we know. A price on an unrecognised domain is   */
/*       discarded rather than shown.                                  */
/*    2. Prices outside a plausible band for luggage are discarded.    */
/*    3. Results are flagged so the UI can tell the user these need    */
/*       verifying against the retailer.                               */
/*                                                                     */
/*  The model is never asked to estimate. It is asked to report, and   */
/*  anything it can't source is dropped.                               */
/* ------------------------------------------------------------------ */

import { callGeminiGrounded, geminiConfigured, parseJson } from "@/lib/gemini";
import { PRIORITY_RETAILERS, RETAILER_INFO, hostOf, matchRetailer } from "@/lib/retailers";
import { NoProviderError, type Offer, type SearchIntent } from "../types";

/** Plausible price band for luggage in CAD. Outside this, we don't believe it. */
const MIN_PRICE = 15;
const MAX_PRICE = 6000;

export function geminiGroundedConfigured(): boolean {
  return geminiConfigured();
}

type RawOffer = {
  retailer?: string;
  price?: number | string;
  url?: string;
  title?: string;
  in_stock?: boolean;
  upc?: string;
};

/** Every domain we're willing to accept a grounded price from. */
function allowedDomains(): string[] {
  return Object.values(RETAILER_INFO).flatMap((r) => [r.domain, ...(r.altDomains ?? [])]);
}

function isAllowedHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return allowedDomains().some((d) => host === d || host.endsWith(`.${d}`));
}

function toNumber(value: number | string | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^0-9.]/g, "");
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * Search for real current listings using Gemini's Google Search grounding.
 *
 * Returns offers that survived validation. May legitimately return an empty
 * array — that is a correct answer, and far better than a fabricated one.
 */
export async function fetchOffers(
  intent: SearchIntent,
): Promise<{ offers: Offer[]; warnings: string[] }> {
  const retailerList = PRIORITY_RETAILERS.join(", ");
  const constraints: string[] = [];
  if (intent.brand) constraints.push(`Brand: ${intent.brand}`);
  if (intent.model) constraints.push(`Model: ${intent.model}`);
  if (intent.productType) constraints.push(`Type: ${intent.productType}`);
  if (intent.maxPrice) constraints.push(`Maximum price: $${intent.maxPrice} CAD`);
  if (intent.minPrice) constraints.push(`Minimum price: $${intent.minPrice} CAD`);
  if (intent.features.length) constraints.push(`Features: ${intent.features.join(", ")}`);

  const prompt = `Search the web right now for current Canadian retail listings for luggage matching this request:

"${intent.terms}"
${constraints.length ? `\n${constraints.join("\n")}\n` : ""}
Prioritise these Canadian retailers: ${retailerList}. Also include brand-direct stores (Samsonite, TUMI, Away, Monos, Travelpro, Briggs & Riley) where they carry it.

Report ONLY listings you actually retrieved from a search result. For each one give the exact product page URL on the retailer's own website.

Return a JSON array. Each element:
{
  "title":    exact product title from the listing,
  "retailer": retailer name,
  "price":    numeric price in CAD, no currency symbol,
  "url":      full https URL of the product page on the retailer's own domain,
  "in_stock": true or false,
  "upc":      UPC/EAN if the listing shows one, otherwise null
}

CRITICAL RULES:
- Do NOT estimate, approximate, or recall prices from memory. Every price must come from a page you retrieved in this search.
- If you cannot find a real listing with a real price, return fewer results. An empty array [] is an acceptable and correct answer.
- Do NOT return marketplace search pages, Google Shopping links, or aggregator URLs. Only direct product pages on the retailer's own domain.
- Do NOT invent a UPC.

Return only the JSON array, no commentary.`;

  let text: string;
  try {
    ({ text } = await callGeminiGrounded(prompt, {
      temperature: 0,
      maxOutputTokens: 4096,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Google Search grounding requires a billing-enabled Gemini project; it
    // is NOT part of the API free tier. Without this check the failure reads
    // as a generic 400 and sends you hunting in the wrong place.
    if (/google_search|grounding|not supported|PERMISSION_DENIED|billing/i.test(message)) {
      throw new NoProviderError(
        "Google Search grounding isn't enabled for this Gemini key. It requires a billing-enabled Google AI Studio project (free tier excludes it). Add a SERPAPI_KEY instead, or enable billing on your Gemini project.",
      );
    }
    throw err;
  }

  const raw = parseJson<RawOffer[]>(text);
  const warnings: string[] = [];

  if (!Array.isArray(raw)) {
    return {
      offers: [],
      warnings: ["The search assistant returned an unreadable response."],
    };
  }

  const fetchedAt = new Date().toISOString();
  let rejectedDomain = 0;
  let rejectedPrice = 0;

  const offers: Offer[] = [];

  for (const r of raw) {
    const url = (r.url ?? "").trim();
    const price = Math.round(toNumber(r.price) * 100) / 100;
    const title = (r.title ?? "").trim();

    if (!url.startsWith("http") || !title) continue;

    if (!isAllowedHost(url)) {
      rejectedDomain += 1;
      continue;
    }

    if (price < MIN_PRICE || price > MAX_PRICE) {
      rejectedPrice += 1;
      continue;
    }

    const key = matchRetailer(r.retailer ?? "", url);
    // isAllowedHost passed, so the URL maps to a known retailer.
    if (!key) continue;

    offers.push({
      retailer: key,
      retailerKey: key,
      price,
      currency: "CAD",
      url,
      inStock: r.in_stock !== false,
      title,
      fetchedAt,
    });
  }

  if (rejectedDomain > 0) {
    warnings.push(
      `${rejectedDomain} result${rejectedDomain === 1 ? "" : "s"} discarded — not on a recognised retailer domain.`,
    );
  }
  if (rejectedPrice > 0) {
    warnings.push(
      `${rejectedPrice} result${rejectedPrice === 1 ? "" : "s"} discarded — price outside a believable range.`,
    );
  }

  warnings.push(
    "Prices came from AI web search rather than a shopping feed — confirm on the retailer's page before acting on them.",
  );

  return { offers, warnings };
}
