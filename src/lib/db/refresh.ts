/* ------------------------------------------------------------------ */
/*  Price refresh                                                     */
/*                                                                     */
/*  Re-runs a live search for a product we already track and writes    */
/*  the new offers onto the EXISTING product row, so history stays     */
/*  continuous. Shared by the manual "Refresh prices" action and the   */
/*  scheduled cron job.                                               */
/* ------------------------------------------------------------------ */

import type { SupabaseClient } from "@supabase/supabase-js";
import { search } from "@/lib/search";
import type { SearchProduct } from "@/lib/search/types";
import type { TrackedProduct } from "@/lib/types";

export type RefreshOutcome = {
  productId: string;
  name: string;
  offersFound: number;
  previousLowest: number | null;
  newLowest: number | null;
  error?: string;
};

/** Build the most identifying query we can for a tracked product. */
export function refreshQuery(p: {
  brand: string;
  model: string;
  name: string;
  color?: string;
  upc?: string | null;
}): string {
  // A UPC is the most precise handle when the listing carries one, but many
  // Canadian listings don't, so pair it with the product name rather than
  // searching the bare number.
  const base = [p.brand, p.model].filter(Boolean).join(" ").trim() || p.name;
  return `${base} luggage`.trim();
}

/**
 * Score how well a freshly-found product matches the one we're refreshing.
 * Guards against a search for "Samsonite Freeform" writing prices for a
 * different Samsonite model onto this product's history.
 */
function matchScore(candidate: SearchProduct, target: { brand: string; model: string; upc: string | null }): number {
  let score = 0;

  if (target.upc && candidate.upc && target.upc === candidate.upc) score += 100;

  const brandA = candidate.brand.toLowerCase();
  const brandB = target.brand.toLowerCase();
  if (brandA && brandB && (brandA.includes(brandB) || brandB.includes(brandA))) score += 20;

  const modelA = candidate.model.toLowerCase();
  const modelB = target.model.toLowerCase();
  if (modelA && modelB) {
    const tokensB = modelB.split(/\s+/).filter((t) => t.length > 2);
    const hits = tokensB.filter((t) => modelA.includes(t)).length;
    score += hits * 8;
  }

  score += Math.min(candidate.retailerCount, 8);
  return score;
}

/**
 * Refresh one tracked product's prices.
 *
 * Writes offers and today's history against `productId`. Never creates a new
 * product row — that would fork the history.
 */
export async function refreshProduct(
  supabase: SupabaseClient,
  product: Pick<TrackedProduct, "id" | "name" | "brand" | "model" | "color" | "upc" | "lowestPrice">,
  opts: { allowedRetailers?: string[] } = {},
): Promise<RefreshOutcome> {
  const outcome: RefreshOutcome = {
    productId: product.id,
    name: product.name,
    offersFound: 0,
    previousLowest: product.lowestPrice,
    newLowest: null,
  };

  try {
    const result = await search(refreshQuery(product), {
      allowedRetailers: opts.allowedRetailers ?? [],
      limit: 5,
      // Meter refreshes against the same allowance, and let them reuse a
      // recent cached search rather than paying for the same query twice.
      db: supabase,
    });

    if (result.products.length === 0) {
      outcome.error = "No current listings found";
      return outcome;
    }

    const best = result.products
      .map((c) => ({ c, score: matchScore(c, product) }))
      .sort((a, b) => b.score - a.score)[0];

    // A weak match is worse than no update — refuse to write it.
    if (best.score < 12) {
      outcome.error = "No confident match for this product";
      return outcome;
    }

    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    const offers = best.c.offers;

    const { error: offerErr } = await supabase.from("retailer_offers").upsert(
      offers.map((o) => ({
        product_id: product.id,
        retailer: o.retailer,
        price: o.price,
        currency: "CAD",
        in_stock: o.inStock,
        url: o.url,
        title: o.title,
        last_checked_at: now,
      })),
      { onConflict: "product_id,retailer" },
    );
    if (offerErr) throw offerErr;

    const { error: histErr } = await supabase.from("price_history").upsert(
      offers.map((o) => ({
        product_id: product.id,
        retailer: o.retailer,
        price: o.price,
        currency: "CAD",
        date,
      })),
      { onConflict: "product_id,retailer,date" },
    );
    if (histErr) throw histErr;

    await supabase
      .from("products")
      .update({
        last_checked_at: now,
        ...(best.c.imageUrl ? { image_url: best.c.imageUrl } : {}),
      })
      .eq("id", product.id);

    outcome.offersFound = offers.length;
    outcome.newLowest = best.c.lowestPrice;
    return outcome;
  } catch (err) {
    outcome.error = err instanceof Error ? err.message : "Refresh failed";
    return outcome;
  }
}

/**
 * Refresh several products in sequence.
 *
 * Sequential on purpose: shopping APIs are quota-metered and rate-limited,
 * and a burst of parallel requests is the fastest way to burn a month's
 * allowance or get throttled.
 */
export async function refreshProducts(
  supabase: SupabaseClient,
  products: Parameters<typeof refreshProduct>[1][],
  opts: { allowedRetailers?: string[]; delayMs?: number; signal?: AbortSignal } = {},
): Promise<RefreshOutcome[]> {
  const results: RefreshOutcome[] = [];
  const delay = opts.delayMs ?? 500;

  for (const product of products) {
    if (opts.signal?.aborted) break;
    results.push(await refreshProduct(supabase, product, opts));
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }

  return results;
}
