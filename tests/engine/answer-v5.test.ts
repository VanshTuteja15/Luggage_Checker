/* ------------------------------------------------------------------ */
/*  v5 F2.3–F2.5: ranking, the answer sentence, suggestions            */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { luggagePack as pack } from "@/lib/engine/packs/luggage";
import { rankForQuery } from "@/lib/engine/research/rank";
import { productViews } from "@/lib/engine/research/rows";
import { buildSuggestions } from "@/lib/engine/research/suggest";
import { summariseAnswer } from "@/lib/engine/research/summary";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { EXTRACTOR_VERSION, VALIDATOR_VERSION } from "@/lib/engine/store/port";
import type { AnswerOffer, AnswerProduct, Freshness } from "@/lib/engine/types";
import { formatDay, formatTime } from "@/lib/time/local";

const NOW = new Date("2026-11-23T16:30:00.000Z"); // 9:30 a.m. in Calgary
const TODAY = "2026-11-23T16:02:00.000Z"; // 9:02 a.m.
const live: Freshness = { kind: "live", fetchedAt: TODAY };
const estimate: Freshness = { kind: "estimate", foundAt: "2026-11-23T16:01:00.000Z" };

function offer(over: Partial<AnswerOffer>): AnswerOffer {
  return {
    sourceId: "canadaluggagedepot",
    retailer: "Canada Luggage Depot",
    url: "https://www.canadaluggagedepot.ca/products/x",
    title: "Samsonite Paralux Hardside Expandable Spinner Medium",
    brand: "Samsonite",
    sizeClass: "medium",
    identifiers: [],
    imageUrl: null,
    reasons: [],
    price: 434.95,
    listPrice: null,
    currency: "CAD",
    availability: "in_stock",
    colour: null,
    freshness: live,
    confidence: 0.9,
    lowConfidence: false,
    method: "shopify_product_json",
    observationId: null,
    listingId: null,
    productId: null,
    evidence: null,
    ...over,
  };
}

function product(
  key: string,
  offers: AnswerOffer[],
  over: Partial<AnswerProduct> = {},
): AnswerProduct {
  return {
    key,
    productId: null,
    name: offers[0].title,
    brand: offers[0].brand,
    sizeClass: offers[0].sizeClass,
    identifiers: [],
    imageUrl: null,
    offers,
    lowestPrice: Math.min(...offers.map((o) => o.price)),
    ...over,
  };
}

const est = (over: Partial<AnswerOffer>) =>
  offer({ freshness: estimate, method: "web_estimate", availability: "unknown", ...over });

describe("F2.3 ranking: constraints, then stock, then price, then freshness", () => {
  const q = pack.parseQuery("medium spinner under $300");
  const upright = product("u", [
    offer({ title: "Travelpro Maxlite 5 Medium Upright", brand: "Travelpro", price: 199 }),
  ]);
  const cheapSpinner = product("s1", [
    offer({ title: "Delsey Helium Medium Spinner", brand: "Delsey", price: 249 }),
  ]);
  const dearSpinner = product("s2", [offer({ title: "Samsonite Omni Medium Spinner", price: 399 })]);
  const oosSpinner = product("s3", [
    offer({
      title: "Heys Medium Spinner",
      brand: "Heys",
      price: 129,
      availability: "out_of_stock",
    }),
  ]);

  it("a product that misses part of the search never ranks above a full match", () => {
    const ranked = rankForQuery([upright, dearSpinner, oosSpinner, cheapSpinner], q, pack);
    expect(ranked.map((p) => p.key)).toEqual(["s1", "s3", "u", "s2"]);
    expect(ranked.find((p) => p.key === "u")!.fails).toEqual(["not a spinner"]);
    expect(ranked.find((p) => p.key === "s2")!.fails).toEqual(["over $300"]);
    // The page uses the same order.
    expect(productViews(ranked).map((v) => v.product.key)).toEqual(["s1", "s3", "u", "s2"]);
  });

  it("a product is only held to what it states (no word for the type: no failure)", () => {
    const silent = product("x", [
      offer({ title: "Delsey Helium Medium", brand: "Delsey", price: 180 }),
    ]);
    expect(rankForQuery([silent], q, pack)[0].fails).toEqual([]);
  });

  it("at the same price, a verified price ranks above a web estimate", () => {
    const e = product("e", [
      est({ title: "Delsey Helium Medium Spinner", brand: "Delsey", price: 249 }),
    ]);
    expect(rankForQuery([e, cheapSpinner], q, pack).map((p) => p.key)).toEqual(["s1", "e"]);
  });

  it('"in stock" makes an out-of-stock product a miss', () => {
    const ranked = rankForQuery(
      [oosSpinner, cheapSpinner],
      pack.parseQuery("medium spinner in stock"),
      pack,
    );
    expect(ranked.map((p) => [p.key, p.fails])).toEqual([
      ["s1", []],
      ["s3", ["out of stock"]],
    ]);
  });
});

describe("F2.4 the answer on top uses only numbers from the offers", () => {
  const paralux = product("p", [
    offer({ price: 434.95 }),
    est({
      sourceId: "amazon-ca",
      retailer: "Amazon.ca",
      url: "https://www.amazon.ca/dp/B0X",
      price: 419.99,
    }),
    est({
      sourceId: "unluggage",
      retailer: "U.N. Luggage",
      url: "https://unluggage.com/products/x",
      price: 520,
      availability: "out_of_stock",
    }),
  ]);

  /** Every $ amount, clock time, date and count in the text, checked against the offers. */
  function expectTraceable(sentences: string[], products: AnswerProduct[]) {
    const text = sentences.join(" ");
    const offers = products.flatMap((p) => p.offers);
    const prices = new Set(offers.map((o) => o.price.toFixed(2)));
    for (const m of text.matchAll(/\$([\d,]+\.\d{2})/g))
      expect(prices, `${m[0]} in "${text}"`).toContain(m[1].replace(/,/g, ""));
    const instants = offers
      .map((o) =>
        o.freshness.kind === "live"
          ? o.freshness.fetchedAt
          : o.freshness.kind === "estimate"
            ? o.freshness.foundAt
            : null,
      )
      .filter((x): x is string => !!x);
    const times = new Set(instants.map((i) => formatTime(i)));
    for (const m of text.matchAll(/\b\d{1,2}:\d{2} [ap]\.m\./g)) expect(times).toContain(m[0]);
    const days = new Set(instants.map((i) => formatDay(i)));
    const DAY = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/g;
    for (const m of text.matchAll(DAY)) expect(days).toContain(m[0]);
    // What's left are store counts: never more than the stores on the products.
    const stores = new Set(offers.map((o) => o.sourceId)).size;
    const bare = text
      .replace(/\$[\d,]+\.\d{2}/g, "")
      .replace(/\b\d{1,2}:\d{2} [ap]\.m\./g, "")
      .replace(DAY, "");
    for (const m of bare.matchAll(/\b\d+\b/g)) expect(Number(m[0])).toBeLessThanOrEqual(stores);
  }

  it("cheapest first with its label, the lowest verified price when an estimate leads, the caution", () => {
    const s = summariseAnswer([paralux], { now: NOW });
    expect(s[0]).toBe("Cheapest: $419.99 at Amazon.ca (web estimate).");
    expect(s[1]).toBe("Lowest verified: $434.95 at Canada Luggage Depot (verified 9:02 a.m.).");
    expect(s[2]).toBe("The cheapest price is a web estimate: confirm it on the store's site.");
    expect(s).toHaveLength(4);
    expectTraceable(s, [paralux]);
  });

  it("speaks about the product the page shows first, and says when nothing matched every part", () => {
    const ranked = rankForQuery(
      [paralux],
      pack.parseQuery("samsonite paralux medium under $300"),
      pack,
    );
    const s = summariseAnswer(ranked, { now: NOW });
    expect(s[0]).toBe("Nothing matched every part of your search; the closest result is below.");
    expectTraceable(s, ranked);
  });

  it("a range when more than three stores have a price; nothing invented when there are none", () => {
    const many = product("m", [
      offer({ price: 300 }),
      est({ sourceId: "amazon-ca", retailer: "Amazon.ca", price: 310 }),
      est({ sourceId: "walmart-ca", retailer: "Walmart.ca", price: 320 }),
      est({ sourceId: "bestbuy-ca", retailer: "Best Buy", price: 330 }),
    ]);
    const s = summariseAnswer([many], { now: NOW });
    expect(s).toContain("Prices at 4 stores range from $300.00 to $330.00.");
    expectTraceable(s, [many]);
    expect(summariseAnswer([], { now: NOW })).toEqual([]);
    const lastSeen = product("l", [
      offer({ freshness: { kind: "stale", lastSeenAt: "2026-11-20T16:00:00Z" } }),
    ]);
    expect(summariseAnswer([lastSeen], { now: NOW }).join(" ")).not.toMatch(/\d/);
  });
});

describe("F2.5 suggestions come from our index, with real prices and their labels", () => {
  async function seed() {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const make = async (
      name: string,
      size: string,
      price: number,
      opts: { adapter?: "web_estimate"; when?: string } = {},
    ) => {
      const p = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: "paralux",
        name,
        sizeClass: size,
        identityKey: `samsonite|paralux|${size}|${name}`,
        attributes: {},
      });
      const l = await store.upsertListing({
        sourceId: "canadaluggagedepot",
        url: `https://www.canadaluggagedepot.ca/products/${encodeURIComponent(name)}`,
        externalId: null,
        title: name,
        brand: "Samsonite",
        sizeClass: size,
        colour: null,
        identifiers: [],
        imageUrl: null,
        discoveredVia: "catalog",
        lastmod: null,
        active: true,
      });
      await store.linkListing(l.id, p.id, null);
      await store.insertObservation({
        listingId: l.id,
        sourceId: "canadaluggagedepot",
        adapter: opts.adapter ?? "shopify_product_json",
        price,
        listPrice: null,
        currency: "CAD",
        availability: "in_stock",
        seller: null,
        condition: null,
        validation: { outcome: "accepted", confidence: 0.9, reasons: [] },
        evidence: {},
        extractorVersion: EXTRACTOR_VERSION,
        validatorVersion: VALIDATOR_VERSION,
        fetchedAt: opts.when ?? TODAY,
        asOf: null,
        sessionId: null,
      });
      return p;
    };
    const medium = await make("Samsonite Paralux Spinner Medium", "medium", 434.95);
    await make("Samsonite Paralux Spinner Large", "large", 489.95, {
      when: "2026-11-20T16:00:00.000Z",
    });
    await make("Samsonite Paralux Spinner Carry-On", "carry_on", 349.95);
    // An upright is not an alternative to a spinner.
    await make("Samsonite Paralux Upright Medium", "medium", 299.95);
    await make("Samsonite Paralux Spinner Medium Lite", "medium", 399.95);
    // A web estimate is never a suggestion's price.
    await make("Samsonite Paralux Spinner Medium Deal", "medium", 199, { adapter: "web_estimate" });
    return { store, medium };
  }

  it("other sizes of the line, cheaper alternatives of the same size and type, colours", async () => {
    const { store, medium } = await seed();
    const title = "Samsonite Paralux Spinner Medium";
    const answer = [
      product(
        "p",
        [
          offer({ productId: medium.id, title, colour: "Black" }),
          offer({ productId: medium.id, title, colour: "Stone Grey" }),
        ],
        { productId: medium.id },
      ),
    ];
    const s = await buildSuggestions(store, pack, answer, pack.parseQuery("Samsonite Paralux Medium"), {
      now: NOW,
      retailerOf: () => "Canada Luggage Depot",
    });
    expect(s.otherSizes.map((x) => [x.sizeClass, x.price, x.label])).toEqual([
      ["carry_on", 349.95, "Verified live · 9:02 a.m."],
      ["large", 489.95, `Last seen · ${formatDay("2026-11-20T16:00:00.000Z")}`],
    ]);
    expect(s.cheaper.map((x) => [x.name, x.price, x.saving])).toEqual([
      ["Samsonite Paralux Spinner Medium Lite", 399.95, 35],
    ]);
    expect(s.colours).toEqual(["Black", "Stone Grey"]);
    expect(s.didYouMean).toBeNull();
  });

  it('carries "Did you mean" from the parser, even with nothing found', async () => {
    const { store } = await seed();
    const s = await buildSuggestions(store, pack, [], pack.parseQuery("samsonte paralux"), {
      now: NOW,
      retailerOf: (id) => id,
    });
    expect(s).toEqual({
      otherSizes: [],
      cheaper: [],
      colours: [],
      didYouMean: "samsonite paralux",
    });
  });
});
