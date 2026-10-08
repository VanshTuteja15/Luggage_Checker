/* ------------------------------------------------------------------ */
/*  Discovery / indexing (P5 check: indexing permitted stores produces  */
/*  listings). Real recorded sitemaps, stubbed network.                 */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  discoverSource,
  discoverViaTavily,
  parseSitemap,
  primaryLocale,
} from "@/lib/engine/discovery";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { fixture, instantLimiter } from "./helpers";

const INDEX = fixture("sitemap/canadaluggagedepot__sitemap.xml");
const PRODUCTS = fixture("sitemap/canadaluggagedepot__products_1.xml");
const OMNI_JSON = fixture(
  "shopify/canadaluggagedepot__samsonite-omni-3-0-large-spinner-expandable-luggage.product.json",
);

function runtimeWith(routes: Record<string, string>, configOverride: Record<string, unknown> = {}) {
  const store = new MemoryEngineStore(SOURCE_SEED);
  const hits: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    hits.push(url);
    if (url.endsWith("/robots.txt"))
      return new Response(
        "User-agent: *\nDisallow: /search\nSitemap: https://www.canadaluggagedepot.ca/sitemap.xml\n",
      );
    const body = routes[url];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  }) as typeof fetch;
  const rt = createRuntime(store, {
    fetchImpl,
    resolve: async () => ["23.227.38.65"],
    limiter: instantLimiter(),
  });
  rt.config = { ...rt.config, ...configOverride };
  return { store, rt, hits };
}

describe("sitemap parsing (recorded)", () => {
  it("reads Canada Luggage Depot's sitemap index and product sitemap", () => {
    const idx = parseSitemap(INDEX);
    expect(idx.kind).toBe("index");
    expect(idx.entries.some((e) => /sitemap_products_1\.xml\?from=/.test(e.loc))).toBe(true);
    expect(idx.entries.every((e) => !e.loc.includes("&amp;"))).toBe(true);
    const urls = parseSitemap(PRODUCTS);
    expect(urls.kind).toBe("urlset");
    expect(urls.entries.length).toBe(25);
    const focus = urls.entries.find((e) =>
      e.loc.endsWith("/products/samsonite-focus-iii-4-attache-case"),
    )!;
    expect(focus.title).toBe("Samsonite Focus III 4 inch Attache Case");
    expect(focus.lastmod).toMatch(/^2026-10-/);
  });
});

describe("discoverSource", () => {
  const productSitemap = parseSitemap(INDEX).entries.find((e) =>
    /sitemap_products_1/.test(e.loc),
  )!.loc;

  it("indexes a permitted store's product pages and enriches them within budget", async () => {
    const productUrls = parseSitemap(PRODUCTS)
      .entries.map((e) => e.loc)
      .filter((u) => u.includes("/products/"));
    const routes: Record<string, string> = {
      "https://www.canadaluggagedepot.ca/sitemap.xml": INDEX,
      [productSitemap]: PRODUCTS,
    };
    // Product JSON for the first two pages (the recorded Omni body stands in for both).
    for (const u of productUrls.slice(0, 2)) routes[`${u}.json`] = OMNI_JSON;
    const { store, rt, hits } = runtimeWith(routes);

    const r = await discoverSource(rt, luggagePack, "canadaluggagedepot", { maxFetches: 2 });
    expect(r.method).toBe("sitemap");
    expect(r.productUrls).toBe(24); // the homepage entry is not a product
    expect(r.newListings).toBe(24);
    expect(r.enriched).toBe(2);
    const counts = await store.countListingsBySource();
    expect(counts.canadaluggagedepot).toBeGreaterThanOrEqual(24);

    // Indexed from the sitemap's own titles: searchable with zero requests.
    // (The two enriched pages took the stand-in Omni title, so search one that wasn't enriched.)
    const found = await store.searchListings(
      luggagePack.parseQuery("JanSport Driver 8 Wheeled Backpack"),
      { limit: 10 },
    );
    expect(found.map((l) => l.title)).toContain("Jansport Driver 8 Wheeled Backpack - Navy");
    // Enriched variants carry identifiers and resolved products.
    const variants = (await store.listingsBySource("canadaluggagedepot", 500)).filter((l) =>
      l.url.includes("?variant="),
    );
    expect(variants.length).toBeGreaterThan(0);
    expect(variants.every((v) => v.identifiers.some((i) => i.kind === "gtin"))).toBe(true);
    expect(variants.every((v) => v.productId !== null)).toBe(true);
    // Only product sitemaps were read; other child sitemaps (agentic, pages, collections) were not.
    expect(
      hits.some((u) => /sitemap_agentic_discovery|sitemap_pages|sitemap_collections/.test(u)),
    ).toBe(false);

    // Incremental: a second run finds nothing new and enriches the next stalest pages.
    const again = await discoverSource(rt, luggagePack, "canadaluggagedepot", { maxFetches: 2 });
    expect(again.newListings).toBe(0);
  });

  it("does not crawl stores whose terms only allow their agent channel, or forbid access", async () => {
    const { rt, hits } = runtimeWith({});
    const travelpro = await discoverSource(rt, luggagePack, "travelpro-ca");
    expect(travelpro.method).toBe("skipped");
    expect(travelpro.skippedReason).toMatch(/agent profile/);
    const amazon = await discoverSource(rt, luggagePack, "amazon-ca");
    expect(amazon.method).toBe("skipped");
    const samsonite = await discoverSource(rt, luggagePack, "samsonite-ca");
    expect(samsonite.method).toBe("skipped");
    expect(hits).toEqual([]);
  });

  it("uses UCP catalog search for agent-channel stores once the profile exists", async () => {
    const product = {
      id: "gid://shopify/Product/42",
      title: 'Platinum Elite 25" Expandable Spinner',
      vendor: "Travelpro",
      handle: "platinum-elite-25-expandable-spinner",
      variants: [
        {
          id: "gid://shopify/ProductVariant/1",
          sku: "4091865-01",
          barcodes: [{ value: "054012000001" }],
          price: { amount: 52999, currency: "CAD" },
          availability: { available: true },
          options: [{ label: "Shadow Black" }],
        },
      ],
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { structuredContent: { products: [product] } },
    });
    const { store, rt } = runtimeWith(
      { "https://canadatravelpro.myshopify.com/api/ucp/mcp": body },
      { ucpAgentProfileUrl: "https://example.org/.well-known/ucp-agent" },
    );
    const r = await discoverSource(rt, luggagePack, "travelpro-ca", { maxFetches: 1 });
    expect(r.method).toBe("ucp");
    expect(r.newListings).toBe(1);
    const [l] = await store.listingsBySource("travelpro-ca", 10);
    expect(l.url).toBe("https://travelpro.ca/products/platinum-elite-25-expandable-spinner");
    expect(l.discoveredVia).toBe("ucp");
  });

  it("Tavily discovery stays off unless its flag is on", async () => {
    const { rt, hits } = runtimeWith({});
    expect(await discoverViaTavily(rt, luggagePack, luggagePack.parseQuery("Samsonite Omni"))).toBe(
      0,
    );
    expect(hits).toEqual([]);
  });
});

describe("brand-direct stores", () => {
  it("fill in their own brand when titles leave it out, so brand queries find them", async () => {
    // Shape of Delsey.ca's product sitemap: titles start with the collection, not "Delsey".
    const urlset = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>https://delsey.ca/products/40167681906-chatelet-air-2-0-26-inch-check-in-suitcase-brown</loc>
<image:image><image:loc>https://cdn.shopify.com/a.jpg</image:loc><image:title>CHATELET AIR 2.0 | 26-Inch Check-In Suitcase, Brown</image:title></image:image></url>
<url><loc>https://delsey.ca/products/samsonite-style-tag</loc>
<image:image><image:loc>https://cdn.shopify.com/b.jpg</image:loc><image:title>Samsonite Luggage Tag</image:title></image:image></url>
</urlset>`;
    const { store, rt } = runtimeWith({ "https://delsey.ca/sitemap.xml": urlset });
    const r = await discoverSource(rt, luggagePack, "delsey-ca", { maxFetches: 0 });
    expect(r.newListings).toBe(2);
    const listings = await store.listingsBySource("delsey-ca", 10);
    const brandOf = (frag: string) => listings.find((l) => l.url.includes(frag))!.brand;
    expect(brandOf("chatelet")).toBe("Delsey");
    // A brand named in the title still wins over the store's own brand.
    expect(brandOf("samsonite-style-tag")).toBe("Samsonite");
    const found = await store.searchListings(
      luggagePack.parseQuery("Delsey Chatelet Air 2.0 Medium"),
      { limit: 10 },
    );
    expect(found.map((l) => l.title)).toEqual([
      "CHATELET AIR 2.0 | 26-Inch Check-In Suitcase, Brown",
    ]);
  });
});

describe("size preference in search", () => {
  it("drops a store's unknown-size listings once it has exact-size matches", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const add = (sourceId: string, url: string, title: string) =>
      store.upsertListing({
        sourceId,
        url,
        externalId: null,
        title,
        brand: "Delsey",
        sizeClass: luggagePack.sizeClassOf(title),
        colour: null,
        identifiers: [],
        imageUrl: null,
        discoveredVia: "sitemap",
        lastmod: null,
        active: true,
      });
    await add(
      "delsey-ca",
      "https://delsey.ca/products/a",
      "Chatelet Air 2.0 26-Inch Check-In Suitcase",
    );
    await add("delsey-ca", "https://delsey.ca/products/b", "Chatelet Air 2.0 Laptop Shoulder Bag");
    await add(
      "canadaluggagedepot",
      "https://www.canadaluggagedepot.ca/products/c",
      "Delsey Chatelet Air 2.0 Spinner",
    );
    const found = await store.searchListings(
      luggagePack.parseQuery("Delsey Chatelet Air 2.0 Medium"),
      {
        limit: 10,
      },
    );
    // Delsey.ca has a medium, so its laptop bag goes; CLD has no sized title, so it stays.
    expect(found.map((l) => l.url).sort()).toEqual([
      "https://delsey.ca/products/a",
      "https://www.canadaluggagedepot.ca/products/c",
    ]);
  });
});

describe("one language per product page", () => {
  const id = (u: string) => u;
  it("drops /fr/ copies when the store has unprefixed pages", () => {
    const urls = [
      "https://www.canadaluggagedepot.ca/products/omni",
      "https://www.canadaluggagedepot.ca/fr/products/omni",
      "https://www.canadaluggagedepot.ca/fr/products/valise-traduite",
      "https://www.canadaluggagedepot.ca/products/focus",
    ];
    expect(primaryLocale(urls, id, null)).toEqual([
      "https://www.canadaluggagedepot.ca/products/omni",
      "https://www.canadaluggagedepot.ca/products/focus",
    ]);
  });
  it("keeps the market prefix (Away /en-ca) and drops other locales", () => {
    const urls = [
      "https://www.awaytravel.com/en-ca/products/a",
      "https://www.awaytravel.com/fr-ca/products/a",
    ];
    expect(primaryLocale(urls, id, "/en-ca")).toEqual([
      "https://www.awaytravel.com/en-ca/products/a",
    ]);
  });
  it("keeps one page per product, English first, when every page is prefixed", () => {
    const urls = [
      "https://www.bentley.ca/fr/products/x",
      "https://www.bentley.ca/en/products/x",
      "https://www.bentley.ca/fr/products/only-fr",
    ];
    expect(primaryLocale(urls, id, null).sort()).toEqual([
      "https://www.bentley.ca/en/products/x",
      "https://www.bentley.ca/fr/products/only-fr",
    ]);
  });
});

describe("sitemap text", () => {
  it("decodes named and numeric entities once (Delsey's ALU&apos;R)", () => {
    const xml = `<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"><url><loc>https://delsey.ca/products/alu-r?a=1&amp;b=2</loc>
<image:image><image:title>ALU&apos;R | 19-Inch Valise &#xE0; &amp;lt;b&amp;gt; &#8217;</image:title></image:image></url></urlset>`;
    const [e] = parseSitemap(xml).entries;
    expect(e.loc).toBe("https://delsey.ca/products/alu-r?a=1&b=2");
    expect(e.title).toBe("ALU'R | 19-Inch Valise à &lt;b&gt; ’");
  });
});
