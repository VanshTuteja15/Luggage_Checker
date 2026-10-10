/* ------------------------------------------------------------------ */
/*  Last-known prices for when a live check can't run (R2.5)          */
/*                                                                     */
/*  Search must never end on a blank or crashed page. If the engine    */
/*  can't start or finish a check, the page shows what we already      */
/*  know, each price labelled with its own date ("Last seen · Oct 8",  */
/*  "Staff-checked · Oct 9", "Dealer list · as of Oct 1"). Nothing      */
/*  here fetches a store; nothing is relabelled as today's.            */
/* ------------------------------------------------------------------ */

import type { TrackedProduct } from "@/lib/types";
import type { EngineStore } from "../store/port";
import { haystackFor, matchScore, requiredTerms, tokenize } from "../store/terms";
import type {
  AnswerOffer,
  AnswerProduct,
  CategoryPack,
  Freshness,
  ListingRecord,
  Observation,
  SourceRecord,
} from "../types";
import { groupOffers, rankProducts } from "./answer";

const MAX_LISTINGS = 40;

function freshnessOf(obs: Observation): Freshness {
  if (obs.adapter === "feed_import") return { kind: "feed", asOf: obs.asOf ?? obs.fetchedAt };
  if (obs.adapter === "manual_entry")
    return { kind: "manual", checkedAt: obs.asOf ?? obs.fetchedAt };
  return { kind: "stale", lastSeenAt: obs.fetchedAt };
}

function offerFor(
  source: SourceRecord,
  pack: CategoryPack,
  l: ListingRecord,
  obs: Observation,
): AnswerOffer {
  return {
    sourceId: source.id,
    retailer: source.retailerLabel,
    url: /^https:/.test(l.url) ? l.url : source.marketHost ? `https://${source.marketHost}/` : l.url,
    title: l.title,
    brand: l.brand,
    sizeClass: l.sizeClass ?? pack.sizeClassOf(l.title),
    identifiers: l.identifiers,
    imageUrl: l.imageUrl,
    reasons: [],
    price: obs.price,
    listPrice: obs.listPrice,
    currency: "CAD",
    availability: obs.availability,
    colour: l.colour,
    freshness: freshnessOf(obs),
    confidence: obs.validation.confidence,
    lowConfidence: obs.validation.outcome === "low_confidence",
    method: obs.adapter,
    observationId: obs.id,
    listingId: l.id,
    productId: l.productId,
    evidence: null,
  };
}

/** From the engine's own records: the latest accepted price of each matching listing. */
export async function lastKnownFromEngine(
  store: EngineStore,
  pack: CategoryPack,
  sources: SourceRecord[],
  query: string,
  opts: { storeIds?: string[] } = {},
): Promise<AnswerProduct[]> {
  const parsed = pack.parseQuery(query);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const listings = (await store.searchListings(parsed, { limit: 80, sourceIds: opts.storeIds }))
    .filter((l) => {
      if (matchScore(parsed, haystackFor(l), l.sizeClass) <= 0) return false;
      const n = parsed.inches ? pack.inchesOf(l.title) : null;
      return !n || n === parsed.inches;
    })
    .slice(0, MAX_LISTINGS);

  const offers: AnswerOffer[] = [];
  for (const l of listings) {
    const source = byId.get(l.sourceId);
    if (!source) continue;
    const obs = await store.latestObservation(l.id, { shownOnly: true });
    // A web estimate stays an estimate: never shown later as a plain "last seen" price.
    if (!obs || obs.adapter === "web_estimate" || !(obs.price > 0)) continue;
    offers.push(offerFor(source, pack, l, obs));
  }
  return rankProducts(groupOffers(offers, pack), (p) =>
    matchScore(
      parsed,
      haystackFor({ brand: p.brand, title: p.name, identifiers: p.identifiers }),
      p.sizeClass,
    ),
  );
}

/**
 * From the tracked products (the tracking tables in Supabase), for when the
 * engine's database itself can't be reached. Each store price keeps its own
 * last-checked time.
 */
export function lastKnownFromTracked(
  products: TrackedProduct[],
  query: string,
  pack: CategoryPack,
  sources: SourceRecord[],
): AnswerProduct[] {
  const parsed = pack.parseQuery(query);
  const required = requiredTerms(parsed);
  if (required.length === 0) return [];
  const idFor = new Map(sources.map((s) => [s.retailerLabel.toLowerCase(), s.id]));
  const out: AnswerProduct[] = [];
  for (const p of products) {
    const words = new Set(tokenize(`${p.brand} ${p.name} ${p.model}`));
    if (!required.every((t) => words.has(t))) continue;
    const sizeClass = pack.sizeClassOf(p.name);
    if (parsed.sizeClass && sizeClass && sizeClass !== parsed.sizeClass) continue;
    const offers: AnswerOffer[] = p.offers
      .filter((o) => o.price > 0 && !!o.url && !!o.lastCheckedAt)
      .map((o) => ({
        sourceId:
          idFor.get(o.retailer.toLowerCase()) ??
          o.retailer.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        retailer: o.retailer,
        url: o.url as string,
        title: o.title ?? p.name,
        brand: p.brand,
        sizeClass,
        identifiers: p.upc ? [{ kind: "gtin" as const, value: p.upc }] : [],
        imageUrl: p.imageUrl,
        reasons: [],
        price: o.price,
        listPrice: null,
        currency: "CAD" as const,
        // The tracking table only knows "out of stock" for sure.
        availability: o.inStock ? ("unknown" as const) : ("out_of_stock" as const),
        colour: p.color || null,
        freshness: { kind: "stale" as const, lastSeenAt: o.lastCheckedAt as string },
        confidence: 1,
        lowConfidence: false,
        method: "tracked_record" as const,
        observationId: null,
        listingId: null,
        productId: null,
        evidence: null,
      }));
    if (offers.length === 0) continue;
    out.push({
      key: `tracked-${p.id}`,
      productId: null,
      name: p.name,
      brand: p.brand,
      sizeClass,
      identifiers: p.upc ? [{ kind: "gtin", value: p.upc }] : [],
      imageUrl: p.imageUrl,
      offers: offers.sort((a, b) => a.price - b.price),
      lowestPrice: null,
    });
  }
  return out;
}
