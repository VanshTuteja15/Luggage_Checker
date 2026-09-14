/* ------------------------------------------------------------------ */
/*  Offer clustering                                                  */
/*                                                                     */
/*  A shopping engine returns a flat list of listings. Eight of them   */
/*  may be the same suitcase at eight retailers, with eight slightly   */
/*  different titles. Grouping them is what turns a list of links into */
/*  a price comparison — and it's the job an LLM is genuinely good at. */
/*                                                                     */
/*  The model only ever sees titles and groups indexes. It cannot      */
/*  change a price, a URL or a retailer: those are carried over from   */
/*  the original offers by index.                                      */
/* ------------------------------------------------------------------ */

import { callGeminiJSON, geminiConfigured, type GeminiSchema } from "@/lib/gemini";
import { RETAILER_INFO } from "@/lib/retailers";
import type { Offer, SearchProduct } from "./types";

const CLUSTER_SCHEMA: GeminiSchema = {
  type: "OBJECT",
  properties: {
    products: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING", description: "Clean product name, brand included, no retailer name, no marketing copy." },
          brand: { type: "STRING" },
          model: { type: "STRING", description: "Model / collection line, e.g. 'Freeform', 'Alpha 3', 'Maxlite 5'." },
          color: { type: "STRING", nullable: true },
          size: { type: "STRING", nullable: true, description: "e.g. '21 inch', 'Carry-On', 'Large Check-In'." },
          productType: { type: "STRING", nullable: true },
          upc: { type: "STRING", nullable: true },
          offerIndexes: { type: "ARRAY", items: { type: "INTEGER" } },
        },
        required: ["name", "brand", "offerIndexes"],
      },
    },
  },
  required: ["products"],
};

type RawCluster = {
  name?: string;
  brand?: string;
  model?: string;
  color?: string | null;
  size?: string | null;
  productType?: string | null;
  upc?: string | null;
  offerIndexes?: number[];
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

const NOISE_WORDS = new Set([
  "luggage", "suitcase", "spinner", "wheeled", "upright", "bag", "travel",
  "new", "sale", "free", "shipping", "with", "and", "the", "for", "inch",
  "in", "of", "hardside", "softside", "expandable", "lightweight", "set",
  "piece", "pc", "tsa", "lock", "carry", "on", "carryon", "checked",
  "black", "blue", "silver", "grey", "gray", "navy", "red", "green",
]);

/** A rough identity signature for a listing title, used as an LLM fallback. */
function titleSignature(title: string): string {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s".]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const sizeToken = tokens.find((t) => /^\d{2}(\.\d)?("|inch|in)?$/.test(t)) ?? "";
  const meaningful = tokens
    .filter((t) => !NOISE_WORDS.has(t) && !/^\d+$/.test(t) && t.length > 2)
    .slice(0, 4);

  return [...meaningful, sizeToken].filter(Boolean).join("-");
}

function cleanStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** Strip a retailer's name out of a title so product names read cleanly. */
function stripRetailerNames(title: string): string {
  let out = title;
  for (const name of Object.keys(RETAILER_INFO)) {
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "");
  }
  return out.replace(/\s{2,}/g, " ").replace(/^[\s\-–|,]+|[\s\-–|,]+$/g, "").trim();
}

/** Build a SearchProduct from a set of offers plus descriptive fields. */
function buildProduct(
  offers: Offer[],
  meta: { name: string; brand: string; model: string; color: string; productType: string | null; upc: string | null },
): SearchProduct | null {
  if (offers.length === 0) return null;

  // Keep the cheapest offer per retailer — a retailer listing the same item
  // three times is noise, not choice.
  const byRetailer = new Map<string, Offer>();
  for (const o of offers) {
    const existing = byRetailer.get(o.retailer);
    if (!existing || o.price < existing.price) byRetailer.set(o.retailer, o);
  }

  const deduped = [...byRetailer.values()].sort((a, b) => a.price - b.price);
  const prices = deduped.map((o) => o.price);
  const lowest = Math.min(...prices);
  const highest = Math.max(...prices);

  const thumbnail = deduped.find((o) => o.thumbnail)?.thumbnail ?? null;
  const key = slugify(`${meta.brand} ${meta.model} ${meta.color}`.trim()) || slugify(meta.name);

  return {
    key,
    name: meta.name,
    brand: meta.brand,
    model: meta.model,
    color: meta.color,
    upc: meta.upc,
    productType: meta.productType,
    imageUrl: thumbnail,
    offers: deduped,
    lowestPrice: lowest,
    highestPrice: highest,
    retailerCount: deduped.length,
    spread: Math.round((highest - lowest) * 100) / 100,
    hasMajorRetailer: deduped.some(
      (o) => o.retailerKey !== null && RETAILER_INFO[o.retailerKey]?.category === "major",
    ),
  };
}

/* ------------------------------------------------------------------ */
/*  Heuristic clustering (no LLM)                                     */
/* ------------------------------------------------------------------ */

export function clusterHeuristic(offers: Offer[]): SearchProduct[] {
  const groups = new Map<string, Offer[]>();

  for (const offer of offers) {
    const sig = titleSignature(offer.title) || offer.title.toLowerCase().slice(0, 30);
    const existing = groups.get(sig);
    if (existing) existing.push(offer);
    else groups.set(sig, [offer]);
  }

  const products: SearchProduct[] = [];

  for (const group of groups.values()) {
    const title = stripRetailerNames(group[0].title);
    const words = title.split(/\s+/);
    const brand = words[0] ?? "Unknown";
    const model = words.slice(1, 4).join(" ") || title;

    const product = buildProduct(group, {
      name: title.slice(0, 140) || "Unknown product",
      brand,
      model,
      color: "",
      productType: null,
      upc: null,
    });
    if (product) products.push(product);
  }

  return products;
}

/* ------------------------------------------------------------------ */
/*  LLM clustering                                                    */
/* ------------------------------------------------------------------ */

/**
 * Group offers into distinct products.
 *
 * Falls back to heuristic grouping when Gemini isn't configured or returns
 * something unusable. Any offer the model failed to place is recovered by
 * the heuristic, so no real listing is ever silently lost.
 */
export async function clusterOffers(
  offers: Offer[],
  opts: { timeoutMs?: number } = {},
): Promise<SearchProduct[]> {
  if (offers.length === 0) return [];
  if (!geminiConfigured()) return clusterHeuristic(offers);

  // Out of time — fall back to heuristic grouping rather than returning
  // nothing. Real prices grouped imperfectly beat an empty result.
  const timeoutMs = opts.timeoutMs ?? 25_000;
  if (timeoutMs < 4_000) return clusterHeuristic(offers);

  const listing = offers
    .map((o, i) => `${i} | ${o.retailer} | $${o.price.toFixed(2)} | ${o.title.slice(0, 130)}`)
    .join("\n");

  const prompt = `Below are luggage listings from Canadian retailers, one per line, formatted as:
index | retailer | price | title

${listing}

Group these listings by the physical product they are selling. Two listings belong to the same product only when they are the same brand, the same model line, and the same size. Different sizes of the same model are DIFFERENT products. Different colours of the same model and size may be grouped together; put the most common colour in "color".

For each product give a clean "name" (brand + model + size, no retailer name, no marketing words like "New" or "Free Shipping"), the "brand", the "model" line, optional "color", "size" and "productType", and "offerIndexes": every index from the list above that belongs to this product.

Rules:
- Use each index at most once, across all products.
- Include every index in exactly one product. Do not drop any.
- Only set "upc" if a UPC or EAN literally appears in the title. Otherwise null.
- Do not invent products that are not in the list.`;

  try {
    const parsed = await callGeminiJSON<{ products?: RawCluster[] }>(prompt, CLUSTER_SCHEMA, {
      temperature: 0,
      maxOutputTokens: 4096,
      timeoutMs,
    });

    const clusters = parsed?.products;
    if (!Array.isArray(clusters) || clusters.length === 0) return clusterHeuristic(offers);

    const used = new Set<number>();
    const products: SearchProduct[] = [];

    for (const c of clusters) {
      const indexes = (Array.isArray(c.offerIndexes) ? c.offerIndexes : [])
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < offers.length && !used.has(n));

      if (indexes.length === 0) continue;
      indexes.forEach((n) => used.add(n));

      const group = indexes.map((n) => offers[n]);
      const brand = cleanStr(c.brand) || stripRetailerNames(group[0].title).split(/\s+/)[0] || "Unknown";
      const model = cleanStr(c.model);
      const size = cleanStr(c.size);
      const name =
        cleanStr(c.name) ||
        [brand, model, size].filter(Boolean).join(" ") ||
        stripRetailerNames(group[0].title).slice(0, 140);

      // Only trust a UPC that is actually a plausible barcode.
      const rawUpc = cleanStr(c.upc).replace(/\D/g, "");
      const upc = rawUpc.length >= 12 && rawUpc.length <= 14 ? rawUpc : null;

      const product = buildProduct(group, {
        name: name.slice(0, 140),
        brand,
        model: model || size || name,
        color: cleanStr(c.color),
        productType: cleanStr(c.productType) || null,
        upc,
      });
      if (product) products.push(product);
    }

    // Recover anything the model dropped.
    const leftovers = offers.filter((_, i) => !used.has(i));
    if (leftovers.length > 0) products.push(...clusterHeuristic(leftovers));

    return products.length > 0 ? products : clusterHeuristic(offers);
  } catch {
    return clusterHeuristic(offers);
  }
}
