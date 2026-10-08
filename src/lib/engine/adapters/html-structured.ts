/* ------------------------------------------------------------------ */
/*  html_structured                                                   */
/*                                                                     */
/*  A product page's own structured data: JSON-LD Product /            */
/*  ProductGroup / Offer (@graph, hasVariant, priceSpecification),     */
/*  microdata (Salesforce Commerce Cloud renders itemprop=price), and  */
/*  the OpenGraph / product: meta price the customer is shown, kept as  */
/*  `displayedPrice` so validation can cross-check it (the Bentley      */
/*  render-time discount case from the store audit).                    */
/* ------------------------------------------------------------------ */

import {
  displayedPrice,
  extractStructured,
  schemaAvailability,
  type StructuredOffer,
  type StructuredProduct,
} from "../extract/structured";
import { normaliseHost } from "../registry";
import type { RawOffer } from "../types";
import {
  blankOffer,
  buildIdentifiers,
  result,
  statusFromOutcome,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type ListingRef,
} from "./base";

type Candidate = {
  node: StructuredProduct;
  offer: StructuredOffer;
  parent: StructuredProduct | null;
};

function candidates(products: StructuredProduct[]): Candidate[] {
  const out: Candidate[] = [];
  for (const p of products) {
    // A ProductGroup's own offer summarises its variants (CLD: same price,
    // no SKU or GTIN); when the variants carry offers, those are the items.
    const variantOffers = p.variants.some((v) => v.offers.length > 0);
    if (!variantOffers) for (const o of p.offers) out.push({ node: p, offer: o, parent: null });
    for (const v of p.variants)
      for (const o of v.offers) out.push({ node: v, offer: o, parent: p });
  }
  return out;
}

function onAllowedDomain(url: string, allowed: string[]): boolean {
  try {
    const h = normaliseHost(new URL(url).hostname);
    return allowed.some((d) => normaliseHost(d) === h);
  } catch {
    return false;
  }
}

export const htmlStructured: Adapter = {
  id: "html_structured",
  live: true,

  async verify(ctx: AdapterContext, listing: ListingRef): Promise<AdapterResult> {
    const res = await ctx.fetcher.fetch({
      source: ctx.source,
      url: listing.url,
      adapter: "html_structured",
      signal: ctx.signal,
      deadlineAt: ctx.deadlineAt,
      sessionId: ctx.sessionId ?? null,
      headers: { Accept: "text/html,application/xhtml+xml" },
      maxBytes: 4_000_000,
    });
    if (res.outcome !== "ok")
      return result(statusFromOutcome(res.outcome), [], res.error ?? res.outcome);

    const s = extractStructured(res.body);
    const shown = displayedPrice(s);
    const isProductPage =
      (s.meta["og:type"] ?? "").toLowerCase() === "product" || s.products.length > 0;
    const evidence = {
      request: listing.url,
      status: res.status,
      jsonLdBlocks: s.jsonLdBlocks,
      jsonLdErrors: s.jsonLdParseErrors,
      meta: s.meta,
    };

    // Offers that link off the store's own domains (Delsey's JSON-LD points to
    // us.delsey.com) can't be shown as this store's price.
    const all = candidates(s.products);
    const usable = all.filter(
      (c) => !c.offer.url || onAllowedDomain(c.offer.url, ctx.source.allowedDomains),
    );
    const offers: RawOffer[] = [];

    // A single-price page: the meta price is the shown price of the same item.
    const distinctPrices = new Set(
      usable.map((c) => c.offer.price).filter((p): p is number => p !== null),
    );
    const crossCheck = distinctPrices.size <= 1 ? shown.price : null;

    for (const c of usable) {
      const title = c.node.name ?? c.parent?.name ?? s.meta["og:title"] ?? listing.title;
      const brand =
        ctx.pack.brandOf(c.node.brand ?? c.parent?.brand ?? "") ??
        ctx.pack.brandOf(title) ??
        c.node.brand ??
        c.parent?.brand ??
        null;
      const sku = c.offer.sku ?? c.node.sku;
      const gtin = c.offer.gtin ?? c.node.gtin;
      offers.push(
        blankOffer(ctx, "html_structured", {
          url: c.offer.url ?? listing.url,
          externalId: c.parent?.productGroupId ?? c.node.productGroupId ?? null,
          variantExternalId: sku,
          title,
          brand,
          identifiers: buildIdentifiers(ctx.pack, ctx.source.id, {
            brand,
            sku,
            barcode: gtin,
            title,
          }),
          colour: c.node.color ?? ctx.pack.colourOf(title),
          options: [c.node.color, c.node.size].filter((x): x is string => !!x),
          price: c.offer.price,
          listPrice:
            c.offer.listPrice !== null &&
            c.offer.price !== null &&
            c.offer.listPrice > c.offer.price
              ? c.offer.listPrice
              : null,
          currency: c.offer.priceCurrency ?? shown.currency,
          availability: schemaAvailability(c.offer.availability),
          seller: c.offer.seller,
          condition: c.offer.itemCondition,
          imageUrl: c.node.image ?? s.meta["og:image"] ?? null,
          displayedPrice: crossCheck,
          pageType: isProductPage ? "product" : "listing",
          cacheAgeSec: res.cacheAgeSec,
          evidence: { ...evidence, from: "json-ld", priceValidUntil: c.offer.priceValidUntil },
        }),
      );
    }

    // No usable JSON-LD offer: fall back to the page's own displayed price.
    if (offers.length === 0 && shown.price !== null) {
      const title = s.meta["og:title"] ?? listing.title;
      offers.push(
        blankOffer(ctx, "html_structured", {
          url: listing.url,
          title,
          brand: ctx.pack.brandOf(title) ?? listing.brand,
          identifiers: [...listing.identifiers],
          price: shown.price,
          currency: shown.currency,
          availability: schemaAvailability(
            s.meta["product:availability"] ?? s.microdata.availability,
          ),
          imageUrl: s.meta["og:image"] ?? null,
          displayedPrice: shown.price,
          pageType: isProductPage ? "product" : "listing",
          cacheAgeSec: res.cacheAgeSec,
          evidence: {
            ...evidence,
            from:
              s.meta["og:price:amount"] || s.meta["product:price:amount"] ? "meta" : "microdata",
          },
        }),
      );
    }

    if (offers.length === 0) {
      return result(
        "garbage",
        [],
        all.length
          ? "structured offers link to another store's domain"
          : "no structured product data on the page",
      );
    }
    return result("ok", offers);
  },
};
