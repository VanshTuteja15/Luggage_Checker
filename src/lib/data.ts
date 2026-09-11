/* ------------------------------------------------------------------ */
/*  Shared reference data                                             */
/*                                                                     */
/*  This file used to hold a hardcoded CATALOG of nine fake products   */
/*  with invented prices and 30 days of generated history. Every page  */
/*  read from it, which is why nothing in the app ever changed.        */
/*                                                                     */
/*  Product data now comes from Supabase via /api/products. What       */
/*  remains here is genuine reference data: the retailer registry      */
/*  (re-exported from ./retailers) and date helpers for charting.      */
/* ------------------------------------------------------------------ */

export {
  RETAILER_INFO,
  RETAILER_NAMES,
  MAJOR_RETAILERS,
  retailerColor,
  retailerCategory,
  retailerRank,
  matchRetailer,
  displayRetailer,
  hostOf,
} from "./retailers";

export type { RetailerCategory, RetailerInfo } from "./retailers";

/** ISO dates (YYYY-MM-DD) for the last `days` days, oldest first. */
export function seriesDates(days: number): string[] {
  const out: string[] = [];
  const start = Date.now() - (days - 1) * 86_400_000;
  for (let i = 0; i < days; i++) {
    out.push(new Date(start + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}
