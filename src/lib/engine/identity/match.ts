/* ------------------------------------------------------------------ */
/*  Matching v2: the pair rules (v4 A5)                                */
/*                                                                     */
/*  One place for "are these two listings the same product?", used by  */
/*  resolution, the AI judge's hard vetoes and the eval, so what we     */
/*  measure is what runs. Order:                                         */
/*    1. the same store SKU at one store → the same product (A5.1)       */
/*    2. hard vetoes → different, whatever else matches (A5.2): size     */
/*       class, stated inches, version/model numbers, stated wheel       */
/*       counts, an edition, a Large/Small/Compact carry-on, an extra    */
/*       line word on one side (International, Lite, Compact, Business,  */
/*       Global, Domestic)                                               */
/*    3. the same identity key → same (other colour → variant), except   */
/*       two different products of one store in the same colour → review */
/*    4. a real near match → review (grey zone; a person decides, an AI  */
/*       verdict may advise but never merges) (A5.3). Stricter since the */
/*       owner's 2026-10-30 answer ("only real near matches"): when the  */
/*       store itself lists the two as separate pages, only the colour   */
/*       part of the names may differ; otherwise the names may be at     */
/*       most one product word apart (and overlap ≥ NEAR_MATCH).         */
/*  "Expandable" is NOT a veto: on our labelled pairs 4 true matches     */
/*  (Samsonite Outline Pro, Paralux) differ only by it, so it stays in   */
/*  the grey zone.                                                      */
/* ------------------------------------------------------------------ */

import type { CategoryPack } from "../types";

/** brand|line words (sorted)|size[|inches]: the name-level identity of a product. */
export function identityKey(
  brand: string | null,
  line: string[],
  sizeClass: string | null,
  inches: number | null = null,
): string | null {
  if (!brand || line.length === 0 || !sizeClass) return null;
  const base = `${brand.toLowerCase()}|${[...line].sort().join(" ")}|${sizeClass}`;
  return inches ? `${base}|${inches}in` : base;
}

/** Product-word overlap (Jaccard) at which a pair is a near match for review. */
export const NEAR_MATCH = 0.6;

const EXTRA_LINE_WORDS = ["international", "lite", "compact", "business", "global", "domestic"];
const ANNIVERSARY_RE = /\b(\d+(?:st|nd|rd|th)\s+anniversary)\b/i;
// "Roland Garros Edition", "Third Edition", "Limited Edition": the word before it.
const EDITION_RE = /\b([a-z0-9'’]+)\s+edition\b/i;
const SIZED_CARRY_ON_RE =
  /\b(large|small|compact)\s+(?:expandable\s+|international\s+)?carry[-\s]?on\b/i;
const WHEELS_RE = /\b([24])\s*-?\s*wheel(?:ed|s)?\b/i;
// Every inch figure, not only luggage sizes: a 13" vs 15" laptop cover, a 30" vs 36" trunk.
const STATED_INCHES_RE = /\b(\d{2}(?:\.\d)?)\s*(?:"|''|”|-?\s?inch(?:es)?\b|-?\s?in\b)/g;
// Letter sizes only as their own upper-case token ("Duffel—M", "Rain Cover - L"); "62L" is litres.
const SIZE_LETTER_RE = /(?<![A-Za-z0-9'’])(XS|S|M|L|XL|XXL)(?![A-Za-z0-9'’])/g;
const SIZE_WORD_RE = /\b(extra[-\s]large|x-large|small|medium|large)\b/gi;
const SIZE_WORDS: Record<string, string> = {
  small: "s",
  medium: "m",
  large: "l",
  "x-large": "xl",
};

/** A stated wheel count, else the bag type: a spinner has 4, an upright or rollaboard 2. */
function wheelsOf(t: string): string | null {
  const n = t.match(WHEELS_RE)?.[1];
  if (n) return n;
  if (/\bspinners?\b/i.test(t)) return "4";
  if (/\b(?:upright|roll-?aboard)\b/i.test(t)) return "2";
  return null;
}

function editionOf(t: string): string | null {
  const m = t.match(ANNIVERSARY_RE) ?? t.match(EDITION_RE);
  return m ? m[1].toLowerCase() : null;
}

function statedInches(t: string): Set<string> {
  return new Set([...t.toLowerCase().matchAll(STATED_INCHES_RE)].map((m) => m[1]));
}

function statedSizes(t: string): Set<string> {
  const out = new Set([...t.matchAll(SIZE_LETTER_RE)].map((m) => m[1].toLowerCase()));
  for (const m of t.matchAll(SIZE_WORD_RE)) {
    const w = m[1].toLowerCase();
    out.add(SIZE_WORDS[w] ?? "xl");
  }
  return out;
}

const disjoint = (a: Set<string>, b: Set<string>) =>
  a.size > 0 && b.size > 0 && ![...a].some((x) => b.has(x));

const wordsOf = (t: string) =>
  new Set(
    t
      .toLowerCase()
      .split(/[^a-z0-9.]+/)
      .filter(Boolean),
  );

/**
 * Numbers among the line words ("Omni 3.0", "Maxlite 5", "V2", "19
 * Degree"); sizes, piece counts and store SKU prefixes are not line words.
 */
function versionDigits(pack: CategoryPack, t: string): string {
  return pack
    .lineOf(t, pack.brandOf(t))
    .filter((w) => /\d/.test(w))
    .sort()
    .join(" ");
}

/** Hard identity rules nothing overrules (not a model, not a near match). */
export function hardVeto(pack: CategoryPack, a: string, b: string): string | null {
  const sa = pack.sizeClassOf(a);
  const sb = pack.sizeClassOf(b);
  if (sa && sb && sa !== sb) return `size differs (${sa} vs ${sb})`;
  const ia = pack.inchesOf(a);
  const ib = pack.inchesOf(b);
  if (ia && ib && ia !== ib) return `inches differ (${ia} vs ${ib})`;
  const inA = statedInches(a);
  const inB = statedInches(b);
  if (disjoint(inA, inB)) return `inches differ (${[...inA].join("/")} vs ${[...inB].join("/")})`;
  const za = statedSizes(a);
  const zb = statedSizes(b);
  if (disjoint(za, zb))
    return `sizes differ (${[...za].join("/").toUpperCase()} vs ${[...zb].join("/").toUpperCase()})`;
  if (versionDigits(pack, a) !== versionDigits(pack, b)) return "version or model numbers differ";
  const wa = wheelsOf(a);
  const wb = wheelsOf(b);
  if (wa && wb && wa !== wb) return `wheels differ (${wa} vs ${wb})`;
  const ea = editionOf(a);
  const eb = editionOf(b);
  if (ea !== eb) return `edition differs (${ea ?? "none"} vs ${eb ?? "none"})`;
  const ca = a.match(SIZED_CARRY_ON_RE)?.[1]?.toLowerCase() ?? null;
  const cb = b.match(SIZED_CARRY_ON_RE)?.[1]?.toLowerCase() ?? null;
  if (ca !== cb) return `"${ca ?? cb} carry-on" on one side only`;
  const xa = wordsOf(a);
  const xb = wordsOf(b);
  const extra = EXTRA_LINE_WORDS.find((w) => xa.has(w) !== xb.has(w));
  if (extra) return `"${extra}" on one side only`;
  return null;
}

export type PairSide = {
  title: string;
  sourceId?: string | null;
  /** The store's own product id (e.g. the Shopify product id), when known. */
  externalId?: string | null;
  storeSku?: string | null;
  brand?: string | null;
};

export type MatchVerdict = {
  verdict: "same" | "variant" | "different" | "review";
  why: string;
};

export function lineOverlap(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * The name without its trailing variant parts ("… - Textured Finish - Grey
 * Textured", "… - New Taupe Green/TNF Black-NPF", "LINE | Product, Navy
 * blue"): stores put colours and finishes there, and colour words we don't
 * know ("TNF Black", "Burgundy Crush") would otherwise read as line words.
 */
export function productName(title: string): string {
  const dash = title.search(/\s[-–—]\s/);
  let head = dash > 0 ? title.slice(0, dash) : title;
  const comma = head.match(/^(.*\S),\s*([^,]{2,40})$/);
  if (comma && comma[2].trim().split(/\s+/).length <= 4) head = comma[1];
  return head.trim().split(/\s+/).length >= 2 ? head.trim() : title;
}

/** The line words of a product's name (its colour part left out). */
export function productWords(pack: CategoryPack, title: string, brand: string | null): string[] {
  return pack.lineOf(productName(title), brand ?? pack.brandOf(title));
}

export type NearMatch =
  { near: true; score: number; why: string } | { near: false; score: number; why: string };

/**
 * Is a pair the hard vetoes let through a real near match, worth a person's
 * time (A5.3)? `listedApart`: the store itself sells the two as separate
 * pages, so a word in the product names is the store telling them apart; only
 * the colour part may differ (a store that lists each colour as its own page).
 * Otherwise the names may be at most one product word apart.
 */
export function nearMatch(
  pack: CategoryPack,
  a: { title: string; brand: string | null },
  b: { title: string; brand: string | null },
  listedApart: boolean,
): NearMatch {
  const wa = productWords(pack, a.title, a.brand);
  const wb = productWords(pack, b.title, b.brand);
  const diff = [...wa.filter((w) => !wb.includes(w)), ...wb.filter((w) => !wa.includes(w))];
  const score = lineOverlap(wa, wb);
  if (listedApart)
    return diff.length === 0
      ? { near: true, score, why: "listed apart by the store; only the colour part differs" }
      : { near: false, score, why: `listed apart by the store ("${diff.join(" ")}")` };
  if (diff.length <= 1 && score >= NEAR_MATCH)
    return {
      near: true,
      score,
      why: diff.length ? `one product word apart ("${diff[0]}")` : "same product words",
    };
  return { near: false, score, why: `${diff.length} product words apart` };
}

export function matchVerdict(pack: CategoryPack, a: PairSide, b: PairSide): MatchVerdict {
  const sameStore = !!a.sourceId && a.sourceId === b.sourceId;
  if (sameStore && a.storeSku && a.storeSku === b.storeSku)
    return { verdict: "same", why: `same store SKU ${a.storeSku}` };
  const side = (s: PairSide) => {
    const brand = s.brand ?? pack.brandOf(s.title);
    const line = pack.lineOf(s.title, brand);
    return {
      brand,
      line,
      colour: pack.colourOf(s.title),
      key: identityKey(brand, line, pack.sizeClassOf(s.title), pack.inchesOf(s.title)),
    };
  };
  const A = side(a);
  const B = side(b);
  if (A.brand && B.brand && A.brand !== B.brand) return { verdict: "different", why: "brand" };
  const veto = hardVeto(pack, a.title, b.title);
  if (veto) return { verdict: "different", why: veto };
  const otherColour = !!A.colour && !!B.colour && A.colour.toLowerCase() !== B.colour.toLowerCase();
  // The store's own ids say these are two of its products (A5.1).
  const listedApart =
    sameStore &&
    ((!!a.externalId && !!b.externalId && a.externalId !== b.externalId) ||
      (!!a.storeSku && !!b.storeSku && a.storeSku !== b.storeSku));
  if (A.key && A.key === B.key) {
    // One store selling two products under one name in the same colour: a person decides.
    if (listedApart && !otherColour)
      return { verdict: "review", why: "two products at one store share this name" };
    return otherColour
      ? { verdict: "variant", why: "same key, other colour" }
      : { verdict: "same", why: A.key };
  }
  const near = nearMatch(
    pack,
    { title: a.title, brand: A.brand },
    { title: b.title, brand: B.brand },
    listedApart,
  );
  return near.near
    ? { verdict: "review", why: `near match: ${near.why}` }
    : { verdict: "different", why: near.why };
}

/* ── Advisory AI verdict for the grey zone (A5.3) ─────────────────── */

export type JudgeRequest = { a: string; b: string; storeA: string; storeB: string };

let advisor: ((r: JudgeRequest) => Promise<void>) | null = null;

/**
 * The worker installs this when `ai.match_judge` may run: it queues the
 * judge on an AI lane and the answer lands in ai_cache beside the review.
 * Advice only: nothing here merges, and a failure never blocks resolution.
 */
export function setReviewAdvisor(fn: ((r: JudgeRequest) => Promise<void>) | null): void {
  advisor = fn;
}

export async function adviseReview(r: JudgeRequest): Promise<void> {
  if (!advisor) return;
  try {
    await advisor(r);
  } catch (err) {
    console.error("identity: review advice not queued", err);
  }
}
