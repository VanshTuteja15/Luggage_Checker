/* ------------------------------------------------------------------ */
/*  Catalogue reads + event storage (v4 A3). Recorded CLD /products.json */
/*  page (reduced to 40 products, objects unchanged), stubbed network.   */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { parseShopifyCatalogPage, readCatalog } from "@/lib/engine/adapters/shopify-catalog";
import { discoverSource } from "@/lib/engine/discovery";
import { factsForUrls } from "@/lib/engine/facts";
import { observeOffer } from "@/lib/engine/observe";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { instantLimiter, makeCtx, source, stubNet, type StubResponse } from "./helpers";

const PAGE = readFileSync("scripts/bench/fixtures/canadaluggagedepot__products_p1.json", "utf8");
const BASE = "https://www.canadaluggagedepot.ca";
const products = (
  JSON.parse(PAGE) as { products: { handle: string; variants: { id: number; price: string }[] }[] }
).products;

/** The canary's per-product pages, built from the same products' recorded variant prices. */
function ownPages(currency = "CAD", priceShift = 0): Record<string, StubResponse> {
  return Object.fromEntries(
    products.slice(0, 2).map((p) => [
      `${BASE}/products/${p.handle}.json`,
      {
        body: JSON.stringify({
          product: {
            variants: p.variants.map((v) => ({
              id: v.id,
              price: (Number(v.price) + priceShift).toFixed(2),
              price_currency: currency,
            })),
          },
        }),
      },
    ]),
  );
}

const pageUrl = (n: number) => `${BASE}/products.json?limit=250&page=${n}`;

describe("Shopify catalogue reads (U-CAT)", () => {
  it("parses a real page: SKU, compare-at and stock per variant; no barcode or currency in the feed", () => {
    const parsed = parseShopifyCatalogPage(PAGE)!;
    expect(parsed).toHaveLength(40);
    const variants = parsed.flatMap((p) => p.variants);
    expect(variants.every((v) => v.barcode === null && v.currency === null)).toBe(true);
    expect(variants.every((v) => typeof v.available === "boolean")).toBe(true);
    expect(variants.filter((v) => v.sku).length).toBe(variants.length);
    expect(parseShopifyCatalogPage("<html>")).toBeNull();
  });

  it("pages until the first empty page, after a currency canary on two products", async () => {
    const { fetchImpl, seen } = stubNet({
      [pageUrl(1)]: { body: PAGE },
      [pageUrl(2)]: { body: '{"products":[]}' },
      ...ownPages(),
    });
    const r = await readCatalog(makeCtx("canadaluggagedepot", fetchImpl));
    expect(r).toMatchObject({ status: "ok", pages: 1, requests: 4 });
    expect(r.products).toHaveLength(40);
    expect(r.products[0].offers.every((o) => o.currency === null && o.pageType === "api")).toBe(
      true,
    );
    const order = seen.map((s) => s.url).filter((u) => !u.endsWith("robots.txt"));
    expect(order[0]).toBe(pageUrl(1));
    expect(order.slice(1, 3).every((u) => /\/products\/[^/]+\.json$/.test(u))).toBe(true);
    expect(order[3]).toBe(pageUrl(2));
  });

  it("stops and uses nothing when a product's own page isn't CAD or disagrees", async () => {
    for (const pages of [ownPages("USD"), ownPages("CAD", 10)]) {
      const { fetchImpl } = stubNet({
        [pageUrl(1)]: { body: PAGE },
        [pageUrl(2)]: { body: '{"products":[]}' },
        ...pages,
      });
      const r = await readCatalog(makeCtx("canadaluggagedepot", fetchImpl));
      expect(r.status).toBe("garbage");
      expect(r.products).toHaveLength(0);
      expect(r.reason).toMatch(/not CAD|own page says/);
    }
  });

  it("a block on a later page stops the run and keeps what was read", async () => {
    const { fetchImpl } = stubNet({
      [pageUrl(1)]: { body: PAGE },
      [pageUrl(2)]: {
        status: 403,
        body: "<title>Just a moment...</title>",
        headers: { "cf-mitigated": "challenge" },
      },
      ...ownPages(),
    });
    const r = await readCatalog(makeCtx("canadaluggagedepot", fetchImpl));
    expect(r.status).toBe("blocked");
    expect(r.products).toHaveLength(40);
  });
});

describe("event storage (U-OBS)", () => {
  it("stores an observation only when price, list price or stock changes", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const src = source("canadaluggagedepot");
    const { fetchImpl } = stubNet({
      [pageUrl(1)]: { body: PAGE },
      [pageUrl(2)]: { body: '{"products":[]}' },
      ...ownPages(),
    });
    const offer = (await readCatalog(makeCtx("canadaluggagedepot", fetchImpl))).products[0]
      .offers[0];
    const opts = {
      sessionId: null,
      discoveredVia: "catalog" as const,
      persist: true,
      onlyOnChange: true,
    };
    expect((await observeOffer(store, luggagePack, src, offer, opts)).stored).toBe("observation");
    const later = {
      ...offer,
      fetchedAt: new Date(Date.parse(offer.fetchedAt) + 3_600_000).toISOString(),
    };
    const repeat = await observeOffer(store, luggagePack, src, later, opts);
    expect(repeat.stored).toBe("range");
    expect(await store.priceRanges(repeat.listing.id, 5)).toMatchObject([{ observationCount: 2 }]);
    const cheaper = {
      ...later,
      price: (offer.price ?? 100) - 10,
      fetchedAt: new Date(Date.parse(later.fetchedAt) + 3_600_000).toISOString(),
    };
    expect((await observeOffer(store, luggagePack, src, cheaper, opts)).stored).toBe("observation");
    // Research sessions keep storing every reading (default).
    expect(
      (await observeOffer(store, luggagePack, src, later, { ...opts, onlyOnChange: false })).stored,
    ).toBe("observation");
  });
});

describe("discovery through the catalogue (I-CAT-1)", () => {
  afterEach(() => {
    delete process.env.ENGINE_FLAGS;
  });

  it("indexes the store, and a second identical run stores no new observations", async () => {
    process.env.ENGINE_FLAGS = "source.canadaluggagedepot.catalog=on";
    const { fetchImpl } = stubNet({
      [pageUrl(1)]: { body: PAGE },
      [pageUrl(2)]: { body: '{"products":[]}' },
      ...ownPages(),
    });
    const rt = createRuntime(new MemoryEngineStore(SOURCE_SEED), {
      fetchImpl,
      resolve: async () => ["23.227.38.65"],
      limiter: instantLimiter(),
    });
    const first = await discoverSource(rt, luggagePack, "canadaluggagedepot", { maxFetches: 0 });
    expect(first).toMatchObject({ method: "catalog", productUrls: 40, newListings: 40 });
    expect(first.observationsStored).toBeGreaterThan(0);
    // The page's 2 variants with a compare-at above the price (A4.2).
    expect(first.promotions).toBe(2);
    const second = await discoverSource(rt, luggagePack, "canadaluggagedepot", { maxFetches: 0 });
    expect(second.newListings).toBe(0);
    expect(second.observationsStored).toBe(0);
    expect(second.rangesExtended).toBe(first.observationsStored);
    // Repeats extend the same 2 rows, which stay current.
    const current = await rt.store.currentPromotions({ at: new Date().toISOString(), limit: 50 });
    expect(current).toHaveLength(2);
    expect(current.every((p) => p.method === "compare_at" && p.salePrice! < p.wasPrice!)).toBe(
      true,
    );

    // A4.1: spec text of single-size products lands on their variants, with evidence.
    const listings = await rt.store.listingsBySource("canadaluggagedepot", 500);
    const productIds = [
      ...new Set(listings.map((l) => l.productId).filter((x): x is string => !!x)),
    ];
    const variants = (
      await Promise.all(productIds.map((id) => rt.store.variantsForProduct(id)))
    ).flat();
    const withSpecs = variants.filter((v) => Object.keys(v.attributes).length > 0);
    expect(withSpecs.length).toBeGreaterThan(0);
    for (const v of withSpecs)
      for (const a of Object.values(v.attributes) as {
        method: string;
        evidence: string;
        sourceId: string;
      }[])
        expect(a).toMatchObject({
          method: "rules",
          sourceId: "canadaluggagedepot",
          evidence: expect.any(String),
        });

    // What the product page asks for: facts by store page URL (index only).
    const onSale = listings.find((l) => l.id === current[0].listingId)!;
    const withAttrs = listings.find((l) => withSpecs.some((v) => v.id === l.variantId))!;
    const facts = await factsForUrls(rt.store, await rt.sources(), [
      onSale.url,
      withAttrs.url,
      "https://www.canadaluggagedepot.ca/products/not-indexed",
      "https://example.com/x",
    ]);
    expect(facts[0].promotions).toMatchObject([{ kind: "sale_price", method: "compare_at" }]);
    expect(Object.keys(facts[1].attributes).length).toBeGreaterThan(0);
    expect(facts[2]).toMatchObject({
      sourceId: "canadaluggagedepot",
      listingId: null,
      promotions: [],
    });
    expect(facts[3]).toMatchObject({ sourceId: null, promotions: [], attributes: {} });
    // Off by default: the same store goes through its sitemaps as before.
    delete process.env.ENGINE_FLAGS;
    rt.invalidate();
    expect(
      (await discoverSource(rt, luggagePack, "canadaluggagedepot", { maxFetches: 0 })).method,
    ).toBe("sitemap");
  });
});
