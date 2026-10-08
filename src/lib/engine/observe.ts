/* ------------------------------------------------------------------ */
/*  Observe one reading: index it, validate it, keep the evidence,      */
/*  and resolve which product it is. Shared by research sessions,       */
/*  discovery and the daily verification job, so every path stores      */
/*  and judges readings the same way.                                    */
/* ------------------------------------------------------------------ */

import { resolveListing, type Resolution } from "./identity/resolve";
import { EXTRACTOR_VERSION, VALIDATOR_VERSION, type EngineStore } from "./store/port";
import type { CategoryPack, ListingRecord, RawOffer, SourceRecord, ValidationResult } from "./types";
import { validateOffer, type ExpectedIdentity } from "./validate";

export type Observed = {
  listing: ListingRecord;
  validation: ValidationResult;
  observationId: string | null;
  resolution: Resolution | null;
};

export async function observeOffer(
  store: EngineStore,
  pack: CategoryPack,
  source: SourceRecord,
  o: RawOffer,
  opts: {
    sessionId: string | null;
    discoveredVia: ListingRecord["discoveredVia"];
    parent?: ListingRecord | null;
    expected?: ExpectedIdentity | null;
    /** false when the reading was shared from another session (already stored). */
    persist: boolean;
    /** Resolve the product identity now (cheap; DB only). */
    resolve?: boolean;
    now?: number;
  },
): Promise<Observed> {
  let listing = await store.upsertListing({
    sourceId: source.id,
    url: o.url,
    externalId: o.externalId,
    title: o.title,
    brand: o.brand,
    sizeClass: pack.sizeClassOf([o.title, ...o.options].join(" ")),
    colour: o.colour,
    identifiers: o.identifiers,
    imageUrl: o.imageUrl,
    discoveredVia: opts.parent?.discoveredVia ?? opts.discoveredVia,
    lastmod: null,
    active: true,
    productId: opts.parent?.productId ?? null,
  });
  const history = (await store.priceRanges(listing.id, 6)).map((r) => r.price);
  const validation = validateOffer(o, { source, pack, expected: opts.expected ?? null, history, now: opts.now ?? Date.now() });

  let observationId: string | null = null;
  if (opts.persist) {
    const obs = await store.insertObservation({
      listingId: listing.id,
      sourceId: source.id,
      adapter: o.adapter,
      price: o.price,
      listPrice: o.listPrice,
      currency: validation.outcome === "rejected" ? (o.currency ?? "unknown") : "CAD",
      availability: o.availability,
      seller: o.seller,
      condition: o.condition,
      validation,
      evidence: o.evidence,
      extractorVersion: EXTRACTOR_VERSION,
      validatorVersion: VALIDATOR_VERSION,
      fetchedAt: o.fetchedAt,
      asOf: o.asOf,
      sessionId: opts.sessionId,
    });
    observationId = obs.id;
  }

  let resolution: Resolution | null = null;
  if (opts.resolve !== false && !listing.productId && validation.outcome !== "rejected") {
    resolution = await resolveListing(store, pack, listing);
    listing = (await store.getListing(listing.id)) ?? listing;
  }
  return { listing, validation, observationId, resolution };
}
