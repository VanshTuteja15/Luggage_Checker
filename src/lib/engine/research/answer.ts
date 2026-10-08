/* ------------------------------------------------------------------ */
/*  Research answer: grouping and freshness                           */
/*                                                                     */
/*  Pure and browser-safe: the session builds its final answer with it  */
/*  and the page uses the same functions to group offers as they        */
/*  stream in. Offers join one product when they share a GTIN, the same */
/*  manufacturer model in the same size class, or brand + line + size.  */
/*  Size classes never merge.                                           */
/* ------------------------------------------------------------------ */

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

const FRESH_ORDER: Record<Freshness["kind"], number> = { live: 0, feed: 1, manual: 1, stale: 2 };

/** Cheapest first among current prices; "last seen" prices always after them. */
export function compareOffers(a: AnswerOffer, b: AnswerOffer): number {
  const fa = FRESH_ORDER[a.freshness.kind] === 2 ? 1 : 0;
  const fb = FRESH_ORDER[b.freshness.kind] === 2 ? 1 : 0;
  if (fa !== fb) return fa - fb;
  return a.price - b.price;
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

  const products: AnswerProduct[] = [];
  for (const list of groups.values()) {
    const sorted = [...list].sort(compareOffers);
    const identifiers = new Map<string, Identifier>();
    for (const o of sorted)
      for (const i of o.identifiers)
        if (i.kind !== "store_sku") identifiers.set(`${i.kind}:${i.value}`, i);
    const current = sorted.filter((o) => o.freshness.kind !== "stale");
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

const TIME = new Intl.DateTimeFormat("en-CA", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/Edmonton",
});
const DATE = new Intl.DateTimeFormat("en-CA", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "America/Edmonton",
});
// Feed and manual dates are calendar days stored as midnight UTC; showing them
// in Calgary time would move them to the day before.
const DAY = new Intl.DateTimeFormat("en-CA", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * The label every price is shown with. There is no unlabelled price:
 *   live   → "Verified live · 2:14 p.m."
 *   feed   → "Feed as of Oct 1, 2026"
 *   manual → "Manually checked Oct 6, 2026"
 *   stale  → "Last seen Oct 5, 2026, 9:02 a.m. · not current"
 */
export function freshnessLabel(f: Freshness): string {
  switch (f.kind) {
    case "live":
      return `Verified live · ${TIME.format(new Date(f.fetchedAt))}`;
    case "feed":
      return `Feed as of ${DAY.format(new Date(f.asOf))}`;
    case "manual":
      return `Manually checked ${DAY.format(new Date(f.checkedAt))}`;
    case "stale":
      return `Last seen ${DATE.format(new Date(f.lastSeenAt))}, ${TIME.format(new Date(f.lastSeenAt))} · not current`;
  }
}
