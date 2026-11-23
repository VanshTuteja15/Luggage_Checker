/* ------------------------------------------------------------------ */
/*  Query parser (v5 F2.2; V3 S1.1–S1.3)                               */
/*                                                                     */
/*  Turns what a person types into a ParsedQuery: brand, line, model,  */
/*  size class, inches / cm / litres, type, shell, material, colour,   */
/*  price limits, store, in-stock, "cheapest", and a typo correction   */
/*  ("Did you mean …"). Rules only; no model, no network. The luggage  */
/*  pack passes its own word rules in (QueryPrimitives) so this file    */
/*  never imports the pack (no cycle) and stays browser-safe.           */
/* ------------------------------------------------------------------ */

import type { BagType, ParsedQuery } from "../types";
import {
  COLOUR_NAMED_LINES,
  MATERIAL_RULES,
  NOISE_WORDS,
  PHRASES,
  SHELL_RULES,
  STORE_NAMES,
  TYPE_RULES,
} from "./synonyms";
import { correctWord } from "./typo";
import { vocabularyIndex } from "./vocabulary";

/** What the category pack knows about words; passed in by the pack. */
export type QueryPrimitives = {
  brandOf(text: string): string | null;
  sizeClassOf(text: string): string | null;
  inchesOf(text: string): number | null;
  colourOf(text: string): string | null;
  lineOf(text: string, brand: string | null): string[];
  modelOf(text: string, brand: string | null): { model: string; colourCode: string | null } | null;
  normaliseGtin(digits: string): string | null;
  classFromInches(n: number): string | null;
  optionalLineWords: ReadonlySet<string>;
  /** Words titles use that are never product-line words (sizes, filler). */
  filler: ReadonlySet<string>;
  /** Query-only filler ("price", "cheapest", "under"). */
  queryFiller: ReadonlySet<string>;
  /** The pack's brand spellings (lower case) → brand. */
  brandAliases: ReadonlyMap<string, string>;
};

/**
 * Where a brand names a stated size differently from the inches table,
 * from our own listings (2026-11-23, dev DB, titles stating both inches and
 * a size word): Delsey calls its 23" and 24" bags "Carry-On" (10 and 2
 * titles) and its 29" a trunk (4); Briggs & Riley and Osprey call 27"
 * "Medium" (4, 3); Samsonite calls 31" "Large" (4). Used only when a query
 * gives inches but no size word, so the size we look for is the one the
 * brand's own titles carry.
 */
export const BRAND_INCH_CLASS: Record<string, Record<number, string>> = {
  Delsey: { 23: "carry_on", 24: "carry_on", 29: "extra_large" },
  "Briggs & Riley": { 27: "medium" },
  Osprey: { 27: "medium" },
  Samsonite: { 31: "large" },
};

const NOT_MONEY = String.raw`(?!\s*(?:"|”|''|-?\s?inch|-?\s?in\b|cm\b|mm\b|l\b|litres?\b|liters?\b|pieces?\b|pcs?\b|%))`;
const MONEY = String.raw`\$?\s*(\d{2,5})(?:\.\d{2})?${NOT_MONEY}(?:\s*(?:\$|dollars?|bucks|cad)\b)?`;
const BETWEEN = new RegExp(
  String.raw`\b(?:between|from)\s+${MONEY}\s+(?:and|to|-|–)\s+${MONEY}`,
  "i",
);
const RANGE = new RegExp(String.raw`\$\s*(\d{2,5})\s*(?:-|–|to)\s*\$?\s*(\d{2,5})\b`, "i");
const UNDER = new RegExp(
  String.raw`(?:\b(?:under|below|less than|cheaper than|max(?:imum)?|up to|no more than|at most)\s+|<\s*)${MONEY}`,
  "i",
);
const OVER = new RegExp(
  String.raw`(?:\b(?:over|above|more than|at least|min(?:imum)?)\s+|>\s*)${MONEY}`,
  "i",
);
const IN_STOCK = /\bin[- ]stock\b|\bavailable (?:now|today)\b/;
const SORT_PRICE = /\bcheapest\b|\blowest price\b|\bbest (?:price|deal)s?\b|\bcheap\b|\bbudget\b/;
// (not the "on" of "carry-on" / "carry on")
const STORE_PHRASE = new RegExp(
  String.raw`(?<!carry[\s-])\b(?:at|from|on)\s+(?:the\s+)?(${STORE_NAMES.map((s) => s.re.source).join("|")})\b`,
);
const CM = /\b(\d{2,3})\s*cm\b/;
const LITRES = /\b(\d{2,3})\s*(?:l|litres?|liters?)\b/;
const PIECES = /\b(\d)\s*-?\s*(?:pc|pcs|piece|pieces)\b/g;

/** Every word a query may contain that no correction should touch. */
function knownWord(w: string, p: QueryPrimitives): boolean {
  return (
    p.filler.has(w) ||
    p.queryFiller.has(w) ||
    NOISE_WORDS.has(w) ||
    p.optionalLineWords.has(w) ||
    p.colourOf(w) !== null ||
    p.sizeClassOf(w) !== null
  );
}

/** A brand our catalogue sells that the pack doesn't list (Dakine, Peak Design). */
function vocabBrand(lower: string): string | null {
  for (const { brand, re } of vocabularyIndex().brandAliases) if (re.test(lower)) return brand;
  return null;
}

/**
 * Typo correction, in two careful steps: first towards brand names (ours
 * and the catalogue's), then, once a brand is known, towards that brand's
 * own line words. A word we know in any role is never changed.
 */
function correctQuery(text: string, p: QueryPrimitives): string | null {
  const vocab = vocabularyIndex();
  const brandWords = new Map<string, number>();
  for (const alias of p.brandAliases.keys())
    for (const w of alias.split(/[^a-z0-9]+/)) if (w.length >= 4) brandWords.set(w, 1_000);
  for (const b of vocab.brandAliases)
    for (const w of b.alias.split(/[^a-z0-9]+/))
      if (w.length >= 4) brandWords.set(w, (brandWords.get(w) ?? 0) + 1);

  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  const known = (w: string) => knownWord(w, p) || vocab.words.has(w) || brandWords.has(w);
  const fixed = words.map((w) => (known(w) ? w : (correctWord(w, brandWords) ?? w)));
  const joined = fixed.join(" ");
  const brand = p.brandOf(joined) ?? vocabBrand(joined);
  if (brand) {
    const lineWords = new Map<string, number>();
    for (const l of vocab.linesByBrand.get(brand) ?? [])
      for (const w of l.phrase.split(/[^a-z0-9'.]+/))
        if (w.length >= 4) lineWords.set(w, (lineWords.get(w) ?? 0) + l.listings);
    for (let i = 0; i < fixed.length; i++)
      if (!known(fixed[i]) && !lineWords.has(fixed[i]))
        fixed[i] = correctWord(fixed[i], lineWords) ?? fixed[i];
  }
  const out = fixed.join(" ");
  return out !== lower ? out : null;
}

/** "Platinum Elite 21", "Nexis Large 28": a bare 18–34 right after the bag's words reads as inches. */
function bareInches(t: string, p: QueryPrimitives): number | null {
  for (const m of t.matchAll(/(?:^|\s)(\d{2})(?=\s|$)/g)) {
    const n = Number(m[1]);
    if (n < 18 || n > 34) continue;
    const before = t.slice(0, m.index);
    if (!/[a-z]/.test(before)) continue;
    const next =
      t
        .slice((m.index ?? 0) + m[0].length)
        .trim()
        .split(/\s+/)[0] ?? "";
    // "19 Degree": the number belongs to the line when a line word follows it.
    if (next && !knownWord(next, p)) continue;
    return n;
  }
  return null;
}

/** A title or query in one spelling (the PHRASES rewrites), lower case, padded. */
function normalised(text: string): string {
  let t = ` ${text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ")} `;
  for (const [re, to] of PHRASES) t = t.replace(re, to);
  return t.replace(/\s+/g, " ");
}

/** The bag type a title states ("4 Wheeled" → spinner), or null when it doesn't say. */
export function bagTypeOf(text: string): BagType | null {
  const t = normalised(text);
  return TYPE_RULES.find(([, re]) => re.test(t))?.[0] ?? null;
}

/** Hard or soft shell, when the title says. */
export function shellOf(text: string): "hard" | "soft" | "hybrid" | null {
  const t = normalised(text);
  return SHELL_RULES.find(([, re]) => re.test(t))?.[0] ?? null;
}

/** Parse a query with the pack's word rules and the current vocabulary. */
export function parseQueryWith(raw: string, p: QueryPrimitives): ParsedQuery {
  const typed = raw.trim().slice(0, 200);
  const corrected = correctQuery(typed, p);
  let t = normalised(corrected ?? typed);

  /* price limits */
  let minPrice: number | null = null;
  let maxPrice: number | null = null;
  const between = t.match(BETWEEN) ?? t.match(RANGE);
  if (between) {
    const a = Number(between[1]);
    const b = Number(between[2]);
    minPrice = Math.min(a, b);
    maxPrice = Math.max(a, b);
    t = t.replace(between[0], " ");
  } else {
    const under = t.match(UNDER);
    if (under) {
      maxPrice = Number(under[1]);
      t = t.replace(under[0], " ");
    }
    const over = t.match(OVER);
    if (over) {
      minPrice = Number(over[1]);
      t = t.replace(over[0], " ");
    }
  }

  /* stock, order, store */
  const inStock = IN_STOCK.test(t);
  if (inStock) t = t.replace(IN_STOCK, " ");
  const sort = SORT_PRICE.test(t) ? ("price" as const) : null;
  const storeIds: string[] = [];
  let storeBrand: string | null = null;
  const storeHit = t.match(STORE_PHRASE);
  if (storeHit) {
    const named = STORE_NAMES.find((s) => new RegExp(`^(?:${s.re.source})$`).test(storeHit[1]));
    if (named) {
      storeIds.push(named.id);
      storeBrand = named.houseBrand;
    }
    t = t.replace(storeHit[0], " ");
  }

  /* identifiers and brand */
  const gtinMatch = t.match(/\b(\d{12,14})\b/);
  const gtin = gtinMatch ? p.normaliseGtin(gtinMatch[1]) : null;
  const brand = p.brandOf(t) ?? vocabBrand(t) ?? storeBrand;
  const modelHit = gtin ? null : p.modelOf(t, brand);
  const model = modelHit ? modelHit.model : null;

  /* sizes */
  const cmHit = t.match(CM);
  const litresHit = t.match(LITRES);
  const stated = p.inchesOf(t);
  const bare = stated ? null : bareInches(t, p);
  const inches = stated ?? bare;
  let sizeClass = p.sizeClassOf(t);
  // Did the size come only from a measurement (no "medium", "carry-on"…)?
  const withoutMeasures = t
    .replace(/\b\d{2}(?:\.\d)?\s*(?:"|''|”|-?\s?inch(?:es)?\b|-?\s?in\b|\s?cm\b)/g, " ")
    .replace(/\(\d{2}\)/g, " ");
  const sizeWord = p.sizeClassOf(withoutMeasures);
  if (!sizeClass && bare) sizeClass = p.classFromInches(bare);
  const byBrand = inches && brand ? BRAND_INCH_CLASS[brand]?.[inches] : undefined;
  if (byBrand && !sizeWord) sizeClass = byBrand;
  const sizeByMeasure = !!sizeClass && !sizeWord;

  /* type, shell, material */
  const type: BagType | null = TYPE_RULES.find(([, re]) => re.test(t))?.[0] ?? null;
  const shell = SHELL_RULES.find(([, re]) => re.test(t))?.[0] ?? null;
  const material = /alu'r/.test(t)
    ? null
    : (MATERIAL_RULES.find(([, re]) => re.test(t))?.[0] ?? null);

  /* colour: not the colour word inside a line's name ("Black Label") */
  let colourText = t;
  for (const phrase of COLOUR_NAMED_LINES) colourText = colourText.replace(phrase, " ");
  const colour = p.colourOf(colourText);

  /* product line */
  let lineText = t;
  if (cmHit) lineText = lineText.replace(cmHit[0], " ");
  if (litresHit) lineText = lineText.replace(litresHit[0], " ");
  if (bare) lineText = lineText.replace(new RegExp(`(^|\\s)${bare}(?=\\s|$)`), " ");
  const pieces = new Set([...t.matchAll(PIECES)].map((m) => m[1]));
  let line = p
    .lineOf(lineText, brand)
    .filter(
      (w) =>
        !p.queryFiller.has(w) &&
        !NOISE_WORDS.has(w) &&
        !pieces.has(w) &&
        !/^\d{12,14}$/.test(w) &&
        !(minPrice !== null && w === String(minPrice)) &&
        !(maxPrice !== null && w === String(maxPrice)),
    );
  // A line whose name has a colour word keeps it ("black label").
  for (const phrase of COLOUR_NAMED_LINES) {
    const [first, ...rest] = phrase.split(" ");
    if (t.includes(phrase) && rest.every((w) => line.includes(w)) && !line.includes(first))
      line = [first, ...line];
  }
  // "TUMI 19 Degree": a two-digit number right before a line word is part of the line.
  for (const m of lineText.matchAll(/(?:^|\s)(\d{2})\s+([a-z][a-z0-9'.-]*)/g)) {
    if (Number(m[1]) === inches) continue;
    const at = line.indexOf(m[2]);
    if (at >= 0 && !line.includes(m[1])) line.splice(at, 0, m[1]);
  }
  const optionalLine = line.filter((w) => p.optionalLineWords.has(w));

  const tokens = [
    ...new Set(
      t
        .replace(/[^a-z0-9.\s-]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
        .filter((w) => w && !p.queryFiller.has(w) && !p.filler.has(w) && !NOISE_WORDS.has(w)),
    ),
  ];

  return {
    raw: typed,
    tokens,
    brand,
    line,
    sizeClass,
    inches,
    colour,
    gtin,
    model,
    maxPrice,
    minPrice,
    cm: cmHit ? Number(cmHit[1]) : null,
    litres: litresHit ? Number(litresHit[1]) : null,
    type,
    shell,
    material,
    storeIds,
    inStock,
    sort,
    optionalLine,
    sizeByMeasure,
    correctedFrom: corrected ? typed : null,
    didYouMean: corrected,
  };
}
