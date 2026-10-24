/* ------------------------------------------------------------------ */
/*  Price history as tables and sentences (R4: no graphs)              */
/*                                                                     */
/*  Pure. Works on the daily price records of tracked products         */
/*  (one price per product, store and day). Every number shown on the  */
/*  History and product pages comes from here, so they can be tested.  */
/* ------------------------------------------------------------------ */

import { usd } from "@/lib/format";
import { addDays } from "@/lib/time/local";
import type { PricePoint, TrackedProduct } from "@/lib/types";

type Product = Pick<
  TrackedProduct,
  "id" | "name" | "brand" | "history" | "historyByRetailer" | "lowestPrice"
>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Percent change, one decimal, unsigned. */
function pctOf(from: number, diff: number): number {
  return from > 0 ? Math.round((Math.abs(diff) / from) * 1000) / 10 : 0;
}

/** "▼ $35.00 (−7.4%)" / "▲ $10.00 (+2.1%)" / "No change". Arrows and signs: colour is never the only signal. */
export function changeText(from: number, to: number): string {
  const diff = round2(to - from);
  if (Math.abs(diff) < 0.005) return "No change";
  const pct = pctOf(from, diff);
  return diff < 0 ? `▼ ${usd(-diff)} (−${pct}%)` : `▲ ${usd(diff)} (+${pct}%)`;
}

/* ── Changes (History page) ───────────────────────────────────────── */

export type PriceChange = {
  date: string;
  productId: string;
  productName: string;
  brand: string;
  retailer: string;
  oldPrice: number;
  newPrice: number;
  /** newPrice − oldPrice */
  diff: number;
  pct: number;
  kind: "down" | "up";
  text: string;
};

/** Every recorded price change per product and store on or after `from` (YYYY-MM-DD), newest first. */
export function priceChanges(
  products: Product[],
  opts: { from: string; productId?: string | null; retailer?: string | null },
): PriceChange[] {
  const out: PriceChange[] = [];
  for (const p of products) {
    if (opts.productId && p.id !== opts.productId) continue;
    for (const [retailer, series] of Object.entries(p.historyByRetailer)) {
      if (opts.retailer && retailer !== opts.retailer) continue;
      const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1];
        const cur = sorted[i];
        const diff = round2(cur.price - prev.price);
        if (Math.abs(diff) < 0.005 || cur.date < opts.from) continue;
        out.push({
          date: cur.date,
          productId: p.id,
          productName: p.name,
          brand: p.brand,
          retailer,
          oldPrice: prev.price,
          newPrice: cur.price,
          diff,
          pct: pctOf(prev.price, diff),
          kind: diff < 0 ? "down" : "up",
          text: changeText(prev.price, cur.price),
        });
      }
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.diff) - Math.abs(a.diff));
}

/** The largest drops on or after `from`, biggest dollar drop first. */
export function biggestDrops(changes: PriceChange[], from: string, limit = 10): PriceChange[] {
  return changes
    .filter((c) => c.kind === "down" && c.date >= from)
    .sort((a, b) => a.diff - b.diff || b.pct - a.pct)
    .slice(0, limit);
}

/* ── Product page ─────────────────────────────────────────────────── */

export type DailyLowestRow = {
  date: string;
  price: number;
  /** Store(s) with that price that day. */
  retailers: string[];
  /** vs the previous recorded day: "▼ $5.00 (−1.1%)", "No change", or null for the first day. */
  change: string | null;
  kind: "down" | "up" | "same" | null;
};

/** Lowest price per day over the last `days` days (ending `today`), newest first. */
export function dailyLowest(product: Product, today: string, days = 30): DailyLowestRow[] {
  const from = addDays(today, -(days - 1));
  const byDate = new Map<string, { price: number; retailers: string[] }>();
  for (const [retailer, series] of Object.entries(product.historyByRetailer))
    for (const pt of series) {
      if (pt.date < from || pt.date > today) continue;
      const cur = byDate.get(pt.date);
      if (!cur || pt.price < cur.price - 0.005)
        byDate.set(pt.date, { price: pt.price, retailers: [retailer] });
      else if (Math.abs(pt.price - cur.price) < 0.005 && !cur.retailers.includes(retailer))
        cur.retailers.push(retailer);
    }
  const dates = [...byDate.keys()].sort();
  const rows = dates.map((date, i) => {
    const { price, retailers } = byDate.get(date)!;
    const prev = i > 0 ? byDate.get(dates[i - 1])!.price : null;
    const diff = prev === null ? null : round2(price - prev);
    return {
      date,
      price,
      retailers: retailers.sort((a, b) => a.localeCompare(b)),
      change: prev === null ? null : changeText(prev, price),
      kind: diff === null ? null : Math.abs(diff) < 0.005 ? "same" : diff < 0 ? "down" : "up",
    } satisfies DailyLowestRow;
  });
  return rows.reverse();
}

export type StoreHistoryRow = {
  retailer: string;
  /** Recorded today / yesterday exactly (never carried over: rule 5). */
  today: number | null;
  yesterday: number | null;
  /** The last price recorded on or before 7 days ago. */
  weekAgo: number | null;
  low30: number | null;
  high30: number | null;
};

function onOrBefore(series: PricePoint[], date: string): number | null {
  let out: number | null = null;
  for (const p of [...series].sort((a, b) => a.date.localeCompare(b.date))) {
    if (p.date <= date) out = p.price;
    else break;
  }
  return out;
}

export function byStore(product: Product, today: string): StoreHistoryRow[] {
  const yesterday = addDays(today, -1);
  const weekAgo = addDays(today, -7);
  const from30 = addDays(today, -29);
  return Object.entries(product.historyByRetailer)
    .map(([retailer, series]) => {
      const recent = series.filter((p) => p.date >= from30 && p.date <= today).map((p) => p.price);
      return {
        retailer,
        today: series.find((p) => p.date === today)?.price ?? null,
        yesterday: series.find((p) => p.date === yesterday)?.price ?? null,
        weekAgo: onOrBefore(series, weekAgo),
        low30: recent.length ? Math.min(...recent) : null,
        high30: recent.length ? Math.max(...recent) : null,
      };
    })
    .sort(
      (a, b) =>
        (a.today ?? a.yesterday ?? Infinity) - (b.today ?? b.yesterday ?? Infinity) ||
        a.retailer.localeCompare(b.retailer),
    );
}

export type ProductSummary = {
  /** "Down $35.00 (7.4%) since last week. Lowest price in 30 days." */
  sentence: string;
  badge: "Lowest in 30 days" | "Highest in 30 days" | null;
};

/** R4.4: the plain sentence at the top of a product. */
export function productSummary(product: Product, today: string): ProductSummary {
  const current = product.lowestPrice;
  if (current === null) return { sentence: "No current price yet.", badge: null };
  const lowestByDay = [...product.history].sort((a, b) => a.date.localeCompare(b.date));
  const weekAgo = onOrBefore(lowestByDay, addDays(today, -7));
  const parts: string[] = [];
  if (weekAgo === null) parts.push("No price from a week ago to compare.");
  else {
    const diff = round2(current - weekAgo);
    if (Math.abs(diff) < 0.005) parts.push("Same price as last week.");
    else
      parts.push(
        `${diff < 0 ? "Down" : "Up"} ${usd(Math.abs(diff))} (${pctOf(weekAgo, diff)}%) since last week.`,
      );
  }
  const recent = lowestByDay.filter((p) => p.date >= addDays(today, -29)).map((p) => p.price);
  let badge: ProductSummary["badge"] = null;
  if (recent.length >= 2) {
    const low = Math.min(...recent);
    const high = Math.max(...recent);
    if (current <= low + 0.005) badge = "Lowest in 30 days";
    else if (current >= high - 0.005 && high > low) badge = "Highest in 30 days";
  }
  if (badge === "Lowest in 30 days") parts.push("Lowest price in 30 days.");
  if (badge === "Highest in 30 days") parts.push("Highest price in 30 days.");
  return { sentence: parts.join(" "), badge };
}
