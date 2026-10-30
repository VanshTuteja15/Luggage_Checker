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
/*    4. close line words → review (grey zone; a person decides, an AI   */
/*       verdict may advise but never merges) (A5.3)                     */
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

/** Line-word overlap (Jaccard) at which a pair is a near match for review. */
export const NEAR_MATCH = 0.6;

const EXTRA_LINE_WORDS = ["international", "lite", "compact", "business", "global", "domestic"];
const EDITION_RE =
  /\b(\d+(?:st|nd|rd|th)\s+anniversary(?:\s+edition)?|limited edition|special edition|signature edition)\b/i;
const SIZED_CARRY_ON_RE =
  /\b(large|small|compact)\s+(?:expandable\s+|international\s+)?carry[-\s]?on\b/i;
const WHEELS_RE = /\b([24])\s*-?\s*wheel(?:ed|s)?\b/i;

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
  if (versionDigits(pack, a) !== versionDigits(pack, b)) return "version or model numbers differ";
  const wa = a.match(WHEELS_RE)?.[1];
  const wb = b.match(WHEELS_RE)?.[1];
  if (wa && wb && wa !== wb) return `wheels differ (${wa} vs ${wb})`;
  const ea = a.match(EDITION_RE)?.[1]?.toLowerCase() ?? null;
  const eb = b.match(EDITION_RE)?.[1]?.toLowerCase() ?? null;
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
  if (A.key && A.key === B.key) {
    // One store selling two products under one name in the same colour: a person decides.
    if (sameStore && a.externalId && b.externalId && a.externalId !== b.externalId && !otherColour)
      return { verdict: "review", why: "two products at one store share this name" };
    return otherColour
      ? { verdict: "variant", why: "same key, other colour" }
      : { verdict: "same", why: A.key };
  }
  return lineOverlap(A.line, B.line) >= NEAR_MATCH
    ? { verdict: "review", why: "near match" }
    : { verdict: "different", why: "line" };
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
