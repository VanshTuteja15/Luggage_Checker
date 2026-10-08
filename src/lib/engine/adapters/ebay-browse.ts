/* ------------------------------------------------------------------ */
/*  ebay_browse_api                                                   */
/*                                                                     */
/*  eBay's official Browse API on marketplace EBAY_CA (OAuth client    */
/*  credentials). Search by GTIN or keywords, new condition, fixed     */
/*  price, priced in CAD. eBay's HTML is never fetched: its terms ban  */
/*  LLM-driven bots, and the registry gives the fetcher only           */
/*  api.ebay.com.                                                      */
/* ------------------------------------------------------------------ */

import type { Availability, ParsedQuery, RawOffer } from "../types";
import { blankOffer, buildIdentifiers, result, statusFromOutcome, type Adapter, type AdapterContext, type AdapterResult, type ListingRef } from "./base";

const API = "https://api.ebay.com";
const SCOPE = "https://api.ebay.com/oauth/api_scope";
const FILTER = "conditionIds:{1000},buyingOptions:{FIXED_PRICE},priceCurrency:CAD,deliveryCountry:CA";

/** One token per client id, refreshed a minute before it expires. */
const tokens = new Map<string, { token: string; expiresAt: number }>();

export function resetEbayTokens(): void {
  tokens.clear();
}

async function token(ctx: AdapterContext): Promise<{ token: string } | { error: AdapterResult }> {
  const creds = ctx.config.ebay!;
  const hit = tokens.get(creds.clientId);
  if (hit && hit.expiresAt - 60_000 > ctx.now()) return { token: hit.token };
  const res = await ctx.fetcher.fetch({
    source: ctx.source,
    url: `${API}/identity/v1/oauth2/token`,
    adapter: "ebay_browse_api",
    method: "POST",
    respectRobots: false,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64")}`,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
    signal: ctx.signal,
    deadlineAt: ctx.deadlineAt,
    sessionId: ctx.sessionId ?? null,
  });
  if (res.outcome !== "ok") return { error: result(res.status === 401 ? "not_configured" : statusFromOutcome(res.outcome), [], `eBay token: ${res.error ?? res.outcome}`) };
  try {
    const j = JSON.parse(res.body) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return { error: result("error", [], "eBay token response had no access_token") };
    tokens.set(creds.clientId, { token: j.access_token, expiresAt: ctx.now() + (j.expires_in ?? 7200) * 1000 });
    return { token: j.access_token };
  } catch {
    return { error: result("garbage", [], "eBay token response was not JSON") };
  }
}

function headers(t: string): Record<string, string> {
  return {
    Authorization: `Bearer ${t}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_CA",
    "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=CA",
    "Accept-Language": "en-CA",
    Accept: "application/json",
  };
}

type EbayItem = Record<string, unknown> & {
  itemId?: string;
  title?: string;
  price?: { value?: string; currency?: string };
  condition?: string;
  conditionId?: string;
  seller?: { username?: string };
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  gtin?: string;
  mpn?: string;
  brand?: string;
  estimatedAvailabilities?: { estimatedAvailabilityStatus?: string }[];
  itemEndDate?: string;
  legacyItemId?: string;
};

function availability(it: EbayItem): Availability {
  const s = it.estimatedAvailabilities?.[0]?.estimatedAvailabilityStatus;
  if (!s) return "unknown";
  return /IN_STOCK|LIMITED_STOCK/i.test(s) ? "in_stock" : /OUT_OF_STOCK/i.test(s) ? "out_of_stock" : "unknown";
}

/** Listing link on www.ebay.ca, without tracking parameters. */
function itemUrl(it: EbayItem): string | null {
  const raw = it.itemWebUrl;
  if (!raw) return it.legacyItemId ? `https://www.ebay.ca/itm/${it.legacyItemId}` : null;
  try {
    const u = new URL(raw);
    u.hostname = "www.ebay.ca";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

function toOffer(ctx: AdapterContext, it: EbayItem, evidence: Record<string, unknown>): RawOffer | null {
  const url = itemUrl(it);
  if (!url || !it.title) return null;
  const brand = ctx.pack.brandOf(it.brand ?? "") ?? ctx.pack.brandOf(it.title) ?? it.brand ?? null;
  const price = it.price?.value !== undefined ? Number(it.price.value) : null;
  return blankOffer(ctx, "ebay_browse_api", {
    url,
    externalId: it.itemId ?? null,
    title: it.title,
    brand,
    identifiers: buildIdentifiers(ctx.pack, ctx.source.id, { brand, sku: it.mpn ?? null, barcode: it.gtin ?? null, title: it.title }),
    colour: ctx.pack.colourOf(it.title),
    price: price !== null && Number.isFinite(price) ? price : null,
    currency: it.price?.currency ?? null,
    availability: availability(it),
    seller: it.seller?.username ?? null,
    condition: it.condition ?? (it.conditionId === "1000" ? "New" : null),
    imageUrl: it.image?.imageUrl ?? null,
    pageType: "api",
    evidence: { ...evidence, itemId: it.itemId, itemEndDate: it.itemEndDate ?? null },
  });
}

export const ebayBrowse: Adapter = {
  id: "ebay_browse_api",
  live: true,

  async search(ctx: AdapterContext, q: ParsedQuery, limit: number): Promise<AdapterResult> {
    if (!ctx.config.ebay) return result("not_configured", [], "eBay API keys not configured");
    const t = await token(ctx);
    if ("error" in t) return t.error;
    const params = new URLSearchParams({ limit: String(Math.min(limit, 50)), filter: FILTER });
    if (q.gtin) params.set("gtin", q.gtin.replace(/^0+(?=\d{12,13}$)/, ""));
    else params.set("q", q.raw.slice(0, 100));
    const url = `${API}/buy/browse/v1/item_summary/search?${params.toString()}`;
    const res = await ctx.fetcher.fetch({ source: ctx.source, url, adapter: "ebay_browse_api", respectRobots: false, headers: headers(t.token), signal: ctx.signal, deadlineAt: ctx.deadlineAt, sessionId: ctx.sessionId ?? null });
    if (res.outcome !== "ok") return result(statusFromOutcome(res.outcome), [], res.error);
    try {
      const j = JSON.parse(res.body) as { itemSummaries?: EbayItem[]; total?: number };
      const offers = (j.itemSummaries ?? []).map((it, i) => toOffer(ctx, it, { request: url, field: `itemSummaries[${i}].price` })).filter((o): o is RawOffer => o !== null);
      return result(offers.length ? "ok" : "not_found", offers, offers.length ? null : "no new, CAD-priced listings");
    } catch {
      return result("garbage", [], "eBay search response was not JSON");
    }
  },

  async verify(ctx: AdapterContext, listing: ListingRef): Promise<AdapterResult> {
    if (!ctx.config.ebay) return result("not_configured", [], "eBay API keys not configured");
    const id = listing.externalId;
    if (!id) return result("not_found", [], "no eBay item id for this listing");
    const t = await token(ctx);
    if ("error" in t) return t.error;
    const url = `${API}/buy/browse/v1/item/${encodeURIComponent(id)}`;
    const res = await ctx.fetcher.fetch({ source: ctx.source, url, adapter: "ebay_browse_api", respectRobots: false, headers: headers(t.token), signal: ctx.signal, deadlineAt: ctx.deadlineAt, sessionId: ctx.sessionId ?? null });
    if (res.outcome !== "ok") return result(statusFromOutcome(res.outcome), [], res.error);
    try {
      const offer = toOffer(ctx, JSON.parse(res.body) as EbayItem, { request: url, field: "price" });
      return offer ? result("ok", [offer]) : result("garbage", [], "item had no link or title");
    } catch {
      return result("garbage", [], "eBay item response was not JSON");
    }
  },
};
