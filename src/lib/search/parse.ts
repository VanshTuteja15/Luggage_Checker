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

function fallbackIntent(query: string): SearchIntent {
  const terms = stripPricePhrases(query) || query;
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

    const terms = cleanString(parsed.terms) ?? stripPricePhrases(raw) ?? raw;
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
