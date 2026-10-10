/* ------------------------------------------------------------------ */
/*  Verified product → the tracking workflow's existing input shape    */
/*                                                                     */
/*  Research never creates products itself (MASTER_PROMPT rule 5). The */
/*  Track button hands this SearchProduct to the unchanged /api/track   */
/*  route, exactly as the old search does. Only current prices go       */
/*  across: a "last seen, not current" price is never tracked as today's. */
/* ------------------------------------------------------------------ */

import { SIZE_LABELS, type SizeClass } from "@/lib/engine/packs/luggage";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { freshnessTime } from "@/lib/engine/research/answer";
import type { AnswerOffer, AnswerProduct } from "@/lib/engine/types";
import type { Offer, SearchProduct } from "@/lib/search/types";

/**
 * Prices that may be written into tracking history: read by us (live) or
 * dated by a person or a dealer list. A web estimate is never saved as a
 * store's price (R3.1), and neither is a "last seen" one.
 */
export function trackableOffers(p: AnswerProduct): AnswerOffer[] {
  return p.offers.filter(
    (o) =>
      o.freshness.kind !== "stale" && o.freshness.kind !== "estimate" && /^https:\/\//.test(o.url),
  );
}

export function toSearchProduct(p: AnswerProduct): SearchProduct | null {
  const offers: Offer[] = trackableOffers(p).map((o) => ({
    retailer: o.retailer,
    retailerKey: o.sourceId,
    price: o.price,
    currency: "CAD",
    url: o.url,
    inStock: o.availability !== "out_of_stock",
    title: o.title,
    fetchedAt: freshnessTime(o.freshness),
    evidence: o.evidence ?? undefined,
    colour: o.colour ?? undefined,
  }));
  if (offers.length === 0) return null;
  const prices = offers.map((o) => o.price);
  const gtin = p.identifiers.find((i) => i.kind === "gtin")?.value ?? null;
  const upc = gtin ? gtin.replace(/^0+(?=\d{12,13}$)/, "") : null;
  const line = luggagePack.lineOf(p.name, p.brand).join(" ");
  return {
    key: p.key,
    name: p.name,
    brand: p.brand ?? "Unknown",
    model: line,
    color: offers[0].colour ?? "",
    size: p.sizeClass && p.sizeClass in SIZE_LABELS ? SIZE_LABELS[p.sizeClass as SizeClass] : "",
    upc,
    productType: "Luggage",
    imageUrl: p.imageUrl,
    offers: [...offers].sort((a, b) => a.price - b.price),
    lowestPrice: Math.min(...prices),
    highestPrice: Math.max(...prices),
    retailerCount: new Set(offers.map((o) => o.retailer)).size,
    spread: Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100,
    hasMajorRetailer: false,
  };
}
