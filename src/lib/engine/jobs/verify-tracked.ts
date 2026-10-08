/* ------------------------------------------------------------------ */
/*  Daily verification of tracked products (lite mode, budget-capped)  */
/*                                                                     */
/*  For each tracked bag, least recently checked first:                 */
/*    1. find its listings on stores we may verify — its known offer    */
/*       links, its UPC, then brand + line + size from the index        */
/*    2. re-read them through the engine (polite, one page per store)   */
/*    3. keep only readings that are this bag: same UPC, or same brand, */
/*       size class and product line                                    */
/*    4. write the lowest verified price per store through the bridge   */
/*       (tracked page, history chart and daily report pick it up)      */
/*    5. alert once per user, product and day when a target is reached  */
/*  The run stops at its fetch budget; the rest wait for the next run.  */
/* ------------------------------------------------------------------ */

import { ADAPTERS } from "../adapters";
import { canonicalUrl, normaliseGtin } from "../adapters/base";
import type { BridgeOffer, TrackedBridge, TrackedItem } from "../bridge/tracked";
import { observeOffer } from "../observe";
import type { EngineRuntime } from "../recorder";
import { liveRoutes, sourceForUrl, type RouteContext } from "../registry";
import type { CategoryPack, ListingRecord, RawOffer, SourceRecord } from "../types";

export type AlertSender = (a: {
  to: string;
  productName: string;
  retailer: string;
  price: number;
  target: number;
  url: string;
  checkedAt: string;
}) => Promise<unknown>;

export type VerifyTrackedStats = {
  products: number;
  verified: number;
  noListing: number;
  skippedForBudget: number;
  fetches: number;
  offersWritten: number;
  alertsSent: number;
  errors: string[];
};

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / (A.size + B.size - n);
}

/** Is this reading the tracked bag? Barcode first, otherwise brand + size + line. */
export function sameBag(pack: CategoryPack, item: TrackedItem, o: RawOffer): boolean {
  const upc = normaliseGtin(item.upc);
  const gtins = o.identifiers.filter((i) => i.kind === "gtin").map((i) => i.value);
  if (upc && gtins.length) return gtins.includes(upc);
  const brand = pack.brandOf(`${item.brand} ${item.name}`);
  const oBrand = o.brand ?? pack.brandOf(o.title);
  if (!brand || !oBrand || brand !== oBrand) return false;
  const size = pack.sizeClassOf(item.name);
  const oSize = pack.sizeClassOf([o.title, ...o.options].join(" "));
  if (size && oSize && size !== oSize) return false;
  if (!size || !oSize) return false;
  const inches = pack.inchesOf(item.name);
  const oInches = pack.inchesOf(o.title);
  if (inches && oInches && inches !== oInches) return false;
  const line = pack.lineOf(`${item.name}`, brand);
  // Words the tracked name leaves out but the store adds ("Expandable") don't count against it.
  const oLine = pack
    .lineOf(o.title, oBrand)
    .filter((w) => !pack.optionalLineWords.has(w) || line.includes(w));
  const nums = (xs: string[]) =>
    xs
      .filter((w) => /\d/.test(w))
      .sort()
      .join(" ");
  return nums(line) === nums(oLine) && jaccard(line, oLine) >= 0.75;
}

async function candidateListings(
  rt: EngineRuntime,
  pack: CategoryPack,
  item: TrackedItem,
): Promise<ListingRecord[]> {
  const out = new Map<string, ListingRecord>();
  const add = (l: ListingRecord) => {
    if (/^https:/.test(l.url)) out.set(`${l.sourceId}|${canonicalUrl(l.url)}`, l);
  };
  for (const o of item.offers) {
    if (!o.url) continue;
    const s = sourceForUrl(o.url);
    if (!s) continue;
    const url = canonicalUrl(o.url);
    const existing = await rt.store.findListingByUrl(s.id, url);
    add(
      existing ??
        (await rt.store.upsertListing({
          sourceId: s.id,
          url,
          externalId: null,
          title: item.name,
          brand: pack.brandOf(`${item.brand} ${item.name}`),
          sizeClass: pack.sizeClassOf(item.name),
          colour: item.color || null,
          identifiers: [],
          imageUrl: null,
          discoveredVia: "seed",
          lastmod: null,
          active: true,
        })),
    );
  }
  const upc = normaliseGtin(item.upc);
  if (upc)
    for (const l of await rt.store.searchListings(pack.parseQuery(upc), { limit: 20 })) add(l);
  for (const l of await rt.store.searchListings(
    pack.parseQuery(`${item.brand} ${item.model || item.name}`),
    { limit: 20 },
  )) {
    const size = pack.sizeClassOf(item.name);
    if (size && l.sizeClass && l.sizeClass !== size) continue;
    add(l);
  }
  return [...out.values()];
}

export async function verifyTracked(
  rt: EngineRuntime,
  pack: CategoryPack,
  bridge: TrackedBridge,
  opts: {
    maxProducts?: number;
    maxFetches?: number;
    sendAlert?: AlertSender;
    signal?: AbortSignal;
    now?: () => number;
    trigger?: "cron" | "admin" | "worker" | "manual";
  } = {},
): Promise<{ stats: VerifyTrackedStats; verifiedProductIds: string[] }> {
  const now = opts.now ?? Date.now;
  const maxFetches = opts.maxFetches ?? rt.config.cron.maxFetchesPerRun;
  const stats: VerifyTrackedStats = {
    products: 0,
    verified: 0,
    noListing: 0,
    skippedForBudget: 0,
    fetches: 0,
    offersWritten: 0,
    alertsSent: 0,
    errors: [],
  };
  const verifiedProductIds: string[] = [];
  const runId = await bridge.startRun("verify.tracked", opts.trigger ?? "cron");
  const routeCtx: RouteContext = { flags: await rt.flags(), config: rt.config };
  const sources = new Map((await rt.sources()).map((s) => [s.id, s] as [string, SourceRecord]));

  try {
    const items = await bridge.listTracked(opts.maxProducts ?? rt.config.cron.maxProductsPerRun);
    stats.products = items.length;
    for (const item of items) {
      if (opts.signal?.aborted) break;
      if (stats.fetches >= maxFetches) {
        stats.skippedForBudget++;
        continue;
      }
      const listings = await candidateListings(rt, pack, item);
      // One product page per store per run: lite mode.
      const perStore = new Map<string, ListingRecord>();
      for (const l of listings) if (!perStore.has(l.sourceId)) perStore.set(l.sourceId, l);

      const written: BridgeOffer[] = [];
      for (const [sourceId, listing] of perStore) {
        if (stats.fetches >= maxFetches) break;
        const source = sources.get(sourceId);
        if (!source) continue;
        const routes = liveRoutes(source, routeCtx);
        if (routes.length === 0) continue;
        const ctx = {
          source,
          fetcher: rt.fetcher,
          config: rt.config,
          pack,
          now,
          signal: opts.signal,
          sessionId: null,
        };
        stats.fetches++;
        let res = await ADAPTERS[routes[0].adapter].verify(ctx, {
          url: listing.url,
          externalId: listing.externalId,
          identifiers: listing.identifiers,
          title: listing.title,
          brand: listing.brand,
        });
        if (
          res.status !== "ok" &&
          res.status !== "blocked" &&
          routes[1] &&
          stats.fetches < maxFetches
        ) {
          stats.fetches++;
          res = await ADAPTERS[routes[1].adapter].verify(ctx, {
            url: listing.url,
            externalId: listing.externalId,
            identifiers: listing.identifiers,
            title: listing.title,
            brand: listing.brand,
          });
        }
        if (res.status !== "ok") continue;

        let best: { o: RawOffer; colourMatch: boolean } | null = null;
        for (const o of res.offers) {
          const { validation } = await observeOffer(rt.store, pack, source, o, {
            sessionId: null,
            discoveredVia: listing.discoveredVia,
            parent: listing,
            persist: true,
            resolve: true,
            now: now(),
          });
          if (validation.outcome === "rejected" || o.price === null || !sameBag(pack, item, o))
            continue;
          const colourMatch =
            !!item.color && !!o.colour && o.colour.toLowerCase() === item.color.toLowerCase();
          if (
            !best ||
            (colourMatch && !best.colourMatch) ||
            (colourMatch === best.colourMatch && o.price < (best.o.price as number))
          )
            best = { o, colourMatch };
        }
        if (best) {
          written.push({
            retailer: source.retailerLabel,
            price: best.o.price as number,
            inStock: best.o.availability !== "out_of_stock",
            url: best.o.url,
            title: best.o.title,
          });
        }
      }

      if (listings.length === 0) stats.noListing++;
      if (written.length === 0) continue;
      const at = new Date(now()).toISOString();
      await bridge.writeOffers(item.productId, written, at);
      stats.verified++;
      stats.offersWritten += written.length;
      verifiedProductIds.push(item.productId);

      // Alerts on the lowest verified price, once per user, product and day.
      const lowest = written.reduce((a, b) => (b.price < a.price ? b : a));
      for (const w of item.watchers) {
        if (!w.alertEnabled || w.targetPrice === null || lowest.price > w.targetPrice || !w.email)
          continue;
        if (
          !(await bridge.recordAlert(
            w.userId,
            item.productId,
            lowest.retailer,
            lowest.price,
            w.targetPrice,
            at.slice(0, 10),
          ))
        )
          continue;
        try {
          await opts.sendAlert?.({
            to: w.email,
            productName: item.name,
            retailer: lowest.retailer,
            price: lowest.price,
            target: w.targetPrice,
            url: lowest.url,
            checkedAt: at,
          });
          stats.alertsSent++;
        } catch (err) {
          stats.errors.push(
            `alert to user ${w.userId.slice(0, 8)}: ${err instanceof Error ? err.message : "send failed"}`,
          );
        }
      }
    }
    await rt.recorder.flush();
    await bridge.finishRun(runId, true, stats);
    return { stats, verifiedProductIds };
  } catch (err) {
    stats.errors.push(err instanceof Error ? err.message : String(err));
    await bridge.finishRun(runId, false, stats).catch(() => undefined);
    throw err;
  }
}
