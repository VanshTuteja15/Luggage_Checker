/* ------------------------------------------------------------------ */
/*  Q2 search: one row per store (E10), headline price (R2.3), stock   */
/*  ordering (R2.6), labels (rule 5), estimates never tracked, and     */
/*  last-known prices when a live check can't run (R2.5, A2.3).        */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { toSearchProduct, trackableOffers } from "@/components/research/track";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { freshnessLabel, groupOffers } from "@/lib/engine/research/answer";
import { lastKnownFromEngine, lastKnownFromTracked } from "@/lib/engine/research/last-known";
import { headlineFor, productViews, stockOf, storeRows } from "@/lib/engine/research/rows";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import type { AnswerOffer, AnswerProduct, Freshness } from "@/lib/engine/types";
import type { TrackedProduct } from "@/lib/types";

const NOW = new Date("2026-10-10T15:30:00.000Z"); // 9:30 a.m. in Calgary
const TODAY_902 = "2026-10-10T15:02:00.000Z";
const live: Freshness = { kind: "live", fetchedAt: TODAY_902 };

function offer(
  o: Partial<AnswerOffer> & Pick<AnswerOffer, "sourceId" | "retailer" | "price">,
): AnswerOffer {
  return {
    url: `https://www.${o.sourceId}.ca/products/paralux-medium`,
    title: "Samsonite Paralux Spinner Medium",
    brand: "Samsonite",
    sizeClass: "medium",
    identifiers: [],
    imageUrl: null,
    reasons: [],
    listPrice: null,
    currency: "CAD",
    availability: "in_stock",
    colour: null,
    freshness: live,
    confidence: 0.95,
    lowConfidence: false,
    method: "shopify_product_json",
    observationId: null,
    listingId: null,
    productId: null,
    evidence: null,
    ...o,
  };
}

const CLD = { sourceId: "canadaluggagedepot", retailer: "Canada Luggage Depot" };

describe("one row per store (R2.2, E10)", () => {
  it("collapses three colour variants at one price into one row with colour chips", () => {
    const rows = storeRows([
      offer({
        ...CLD,
        price: 434.95,
        colour: "Black",
        url: "https://www.canadaluggagedepot.ca/products/paralux?variant=1",
      }),
      offer({
        ...CLD,
        price: 434.95,
        colour: "Stone Grey",
        url: "https://www.canadaluggagedepot.ca/products/paralux?variant=2",
      }),
      offer({
        ...CLD,
        price: 434.95,
        colour: "Midnight Navy",
        url: "https://www.canadaluggagedepot.ca/products/paralux?variant=3",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(434.95);
    expect(rows[0].colours).toEqual(["Black", "Stone Grey", "Midnight Navy"]);
    expect(rows[0].pages).toHaveLength(1); // variants of one page are one page
  });

  it("shows twin pages at one store as one row with '+1 more page'", () => {
    const tumi = { sourceId: "tumi-ca", retailer: "TUMI.ca" };
    const rows = storeRows([
      offer({ ...tumi, price: 1815, url: "https://www.tumi.ca/p/alpha-a" }),
      offer({ ...tumi, price: 1810, url: "https://www.tumi.ca/p/alpha-b" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].price).toBe(1810);
    expect(rows[0].pages.map((p) => p.price)).toEqual([1810, 1815]);
  });

  it("lists stores lowest first, out of stock after in stock at the same price, last-seen last", () => {
    const rows = storeRows([
      offer({ sourceId: "a", retailer: "A", price: 400, availability: "out_of_stock" }),
      offer({ sourceId: "b", retailer: "B", price: 400 }),
      offer({
        sourceId: "c",
        retailer: "C",
        price: 380,
        freshness: { kind: "stale", lastSeenAt: "2026-10-08T15:00:00Z" },
      }),
      offer({ sourceId: "d", retailer: "D", price: 420 }),
    ]);
    expect(rows.map((r) => r.retailer)).toEqual(["B", "A", "D", "C"]);
  });

  it("prefers a store's in-stock offer over its cheaper out-of-stock colour", () => {
    const rows = storeRows([
      offer({
        ...CLD,
        price: 399,
        colour: "Red",
        availability: "out_of_stock",
        url: "https://www.canadaluggagedepot.ca/products/p?variant=1",
      }),
      offer({
        ...CLD,
        price: 434.95,
        colour: "Black",
        url: "https://www.canadaluggagedepot.ca/products/p?variant=2",
      }),
    ]);
    expect(rows[0].price).toBe(434.95);
    expect(rows[0].stock).toBe("in_stock");
    expect(rows[0].otherColours).toEqual(["Red"]);
  });
});

describe("headline price (R2.3, R2.6)", () => {
  it("leads with the verified price and its label", () => {
    const h = headlineFor(storeRows([offer({ ...CLD, price: 434.95 })]))!;
    expect(h.row.price).toBe(434.95);
    expect(h.confirmed).toBeNull();
    expect(freshnessLabel(h.row.offer.freshness, NOW)).toBe("Verified live · 9:02 a.m.");
  });

  it("shows both lines when a validated web estimate is lower than the lowest verified price", () => {
    const h = headlineFor(
      storeRows([
        offer({ ...CLD, price: 434.95 }),
        offer({
          sourceId: "amazon-ca",
          retailer: "Amazon.ca",
          price: 419.99,
          method: "web_estimate",
          freshness: { kind: "estimate", foundAt: "2026-10-10T15:01:00Z" },
          availability: "unknown",
        }),
      ]),
    )!;
    expect(h.row.retailer).toBe("Amazon.ca");
    expect(h.confirmed?.retailer).toBe("Canada Luggage Depot");
    expect(freshnessLabel(h.row.offer.freshness, NOW)).toBe(
      "Web estimate · found 9:01 a.m. · confirm on site",
    );
  });

  it("never leads with out of stock while something is in stock; says so when nothing is", () => {
    const some = headlineFor(
      storeRows([
        offer({ sourceId: "a", retailer: "A", price: 300, availability: "out_of_stock" }),
        offer({ sourceId: "b", retailer: "B", price: 350 }),
      ]),
    )!;
    expect(some.row.retailer).toBe("B");
    expect(some.allOutOfStock).toBe(false);
    const none = headlineFor(
      storeRows([
        offer({ sourceId: "a", retailer: "A", price: 300, availability: "out_of_stock" }),
      ]),
    )!;
    expect(none.allOutOfStock).toBe(true);
  });

  it("has no headline when only last-seen prices exist", () => {
    expect(
      headlineFor(
        storeRows([
          offer({
            ...CLD,
            price: 400,
            freshness: { kind: "stale", lastSeenAt: "2026-10-08T15:00:00Z" },
          }),
        ]),
      ),
    ).toBeNull();
  });
});

describe("product order and junk (R2.2, A2.2)", () => {
  it("sorts products by headline price and hides accessories unless asked for", () => {
    const products = groupOffers(
      [
        offer({
          ...CLD,
          price: 500,
          title: "Samsonite Paralux Spinner Medium",
          url: "https://www.canadaluggagedepot.ca/products/a",
        }),
        offer({
          sourceId: "delsey-ca",
          retailer: "Delsey.ca",
          brand: "Delsey",
          price: 300,
          title: "Delsey Chatelet Air 2.0 Medium",
          url: "https://www.delsey.ca/products/b",
        }),
        offer({
          ...CLD,
          price: 19.99,
          title: "Samsonite Luggage Tag",
          sizeClass: "accessory",
          url: "https://www.canadaluggagedepot.ca/products/c",
        }),
      ],
      luggagePack,
    );
    const views = productViews(products);
    expect(views.map((v) => v.headline?.row.price)).toEqual([300, 500]);
    expect(productViews(products, { wantsAccessory: true })).toHaveLength(3);
  });
});

describe("web estimates join the verified product (A2.1)", () => {
  const estimate = (
    o: Partial<AnswerOffer> & Pick<AnswerOffer, "sourceId" | "retailer" | "price">,
  ) =>
    offer({
      method: "web_estimate",
      freshness: { kind: "estimate", foundAt: "2026-10-10T15:01:00Z" },
      availability: "unknown",
      ...o,
    });

  it("puts estimates whose titles leave out an optional word in the store's product", () => {
    const products = groupOffers(
      [
        offer({
          ...CLD,
          price: 434.95,
          title: "Samsonite Paralux Hardside Expandable Spinner Medium",
          url: "https://www.canadaluggagedepot.ca/products/paralux-medium",
        }),
        estimate({
          sourceId: "amazon-ca",
          retailer: "Amazon.ca",
          price: 434.95,
          title: "Samsonite Paralux Hardside Spinner Medium",
          url: "https://www.amazon.ca/dp/B0PARALUX",
        }),
        estimate({
          sourceId: "luggagecity",
          retailer: "Luggage City",
          price: 374.95,
          title: "Samsonite Paralux Hardside Spinner Medium - Black",
          url: "https://www.luggagecity.ca/products/paralux-medium",
        }),
      ],
      luggagePack,
    );
    expect(products).toHaveLength(1);
    expect(products[0].lowestPrice).toBe(374.95);
    const rows = storeRows(products[0].offers);
    expect(rows.map((r) => r.retailer)).toEqual([
      "Luggage City",
      "Canada Luggage Depot",
      "Amazon.ca",
    ]);
    const h = headlineFor(rows)!;
    expect(h.row.retailer).toBe("Luggage City");
    expect(h.confirmed?.retailer).toBe("Canada Luggage Depot");
  });

  it("never joins a different size, and stays apart when two verified products fit", () => {
    const products = groupOffers(
      [
        offer({
          sourceId: "tumi-ca",
          retailer: "TUMI.ca",
          brand: "TUMI",
          price: 1095,
          sizeClass: "carry_on",
          title: "TUMI Alpha International Carry-On",
          url: "https://www.tumi.ca/p/intl",
        }),
        offer({
          sourceId: "tumi-ca",
          retailer: "TUMI.ca",
          brand: "TUMI",
          price: 1195,
          sizeClass: "carry_on",
          title: "TUMI Alpha International Expandable Carry-On",
          url: "https://www.tumi.ca/p/intl-exp",
        }),
        estimate({
          sourceId: "amazon-ca",
          retailer: "Amazon.ca",
          brand: "TUMI",
          price: 1050,
          sizeClass: "carry_on",
          title: "TUMI Alpha Carry-On",
          url: "https://www.amazon.ca/dp/B0ALPHA",
        }),
        offer({
          ...CLD,
          price: 434.95,
          title: "Samsonite Paralux Hardside Expandable Spinner Medium",
        }),
        estimate({
          sourceId: "samsonite-ca",
          retailer: "Samsonite.ca",
          price: 499.99,
          sizeClass: "large",
          title: "Samsonite Paralux Hardside Spinner Large",
          url: "https://www.samsonite.ca/paralux-large",
        }),
      ],
      luggagePack,
    );
    const byPrice = (price: number) =>
      products.find((p) => p.offers.some((o) => o.price === price))!;
    // TUMI's two verified pages stay two products; the estimate fits both, so joins neither.
    expect(byPrice(1095)).not.toBe(byPrice(1195));
    expect(byPrice(1050).offers).toHaveLength(1);
    // A Large estimate never joins the Medium.
    expect(byPrice(499.99)).not.toBe(byPrice(434.95));
    expect(byPrice(434.95).offers).toHaveLength(1);
  });
});

describe("labels (rule 5): nothing older than today looks like today's price", () => {
  it("uses the exact wording for every kind", () => {
    expect(freshnessLabel({ kind: "live", fetchedAt: TODAY_902 }, NOW)).toBe(
      "Verified live · 9:02 a.m.",
    );
    expect(freshnessLabel({ kind: "live", fetchedAt: "2026-10-08T15:02:00Z" }, NOW)).toBe(
      "Last seen · Oct 8",
    );
    expect(freshnessLabel({ kind: "manual", checkedAt: "2026-10-09T00:00:00Z" }, NOW)).toBe(
      "Staff-checked · Oct 9",
    );
    expect(freshnessLabel({ kind: "feed", asOf: "2026-10-01T00:00:00.000Z" }, NOW)).toBe(
      "Dealer list · as of Oct 1",
    );
    expect(freshnessLabel({ kind: "stale", lastSeenAt: "2026-10-08T15:02:00Z" }, NOW)).toBe(
      "Last seen · Oct 8",
    );
    expect(freshnessLabel({ kind: "estimate", foundAt: "2026-10-09T15:01:00Z" }, NOW)).toBe(
      "Last seen · Oct 9 (web estimate)",
    );
  });

  it("maps stock to three plain states", () => {
    expect(stockOf("in_stock")).toBe("in_stock");
    expect(stockOf("out_of_stock")).toBe("out_of_stock");
    expect(stockOf("backorder")).toBe("out_of_stock");
    expect(stockOf("preorder")).toBe("out_of_stock");
    expect(stockOf("unknown")).toBe("unknown");
    expect(stockOf(null)).toBe("unknown");
  });
});

describe("tracking never saves an estimate (R3.1)", () => {
  it("leaves estimates and last-seen prices out of what /api/track receives", () => {
    const product: AnswerProduct = {
      key: "samsonite-paralux-medium",
      productId: null,
      name: "Samsonite Paralux Spinner Medium",
      brand: "Samsonite",
      sizeClass: "medium",
      identifiers: [],
      imageUrl: null,
      lowestPrice: 419.99,
      offers: [
        offer({ ...CLD, price: 434.95 }),
        offer({
          sourceId: "amazon-ca",
          retailer: "Amazon.ca",
          price: 419.99,
          freshness: { kind: "estimate", foundAt: TODAY_902 },
        }),
        offer({
          sourceId: "x",
          retailer: "X",
          price: 400,
          freshness: { kind: "stale", lastSeenAt: TODAY_902 },
        }),
      ],
    };
    expect(trackableOffers(product).map((o) => o.retailer)).toEqual(["Canada Luggage Depot"]);
    expect(toSearchProduct(product)!.offers.map((o) => o.price)).toEqual([434.95]);
  });
});

describe("last-known prices (R2.5, A2.3)", () => {
  it("serves the engine's latest accepted prices, dated, and never an estimate", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const l = await store.upsertListing({
      sourceId: "canadaluggagedepot",
      url: "https://www.canadaluggagedepot.ca/products/samsonite-paralux-medium",
      externalId: null,
      title: "Samsonite Paralux Spinner Medium",
      brand: "Samsonite",
      sizeClass: "medium",
      colour: "Black",
      identifiers: [],
      imageUrl: null,
      discoveredVia: "sitemap",
      lastmod: null,
      active: true,
    });
    const base = {
      listingId: l.id,
      sourceId: "canadaluggagedepot",
      listPrice: null,
      currency: "CAD",
      availability: "in_stock" as const,
      seller: null,
      condition: null,
      validation: { outcome: "accepted" as const, confidence: 0.95, reasons: [] },
      evidence: {},
      extractorVersion: "t",
      validatorVersion: "t",
      asOf: null,
      sessionId: null,
    };
    await store.insertObservation({
      ...base,
      adapter: "shopify_product_json",
      price: 434.95,
      fetchedAt: "2026-10-08T15:02:00Z",
    });
    const products = await lastKnownFromEngine(
      store,
      luggagePack,
      SOURCE_SEED,
      "Samsonite Paralux Medium",
    );
    expect(products).toHaveLength(1);
    expect(products[0].offers[0].price).toBe(434.95);
    expect(products[0].offers[0].freshness).toEqual({
      kind: "stale",
      lastSeenAt: "2026-10-08T15:02:00Z",
    });
    expect(freshnessLabel(products[0].offers[0].freshness, NOW)).toBe("Last seen · Oct 8");

    await store.insertObservation({
      ...base,
      adapter: "web_estimate",
      price: 399,
      fetchedAt: "2026-10-09T15:02:00Z",
    });
    const after = await lastKnownFromEngine(
      store,
      luggagePack,
      SOURCE_SEED,
      "Samsonite Paralux Medium",
    );
    expect(after.flatMap((p) => p.offers).some((o) => o.price === 399)).toBe(false);
  });

  it("falls back to tracked products, matching the query and keeping each price's own date", () => {
    const tracked = [
      {
        id: "p1",
        name: "Paralux Spinner Medium",
        brand: "Samsonite",
        model: "Paralux",
        color: "Black",
        upc: null,
        imageUrl: null,
        offers: [
          {
            retailer: "Canada Luggage Depot",
            price: 434.95,
            inStock: true,
            url: "https://www.canadaluggagedepot.ca/products/x",
            title: null,
            lastCheckedAt: "2026-10-09T15:00:00Z",
          },
        ],
      },
      {
        id: "p2",
        name: "Omni 3.0 Large",
        brand: "Samsonite",
        model: "Omni",
        color: "",
        upc: null,
        imageUrl: null,
        offers: [],
      },
    ] as unknown as TrackedProduct[];
    const out = lastKnownFromTracked(tracked, "Samsonite Paralux Medium", luggagePack, SOURCE_SEED);
    expect(out).toHaveLength(1);
    expect(out[0].offers[0].sourceId).toBe("canadaluggagedepot");
    expect(out[0].offers[0].method).toBe("tracked_record");
    expect(freshnessLabel(out[0].offers[0].freshness, NOW)).toBe("Last seen · Oct 9");
  });
});
