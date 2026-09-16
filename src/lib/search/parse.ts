/* ------------------------------------------------------------------ */
/*  Query understanding                                               */
/*                                                                     */
/*  Turns "hard shell carry-on under $300" into structured intent so   */
/*  the shopping engine gets good keywords and the pipeline can apply  */
/*  price filters. Degrades to a keyword passthrough with no LLM.      */
/* ------------------------------------------------------------------ */

import { callGeminiJSON, geminiConfigured, type GeminiSchema } from "@/lib/gemini";
import type { SearchIntent } from "./types";

const INTENT_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    terms: {
      type: "STRING",
      description:
        "Keyword string to send to a shopping search engine. Product words only — no price constraints, no filler.",
    },
    brand: { type: "STRING", nullable: true },
    model: { type: "STRING", nullable: true },
    productType: {
      type: "STRING",
      nullable: true,
      description: "e.g. carry-on, checked bag, spinner, duffel, backpack, luggage set",
    },
    maxPrice: { type: "NUMBER", nullable: true },
    minPrice: { type: "NUMBER", nullable: true },
    features: { type: "ARRAY", items: { type: "STRING" } },
    explanation: {
      type: "STRING",
      description: "One short sentence, addressed to the user, describing what is being searched for.",
    },
  },
  required: ["terms", "explanation"],
};

/** Pull "$300", "under 300", "300 dollars" out of a raw query. */
function heuristicMaxPrice(query: string): number | null {
  const m = query.match(/(?:under|below|less than|max|up to|<)\s*\$?\s*(\d[\d,]*)/i);
  if (m) return Number(m[1].replace(/,/g, ""));
  return null;
}

function heuristicMinPrice(query: string): number | null {
  const m = query.match(/(?:over|above|more than|min|at least|>)\s*\$?\s*(\d[\d,]*)/i);
  if (m) return Number(m[1].replace(/,/g, ""));
  return null;
}

/** Strip price phrases so they don't pollute the shopping keywords. */
function stripPricePhrases(query: string): string {
  return query
    .replace(/(?:under|below|less than|max|up to|over|above|more than|min|at least)\s*\$?\s*\d[\d,]*/gi, "")
    .replace(/\$\s*\d[\d,]*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/*  Category anchoring                                                */
/*                                                                     */
/*  Every search in this app is about luggage, but Google doesn't know */
/*  that. "Freeform 21" returns shelving. "Alpha 3" returns car parts. */
/*  "Monos" returns a typeface. Brand-and-model queries are exactly    */
/*  what a luggage retailer's staff type, so anchoring the category    */
/*  is the difference between a useful result set and a random one.    */
/*                                                                     */
/*  Only added when the query has no luggage word of its own, so       */
/*  "carry-on spinner" is never padded into "carry-on spinner luggage  */
/*  luggage".                                                         */
/* ------------------------------------------------------------------ */

const LUGGAGE_WORDS =
  /\b(luggage|suitcase|suitcases|carry[-\s]?on|carryon|spinner|checked|check[-\s]?in|duffel|duffle|backpack|garment bag|travel bag|trolley|underseat|weekender|briefcase|tote)\b/i;

export function anchorToLuggage(terms: string): string {
  const t = terms.trim();
  if (!t) return t;
  return LUGGAGE_WORDS.test(t) ? t : `${t} luggage`;
}

function fallbackIntent(query: string): SearchIntent {
  const terms = anchorToLuggage(stripPricePhrases(query) || query);
  return {
    terms,
    brand: null,
    model: null,
    productType: null,
    maxPrice: heuristicMaxPrice(query),
    minPrice: heuristicMinPrice(query),
    features: [],
    explanation: `Searching for "${terms}".`,
  };
}

/**
 * True when a query is just a product name — brand, model, maybe a size —
 * with nothing an LLM could usefully extract.
 *
 * Conservative: anything with a price constraint, a comparison word, or a
 * sentence-like shape goes to the model.
 */
export function isPlainProductQuery(query: string): boolean {
  const q = query.trim();
  if (!q) return false;

  // Price constraints are the main thing the LLM is there for.
  if (/\d\s*(?:dollars?|cad|\$)|\$\s*\d/i.test(q)) return false;
  if (/\b(under|below|less than|over|above|more than|between|max|min|up to|at least|cheaper|cheapest|budget)\b/i.test(q)) {
    return false;
  }

  // Questions and instructions, not product names.
  if (/[?]/.test(q)) return false;
  if (/\b(show|find|get|need|want|looking|compare|best|good|vs|versus|for my|that|which|what|recommend)\b/i.test(q)) {
    return false;
  }

  // Short and plain. Six words covers "Samsonite Omni PC 20 inch spinner".
  return q.split(/\s+/).filter(Boolean).length <= 6;
}

function clampPrice(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return null;
  return Math.round(n * 100) / 100;
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "none") return null;
  return s;
}

/**
 * Interpret a natural-language query. Never throws — a failure here should
 * degrade the search, not break it.
 */
export async function parseQuery(
  query: string,
  opts: { timeoutMs?: number } = {},
): Promise<SearchIntent> {
  const raw = query.trim();
  if (!raw) return fallbackIntent(raw);

  if (!geminiConfigured()) return fallbackIntent(raw);

  // A plain product query needs no LLM: the heuristic produces the same
  // keywords the model would, instantly and without a network round trip.
  //
  // This matters more than it looks. "samsonite luggage" is the typical
  // search, and sending it to Gemini added a network hop that could take
  // seconds — time subtracted from the only call that actually returns
  // prices. The LLM earns its place on queries with real structure to
  // extract ("hard shell carry-on under $300"), not on two nouns.
  if (isPlainProductQuery(raw)) return fallbackIntent(raw);

  // With no time left, skip the LLM entirely — the heuristic parser still
  // extracts price limits and usable keywords.
  const timeoutMs = opts.timeoutMs ?? 12_000;
  if (timeoutMs < 2_000) return fallbackIntent(raw);

  const prompt = `You interpret shopping queries for a Canadian luggage price-tracking tool.

User query: "${raw}"

Extract the search intent. Rules:
- "terms" must be keywords a shopping engine would match on. Include the brand and model when the user named them. Do not include price constraints or words like "cheap" or "best".
- If the user named a specific product, put the brand in "brand" and the model line in "model".
- Convert any price constraint into maxPrice / minPrice as plain numbers in CAD.
- "features" holds attributes like "hardside", "spinner", "expandable", "carry-on size", "TSA lock".
- "explanation" is one short sentence you would show the user, e.g. "Looking for Samsonite carry-on spinners under $300."
- Never add a brand the user did not mention.`;

  try {
    const parsed = await callGeminiJSON<Record<string, unknown>>(prompt, INTENT_SCHEMA, {
      temperature: 0,
      timeoutMs,
    });

    if (!parsed) return fallbackIntent(raw);

    const terms = anchorToLuggage(cleanString(parsed.terms) ?? stripPricePhrases(raw) ?? raw);
    const features = Array.isArray(parsed.features)
      ? parsed.features.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];

    return {
      terms,
      brand: cleanString(parsed.brand),
      model: cleanString(parsed.model),
      productType: cleanString(parsed.productType),
      maxPrice: clampPrice(parsed.maxPrice) ?? heuristicMaxPrice(raw),
      minPrice: clampPrice(parsed.minPrice) ?? heuristicMinPrice(raw),
      features,
      explanation: cleanString(parsed.explanation) ?? `Searching for "${terms}".`,
    };
  } catch {
    return fallbackIntent(raw);
  }
}
