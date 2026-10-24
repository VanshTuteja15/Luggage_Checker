/* ------------------------------------------------------------------ */
/*  Prices for one chosen product, from the engine's own records       */
/*                                                                     */
/*  The email shows only prices the engine stands behind: verified      */
/*  live readings, staff-checked and dealer-list prices, and validated  */
/*  web estimates, each with its own time. The tracking tables also     */
/*  hold prices from the old web search (the Add New Product panel),   */
/*  which were never validated, so they are not read here.             */
/*                                                                     */
/*  Listings are matched to the tracked bag the same way the daily     */
/*  verification does (its store links, its barcode, then brand + line */
/*  + size, all checked with sameBag). Read-only: nothing is created.  */
/* ------------------------------------------------------------------ */

import { canonicalUrl } from "@/lib/engine/adapters/base";
import { sameBag } from "@/lib/engine/jobs/verify-tracked";
import { LIVE_ADAPTERS, sourceForUrl } from "@/lib/engine/registry";
import type { EngineStore } from "@/lib/engine/store/port";
import type {
  AdapterId,
  CategoryPack,
  Freshness,
  ListingRecord,
  Observation,
  SourceRecord,
} from "@/lib/engine/types";
import type { DigestHistoryPoint, DigestOffer } from "./build";

export type ChosenBag = {
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string | null;
  /** Store pages this product was tracked from (retailer_offers.url). */
  knownUrls: string[];
};

const LIVE_DAYS = 30;
const DATED_DAYS = 120; // staff-checked and dealer-list prices are dated in their label
const MAX_LISTINGS = 40;

function freshnessOf(o: Observation): Freshness | null {
  if (o.adapter === "web_estimate") {
    const found = typeof o.evidence.foundAt === "string" ? o.evidence.foundAt : o.fetchedAt;
    return { kind: "estimate", foundAt: found };
  }
  if (o.adapter === "feed_import") return { kind: "feed", asOf: o.asOf ?? o.fetchedAt };
  if (o.adapter === "manual_entry") return { kind: "manual", checkedAt: o.asOf ?? o.fetchedAt };
  if (LIVE_ADAPTERS.has(o.adapter as AdapterId)) return { kind: "live", fetchedAt: o.fetchedAt };
  return null; // tracked_record and anything unknown: not a price we read
}

/** Engine listings that are this bag (never creates one). */
export async function matchListings(
  engine: EngineStore,
  pack: CategoryPack,
  sources: SourceRecord[],
  bag: ChosenBag,
): Promise<ListingRecord[]> {
  const found = new Map<string, ListingRecord>();
  for (const url of bag.knownUrls) {
    const s = sourceForUrl(url, sources);
    if (!s) continue;
    let canonical = url;
    try {
      canonical = canonicalUrl(url);
    } catch {
      continue;
    }
    const l = await engine.findListingByUrl(s.id, canonical).catch(() => null);
    if (l) found.set(l.id, l);
  }
  const size = pack.sizeClassOf(bag.name);
  const queries = [bag.upc, `${bag.brand} ${bag.model || bag.name}`].filter(
    (q): q is string => !!q?.trim(),
  );
  for (const q of queries) {
    const hits = await engine.searchListings(pack.parseQuery(q), { limit: 30 }).catch(() => []);
    for (const l of hits) if (!size || !l.sizeClass || l.sizeClass === size) found.set(l.id, l);
  }
  return [...found.values()]
    .filter((l) =>
      sameBag(pack, bag, {
        title: l.title,
        brand: l.brand,
        identifiers: l.identifiers,
        options: l.sizeClass ? [l.sizeClass.replace("_", "-")] : [],
      }),
    )
    .slice(0, MAX_LISTINGS);
}

/** The link a person opens: the listing page, or the store's home for feed/manual rows. */
function pageUrl(l: ListingRecord, s: SourceRecord): string {
  if (/^https:/.test(l.url)) return l.url;
  return s.marketHost ? `https://${s.marketHost}/` : "";
}

export async function pricesFor(
  engine: EngineStore,
  pack: CategoryPack,
  sources: SourceRecord[],
  bag: ChosenBag,
  opts: { now: Date; storeIds?: ReadonlySet<string> | null },
): Promise<{ offers: DigestOffer[]; history: DigestHistoryPoint[] }> {
  const bySource = new Map(sources.map((s) => [s.id, s]));
  const listings = (await matchListings(engine, pack, sources, bag)).filter(
    (l) => bySource.has(l.sourceId) && (!opts.storeIds || opts.storeIds.has(l.sourceId)),
  );
  if (listings.length === 0) return { offers: [], history: [] };
  const byListing = new Map(listings.map((l) => [l.id, l]));
  const ids = listings.map((l) => l.id);
  const nowMs = opts.now.getTime();

  const offers: DigestOffer[] = [];
  for (const o of await engine.latestObservations(ids)) {
    const l = byListing.get(o.listingId);
    const s = l && bySource.get(l.sourceId);
    const freshness = freshnessOf(o);
    if (!l || !s || !freshness || o.price <= 0 || o.currency !== "CAD") continue;
    const at = Date.parse(o.asOf ?? o.fetchedAt);
    const maxDays = freshness.kind === "feed" || freshness.kind === "manual" ? DATED_DAYS : LIVE_DAYS;
    if (!Number.isFinite(at) || nowMs - at > maxDays * 86_400_000) continue;
    offers.push({
      sourceId: s.id,
      retailer: s.retailerLabel,
      price: o.price,
      url: pageUrl(l, s),
      title: l.title,
      colour: l.colour,
      availability: o.availability,
      freshness,
      method: o.adapter,
    });
  }

  const since = new Date(nowMs - 31 * 86_400_000).toISOString();
  const history: DigestHistoryPoint[] = [];
  for (const r of await engine.priceRangesSince(ids, since)) {
    const s = bySource.get(byListing.get(r.listingId)?.sourceId ?? "");
    if (!s || r.price <= 0) continue;
    history.push({
      sourceId: s.id,
      retailer: s.retailerLabel,
      price: r.price,
      firstSeenAt: r.firstSeenAt,
      lastSeenAt: r.lastSeenAt,
    });
  }
  return { offers, history };
}
