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
import type { Offer, SearchMode, SearchProduct } from "./types";

/** Colour words that appear in luggage titles, for variant separation. */
const COLOUR_WORDS =
  /\b(black|white|grey|gray|silver|navy|blue|red|green|teal|purple|pink|burgundy|maroon|brown|tan|beige|gold|rose gold|rose|charcoal|graphite|champagne|olive|khaki|orange|yellow|ivory|cream|bronze|copper|coral)\b/i;

/** Pull a colour out of a listing title, or "" when it names none. */
export function extractColour(title: string): string {
  const m = title.match(COLOUR_WORDS);
  if (!m) return "";
  return m[1].replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The same colour vocabulary, as single tokens, for signature building. */
const COLOUR_TOKENS = new Set(
  COLOUR_WORDS.source
    .replace(/^\\b\(|\)\\b$/g, "")
    .split("|")
    .flatMap((w) => w.split(" ")),
);

function isColourToken(token: string): boolean {
  return COLOUR_TOKENS.has(token.toLowerCase());
}

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

/** Pull a size out of a listing title: 21", 28 inch, Carry-On, Check-In. */
export function extractSize(title: string): string {
  const inches = title.match(/\b(\d{2}(?:\.\d)?)\s*(?:"|''|inch|inches|in\b)/i);
  if (inches) return `${inches[1]} inch`;
  if (/\bcarry[-\s]?on\b/i.test(title)) return "Carry-On";
  if (/\bcheck(?:ed)?[-\s]?in\b/i.test(title)) return "Check-In";
  if (/\bunderseat\b/i.test(title)) return "Underseat";
  return "";
}

/**
 * What identifies a listing, for grouping without an LLM.
 *
 * Model numbers are kept ("Winfield 2" is not "Winfield 3", "Alpha 3" is not
 * "Alpha 4"), sizes are compared separately, and colour is ignored unless
 * the caller is browsing variants.
 */
type Identity = { tokens: Set<string>; brand: string; size: string; colour: string };

/** Two-digit numbers in this range are almost always a size in inches. */
function isSizeNumber(t: string): boolean {
  const n = Number(t);
  return /^\d{2}$/.test(t) && n >= 14 && n <= 34;
}

function identify(title: string): Identity {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s".]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/["]+$/, ""))
    .filter(Boolean);

  const meaningful = tokens.filter((t) => {
    if (NOISE_WORDS.has(t) || isColourToken(t)) return false;
    if (/^\d+$/.test(t)) return !isSizeNumber(t) && (t.length === 1 || t.length >= 3);
    return t.length > 2;
  });

  return {
    tokens: new Set(meaningful),
    brand: meaningful.find((t) => !/^\d+$/.test(t)) ?? "",
    size: extractSize(title),
    colour: extractColour(title).toLowerCase(),
  };
}

/**
 * Same physical product? Brand must match, sizes must not conflict, and the
 * remaining words must overlap strongly — either most words shared, or one
 * title's words (at least three) almost entirely contained in the other's,
 * which covers a short title vs a long marketing one.
 */
function sameProduct(a: Identity, b: Identity, mode: SearchMode): boolean {
  if (a.brand && b.brand && a.brand !== b.brand) return false;
  if (a.size && b.size && a.size !== b.size) return false;
  if (mode === "catalog" && a.colour !== b.colour) return false;

  // Model numbers must agree when both titles have one.
  const numsA = [...a.tokens].filter((t) => /^\d+$/.test(t));
  const numsB = [...b.tokens].filter((t) => /^\d+$/.test(t));
  if (numsA.length && numsB.length && !numsA.some((n) => numsB.includes(n))) return false;

  let overlap = 0;
  for (const t of a.tokens) if (b.tokens.has(t)) overlap++;
  const union = new Set([...a.tokens, ...b.tokens]).size;
  if (union === 0 || overlap === 0) return false;

  const jaccard = overlap / union;
  const containment = overlap / Math.min(a.tokens.size, b.tokens.size);
  if (jaccard >= 0.6) return true;
  if (overlap >= 3 && containment >= 0.85) return true;

  // Same stated size, and one title (brand + model at least) sits wholly
  // inside the other: "Samsonite Freeform 28"" vs "Samsonite Freeform
  // Hardside Expandable Spinner 28" Large Check-In".
  return !!a.size && a.size === b.size && overlap >= 2 && containment === 1;
}

function cleanStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Store names to strip from titles. Brand-direct retailers (Travelpro,
 * Away, Monos, RIMOWA, TUMI, Samsonite…) are left alone: their name IS the
 * product's brand, and stripping it turned "Away Bigger Carry-On" into a
 * product whose brand was "Bigger".
 */
const STORE_NAMES = Object.entries(RETAILER_INFO)
  .filter(([, info]) => info.category !== "specialty")
  .map(([name]) => name);

/** Strip a store's name out of a title so product names read cleanly. */
function stripRetailerNames(title: string): string {
  let out = title;
  for (const name of STORE_NAMES) {
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "");
  }
  return out.replace(/\s{2,}/g, " ").replace(/^[\s\-–|,]+|[\s\-–|,]+$/g, "").trim();
}

/** Build a SearchProduct from a set of offers plus descriptive fields. */
function buildProduct(
  offers: Offer[],
  meta: { name: string; brand: string; model: string; color: string; size: string; productType: string | null; upc: string | null },
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
    size: meta.size,
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

export function clusterHeuristic(offers: Offer[], mode: SearchMode = "compare"): SearchProduct[] {
  // Greedy grouping: each listing joins the first group whose founding
  // listing is the same product, else starts a new group. Order-insensitive
  // on words, so "Rhapsody 360 Medium Spinner – Samsonite" and "Samsonite
  // Rhapsody 360 Spinner Medium" land together. In catalog mode colour is
  // part of identity, so the black and navy versions stay separate rows.
  const groups: { id: Identity; offers: Offer[] }[] = [];

  for (const offer of offers) {
    const id = identify(stripRetailerNames(offer.title));
    const home = groups.find((g) => sameProduct(g.id, id, mode));
    if (home) home.offers.push(offer);
    else groups.push({ id, offers: [offer] });
  }

  const products: SearchProduct[] = [];

  for (const { offers: group } of groups) {
    const title = stripRetailerNames(group[0].title);
    const words = title.split(/\s+/);
    const brand = words[0] ?? "Unknown";
    const model = words.slice(1, 4).join(" ") || title;

    const product = buildProduct(group, {
      name: title.slice(0, 140) || "Unknown product",
      brand,
      model,
      color: extractColour(group[0].title),
      size: extractSize(group[0].title),
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
  opts: { timeoutMs?: number; mode?: SearchMode } = {},
): Promise<SearchProduct[]> {
  const mode: SearchMode = opts.mode ?? "compare";

  if (offers.length === 0) return [];
  if (!geminiConfigured()) return clusterHeuristic(offers, mode);

  // Out of time — fall back to heuristic grouping rather than returning
  // nothing. Real prices grouped imperfectly beat an empty result.
  const timeoutMs = opts.timeoutMs ?? 25_000;
  if (timeoutMs < 4_000) return clusterHeuristic(offers, mode);

  const listing = offers
    .map((o, i) => `${i} | ${o.retailer} | $${o.price.toFixed(2)} | ${o.title.slice(0, 130)}`)
    .join("\n");

  const prompt = `Below are luggage listings from Canadian retailers, one per line, formatted as:
index | retailer | price | title

${listing}

Group these listings by the physical product they are selling. Two listings belong to the same product only when they are the same brand, the same model line, and the same size. Different sizes of the same model are DIFFERENT products. ${
    mode === "catalog"
      ? 'Different COLOURS of the same model and size are also DIFFERENT products — the user is browsing a range and needs to pick a specific variant, so keep each colour as its own product and name the colour in "color".'
      : 'Different colours of the same model and size may be grouped together; put the most common colour in "color".'
  }

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
    if (!Array.isArray(clusters) || clusters.length === 0) return clusterHeuristic(offers, mode);

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
        size: size || extractSize(group[0].title),
        productType: cleanStr(c.productType) || null,
        upc,
      });
      if (product) products.push(product);
    }

    // Recover anything the model dropped.
    const leftovers = offers.filter((_, i) => !used.has(i));
    if (leftovers.length > 0) products.push(...clusterHeuristic(leftovers, mode));

    return products.length > 0 ? products : clusterHeuristic(offers, mode);
  } catch {
    return clusterHeuristic(offers, mode);
  }
}
