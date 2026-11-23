/* ------------------------------------------------------------------ */
/*  The answer on top, in sentences (v5 F2.4; V3 S4.1)                 */
/*                                                                     */
/*  "Cheapest: $434.95 at Canada Luggage Depot (verified 9:02 a.m.).   */
/*   Amazon.ca shows $434.95 (web estimate)."                          */
/*                                                                     */
/*  Deterministic and built only from the offers on screen: every      */
/*  price, time, date and count in it comes from them (tested). It     */
/*  speaks about the product the page shows first, in the same order  */
/*  (productViews), and says nothing when there is nothing to say.     */
/*  No model writes or rewords it. Pure, browser-safe.                 */
/* ------------------------------------------------------------------ */

import { usd } from "@/lib/format";
import {
  DEFAULT_TIME_ZONE,
  formatDay,
  formatTime,
  formatYmd,
  isSameLocalDay,
} from "@/lib/time/local";
import type { AnswerOffer, AnswerProduct } from "../types";
import { productViews, type ProductView, type StoreRow } from "./rows";

/** Feed and manual dates are calendar days: read the day, not the instant. */
function calendarDay(iso: string): string {
  const ymd = /^\d{4}-\d{2}-\d{2}/.exec(iso)?.[0];
  return ymd ? formatYmd(ymd) : formatDay(iso);
}

/** The short label inside the sentence ("verified 9:02 a.m.", "web estimate"). */
export function sentenceLabel(o: AnswerOffer, now: Date, tz: string): string {
  const f = o.freshness;
  switch (f.kind) {
    case "live":
      return isSameLocalDay(f.fetchedAt, now, tz)
        ? `verified ${formatTime(f.fetchedAt, tz)}`
        : `last seen ${formatDay(f.fetchedAt, tz)}`;
    case "estimate":
      return isSameLocalDay(f.foundAt, now, tz)
        ? "web estimate"
        : `web estimate, last seen ${formatDay(f.foundAt, tz)}`;
    case "manual":
      return `staff-checked ${calendarDay(f.checkedAt)}`;
    case "feed":
      return `dealer list as of ${calendarDay(f.asOf)}`;
    case "stale":
      return `last seen ${formatDay(f.lastSeenAt, tz)}`;
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The product the answer speaks about: the first full match with a current price. */
export function answerFocus(views: ProductView[]): ProductView | null {
  return (
    views.find((v) => v.headline && !v.product.fails?.length) ??
    views.find((v) => v.headline) ??
    null
  );
}

/**
 * The answer in at most four short sentences. `products` are the answer's
 * products (any order); they are put in the page's order first.
 */
export function summariseAnswer(
  products: AnswerProduct[],
  opts: { now?: Date; tz?: string; wantsAccessory?: boolean } = {},
): string[] {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? DEFAULT_TIME_ZONE;
  const views = productViews(products, { wantsAccessory: opts.wantsAccessory });
  const focus = answerFocus(views);
  if (!focus) {
    return views.some((v) => v.rows.length > 0)
      ? [
          "No store has a current price for this. The last prices we saw are below, each with its date.",
        ]
      : [];
  }
  const out: string[] = [];
  if (focus.product.fails?.length)
    out.push("Nothing matched every part of your search; the closest result is below.");

  const head = focus.headline!;
  const at = (r: StoreRow) =>
    `${usd(r.price)} at ${r.retailer} (${sentenceLabel(r.offer, now, tz)})`;
  out.push(`Cheapest: ${at(head.row)}.`);
  if (head.confirmed) out.push(`Lowest verified: ${at(head.confirmed)}.`);
  if (head.row.offer.freshness.kind === "estimate")
    out.push("The cheapest price is a web estimate: confirm it on the store's site.");

  const current = focus.rows.filter((r) => r.current);
  const others = current.filter(
    (r) => r.sourceId !== head.row.sourceId && r.sourceId !== head.confirmed?.sourceId,
  );
  if (current.length > 3) {
    const prices = current.map((r) => r.price);
    out.push(
      `Prices at ${plural(current.length, "store", "stores")} range from ${usd(Math.min(...prices))} to ${usd(Math.max(...prices))}.`,
    );
  } else {
    for (const r of others.slice(0, 2))
      out.push(`${r.retailer} shows ${usd(r.price)} (${sentenceLabel(r.offer, now, tz)}).`);
  }

  const outOfStock = current.filter((r) => r.stock === "out_of_stock").length;
  if (head.allOutOfStock) out.push("Out of stock everywhere we checked.");
  else if (outOfStock > 0) out.push(`Out of stock at ${plural(outOfStock, "store", "stores")}.`);
  return out.slice(0, 4);
}
