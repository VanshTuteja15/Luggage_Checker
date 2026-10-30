/* ------------------------------------------------------------------ */
/*  Stated facts for offers on screen (v4 A4)                          */
/*                                                                     */
/*  For each store page URL: the promotions its latest shown reading   */
/*  stated, and the attributes stored on its variant, each with the    */
/*  store, method, evidence and date it came from. Reads the index     */
/*  only and never fetches a store; prices still come only from        */
/*  observations (a promotion's figures are what the store stated).    */
/* ------------------------------------------------------------------ */

import { canonicalUrl } from "./adapters/base";
import type { StoredAttribute } from "./extract/attributes";
import { sourceForUrl } from "./registry";
import type { EngineStore, PromotionRecord } from "./store/port";
import type { SourceRecord } from "./types";

export type OfferFacts = {
  url: string;
  sourceId: string | null;
  listingId: string | null;
  promotions: PromotionRecord[];
  attributes: Record<string, StoredAttribute>;
};

export const MAX_FACT_URLS = 20;

export async function factsForUrls(
  store: EngineStore,
  sources: SourceRecord[],
  urls: string[],
  at: string = new Date().toISOString(),
): Promise<OfferFacts[]> {
  const out: OfferFacts[] = [];
  for (const url of [...new Set(urls)].slice(0, MAX_FACT_URLS)) {
    const facts: OfferFacts = {
      url,
      sourceId: null,
      listingId: null,
      promotions: [],
      attributes: {},
    };
    out.push(facts);
    const source = sourceForUrl(url, sources);
    if (!source) continue;
    facts.sourceId = source.id;
    // Exact first: a variant's own page (?variant=…) is its own listing.
    const listing =
      (await store.findListingByUrl(source.id, url)) ??
      (await store.findListingByUrl(source.id, canonicalUrl(url)));
    if (!listing) continue;
    facts.listingId = listing.id;
    facts.promotions = await store.currentPromotions({ at, listingIds: [listing.id], limit: 10 });
    if (listing.productId && listing.variantId) {
      const variant = (await store.variantsForProduct(listing.productId)).find(
        (v) => v.id === listing.variantId,
      );
      facts.attributes = (variant?.attributes ?? {}) as Record<string, StoredAttribute>;
    }
  }
  return out;
}
