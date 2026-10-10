/* ------------------------------------------------------------------ */
/*  Research answer: grouping and freshness                           */
/*                                                                     */
/*  Pure and browser-safe: the session builds its final answer with it  */
/*  and the page uses the same functions to group offers as they        */
/*  stream in. Offers join one product when they share a GTIN, the same */
/*  manufacturer model in the same size class, or brand + line + size.  */
/*  Size classes never merge.                                           */
/* ------------------------------------------------------------------ */

import { DEFAULT_TIME_ZONE, formatDay, formatTime, formatYmd, isSameLocalDay } from "@/lib/time/local";
import type { AnswerOffer, AnswerProduct, CategoryPack, Freshness, Identifier } from "../types";

class UnionFind {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

function keysFor(o: AnswerOffer, pack: CategoryPack): string[] {
  const size = o.sizeClass ?? "?";
  // Listings already resolved to one catalog product belong together.
  const keys: string[] = o.productId ? [`product:${o.productId}`] : [];
  for (const i of o.identifiers) {
    if (i.kind === "gtin") keys.push(`gtin:${i.value}`);
    if (i.kind === "model") keys.push(`model:${i.value}|${size}`);
  }
  const brand = (o.brand ?? pack.brandOf(o.title) ?? "").toLowerCase();
  const line = pack.lineOf(o.title, o.brand).sort().join(" ");
  const inches = pack.inchesOf(o.title);
  if (brand && line) keys.push(`name:${brand}|${line}|${size}${inches ? `|${inches}in` : ""}`);
  return keys;
}

/** At the same price: verified first, then staff/dealer prices, then estimates. */
const FRESH_ORDER: Record<Freshness["kind"], number> = {
  live: 0,
  feed: 1,
  manual: 1,
  estimate: 2,
  stale: 3,
};

/** A price found during this check (not a "last seen" one). Estimates count. */
export function isCurrent(o: Pick<AnswerOffer, "freshness">): boolean {
  return o.freshness.kind !== "stale";
}

/**
 * Cheapest first among current prices; "last seen" prices always after them.
 * At the same price an out-of-stock offer sorts after the others (R2.6).
 */
export function compareOffers(a: AnswerOffer, b: AnswerOffer): number {
  const fa = isCurrent(a) ? 0 : 1;
  const fb = isCurrent(b) ? 0 : 1;
  if (fa !== fb) return fa - fb;
  if (a.price !== b.price) return a.price - b.price;
  const oa = a.availability === "out_of_stock" ? 1 : 0;
  const ob = b.availability === "out_of_stock" ? 1 : 0;
  if (oa !== ob) return oa - ob;
  return FRESH_ORDER[a.freshness.kind] - FRESH_ORDER[b.freshness.kind];
}

function productName(offers: AnswerOffer[], pack: CategoryPack): string {
  // The shortest title, without a trailing " - Colour" variant suffix or a
  // ", Colour" one (Delsey: "ALU'R | 19-Inch Aluminum Carry-On Suitcase, Pink").
  const titles = offers
    .map((o) => {
      const t = o.title.replace(/\s+-\s+[^-]{2,30}$/, "");
      const m = t.match(/^(.*\S),\s*([^,]{2,30})$/);
      const colour =
        !!m &&
        (!!pack.colourOf(m[2]) ||
          (!!o.colour && m[2].toLowerCase().includes(o.colour.toLowerCase())));
      return (colour && m ? m[1] : t).trim();
    })
    .sort((a, b) => a.length - b.length);
  return titles[0] ?? offers[0]?.title ?? "";
}

type NameParts = { brand: string; line: Set<string>; size: string | null; inches: number | null };

function nameParts(o: AnswerOffer, pack: CategoryPack): NameParts | null {
  const brand = (o.brand ?? pack.brandOf(o.title) ?? "").toLowerCase();
  if (!brand) return null;
  return {
    brand,
    line: new Set(pack.lineOf(o.title, o.brand)),
    size: o.sizeClass,
    inches: pack.inchesOf(o.title),
  };
}

/**
 * A web estimate's title often leaves out a word the store's own title has
 * ("Paralux Hardside Spinner Medium" vs CLD's "Paralux Hardside Expandable
 * Spinner Medium"). A group made only of estimates joins a verified group
 * when it is the same brand, size and stated inches and differs only by
 * optional line words (expandable, international…), and only when exactly
 * one verified group qualifies. Verified groups are never merged this way:
 * TUMI's International and International Expandable stay two products.
 */
function mergeEstimateGroups(groups: Map<number, AnswerOffer[]>, pack: CategoryPack): void {
  const isEstimateOnly = (list: AnswerOffer[]) => list.every((o) => o.method === "web_estimate");
  const parts = new Map<number, NameParts | null>();
  for (const [k, list] of groups) parts.set(k, nameParts(list[0], pack));
  for (const [k, list] of [...groups]) {
    if (!isEstimateOnly(list)) continue;
    const mine = parts.get(k);
    if (!mine || !mine.size) continue;
    const homes = [...groups.keys()].filter((other) => {
      if (other === k || isEstimateOnly(groups.get(other)!)) return false;
      const theirs = parts.get(other);
      if (!theirs || theirs.brand !== mine.brand || theirs.size !== mine.size) return false;
      if (mine.inches && theirs.inches && mine.inches !== theirs.inches) return false;
      const extra = [...theirs.line].filter((w) => !mine.line.has(w));
      const missing = [...mine.line].filter((w) => !theirs.line.has(w));
      return (
        missing.every((w) => pack.optionalLineWords.has(w)) &&
        extra.every((w) => pack.optionalLineWords.has(w))
      );
    });
    if (homes.length !== 1) continue;
    groups.set(homes[0], [...groups.get(homes[0])!, ...list]);
    groups.delete(k);
  }
}

export function groupOffers(offers: AnswerOffer[], pack: CategoryPack): AnswerProduct[] {
  const uf = new UnionFind(offers.length);
  const owner = new Map<string, number>();
  offers.forEach((o, i) => {
    for (const k of keysFor(o, pack)) {
      const prev = owner.get(k);
      if (prev === undefined) owner.set(k, i);
      else {
        const a = offers[prev].sizeClass;
        const b = o.sizeClass;
        // A shared barcode joins offers unless they disagree on size; model and
        // name keys already include the size class.
        // product: keys come from identity resolution, which already enforced the size wall.
        if (
          k.startsWith("product:") ||
          a === b ||
          (k.startsWith("gtin:") && (a === null || b === null))
        )
          uf.union(prev, i);
      }
    }
  });
  const groups = new Map<number, AnswerOffer[]>();
  offers.forEach((o, i) => {
    const r = uf.find(i);
    groups.set(r, [...(groups.get(r) ?? []), o]);
  });
  mergeEstimateGroups(groups, pack);

  const products: AnswerProduct[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort(compareOffers);
    const identifiers = new Map<string, Identifier>();
    for (const o of sorted)
      for (const i of o.identifiers)
        if (i.kind !== "store_sku") identifiers.set(`${i.kind}:${i.value}`, i);
    const current = sorted.filter(isCurrent);
    const first = sorted[0];
    const gtin = [...identifiers.values()].find((i) => i.kind === "gtin")?.value;
    const brand = first.brand ?? pack.brandOf(first.title);
    products.push({
      key: gtin
        ? `gtin-${gtin}`
        : `${(brand ?? "x").toLowerCase()}-${pack.lineOf(first.title, brand).join("-")}-${first.sizeClass ?? "any"}`,
      productId: sorted.find((o) => o.productId)?.productId ?? null,
      name: productName(sorted, pack),
      brand,
      sizeClass: first.sizeClass,
      identifiers: [...identifiers.values()],
      imageUrl: sorted.find((o) => o.imageUrl)?.imageUrl ?? null,
      offers: sorted,
      lowestPrice: current.length ? Math.min(...current.map((o) => o.price)) : null,
    });
  }
  return products;
}

/** Products ordered by how well they match the query, then lowest current price. */
export function rankProducts(
  products: AnswerProduct[],
  relevance: (p: AnswerProduct) => number,
): AnswerProduct[] {
  return [...products].sort((a, b) => {
    const r = relevance(b) - relevance(a);
    if (Math.abs(r) > 1e-9) return r;
    return (a.lowestPrice ?? Infinity) - (b.lowestPrice ?? Infinity);
  });
}

/* ── Freshness labels ─────────────────────────────────────────────── */

/** Feed and manual dates are calendar days (midnight UTC): read the day, not the instant. */
function calendarDay(iso: string): string {
  const ymd = /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0];
  return ymd ? formatYmd(ymd) : formatDay(iso);
}

/** When the price was read or found, as an instant. */
export function freshnessTime(f: Freshness): string {
  switch (f.kind) {
    case "live":
      return f.fetchedAt;
    case "estimate":
      return f.foundAt;
    case "feed":
      return f.asOf;
    case "manual":
      return f.checkedAt;
    case "stale":
      return f.lastSeenAt;
  }
}

/**
 * The label every price is shown with (MASTER_PROMPT_V2 rule 5). There is no
 * unlabelled price, and nothing read before today looks like today's:
 *   live     → "Verified live · 9:02 a.m."  (read on an earlier day: "Last seen · Oct 8")
 *   estimate → "Web estimate · found 9:01 a.m. · confirm on site"
 *   manual   → "Staff-checked · Oct 9"
 *   feed     → "Dealer list · as of Oct 1"
 *   stale    → "Last seen · Oct 8"
 */
export function freshnessLabel(
  f: Freshness,
  now: Date = new Date(),
  tz: string = DEFAULT_TIME_ZONE,
): string {
  switch (f.kind) {
    case "live":
      return isSameLocalDay(f.fetchedAt, now, tz)
        ? `Verified live · ${formatTime(f.fetchedAt, tz)}`
        : `Last seen · ${formatDay(f.fetchedAt, tz)}`;
    case "estimate":
      return isSameLocalDay(f.foundAt, now, tz)
        ? `Web estimate · found ${formatTime(f.foundAt, tz)} · confirm on site`
        : `Last seen · ${formatDay(f.foundAt, tz)} (web estimate)`;
    case "feed":
      return `Dealer list · as of ${calendarDay(f.asOf)}`;
    case "manual":
      return `Staff-checked · ${calendarDay(f.checkedAt)}`;
    case "stale":
      return `Last seen · ${formatDay(f.lastSeenAt, tz)}`;
  }
}

/** Short form for tight spaces: "Web estimate · confirm on site". */
export function freshnessShortLabel(f: Freshness, now: Date = new Date(), tz?: string): string {
  if (f.kind === "estimate" && isSameLocalDay(f.foundAt, now, tz))
    return "Web estimate · confirm on site";
  return freshnessLabel(f, now, tz);
}
