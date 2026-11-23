/* ------------------------------------------------------------------ */
/*  Query → listing matching, shared by both stores                   */
/*                                                                     */
/*  The memory store scores in JS; the Postgres store turns the same    */
/*  required terms into a tsquery over the generated `search_tsv`.      */
/*  Tokenisation mirrors Postgres's 'simple' parser closely enough for   */
/*  the words we match on (brand, line, version numbers, identifiers).  */
/* ------------------------------------------------------------------ */

import type { ListingRecord, ParsedQuery } from "../types";

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

export function haystackFor(
  l: Pick<ListingRecord, "brand" | "title" | "identifiers">,
): Set<string> {
  return new Set([
    ...tokenize(l.brand ?? ""),
    ...tokenize(l.title),
    ...l.identifiers.flatMap((i) => tokenize(i.value)),
  ]);
}

/**
 * Words a listing must contain to count as a match for the query. Optional
 * line words (International, Expandable) only rank: a store may leave them out.
 */
export function requiredTerms(q: ParsedQuery): string[] {
  if (q.gtin) return [q.gtin];
  if (q.model) return [q.model];
  const optional = new Set(q.optionalLine ?? []);
  const terms = [
    ...tokenize(q.brand ?? ""),
    ...q.line.filter((w) => !optional.has(w)).flatMap(tokenize),
  ];
  return [...new Set(terms.length ? terms : q.tokens.flatMap(tokenize))];
}

/**
 * Size filter for a query: the class, unless the size came only from inches
 * ("Delsey 23 inch"), in which case listings are matched on the inches
 * instead (a store may call its 23" a carry-on).
 */
export function sizeFilterOf(q: ParsedQuery): string | null {
  return q.sizeByMeasure && q.inches ? null : q.sizeClass;
}

/** 0 = not a match. Size classes never cross: a carry-on query never returns a large. */
export function matchScore(
  q: ParsedQuery,
  haystack: Set<string>,
  listingSize: string | null,
): number {
  const required = requiredTerms(q);
  if (required.length === 0) return 0;
  if (!required.every((t) => haystack.has(t))) return 0;
  const size = sizeFilterOf(q);
  if (size && listingSize && listingSize !== size) return 0;
  let score = required.length * 2;
  for (const t of q.tokens) if (haystack.has(t)) score += 0.5;
  if (q.sizeClass && listingSize === q.sizeClass) score += 2;
  if (q.colour && haystack.has(q.colour.toLowerCase().split(" ").pop() ?? "")) score += 1;
  return score;
}

/**
 * Within one store, once some listings match the asked size exactly, its
 * listings with no size at all are dropped: "Chatelet Air 2.0 Medium" should
 * not also check that store's Chatelet laptop bag. A store whose titles never
 * carry a size keeps its unknown-size listings.
 */
export function preferExactSize<T extends { l: Pick<ListingRecord, "sourceId" | "sizeClass"> }>(
  q: ParsedQuery,
  scored: T[],
): T[] {
  if (!sizeFilterOf(q)) return scored;
  const exact = new Set(
    scored.filter((x) => x.l.sizeClass === q.sizeClass).map((x) => x.l.sourceId),
  );
  return scored.filter((x) => x.l.sizeClass !== null || !exact.has(x.l.sourceId));
}

/** tsquery text for to_tsquery('simple', …), or null if nothing to search. Inputs are sanitised to [a-z0-9.]. */
export function tsQueryFor(q: ParsedQuery): string | null {
  const terms = requiredTerms(q)
    .map((t) => t.replace(/[^a-z0-9.]/g, ""))
    .filter(Boolean);
  return terms.length ? terms.join(" & ") : null;
}
