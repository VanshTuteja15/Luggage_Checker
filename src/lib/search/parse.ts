/* ------------------------------------------------------------------ */
/*  Query understanding                                               */
/*                                                                     */
/*  Turns "hard shell carry-on under $300" into structured intent so   */
/*  the shopping engine gets good keywords and the pipeline can apply  */
/*  price filters. Degrades to a keyword passthrough with no LLM.      */
/* ------------------------------------------------------------------ */

import { callGeminiJSON, geminiConfigured, type GeminiSchema } from "@/lib/gemini";
import type { SearchIntent, SearchMode } from "./types";

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

function ensureLuggageTerms(terms: string): string {
  if (/\b(luggage|suitcase|carry-?on|spinner|duffel|backpack|travel bag)\b/i.test(terms)) {
    return terms;
  }
  return `${terms} luggage`.trim();
}

function fallbackIntent(query: string, mode: SearchMode): SearchIntent {
  const terms = ensureLuggageTerms(stripPricePhrases(query) || query);
  return {
    terms,
    brand: null,
    model: null,
    productType: null,
    maxPrice: mode === "catalog" ? null : heuristicMaxPrice(query),
    minPrice: mode === "catalog" ? null : heuristicMinPrice(query),
    features: [],
    explanation:
      mode === "catalog"
        ? `Finding types, sizes and colours for "${stripPricePhrases(query) || query}".`
        : `Searching live prices for "${terms}".`,
  };
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
  mode: SearchMode = "compare",
): Promise<SearchIntent> {
  const raw = query.trim();
  if (!raw) return fallbackIntent(raw, mode);

  if (!geminiConfigured()) return fallbackIntent(raw, mode);

  const catalogExtra =
    mode === "catalog"
      ? `
This is a catalog lookup, not a price-comparison query.
- If the user named a brand (e.g. "American Tourister", "Samsonite"), put that in "brand" and set "terms" to "{brand} luggage" so the engine returns the full range of types, sizes and colours.
- Do not set productType unless the user named one — we want every type back.
- Do not set maxPrice / minPrice unless the user stated a budget.
- "explanation" should say we are listing variants, e.g. "Showing American Tourister luggage by type, size and colour."`
      : `
- "terms" must be keywords a shopping engine would match on. Include the brand and model when the user named them. Do not include price constraints or words like "cheap" or "best".
- Convert any price constraint into maxPrice / minPrice as plain numbers in CAD.
- "explanation" is one short sentence you would show the user, e.g. "Looking for Samsonite carry-on spinners under $300."`;

  const prompt = `You interpret shopping queries for a Canadian luggage price-tracking tool.

User query: "${raw}"
${catalogExtra}

Extract the search intent. Rules:
- "terms" is the keyword string sent to Google Shopping. Always include a luggage word (luggage, suitcase, carry-on) so results stay on-category.
- If the user named a specific product, put the brand in "brand" and the model line in "model".
- "features" holds attributes like "hardside", "spinner", "expandable", "carry-on size", "TSA lock".
- Never add a brand the user did not mention.`;

  try {
    const parsed = await callGeminiJSON<Record<string, unknown>>(prompt, INTENT_SCHEMA, {
      temperature: 0,
      timeoutMs: 12_000,
    });

    if (!parsed) return fallbackIntent(raw, mode);

    const terms =
      ensureLuggageTerms(cleanString(parsed.terms) ?? stripPricePhrases(raw) ?? raw);
    const features = Array.isArray(parsed.features)
      ? parsed.features.filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      : [];

    return {
      terms,
      brand: cleanString(parsed.brand),
      model: cleanString(parsed.model),
      productType: cleanString(parsed.productType),
      maxPrice:
        mode === "catalog"
          ? clampPrice(parsed.maxPrice)
          : (clampPrice(parsed.maxPrice) ?? heuristicMaxPrice(raw)),
      minPrice:
        mode === "catalog"
          ? clampPrice(parsed.minPrice)
          : (clampPrice(parsed.minPrice) ?? heuristicMinPrice(raw)),
      features,
      explanation: cleanString(parsed.explanation) ?? fallbackIntent(raw, mode).explanation,
    };
  } catch {
    return fallbackIntent(raw, mode);
  }
}
