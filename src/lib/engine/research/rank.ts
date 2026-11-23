/* ------------------------------------------------------------------ */
/*  Ranking for a search (v5 F2.3; V3 S3.2)                            */
/*                                                                     */
/*  1. hard constraints hold (brand, size, inches, type, shell, price  */
/*     limits, in stock): a product that misses one never ranks above  */
/*     one that meets them all, and says which part it misses;         */
/*  2. then something in stock, 3. then the lowest current price,      */
/*  4. then the freshest price (verified > staff/dealer > estimate).   */
/*  A product is only held to what it states: a title that doesn't    */
/*  say "spinner" isn't marked "not a spinner". Pure, browser-safe.    */
/* ------------------------------------------------------------------ */

import { SIZE_LABELS, type SizeClass } from "../packs/luggage";
import { bagTypeOf, shellOf } from "../query/parse";
import { sizeFilterOf } from "../store/terms";
import type { AnswerOffer, AnswerProduct, CategoryPack, Freshness, ParsedQuery } from "../types";
import { isCurrent } from "./answer";

const TYPE_WORD: Record<string, string> = {
  spinner: "a spinner",
  upright: "an upright",
  duffel: "a duffel",
  backpack: "a backpack",
  garment: "a garment bag",
  set: "a set",
};

const money = (n: number) =>
  `$${n.toLocaleString("en-CA", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const isOut = (o: AnswerOffer) =>
  o.availability === "out_of_stock" ||
  o.availability === "preorder" ||
  o.availability === "backorder";

/** The price a product is judged by: its lowest current price (in stock first). */
function judgedPrice(p: AnswerProduct): number | null {
  const current = p.offers.filter(isCurrent);
  const inStock = current.filter((o) => !isOut(o));
  const pool = inStock.length ? inStock : current;
  return pool.length ? Math.min(...pool.map((o) => o.price)) : null;
}

/** Which parts of the search this product doesn't meet, in plain words. */
export function constraintFailures(
  p: AnswerProduct,
  q: ParsedQuery,
  pack: CategoryPack,
): string[] {
  const fails: string[] = [];
  const titles = [p.name, ...p.offers.map((o) => o.title)].join(" · ");
  if (q.brand && p.brand && p.brand.toLowerCase() !== q.brand.toLowerCase())
    fails.push(`not ${q.brand}`);
  const size = sizeFilterOf(q);
  if (size && p.sizeClass && p.sizeClass !== size)
    fails.push(`not ${(SIZE_LABELS[size as SizeClass] ?? size).toLowerCase()}`);
  if (q.inches) {
    const n =
      pack.inchesOf(p.name) ?? p.offers.map((o) => pack.inchesOf(o.title)).find((x) => !!x);
    if (n && n !== q.inches) fails.push(`${n}" (you asked for ${q.inches}")`);
  }
  if (q.type) {
    const t = bagTypeOf(titles);
    if (t && t !== q.type) fails.push(`not ${TYPE_WORD[q.type] ?? q.type}`);
  }
  if (q.shell && q.shell !== "hybrid") {
    const s = shellOf(titles);
    if (s && s !== q.shell)
      fails.push(q.shell === "hard" ? "a soft-sided bag" : "a hard-sided bag");
  }
  const price = judgedPrice(p);
  if (price !== null && q.maxPrice != null && price > q.maxPrice)
    fails.push(`over ${money(q.maxPrice)}`);
  if (price !== null && q.minPrice != null && price < q.minPrice)
    fails.push(`under ${money(q.minPrice)}`);
  if (q.inStock) {
    const current = p.offers.filter(isCurrent);
    if (current.length && current.every(isOut)) fails.push("out of stock");
  }
  return fails;
}

/** Products with what they miss written on them (`fails`), for the page and the answer. */
export function withConstraints(
  products: AnswerProduct[],
  q: ParsedQuery,
  pack: CategoryPack,
): AnswerProduct[] {
  return products.map((p) => ({ ...p, fails: constraintFailures(p, q, pack) }));
}

const FRESH_RANK: Record<Freshness["kind"], number> = {
  live: 0,
  feed: 1,
  manual: 1,
  estimate: 2,
  stale: 3,
};

/** How fresh a product's cheapest current price is (0 = verified live, 4 = no price). */
export function freshnessRank(p: AnswerProduct): number {
  const price = judgedPrice(p);
  if (price === null) return 4;
  const at = p.offers.filter((o) => isCurrent(o) && Math.abs(o.price - price) < 0.005);
  return Math.min(...at.map((o) => FRESH_RANK[o.freshness.kind]));
}

/**
 * The ranking order: full matches first, then something in stock, then the
 * lowest current price, then the freshest price, then relevance.
 */
export function rankForQuery(
  products: AnswerProduct[],
  q: ParsedQuery,
  pack: CategoryPack,
  relevance: (p: AnswerProduct) => number = () => 0,
): AnswerProduct[] {
  const key = (p: AnswerProduct) => {
    const current = p.offers.filter(isCurrent);
    return {
      fails: p.fails?.length ? 1 : 0,
      stock: current.length === 0 ? 2 : current.every(isOut) ? 1 : 0,
      price: judgedPrice(p) ?? Infinity,
      fresh: freshnessRank(p),
      rel: relevance(p),
    };
  };
  return withConstraints(products, q, pack)
    .map((p) => ({ p, k: key(p) }))
    .sort(
      (a, b) =>
        a.k.fails - b.k.fails ||
        a.k.stock - b.k.stock ||
        a.k.price - b.k.price ||
        a.k.fresh - b.k.fresh ||
        b.k.rel - a.k.rel ||
        a.p.name.localeCompare(b.p.name),
    )
    .map((x) => x.p);
}
