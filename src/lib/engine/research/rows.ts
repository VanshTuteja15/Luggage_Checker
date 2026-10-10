/* ------------------------------------------------------------------ */
/*  One row per store, the headline price, and product order (R2, R6)  */
/*                                                                     */
/*  A store often lists one bag as several colour variants at the same */
/*  price, or on two pages (E10: 3 × $434.95, TUMI $1,810/$1,815).      */
/*  Shoppers see one row per store: its lowest current price, the      */
/*  colours at that price as chips, and "+1 more page" for twin pages. */
/*  Pure and browser-safe; the search page and the email both use it.  */
/* ------------------------------------------------------------------ */

import { canonicalUrl } from "../adapters/base";
import type { AnswerOffer, AnswerProduct, Availability } from "../types";
import { compareOffers, isCurrent } from "./answer";

export type StockState = "in_stock" | "out_of_stock" | "unknown";

/** Three states for people. Pre-order and back-order can't be bought off the shelf today. */
export function stockOf(a: Availability | null | undefined): StockState {
  if (a === "in_stock") return "in_stock";
  if (a === "out_of_stock" || a === "preorder" || a === "backorder") return "out_of_stock";
  return "unknown";
}

export const STOCK_TEXT: Record<StockState, string> = {
  in_stock: "In stock",
  out_of_stock: "Out of stock",
  unknown: "Unknown",
};

export type StorePage = {
  url: string;
  price: number;
  colours: string[];
  stock: StockState;
  title: string;
};

export type StoreRow = {
  sourceId: string;
  retailer: string;
  /** The offer the row stands for: the store's lowest current price. */
  offer: AnswerOffer;
  price: number;
  /** Colours offered at the row's price ("Black · Stone Grey"). */
  colours: string[];
  /** Colours this store lists only at other prices. */
  otherColours: string[];
  /** Distinct product pages at this store; the row's own page first. */
  pages: StorePage[];
  stock: StockState;
  /** Found during this check (false: a "last seen" price). */
  current: boolean;
};

const isOut = (o: AnswerOffer) => stockOf(o.availability) === "out_of_stock";

function pageKey(url: string): string {
  try {
    return /^https:/.test(url) ? canonicalUrl(url) : url;
  } catch {
    return url;
  }
}

function uniq(list: (string | null | undefined)[]): string[] {
  const seen = new Map<string, string>();
  for (const v of list) {
    const t = v?.trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()];
}

/** Collapse a product's offers to one row per store, lowest first. */
export function storeRows(offers: AnswerOffer[]): StoreRow[] {
  const bySource = new Map<string, AnswerOffer[]>();
  for (const o of offers) bySource.set(o.sourceId, [...(bySource.get(o.sourceId) ?? []), o]);

  const rows: StoreRow[] = [];
  for (const list of bySource.values()) {
    // Current prices beat "last seen" ones; in stock beats out of stock.
    const current = list.filter(isCurrent);
    const pool = current.length ? current : list;
    const available = pool.filter((o) => !isOut(o));
    const best = [...(available.length ? available : pool)].sort(compareOffers)[0];

    const samePrice = pool.filter((o) => Math.abs(o.price - best.price) < 0.005);
    const colours = uniq(samePrice.map((o) => o.colour));
    const otherColours = uniq(
      pool.filter((o) => Math.abs(o.price - best.price) >= 0.005).map((o) => o.colour),
    ).filter((c) => !colours.some((x) => x.toLowerCase() === c.toLowerCase()));

    const pages = new Map<string, AnswerOffer[]>();
    for (const o of pool) pages.set(pageKey(o.url), [...(pages.get(pageKey(o.url)) ?? []), o]);
    const pageList: StorePage[] = [...pages.values()].map((ps) => {
      const sorted = [...ps].sort(compareOffers);
      const top = sorted.find((o) => !isOut(o)) ?? sorted[0];
      return {
        url: top.url,
        price: top.price,
        colours: uniq(ps.map((o) => o.colour)),
        stock: stockOf(top.availability),
        title: top.title,
      };
    });
    const own = pageKey(best.url);
    pageList.sort((a, b) =>
      pageKey(a.url) === own ? -1 : pageKey(b.url) === own ? 1 : a.price - b.price,
    );

    rows.push({
      sourceId: best.sourceId,
      retailer: best.retailer,
      offer: best,
      price: best.price,
      colours,
      otherColours,
      pages: pageList,
      stock: stockOf(best.availability),
      current: isCurrent(best),
    });
  }
  return rows.sort((a, b) => compareOffers(a.offer, b.offer));
}

export type Headline = {
  /** The lowest current price we can stand behind. */
  row: StoreRow;
  /** When the headline is a web estimate: the lowest price that isn't one. */
  confirmed: StoreRow | null;
  /** Nothing in stock anywhere: the headline is the lowest out-of-stock price. */
  allOutOfStock: boolean;
};

/**
 * R2.3 / R2.6: the lowest current price of any label. Out-of-stock rows never
 * lead unless nothing is in stock. A web estimate may lead (the validator
 * already accepted it), but then the lowest confirmed price is shown too.
 */
export function headlineFor(rows: StoreRow[]): Headline | null {
  const current = rows.filter((r) => r.current);
  if (current.length === 0) return null;
  const inStock = current.filter((r) => r.stock !== "out_of_stock");
  const pool = inStock.length ? inStock : current;
  const row = [...pool].sort((a, b) => compareOffers(a.offer, b.offer))[0];
  const confirmed =
    row.offer.freshness.kind === "estimate"
      ? ([...pool]
          .filter((r) => r.offer.freshness.kind !== "estimate")
          .sort((a, b) => compareOffers(a.offer, b.offer))[0] ?? null)
      : null;
  return { row, confirmed, allOutOfStock: inStock.length === 0 };
}

export type ProductView = {
  product: AnswerProduct;
  rows: StoreRow[];
  headline: Headline | null;
};

/**
 * Products for display: lowest headline price first (R2.2), products with
 * something in stock before those out of stock everywhere, products with no
 * current price last. Accessories are left out unless the query asks for one.
 */
export function productViews(
  products: AnswerProduct[],
  opts: { wantsAccessory?: boolean } = {},
): ProductView[] {
  const views = products
    .filter((p) => opts.wantsAccessory || p.sizeClass !== "accessory")
    .map((product) => {
      const rows = storeRows(product.offers);
      return { product, rows, headline: headlineFor(rows) };
    });
  const tier = (v: ProductView) => (!v.headline ? 2 : v.headline.allOutOfStock ? 1 : 0);
  return views.sort((a, b) => {
    const t = tier(a) - tier(b);
    if (t !== 0) return t;
    const pa = a.headline?.row.price ?? a.rows[0]?.price ?? Infinity;
    const pb = b.headline?.row.price ?? b.rows[0]?.price ?? Infinity;
    return pa - pb;
  });
}
