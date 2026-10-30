/* Promotions from real offer text (v4 A4.2, U-PROMO). Snippets from scripts/bench/sets/promos.json. */

import { describe, expect, it } from "vitest";
import { ADAPTERS } from "@/lib/engine/adapters";
import { blankOffer } from "@/lib/engine/adapters/base";
import {
  approximateEnd,
  extractPromotion,
  promotionsFromOffer,
} from "@/lib/engine/extract/promotions";
import { extractStructured } from "@/lib/engine/extract/structured";
import type { AdapterId } from "@/lib/engine/types";
import { fixture, makeCtx, stubNet } from "./helpers";

const CLD =
  "https://www.canadaluggagedepot.ca/products/samsonite-omni-3-0-large-spinner-expandable-luggage";
const CLD_HTML = () =>
  fixture("html/canadaluggagedepot__samsonite-omni-3-0-large-spinner-expandable-luggage.html");

describe("promotions from one reading (U-PROMO storage)", () => {
  const ctx = makeCtx("canadaluggagedepot", stubNet({}).fetchImpl);
  const offer = (
    partial: Parameters<typeof blankOffer>[2],
    adapter: AdapterId = "shopify_product_json",
  ) => blankOffer(ctx, adapter, partial);

  it("a recorded JSON-LD ListPrice above the price is a sale with its end date; an AggregateOffer high price never is", async () => {
    const s = extractStructured(CLD_HTML());
    const offers = s.products.flatMap((p) => [p, ...p.variants]).flatMap((p) => p.offers);
    expect(
      offers.some((o) => o.listPrice === 440 && o.listPriceFrom === "price_specification"),
    ).toBe(true);
    expect(offers.filter((o) => o.listPriceFrom === "aggregate_high").length).toBeLessThanOrEqual(
      1,
    );

    const net = stubNet({ [CLD]: { body: CLD_HTML(), headers: { "content-type": "text/html" } } });
    const r = await ADAPTERS.html_structured.verify(makeCtx("canadaluggagedepot", net.fetchImpl), {
      url: CLD,
      externalId: null,
      identifiers: [],
      title: "",
      brand: null,
    });
    const promos = r.offers.flatMap((o) => promotionsFromOffer(o));
    expect(promos.length).toBe(r.offers.length);
    for (const p of promos) {
      expect(p).toMatchObject({
        kind: "sale_price",
        method: "jsonld",
        salePrice: 279.99,
        wasPrice: 440,
      });
      expect(p.evidence[0]).toMatch(/list price 440/);
      if (p.endsText) expect(p.endsAt).toBe(approximateEnd(p.endsText));
    }
    // The same page's AggregateOffer range, had it been the only offer: no promotion.
    const range = offer(
      {
        url: CLD,
        title: "x",
        price: 279.99,
        listPrice: 440,
        evidence: { from: "json-ld", listPriceFrom: "aggregate_high" },
      },
      "html_structured",
    );
    expect(promotionsFromOffer(range as never)).toEqual([]);
  });

  it("a Shopify compare-at above the price is a sale; equal, missing or implausible ones aren't", () => {
    const base = { url: "https://www.canadaluggagedepot.ca/products/x", title: "x" };
    expect(
      promotionsFromOffer(
        offer({ ...base, price: 324.95, listPrice: 405, evidence: { rawCompareAt: 405 } }),
      ),
    ).toMatchObject([
      { kind: "sale_price", method: "compare_at", salePrice: 324.95, wasPrice: 405 },
    ]);
    expect(promotionsFromOffer(offer({ ...base, price: 405, listPrice: null }))).toEqual([]);
    // A "was" price over 5× the price is a data error, not an 85% sale.
    expect(promotionsFromOffer(offer({ ...base, price: 60, listPrice: 400 }))).toEqual([]);
    // Other adapters' list prices (marketplaces, feeds) are not read as promotions.
    expect(
      promotionsFromOffer(
        offer({ ...base, price: 300, listPrice: 400 }, "amazon_creators" as never),
      ),
    ).toEqual([]);
  });

  it("offer text counts only when its sale price is this offer's price; shipping and codes stand alone", () => {
    const base = { url: "https://www.samsonite.ca/x", title: "x" };
    const text = "Now C$ 784.95 , was C$ 985.00 , discount of 20% Off";
    expect(
      promotionsFromOffer(
        offer({ ...base, price: 784.95, evidence: { offerText: text } }, "html_structured"),
      ),
    ).toMatchObject([
      {
        kind: "percent_off",
        method: "page_text",
        percentOff: 20,
        salePrice: 784.95,
        wasPrice: 985,
      },
    ]);
    expect(
      promotionsFromOffer(
        offer({ ...base, price: 799, evidence: { offerText: text } }, "html_structured"),
      ),
    ).toEqual([]);
    expect(
      promotionsFromOffer(
        offer(
          {
            ...base,
            price: 200,
            evidence: { offerText: "Free Shipping Over $100 Price Match Guarantee" },
          },
          "html_structured",
        ),
      ),
    ).toMatchObject([{ kind: "free_shipping", threshold: 100 }]);
  });

  it("reads end dates verbatim and approximately", () => {
    expect(approximateEnd("2026-12-31")).toBe("2026-12-31T23:59:59.000Z");
    expect(approximateEnd("2026-11-02T23:59:00-05:00")).toBe("2026-11-03T04:59:00.000Z");
    expect(approximateEnd("while supplies last")).toBeNull();
    expect(approximateEnd(null)).toBeNull();
  });
});

describe("promotions (U-PROMO)", () => {
  it("reads real discounts with their numbers", () => {
    expect(extractPromotion("Now C$ 784.95 , was C$ 985.00 , discount of 20% Off")).toMatchObject({
      isPromotion: true,
      percentOff: 20,
      salePrice: 784.95,
      wasPrice: 985,
    });
    expect(
      extractPromotion("Price: Sale price$469.95 CAD Regular price$522.00 CAD."),
    ).toMatchObject({ isPromotion: true, kinds: ["sale_price"], salePrice: 469.95, wasPrice: 522 });
    expect(
      extractPromotion("Up to 20% off Samsonite Sale price $324.95 CAD Regular price $405.00"),
    ).toMatchObject({ upTo: true, percentOff: 20 });
    expect(extractPromotion("Free Shipping Over $100 Price Match Guarantee")).toMatchObject({
      isPromotion: true,
      threshold: 100,
    });
  });

  it("never invents a deal: equal 'sale' price, comparable value, best offer, tags, 'no further discounts'", () => {
    for (const text of [
      "The Aluminum Medium in Silver Regular price $725 Sale price $725 interest-free installments",
      "Comparable value: $350.00 CAD Price: $279.95 Discount in store.",
      'Briggs & Riley Sympatico 22" CX Expandable Carry-On Spinner · C $320.67. or Best Offer',
      "tags: $251 - $500, badge-F8700A-Free Gift, CLEARANCE, free-gift1, icon-free-shipping",
      "The current price is C$ 434.95 This product does not qualify for any further discounts.",
    ]) {
      const p = extractPromotion(text);
      expect(p.isPromotion, text).toBe(false);
      expect(p.wasPrice, text).toBeNull();
    }
  });
});
