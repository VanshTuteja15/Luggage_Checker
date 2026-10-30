/* ------------------------------------------------------------------ */
/*  Observe one reading: index it, validate it, keep the evidence,      */
/*  and resolve which product it is. Shared by research sessions,       */
/*  discovery and the daily verification job, so every path stores      */
/*  and judges readings the same way.                                    */
/* ------------------------------------------------------------------ */

import { toStoredAttributes } from "./extract/attributes";
import { promotionsFromOffer } from "./extract/promotions";
import { resolveListing, type Resolution } from "./identity/resolve";
import { EXTRACTOR_VERSION, VALIDATOR_VERSION, type EngineStore } from "./store/port";
import type {
  CategoryPack,
  ListingRecord,
  RawOffer,
  SourceRecord,
  ValidationResult,
} from "./types";
import { validateOffer, type ExpectedIdentity } from "./validate";

export type Observed = {
  listing: ListingRecord;
  validation: ValidationResult;
  observationId: string | null;
  resolution: Resolution | null;
  /** What was written: a new observation, an extended price range, or nothing. */
  stored: "observation" | "range" | "none";
  /** Promotion rows this reading opened or extended (v4 A4.2). */
  promotions: number;
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
    /**
     * Catalogue runs (v4 A3.4): store an observation only when price, list
     * price or stock changed; a repeat extends the open price range. Keeps
     * the database from filling with identical readings (review D2).
     */
    onlyOnChange?: boolean;
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
  const validation = validateOffer(o, {
    source,
    pack,
    expected: opts.expected ?? null,
    history,
    now: opts.now ?? Date.now(),
  });

  let observationId: string | null = null;
  let stored: Observed["stored"] = "none";
  if (opts.persist && opts.onlyOnChange && validation.outcome !== "rejected" && o.price !== null) {
    const last = await store.latestObservation(listing.id, { shownOnly: true });
    const same =
      !!last &&
      Math.abs(last.price - o.price) <= 0.005 &&
      (last.listPrice === null) === (o.listPrice === null) &&
      (last.listPrice === null ||
        o.listPrice === null ||
        Math.abs(last.listPrice - o.listPrice) <= 0.005) &&
      last.availability === o.availability;
    if (same && (await store.touchPriceRange(listing.id, o.price, o.availability, o.fetchedAt)))
      stored = "range";
  }
  if (opts.persist && stored === "none") {
    stored = "observation";
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

  // v4 A4.2: the promotions this shown reading states (one write only when
  // there are any; a promotion missing from a later reading stops being current).
  let promotions = 0;
  if (opts.persist && validation.outcome !== "rejected" && o.price !== null) {
    const seen = promotionsFromOffer(o);
    if (seen.length > 0) {
      const r = await store.recordPromotions(
        listing.id,
        source.id,
        seen,
        o.fetchedAt,
        observationId,
      );
      promotions = r.opened + r.extended;
    }
  }

  let resolution: Resolution | null = null;
  if (opts.resolve !== false && !listing.productId && validation.outcome !== "rejected") {
    resolution = await resolveListing(store, pack, listing);
    listing = (await store.getListing(listing.id)) ?? listing;
  }

  // v4 A4.1: stated attributes onto the variant. Never inside a research
  // session (no extra writes on the ≤ 8 s path); discovery and the daily
  // jobs fill them in.
  if (
    opts.persist &&
    opts.sessionId === null &&
    o.attributes &&
    listing.variantId &&
    validation.outcome !== "rejected"
  )
    await store.mergeVariantAttributes(
      listing.variantId,
      toStoredAttributes(o.attributes, source.id, o.url, o.fetchedAt),
    );
  return { listing, validation, observationId, resolution, stored, promotions };
}
