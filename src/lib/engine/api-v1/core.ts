/* ------------------------------------------------------------------ */
/*  Price Data API v1 (v4 A7): the read-only core, free of HTTP         */
/*                                                                     */
/*  An internal API over the store the app already uses. Keys live on   */
/*  the server only, as SHA-256 hashes in PRICE_API_KEYS ("name:hex,…"),*/
/*  compared in constant time; each key has a rate limit. Every price   */
/*  in every answer carries its source, method, observed_at, confidence */
/*  and the label the app shows; a web estimate is typed "estimate".    */
/*  Answers come from our index only: no store is contacted.            */
/* ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SIZE_LABELS, type SizeClass } from "../packs/luggage";
import { freshnessLabel } from "../research/answer";
import type { CatalogProduct, CatalogVariant, EngineStore } from "../store/port";
import type { CategoryPack, Freshness, ListingRecord, Observation, SourceRecord } from "../types";

/* ── keys and rate limit ──────────────────────────────────────────── */

export type ApiKey = { name: string; hash: Buffer };

/** PRICE_API_KEYS = "name:<sha256 hex of the key>,…" (never the keys themselves). */
export function apiKeys(raw: string | undefined = process.env.PRICE_API_KEYS): ApiKey[] {
  return (raw ?? "")
    .split(",")
    .map((p) => p.trim())
    .flatMap((p) => {
      const m = p.match(/^([a-z0-9_-]{1,40})[:=]([0-9a-f]{64})$/i);
      return m ? [{ name: m[1], hash: Buffer.from(m[2].toLowerCase(), "hex") }] : [];
    });
}

export const hashKey = (key: string): Buffer => createHash("sha256").update(key, "utf8").digest();

/** The name of the key a request carries, or null. Every key is compared, in constant time. */
export function keyName(headers: Headers, keys: ApiKey[]): string | null {
  const bearer = (headers.get("authorization") ?? "").match(/^Bearer\s+(\S{1,200})$/i)?.[1];
  const raw = (bearer ?? headers.get("x-api-key") ?? "").trim();
  if (!raw || raw.length > 200) return null;
  const h = hashKey(raw);
  let found: string | null = null;
  for (const k of keys) if (timingSafeEqual(h, k.hash) && found === null) found = k.name;
  return found;
}

/** A one-minute window per key, in this process (each server instance counts on its own). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(readonly perMinute: number) {}
  take(key: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
    const w = this.windows.get(key);
    if (!w || now - w.start >= 60_000) {
      this.windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (w.count >= this.perMinute)
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((w.start + 60_000 - now) / 1000)) };
    w.count++;
    return { ok: true };
  }
}

export function ratePerMinute(
  raw: string | undefined = process.env.PRICE_API_RATE_PER_MIN,
): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 60;
}

/* ── parameters ───────────────────────────────────────────────────── */

export class ApiInputError extends Error {}
export class ApiNotFound extends Error {}

const productId = z.string().regex(/^[0-9a-f-]{8,64}$/i, "that isn't a product id of ours");
const limit = (max: number, dflt: number) => z.coerce.number().int().min(1).max(max).default(dflt);

export const params = {
  search: z.object({
    q: z.string().trim().min(2, "say what to search for (2 characters at least)").max(200),
    limit: limit(50, 20),
  }),
  product: z.object({ id: productId }),
  history: z.object({ id: productId, days: limit(365, 90) }),
  promotions: z.object({
    store: z
      .string()
      .regex(/^[a-z0-9-]{2,60}$/, "that isn't a store id")
      .optional(),
    limit: limit(200, 50),
  }),
  stores: z.object({}),
  changes: z.object({
    since: z
      .string()
      .datetime({ offset: true, message: "use a date and time such as 2026-10-30T00:00:00Z" }),
    limit: limit(500, 100),
  }),
};

/** zod's answer as one plain sentence ("limit: Number must be less than or equal to 50."). */
export function parseParams<T extends z.ZodTypeAny>(
  schema: T,
  raw: Record<string, string>,
): z.infer<T> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  throw new ApiInputError(`${i?.path.join(".") || "request"}: ${i?.message ?? "not valid"}.`);
}

/* ── views ────────────────────────────────────────────────────────── */

export type ApiDeps = {
  store: EngineStore;
  pack: CategoryPack;
  sources: SourceRecord[];
  now?: () => Date;
};

export type PriceView = {
  amount: number;
  currency: "CAD";
  list_price: number | null;
  availability: string;
  source: { id: string; name: string };
  url: string;
  method: string;
  type: "observed" | "estimate";
  observed_at: string;
  confidence: number;
  label: string;
};

function freshnessOf(o: Observation, seenAt: string): Freshness {
  switch (o.adapter) {
    case "web_estimate":
      return { kind: "estimate", foundAt: seenAt };
    case "feed_import":
      return { kind: "feed", asOf: o.asOf ?? seenAt };
    case "manual_entry":
      return { kind: "manual", checkedAt: seenAt };
    default:
      return { kind: "live", fetchedAt: seenAt };
  }
}

const storeName = (d: ApiDeps, id: string) =>
  d.sources.find((s) => s.id === id)?.retailerLabel ?? id;

/** One stored reading as a price: never without its source, method, time, confidence and label. */
export function priceView(
  d: ApiDeps,
  o: Observation,
  listing: ListingRecord | null,
  seenAt: string = o.fetchedAt,
): PriceView {
  return {
    amount: o.price,
    currency: "CAD",
    list_price: o.listPrice,
    availability: o.availability,
    source: { id: o.sourceId, name: storeName(d, o.sourceId) },
    url: listing?.url ?? "",
    method: o.adapter,
    type: o.adapter === "web_estimate" ? "estimate" : "observed",
    observed_at: seenAt,
    confidence: o.validation.confidence,
    label: freshnessLabel(freshnessOf(o, seenAt), (d.now ?? (() => new Date()))()),
  };
}

function productView(p: CatalogProduct, variants?: CatalogVariant[]) {
  return {
    id: p.id,
    brand: p.brand,
    line: p.line,
    name: p.name,
    size_class: p.sizeClass,
    size_label: p.sizeClass ? (SIZE_LABELS[p.sizeClass as SizeClass] ?? null) : null,
    ...(variants
      ? {
          variants: variants.map((v) => ({
            id: v.id,
            colour: v.colour,
            attributes: v.attributes ?? {},
          })),
        }
      : {}),
  };
}

/**
 * The latest shown reading of each listing. Event storage extends a price
 * range instead of storing a repeat, so a price confirmed since its reading
 * is reported with that later time.
 */
async function latestPrices(d: ApiDeps, listings: ListingRecord[]) {
  const out = new Map<string, { o: Observation; seenAt: string }>();
  const obs = await d.store.latestObservations(listings.map((l) => l.id));
  await Promise.all(
    obs.map(async (o) => {
      const [r] = await d.store.priceRanges(o.listingId, 1);
      const seenAt =
        r && r.price === o.price && r.lastSeenAt > o.fetchedAt ? r.lastSeenAt : o.fetchedAt;
      out.set(o.listingId, { o, seenAt });
    }),
  );
  return out;
}

async function offersOf(d: ApiDeps, listings: ListingRecord[]) {
  const prices = await latestPrices(d, listings);
  return listings
    .flatMap((l) => {
      const p = prices.get(l.id);
      return p
        ? [
            {
              ...priceView(d, p.o, l, p.seenAt),
              listing_id: l.id,
              title: l.title,
              colour: l.colour,
            },
          ]
        : [];
    })
    .sort((a, b) => a.amount - b.amount);
}

async function productOr404(d: ApiDeps, id: string): Promise<CatalogProduct> {
  const p = await d.store.getProduct(id);
  if (!p) throw new ApiNotFound("That product isn't in our index.");
  return p;
}

const INDEX_NOTE = "From our index only; no store was contacted. Each price says when it was read.";

/* ── handlers ─────────────────────────────────────────────────────── */

export async function searchV1(d: ApiDeps, p: { q: string; limit: number }) {
  const parsed = d.pack.parseQuery(p.q);
  const listings = (await d.store.searchListings(parsed, { limit: p.limit * 4 })).filter(
    (l) => l.active,
  );
  const groups = new Map<string, ListingRecord[]>();
  for (const l of listings) {
    const k = l.productId ?? `listing:${l.id}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const results = [];
  for (const [k, ls] of [...groups].slice(0, p.limit)) {
    const product = k.startsWith("listing:") ? null : await d.store.getProduct(k);
    // A product's prices often sit on its variant pages (?variant=), not the page the
    // search matched: offer every active page of the product, as /offers does.
    const pages = product
      ? (await d.store.listingsForProduct(product.id)).filter((l) => l.active)
      : ls;
    const offers = await offersOf(d, pages);
    // A store page we know of but never priced, outside any product (a catalogue's
    // product page whose variant pages carry the prices) tells the caller nothing.
    if (!product && offers.length === 0) continue;
    results.push({
      product: product ? productView(product) : null,
      title: product?.name ?? ls[0].title,
      offers,
    });
  }
  return {
    query: {
      text: parsed.raw,
      brand: parsed.brand,
      line: parsed.line,
      size_class: parsed.sizeClass,
      inches: parsed.inches,
      colour: parsed.colour,
      max_price: parsed.maxPrice,
    },
    results,
    note: INDEX_NOTE,
  };
}

export async function productV1(d: ApiDeps, p: { id: string }) {
  const product = await productOr404(d, p.id);
  return { product: productView(product, await d.store.variantsForProduct(product.id)) };
}

export async function offersV1(d: ApiDeps, p: { id: string }) {
  const product = await productOr404(d, p.id);
  const listings = (await d.store.listingsForProduct(product.id)).filter((l) => l.active);
  return { product: productView(product), offers: await offersOf(d, listings), note: INDEX_NOTE };
}

export async function historyV1(d: ApiDeps, p: { id: string; days: number }) {
  const product = await productOr404(d, p.id);
  const listings = await d.store.listingsForProduct(product.id);
  const byId = new Map(listings.map((l) => [l.id, l]));
  const now = (d.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - p.days * 86_400_000).toISOString();
  const rows = listings.length
    ? await d.store.observationsSince({
        sinceIso: since,
        listingIds: listings.map((l) => l.id),
        changesOnly: false,
        limit: 1000,
      })
    : [];
  return {
    product: productView(product),
    since,
    readings: rows.map((o) => ({
      ...priceView(d, o, byId.get(o.listingId) ?? null),
      listing_id: o.listingId,
      previous_amount: o.previousPrice,
    })),
  };
}

export async function promotionsV1(d: ApiDeps, p: { store?: string; limit: number }) {
  const now = (d.now ?? (() => new Date()))();
  const promos = await d.store.currentPromotions({
    at: now.toISOString(),
    sourceIds: p.store ? [p.store] : undefined,
    limit: p.limit,
  });
  const ids = [...new Set(promos.map((x) => x.listingId))];
  const [listings, readings] = await Promise.all([
    Promise.all(ids.map((id) => d.store.getListing(id))),
    d.store.latestObservations(ids),
  ]);
  const listing = new Map(listings.filter((l): l is ListingRecord => !!l).map((l) => [l.id, l]));
  const reading = new Map(readings.map((o) => [o.listingId, o]));
  return {
    promotions: promos.map((x) => ({
      kind: x.kind,
      sale_price: x.salePrice,
      was_price: x.wasPrice,
      percent_off: x.percentOff,
      up_to: x.upTo,
      amount_off: x.amountOff,
      threshold: x.threshold,
      code: x.code,
      ends_text: x.endsText,
      ends_at: x.endsAt,
      evidence: x.evidence,
      source: { id: x.sourceId, name: storeName(d, x.sourceId) },
      url: listing.get(x.listingId)?.url ?? "",
      listing_id: x.listingId,
      method: x.method,
      first_seen_at: x.firstSeenAt,
      observed_at: x.lastSeenAt,
      // The confidence of the reading that shows it (a current promotion is
      // shown by its listing's latest shown reading).
      confidence: reading.get(x.listingId)?.validation.confidence ?? null,
      label: `Stated by the store · ${freshnessLabel({ kind: "live", fetchedAt: x.lastSeenAt }, now)}`,
    })),
  };
}

export async function storesV1(d: ApiDeps) {
  return {
    stores: d.sources
      .filter((s) => !s.discovery && s.status === "active")
      .map((s) => ({
        id: s.id,
        name: s.retailerLabel,
        category: s.category,
        website: s.marketHost ? `https://${s.marketHost}${s.marketPathPrefix ?? ""}` : null,
        live_class: s.liveClass,
        permission: s.permission,
      })),
  };
}

export async function changesV1(d: ApiDeps, p: { since: string; limit: number }) {
  const rows = await d.store.observationsSince({
    sinceIso: new Date(p.since).toISOString(),
    changesOnly: true,
    limit: p.limit,
  });
  const ids = [...new Set(rows.map((o) => o.listingId))];
  const listings = new Map(
    (await Promise.all(ids.map((id) => d.store.getListing(id))))
      .filter((l): l is ListingRecord => !!l)
      .map((l) => [l.id, l]),
  );
  return {
    since: p.since,
    changes: rows.map((o) => ({
      ...priceView(d, o, listings.get(o.listingId) ?? null),
      listing_id: o.listingId,
      product_id: listings.get(o.listingId)?.productId ?? null,
      previous_amount: o.previousPrice,
      previous_availability: o.previousAvailability,
    })),
  };
}
