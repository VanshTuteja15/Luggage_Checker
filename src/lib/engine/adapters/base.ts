/* ------------------------------------------------------------------ */
/*  Acquisition adapters: shared contract                             */
/*                                                                     */
/*  One module per protocol. An adapter turns a store channel's        */
/*  response into RawOffers (exactly what the source said) or a        */
/*  status explaining why it couldn't. It never validates, never       */
/*  guesses, and never touches the network except via ctx.fetcher.     */
/* ------------------------------------------------------------------ */

import type { EngineConfig } from "../config";
import type { PoliteFetcher } from "../politeness/fetcher";
import type { AdapterId, CategoryPack, FetchOutcome, Identifier, ListingRecord, ParsedQuery, RawOffer, SourceRecord } from "../types";

export type AdapterContext = {
  source: SourceRecord;
  fetcher: PoliteFetcher;
  config: EngineConfig;
  pack: CategoryPack;
  now: () => number;
  signal?: AbortSignal;
  deadlineAt?: number;
  sessionId?: string | null;
};

export type AdapterStatus = "ok" | "not_found" | "blocked" | "not_permitted" | "not_configured" | "timeout" | "error" | "garbage";

export type AdapterResult = {
  status: AdapterStatus;
  offers: RawOffer[];
  message: string | null;
};

export type ListingRef = Pick<ListingRecord, "url" | "externalId" | "identifiers" | "title" | "brand">;

export interface Adapter {
  readonly id: AdapterId;
  /** Reads a live price from the store or its official API. */
  readonly live: boolean;
  /** Fresh price(s) for one known listing. */
  verify(ctx: AdapterContext, listing: ListingRef): Promise<AdapterResult>;
  /** Live search through the channel, when it supports one (UCP, eBay). */
  search?(ctx: AdapterContext, q: ParsedQuery, limit: number): Promise<AdapterResult>;
}

export function result(status: AdapterStatus, offers: RawOffer[] = [], message: string | null = null): AdapterResult {
  return { status, offers, message };
}

/** Map a fetch outcome onto an adapter status (blocks stay blocks). */
export function statusFromOutcome(o: FetchOutcome): AdapterStatus {
  switch (o) {
    case "ok":
      return "ok";
    case "not_found":
      return "not_found";
    case "blocked":
    case "challenge":
    case "rate_limited":
    case "circuit_open":
      return "blocked";
    case "robots_disallowed":
    case "not_permitted":
    case "ssrf_rejected":
    case "outside_visit_window":
      return "not_permitted";
    case "timeout":
      return "timeout";
    case "garbage":
      return "garbage";
    default:
      return "error";
  }
}

export function normaliseGtin(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.length < 8 || d.length > 14) return null;
  return d.padStart(14, "0");
}

function brandKey(brand: string | null): string | null {
  return brand ? brand.toLowerCase().replace(/[^a-z0-9]+/g, "") : null;
}

/**
 * Identifiers for one offer: GTIN (normalised to 14 digits), the store SKU
 * (scoped to the store), and the manufacturer model number (+ colour code)
 * when the category pack can read one from the SKU or title.
 */
export function buildIdentifiers(
  pack: CategoryPack,
  sourceId: string,
  input: { brand: string | null; sku: string | null; barcode: string | null; title: string },
): Identifier[] {
  const out: Identifier[] = [];
  const gtin = normaliseGtin(input.barcode);
  if (gtin) out.push({ kind: "gtin", value: gtin });
  if (input.sku) out.push({ kind: "store_sku", value: input.sku.slice(0, 120), sourceId });
  const key = brandKey(input.brand);
  const model = (input.sku ? pack.modelOf(input.sku, input.brand) : null) ?? pack.modelOf(input.title, input.brand);
  if (model && key) {
    out.push({ kind: "model", value: `${key}:${model.model}` });
    if (model.colourCode) out.push({ kind: "mpn", value: `${key}:${model.model}-${model.colourCode}` });
  }
  return out;
}

/** https, lower-case host, no query/fragment, no trailing slash. */
export function canonicalUrl(url: string): string {
  const u = new URL(url);
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  u.search = "";
  return u.toString().replace(/\/$/, "");
}

export function withVariant(productUrl: string, variantId: string | null): string {
  if (!variantId) return productUrl;
  const u = new URL(productUrl);
  u.search = "";
  u.searchParams.set("variant", variantId);
  return u.toString();
}

/** Shopify product handle from a /products/<handle> URL (market prefixes allowed). */
export function shopifyHandle(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/products\/([a-z0-9][a-z0-9_-]*)/i);
    return m ? m[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

export function blankOffer(ctx: AdapterContext, adapter: AdapterId, partial: Partial<RawOffer> & Pick<RawOffer, "url" | "title">): RawOffer {
  return {
    sourceId: ctx.source.id,
    adapter,
    externalId: null,
    variantExternalId: null,
    brand: null,
    identifiers: [],
    colour: null,
    options: [],
    price: null,
    listPrice: null,
    currency: null,
    availability: "unknown",
    seller: null,
    condition: null,
    imageUrl: null,
    displayedPrice: null,
    pageType: "unknown",
    evidence: {},
    fetchedAt: new Date(ctx.now()).toISOString(),
    cacheAgeSec: null,
    asOf: null,
    ...partial,
  };
}
