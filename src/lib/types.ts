/* ------------------------------------------------------------------ */
/*  Application-level shapes shared by the API and the UI              */
/* ------------------------------------------------------------------ */

export type PricePoint = { date: string; price: number };

export type TrackedOffer = {
  retailer: string;
  price: number;
  inStock: boolean;
  url: string | null;
  title: string | null;
  lastCheckedAt: string | null;
};

/** A product the signed-in user tracks, with everything the UI needs. */
export type TrackedProduct = {
  id: string;
  slug: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string | null;
  imageUrl: string | null;
  productType: string | null;

  /** Current offers, cheapest first. May be empty if never fetched yet. */
  offers: TrackedOffer[];
  /** Lowest price per day across all retailers, oldest first. */
  history: PricePoint[];
  /** Per-retailer series, for the product detail chart. */
  historyByRetailer: Record<string, PricePoint[]>;

  lowestPrice: number | null;
  lowestRetailer: string | null;
  /** Lowest price on the most recent earlier day we have data for. */
  previousLowest: number | null;
  /** lowestPrice - previousLowest. 0 when there's nothing to compare. */
  change: number;
  retailerCount: number;
  spread: number;
  inStock: boolean;

  targetPrice: number | null;
  alertEnabled: boolean;
  lastCheckedAt: string | null;
  trackedAt: string;
};

export type UserSettings = {
  adminEmail: string;
  timezone: string;
  dailyReport: boolean;
  reportEmail: string;
  include: { drops: boolean; increases: boolean; oos: boolean; summary: boolean };
  retailers: string[];
};

export const DEFAULT_INCLUDE = {
  drops: true,
  increases: true,
  oos: true,
  summary: true,
};

/** Statistics derived from a product's history. */
export type PriceStats = {
  lowest: PricePoint | null;
  highest: PricePoint | null;
  average: number | null;
  days: number;
};

export function priceStats(history: PricePoint[]): PriceStats {
  if (history.length === 0) {
    return { lowest: null, highest: null, average: null, days: 0 };
  }
  let lowest = history[0];
  let highest = history[0];
  let sum = 0;
  for (const p of history) {
    if (p.price < lowest.price) lowest = p;
    if (p.price > highest.price) highest = p;
    sum += p.price;
  }
  return {
    lowest,
    highest,
    average: Math.round((sum / history.length) * 100) / 100,
    days: history.length,
  };
}
