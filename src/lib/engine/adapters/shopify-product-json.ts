/* ------------------------------------------------------------------ */
/*  shopify_product_json                                              */
/*                                                                     */
/*  /products/<handle>.json (+ .js for availability when needed). Used */
/*  only where the registry permits it: Canada Luggage Depot (its       */
/*  agents.md sanctions it), Delsey (terms silent), and stores whose    */
/*  per-source flag a human has turned on after reading the terms.      */
/* ------------------------------------------------------------------ */

import { mergeShopify, parseShopifyJs, parseShopifyJson, type ShopifyProduct, type ShopifyVariant } from "../extract/shopify";
import type { Availability, RawOffer } from "../types";
import {
  blankOffer,
  buildIdentifiers,
  canonicalUrl,
  result,
  shopifyHandle,
  statusFromOutcome,
  withVariant,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type ListingRef,
} from "./base";

function availability(v: ShopifyVariant): Availability {
  return v.available === true ? "in_stock" : v.available === false ? "out_of_stock" : "unknown";
}

/** /products/<handle> path for the listing, keeping a market prefix like /en-ca. */
function productPath(url: string, handle: string): string {
  const u = new URL(url);
  const i = u.pathname.toLowerCase().indexOf(`/products/${handle}`);
  return `${u.origin}${u.pathname.slice(0, i)}/products/${handle}`;
}

export function offersFromShopify(
  ctx: AdapterContext,
  product: ShopifyProduct,
  productUrl: string,
  evidence: Record<string, unknown>,
  cacheAgeSec: number | null,
): RawOffer[] {
  const brand = ctx.pack.brandOf(product.vendor ?? "") ?? ctx.pack.brandOf(product.title) ?? product.vendor;
  return product.variants.map((v, i) => {
    const variantLabel = v.title && v.title !== "Default Title" ? v.title : null;
    const title = variantLabel && !product.title.toLowerCase().includes(variantLabel.toLowerCase()) ? `${product.title} - ${variantLabel}` : product.title;
    const listPrice = v.compareAt !== null && v.price !== null && v.compareAt > v.price ? v.compareAt : null;
    return blankOffer(ctx, "shopify_product_json", {
      url: withVariant(productUrl, product.variants.length > 1 ? v.id : null),
      externalId: product.id,
      variantExternalId: v.id,
      title,
      brand,
      identifiers: buildIdentifiers(ctx.pack, ctx.source.id, { brand, sku: v.sku, barcode: v.barcode, title: product.title }),
      colour: ctx.pack.colourOf(v.options.join(" ")) ?? ctx.pack.colourOf(variantLabel ?? "") ?? ctx.pack.colourOf(product.title),
      options: v.options,
      price: v.price,
      listPrice,
      currency: v.currency,
      availability: availability(v),
      imageUrl: product.imageUrl,
      pageType: "api",
      cacheAgeSec,
      evidence: {
        ...evidence,
        field: `product.variants[${i}].price`,
        rawPrice: v.price,
        rawCompareAt: v.compareAt,
        currencyField: v.currency ? `product.variants[${i}].price_currency` : null,
        sku: v.sku,
        barcode: v.barcode,
      },
    });
  });
}

export const shopifyProductJson: Adapter = {
  id: "shopify_product_json",
  live: true,

  async verify(ctx: AdapterContext, listing: ListingRef): Promise<AdapterResult> {
    const handle = shopifyHandle(listing.url);
    if (!handle) return result("not_found", [], "not a Shopify product URL");
    const base = productPath(listing.url, handle);
    const common = { source: ctx.source, adapter: "shopify_product_json" as const, signal: ctx.signal, deadlineAt: ctx.deadlineAt, sessionId: ctx.sessionId ?? null, headers: { Accept: "application/json" } };

    const json = await ctx.fetcher.fetch({ ...common, url: `${base}.json` });
    if (json.outcome !== "ok") return result(statusFromOutcome(json.outcome), [], json.error ?? json.outcome);
    const parsed = parseShopifyJson(json.body);
    if (!parsed) return result("garbage", [], "response was not Shopify product JSON");

    let product = parsed;
    const evidence: Record<string, unknown> = { request: `${base}.json`, status: json.status };
    if (parsed.variants.some((v) => v.available === null)) {
      // .json doesn't say whether it's in stock; the storefront's .js does.
      const js = await ctx.fetcher.fetch({ ...common, url: `${base}.js` });
      if (js.outcome === "ok") {
        const merged = mergeShopify(parsed, parseShopifyJs(js.body));
        product = merged.product;
        evidence.availabilityFrom = `${base}.js`;
        if (merged.priceDisagreements.length) evidence.priceDisagreements = merged.priceDisagreements;
      } else {
        evidence.availabilityFrom = `unavailable (${js.outcome})`;
      }
    } else {
      evidence.availabilityFrom = ".json inventory";
    }

    const offers = offersFromShopify(ctx, product, canonicalUrl(base), evidence, json.cacheAgeSec);
    return offers.length ? result("ok", offers) : result("garbage", [], "product has no variants");
  },
};
