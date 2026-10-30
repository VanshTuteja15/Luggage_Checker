/* ------------------------------------------------------------------ */
/*  Shopify catalogue reads: /products.json?limit=250&page=N            */
/*                                                                     */
/*  A whole permitted store in a few requests (CLD: 3,229 products in   */
/*  13 pages) instead of one product page at a time. The feed carries   */
/*  price, compare-at, SKU, `available`, vendor and type, but NO barcode */
/*  and NO currency (measured 2026-10-30, review 02), so:                */
/*    • GTINs still come from per-product reads (discovery backfill);    */
/*    • before any of it is used, a currency canary reads two products'  */
/*      own .json (which states price_currency): CAD and the same price,  */
/*      or the run stops.                                                */
/*  Pages go through the PoliteFetcher; stop on the first empty page,    */
/*  at a block, or at maxPages; Shopify refuses page × limit > 25,000.   */
/* ------------------------------------------------------------------ */

import type { ShopifyProduct } from "../extract/shopify";
import { decodeHtmlText } from "../extract/structured";
import type { RawOffer } from "../types";
import { canonicalUrl, statusFromOutcome, type AdapterContext, type AdapterStatus } from "./base";
import { offersFromShopify } from "./shopify-product-json";

type Json = Record<string, unknown>;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

/** body_html → plain text for the spec rules (tags out, entities decoded, ≤ 5,000 chars; v4 A4.1). */
function textOf(html: string | null): string | null {
  if (!html) return null;
  const t = decodeHtmlText(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, 5_000) : null;
}

/** One /products.json page → products; null when it isn't a Shopify catalogue page. */
export function parseShopifyCatalogPage(text: string): ShopifyProduct[] | null {
  let j: { products?: unknown };
  try {
    j = JSON.parse(text) as { products?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(j.products)) return null;
  return (j.products as Json[])
    .filter((p) => str(p.title) && Array.isArray(p.variants))
    .map((p) => ({
      id: String(p.id ?? ""),
      handle: str(p.handle),
      title: str(p.title) ?? "",
      vendor: str(p.vendor),
      productType: str(p.product_type),
      imageUrl: str(((p.images as Json[] | undefined) ?? [])[0]?.src) ?? null,
      description: textOf(str(p.body_html)),
      source: ".json" as const,
      variants: (p.variants as Json[]).map((v) => ({
        id: String(v.id ?? ""),
        title: str(v.title),
        sku: str(v.sku),
        // The catalogue feed has no barcode and no currency field (see the header).
        barcode: null,
        price: num(v.price),
        compareAt: num(v.compare_at_price),
        currency: null,
        available: typeof v.available === "boolean" ? v.available : null,
        options: [v.option1, v.option2, v.option3]
          .map(str)
          .filter((x): x is string => !!x && x !== "Default Title"),
      })),
    }));
}

export type CatalogProduct = { product: ShopifyProduct; url: string; offers: RawOffer[] };

export type CatalogRead = {
  status: AdapterStatus;
  products: CatalogProduct[];
  pages: number;
  requests: number;
  reason: string | null;
};

const PAGE_LIMIT = 250;
const SHOPIFY_CAP = 25_000;

export async function readCatalog(
  ctx: AdapterContext,
  opts: { maxPages?: number; canaryVariants?: number } = {},
): Promise<CatalogRead> {
  const host = ctx.source.marketHost;
  const out: CatalogRead = { status: "ok", products: [], pages: 0, requests: 0, reason: null };
  if (!host) return { ...out, status: "not_configured", reason: "no market host on record" };
  const base = `https://${host}${ctx.source.marketPathPrefix ?? ""}`;
  const maxPages = Math.min(opts.maxPages ?? 100, Math.floor(SHOPIFY_CAP / PAGE_LIMIT));
  const common = {
    source: ctx.source,
    adapter: "shopify_product_json" as const,
    signal: ctx.signal,
    sessionId: null,
    headers: { Accept: "application/json" },
    maxBytes: 10_000_000,
  };

  for (let page = 1; page <= maxPages; page++) {
    if (ctx.signal?.aborted) return { ...out, status: "timeout", reason: "cancelled" };
    const url = `${base}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
    const res = await ctx.fetcher.fetch({ ...common, url });
    out.requests++;
    if (res.outcome !== "ok")
      return {
        ...out,
        status: statusFromOutcome(res.outcome),
        reason: `${ctx.source.retailerLabel} answered page ${page} with ${res.error ?? res.outcome}`,
      };
    const products = parseShopifyCatalogPage(res.body);
    if (!products)
      return { ...out, status: "garbage", reason: `page ${page} wasn't a Shopify catalogue page` };
    if (products.length === 0) break;
    out.pages = page;
    for (const p of products) {
      if (!p.handle) continue;
      const productUrl = canonicalUrl(`${base}/products/${p.handle}`);
      const evidence = {
        request: url,
        channel: "products.json catalogue",
        status: res.status,
        currency: "implied by the Canadian storefront (no currency field in the catalogue feed)",
      };
      out.products.push({
        product: p,
        url: productUrl,
        offers: offersFromShopify(ctx, p, productUrl, evidence, res.cacheAgeSec),
      });
    }
    if (page === 1) {
      const canary = await currencyCanary(ctx, base, out.products, opts.canaryVariants ?? 2);
      out.requests += canary.requests;
      if (!canary.ok) return { ...out, products: [], status: "garbage", reason: canary.reason };
    }
  }
  return out;
}

/** Two products' own .json must say CAD and match the catalogue price, or nothing from the run is used. */
async function currencyCanary(
  ctx: AdapterContext,
  base: string,
  products: CatalogProduct[],
  n: number,
): Promise<{ ok: boolean; reason: string | null; requests: number }> {
  // Up to 3n candidates: a product listed in the feed but gone from its own page (404) says nothing about currency.
  const picks = products
    .filter((p) => p.product.variants.some((v) => v.price !== null))
    .slice(0, n * 3);
  if (picks.length === 0)
    return { ok: false, reason: "no priced product to check the currency against", requests: 0 };
  let requests = 0;
  let checked = 0;
  for (const p of picks) {
    if (checked >= n) break;
    const res = await ctx.fetcher.fetch({
      source: ctx.source,
      url: `${base}/products/${p.product.handle}.json`,
      adapter: "shopify_product_json",
      headers: { Accept: "application/json" },
      signal: ctx.signal,
      sessionId: null,
    });
    requests++;
    if (res.outcome === "not_found") continue;
    if (res.outcome !== "ok")
      return {
        ok: false,
        reason: `the currency check couldn't read ${p.product.handle} (${res.outcome})`,
        requests,
      };
    checked++;
    let variants: Json[] = [];
    try {
      variants = ((JSON.parse(res.body) as { product?: { variants?: Json[] } }).product?.variants ??
        []) as Json[];
    } catch {
      return { ok: false, reason: "the currency check got an unreadable product page", requests };
    }
    for (const bulk of p.product.variants) {
      const own = variants.find((v) => String(v.id) === bulk.id);
      if (!own || bulk.price === null) continue;
      const currency = str(own.price_currency)?.toUpperCase() ?? null;
      if (currency !== "CAD")
        return {
          ok: false,
          reason: `the product's own page prices in ${currency ?? "an unstated currency"}, not CAD`,
          requests,
        };
      if (Math.abs((num(own.price) ?? -1) - bulk.price) > 0.005)
        return {
          ok: false,
          reason: `the catalogue says ${bulk.price} but the product's own page says ${String(own.price)}`,
          requests,
        };
    }
  }
  if (checked < n)
    return {
      ok: false,
      reason: `the currency check could read only ${checked} of ${n} products`,
      requests,
    };
  return { ok: true, reason: null, requests };
}
