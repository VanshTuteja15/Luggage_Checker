/* ------------------------------------------------------------------ */
/*  Adapter fixture tests: prices, sale prices, variants, currency,    */
/*  availability, and block / 404 / garbage, per adapter. Recorded     */
/*  real responses where the channel can be read today; doc-shaped     */
/*  responses with real values where it needs a human action first     */
/*  (see scripts/fixtures/README.md).                                  */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { ADAPTERS } from "@/lib/engine/adapters";
import { signPaapi } from "@/lib/engine/adapters/amazon-creators";
import { resetEbayTokens } from "@/lib/engine/adapters/ebay-browse";
import { parseCsv, parseFeed } from "@/lib/engine/adapters/feed-import";
import { manualOffer } from "@/lib/engine/adapters/manual-entry";
import { luggagePack } from "@/lib/engine/packs/luggage";
import type { RawOffer } from "@/lib/engine/types";
import { validateOffer } from "@/lib/engine/validate";
import { fixture, makeCtx, probeShopifyBodies, source, stubNet } from "./helpers";

const CLD_HANDLE = "samsonite-omni-3-0-large-spinner-expandable-luggage";
const CLD = `https://www.canadaluggagedepot.ca/products/${CLD_HANDLE}`;
const DELSEY_HANDLE = "40119980500us-wagram-23-inch-expandable-carry-on-suitcase-black";
const DELSEY = `https://delsey.ca/products/${DELSEY_HANDLE}`;
const CLD_FILE = `canadaluggagedepot__${CLD_HANDLE.slice(0, 60)}`;
const DELSEY_FILE = `delsey-ca__${DELSEY_HANDLE.slice(0, 60)}`;

const listing = (
  url: string,
  extra: Partial<{ externalId: string | null; title: string }> = {},
) => ({
  url,
  externalId: extra.externalId ?? null,
  identifiers: [],
  title: extra.title ?? "",
  brand: null,
});

const ids = (o: RawOffer, kind: string) =>
  o.identifiers.filter((i) => i.kind === kind).map((i) => i.value);

/* ── shopify_product_json ─────────────────────────────────────────── */

describe("shopify_product_json (recorded)", () => {
  it("Canada Luggage Depot: 4 colour variants, sale price, CAD, stock from .json — one request", async () => {
    const net = stubNet({
      [`${CLD}.json`]: {
        body: fixture(`shopify/${CLD_FILE}.product.json`),
        headers: { "content-type": "application/json" },
      },
    });
    const ctx = makeCtx("canadaluggagedepot", net.fetchImpl);
    const r = await ADAPTERS.shopify_product_json.verify(ctx, listing(CLD));
    expect(r.status).toBe("ok");
    expect(r.offers).toHaveLength(4);
    const blue = r.offers.find((o) => o.colour === "Blue")!;
    expect(blue.price).toBe(279.99);
    expect(blue.listPrice).toBe(440);
    expect(blue.currency).toBe("CAD");
    expect(blue.availability).toBe("in_stock");
    expect(r.offers.find((o) => o.colour === "Black")!.availability).toBe("out_of_stock");
    expect(blue.url).toBe(`${CLD}?variant=42742339010736`);
    expect(ids(blue, "gtin")).toEqual(["00043202917998"]);
    expect(ids(blue, "store_sku")).toEqual(["135955-1247"]);
    expect(ids(blue, "model")).toEqual(["samsonite:135955"]);
    expect(ids(blue, "mpn")).toEqual(["samsonite:135955-1247"]);
    expect(blue.brand).toBe("Samsonite");
    expect(net.seen.filter((s) => !s.url.endsWith("robots.txt")).map((s) => s.url)).toEqual([
      `${CLD}.json`,
    ]);
    for (const o of r.offers)
      expect(
        validateOffer(o, { source: ctx.source, pack: luggagePack, now: ctx.now() }).outcome,
      ).toBe("accepted");
  });

  it("Delsey: single variant, availability needs .js (out of stock), sale price 335 vs 478", async () => {
    const net = stubNet({
      [`${DELSEY}.json`]: { body: fixture(`shopify/${DELSEY_FILE}.product.json`) },
      [`${DELSEY}.js`]: { body: fixture(`shopify/${DELSEY_FILE}.product.js.json`) },
    });
    const ctx = makeCtx("delsey-ca", net.fetchImpl);
    const r = await ADAPTERS.shopify_product_json.verify(ctx, listing(DELSEY));
    expect(r.status).toBe("ok");
    expect(r.offers).toHaveLength(1);
    const o = r.offers[0];
    expect([o.price, o.listPrice, o.currency, o.availability]).toEqual([
      335,
      478,
      "CAD",
      "out_of_stock",
    ]);
    expect(o.url).toBe(DELSEY);
    expect(o.brand).toBe("Delsey");
    expect(ids(o, "gtin")).toEqual(["00098376088166"]);
    expect(ids(o, "model")).toEqual(["delsey:401199805"]);
    expect(o.evidence.availabilityFrom).toBe(`${DELSEY}.js`);
  });

  it("U.N. Luggage (probe values): Samsonite model from '137394-Black' SKUs", async () => {
    const handle = "samsonite-outline-pro-medium-spinner";
    const url = `https://unluggage.com/products/${handle}`;
    const bodies = probeShopifyBodies("unluggage", handle);
    const net = stubNet({
      [`${url}.json`]: { body: bodies.json },
      [`${url}.js`]: { body: bodies.js },
    });
    const r = await ADAPTERS.shopify_product_json.verify(
      makeCtx("unluggage", net.fetchImpl),
      listing(url),
    );
    expect(r.status).toBe("ok");
    expect(r.offers.map((o) => o.price)).toEqual([324.95, 324.95, 324.95, 324.95]);
    expect(r.offers.every((o) => o.listPrice === 405)).toBe(true);
    expect(new Set(r.offers.flatMap((o) => ids(o, "model")))).toEqual(
      new Set(["samsonite:137394"]),
    );
    expect(r.offers.find((o) => ids(o, "gtin")[0] === "00043202927614")!.availability).toBe(
      "in_stock",
    );
  });

  it("a real 404 is not_found; truncated JSON and HTML are garbage; a CAPTCHA is a block", async () => {
    const cases: [string, Parameters<typeof stubNet>[0][string], string][] = [
      [
        "404",
        { status: 404, body: fixture("shopify/canadaluggagedepot__missing.product.json") },
        "not_found",
      ],
      ["truncated", { body: fixture(`shopify/${CLD_FILE}.product.json`).slice(0, 900) }, "garbage"],
      [
        "password page",
        {
          body: "<html><body>Opening soon — enter password</body></html>",
          headers: { "content-type": "text/html" },
        },
        "garbage",
      ],
      [
        "captcha",
        { status: 307, body: fixture("blocks/samsonite-perimeterx-307.html") },
        "blocked",
      ],
      ["rate limited", { status: 429, body: "" }, "blocked"],
    ];
    for (const [label, response, status] of cases) {
      const net = stubNet({ [`${CLD}.json`]: response });
      const r = await ADAPTERS.shopify_product_json.verify(
        makeCtx("canadaluggagedepot", net.fetchImpl),
        listing(CLD),
      );
      expect(r.status, label).toBe(status);
      expect(r.offers, label).toEqual([]);
    }
  });

  it("refuses non-product URLs without a request", async () => {
    const net = stubNet({});
    const r = await ADAPTERS.shopify_product_json.verify(
      makeCtx("canadaluggagedepot", net.fetchImpl),
      listing("https://www.canadaluggagedepot.ca/collections/all"),
    );
    expect(r.status).toBe("not_found");
    expect(net.seen).toEqual([]);
  });
});

/* ── html_structured ──────────────────────────────────────────────── */

describe("html_structured (recorded + platform cases)", () => {
  it("Canada Luggage Depot JSON-LD: ProductGroup variants with GTIN, strikethrough list price, stock", async () => {
    const net = stubNet({
      [CLD]: { body: fixture(`html/${CLD_FILE}.html`), headers: { "content-type": "text/html" } },
    });
    const ctx = makeCtx("canadaluggagedepot", net.fetchImpl);
    const r = await ADAPTERS.html_structured.verify(ctx, listing(CLD));
    expect(r.status).toBe("ok");
    expect(r.offers).toHaveLength(4);
    expect(r.offers.map((o) => o.availability).sort()).toEqual([
      "in_stock",
      "in_stock",
      "out_of_stock",
      "out_of_stock",
    ]);
    expect(
      r.offers.every((o) => o.price === 279.99 && o.listPrice === 440 && o.currency === "CAD"),
    ).toBe(true);
    expect(r.offers.every((o) => o.displayedPrice === 279.99)).toBe(true);
    expect(new Set(r.offers.flatMap((o) => ids(o, "gtin")))).toEqual(
      new Set(["00043202917998", "00043202917950", "00043202918032", "00043202918001"]),
    );
    for (const o of r.offers)
      expect(
        validateOffer(o, { source: ctx.source, pack: luggagePack, now: ctx.now() }).outcome,
      ).toBe("accepted");
  });

  it("Delsey: variant offers that link to us.delsey.com are dropped; the page's own offer stays", async () => {
    const net = stubNet({ [DELSEY]: { body: fixture(`html/${DELSEY_FILE}.html`) } });
    const r = await ADAPTERS.html_structured.verify(
      makeCtx("delsey-ca", net.fetchImpl),
      listing(DELSEY),
    );
    expect(r.status).toBe("ok");
    expect(r.offers.every((o) => new URL(o.url).hostname === "delsey.ca")).toBe(true);
    expect(r.offers.map((o) => [o.price, o.currency, o.availability])).toEqual([
      [335, "CAD", "out_of_stock"],
    ]);
  });

  it("Bentley case: data price ≠ displayed price is flagged low-confidence, not hidden or rewritten", async () => {
    const url = "https://www.shopbentley.com/products/air-canada-logan-20-hardside-spinner";
    const html = `<html><head><meta property="og:type" content="product"><meta property="og:price:amount" content="125.99"><meta property="og:price:currency" content="CAD"></head>
      <body><script type="application/ld+json">{"@type":"Product","name":"Air Canada Logan Carry-on","brand":{"@type":"Brand","name":"Air Canada"},"sku":"128201001","gtin12":"770005864180",
      "offers":[{"@type":"Offer","price":"179.99","priceCurrency":"CAD","availability":"https://schema.org/InStock","url":"${url}"}]}</script></body></html>`;
    const ctx = makeCtx("bentley", stubNet({ [url]: { body: html } }).fetchImpl);
    const r = await ADAPTERS.html_structured.verify(ctx, listing(url));
    expect(r.offers[0].price).toBe(179.99);
    expect(r.offers[0].displayedPrice).toBe(125.99);
    const v = validateOffer(r.offers[0], { source: ctx.source, pack: luggagePack, now: ctx.now() });
    expect(v.outcome).toBe("low_confidence");
    expect(v.reasons.join(" ")).toMatch(/page shows 125\.99, data says 179\.99/);
  });

  it("Salesforce Commerce Cloud microdata price is read when there's no JSON-LD offer", async () => {
    const url = "https://www.samsonite.ca/en/luggage/carry-on/x/143108XXXX.html";
    const html = `<html><head><meta property="og:type" content="product"><meta property="og:title" content="Upscape Spinner Carry-On"></head><body>
      <span class="sales"><span class="value" itemprop="price" content="224.95">$224.95</span></span><meta itemprop="priceCurrency" content="CAD"></body></html>`;
    const r = await ADAPTERS.html_structured.verify(
      makeCtx("samsonite-ca", stubNet({ [url]: { body: html } }).fetchImpl),
      listing(url),
    );
    expect(r.status).toBe("ok");
    expect([r.offers[0].price, r.offers[0].currency]).toEqual([224.95, "CAD"]);
  });

  it("blocks, misses and pages without product data", async () => {
    const url =
      "https://www.samsonite.ca/en/luggage/checked/samsonite-outline-pro-spinner-medium/137394XXXX.html";
    const cases: [Parameters<typeof stubNet>[0][string], string][] = [
      [{ status: 307, body: fixture("blocks/samsonite-perimeterx-307.html") }, "blocked"],
      [
        {
          status: 403,
          body: fixture("blocks/sportinglife-cloudflare-403.html"),
          headers: { "cf-mitigated": "challenge" },
        },
        "blocked",
      ],
      [{ status: 404, body: "" }, "not_found"],
      [
        { body: "<html><head><title>Luggage</title></head><body>Shop all</body></html>" },
        "garbage",
      ],
    ];
    for (const [resp, status] of cases) {
      const r = await ADAPTERS.html_structured.verify(
        makeCtx("samsonite-ca", stubNet({ [url]: resp }).fetchImpl),
        listing(url),
      );
      expect(r.status).toBe(status);
    }
  });
});

/* ── shopify_ucp (doc-shaped, real CLD values) ────────────────────── */

const UCP_PROFILE = "https://luggagetracker.example/.well-known/ucp-agent";
const CLD_MCP = "https://canadaluggagedepot.myshopify.com/api/ucp/mcp";
const ucpProduct = {
  id: "gid://shopify/Product/7400000000001",
  title: "Samsonite Omni 3.0 Large Spinner Expandable Luggage",
  vendor: "Samsonite",
  handle: CLD_HANDLE,
  variants: [
    {
      id: "gid://shopify/ProductVariant/42742339010736",
      title: "Blue",
      sku: "135955-1247",
      barcodes: [{ type: "UPC", value: "043202917998" }],
      price: { amount: 27999, currency: "CAD" },
      list_price: { amount: 44000, currency: "CAD" },
      availability: { available: true },
      options: [{ name: "Color", label: "Blue" }],
    },
    {
      id: "gid://shopify/ProductVariant/42055984283824",
      title: "Black",
      sku: "135955-1041",
      barcodes: [{ type: "UPC", value: "043202917950" }],
      price: { amount: 27999, currency: "CAD" },
      list_price: { amount: 44000, currency: "CAD" },
      availability: { available: false },
      options: [{ name: "Color", label: "Black" }],
    },
  ],
};

describe("shopify_ucp (doc-shaped)", () => {
  it("is not configured until our agent profile is published", async () => {
    const net = stubNet({});
    const r = await ADAPTERS.shopify_ucp.search!(
      makeCtx("canadaluggagedepot", net.fetchImpl),
      luggagePack.parseQuery("omni large"),
      5,
    );
    expect(r.status).toBe("not_configured");
    expect(r.message).toMatch(/agent profile/);
    expect(net.seen).toEqual([]);
  });

  it("search_catalog over SSE: minor units → dollars, barcodes, availability, store links", async () => {
    const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ products: [ucpProduct] }) }] } })}\n\n`;
    const net = stubNet({
      [CLD_MCP]: { body: sse, headers: { "content-type": "text/event-stream" } },
    });
    const r = await ADAPTERS.shopify_ucp.search!(
      makeCtx("canadaluggagedepot", net.fetchImpl, { ucpAgentProfileUrl: UCP_PROFILE }),
      luggagePack.parseQuery("Samsonite Omni 3.0 Large"),
      5,
    );
    expect(r.status).toBe("ok");
    expect(r.offers.map((o) => [o.price, o.listPrice, o.currency, o.availability])).toEqual([
      [279.99, 440, "CAD", "in_stock"],
      [279.99, 440, "CAD", "out_of_stock"],
    ]);
    expect(r.offers[0].url).toBe(`${CLD}?variant=42742339010736`);
    expect(ids(r.offers[0], "gtin")).toEqual(["00043202917998"]);
    const call = net.seen.find((s) => s.url === CLD_MCP)!;
    const body = JSON.parse(call.body!);
    expect(body.params.name).toBe("search_catalog");
    expect(body.params.arguments.meta["ucp-agent"].profile).toBe(UCP_PROFILE);
    expect(body.params.arguments.catalog.context.address_country).toBe("CA");
    expect(call.headers["UCP-Agent"]).toBe(`profile="${UCP_PROFILE}"`);
  });

  it("get_product verifies a known listing by product id", async () => {
    const net = stubNet({
      [CLD_MCP]: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { product: ucpProduct } },
        }),
      },
    });
    const r = await ADAPTERS.shopify_ucp.verify(
      makeCtx("canadaluggagedepot", net.fetchImpl, { ucpAgentProfileUrl: UCP_PROFILE }),
      listing(CLD, { externalId: "7400000000001" }),
    );
    expect(r.status).toBe("ok");
    expect(r.offers).toHaveLength(2);
  });

  it("a US-priced answer from a shared shop is rejected by validation", async () => {
    const us = {
      ...ucpProduct,
      variants: [{ ...ucpProduct.variants[0], price: { amount: 19999, currency: "USD" } }],
    };
    const net = stubNet({
      [CLD_MCP]: {
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { structuredContent: { products: [us] } },
        }),
      },
    });
    const ctx = makeCtx("canadaluggagedepot", net.fetchImpl, { ucpAgentProfileUrl: UCP_PROFILE });
    const r = await ADAPTERS.shopify_ucp.search!(ctx, luggagePack.parseQuery("omni"), 5);
    expect(
      validateOffer(r.offers[0], { source: ctx.source, pack: luggagePack, now: ctx.now() }).outcome,
    ).toBe("rejected");
  });

  it("protocol errors: bad profile → not_configured; tool error → error; HTML → error", async () => {
    const cases: [string, string][] = [
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32602, message: "Invalid agent profile" },
        }),
        "not_configured",
      ],
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { isError: true, content: [{ type: "text", text: "catalog unavailable" }] },
        }),
        "error",
      ],
      ["<html>oops</html>", "error"],
    ];
    for (const [body, status] of cases) {
      const r = await ADAPTERS.shopify_ucp.search!(
        makeCtx("canadaluggagedepot", stubNet({ [CLD_MCP]: { body } }).fetchImpl, {
          ucpAgentProfileUrl: UCP_PROFILE,
        }),
        luggagePack.parseQuery("omni"),
        5,
      );
      expect(r.status).toBe(status);
    }
  });
});

/* ── ebay_browse_api (doc-shaped) ─────────────────────────────────── */

describe("ebay_browse_api (doc-shaped)", () => {
  const keys = { ebay: { clientId: "test-client", clientSecret: "test-secret" } };
  const token = {
    "https://api.ebay.com/identity/v1/oauth2/token": {
      body: JSON.stringify({
        access_token: "v^1.1#token",
        expires_in: 7200,
        token_type: "Application Access Token",
      }),
    },
  };
  const summaries = {
    total: 3,
    itemSummaries: [
      {
        itemId: "v1|1234567890|0",
        title: "Samsonite Outline Pro Medium Spinner Black",
        price: { value: "309.99", currency: "CAD" },
        condition: "New",
        conditionId: "1000",
        seller: { username: "luggage_outlet_ca" },
        itemWebUrl: "https://www.ebay.ca/itm/1234567890?hash=abc",
        image: { imageUrl: "https://i.ebayimg.com/1.jpg" },
      },
      {
        itemId: "v1|2222222222|0",
        title: "Samsonite Outline Pro Medium Spinner",
        price: { value: "229.00", currency: "USD" },
        condition: "New",
        seller: { username: "us_seller" },
        itemWebUrl: "https://www.ebay.com/itm/2222222222",
      },
      {
        itemId: "v1|3333333333|0",
        title: "Samsonite Outline Pro Medium Spinner",
        price: { value: "150.00", currency: "CAD" },
        condition: "Used",
        seller: { username: "someone" },
        itemWebUrl: "https://www.ebay.ca/itm/3333333333",
      },
    ],
  };

  it("isn't configured without keys and never touches www.ebay.ca", async () => {
    const net = stubNet({});
    expect(
      (
        await ADAPTERS.ebay_browse_api.search!(
          makeCtx("ebay-ca", net.fetchImpl),
          luggagePack.parseQuery("outline pro"),
          10,
        )
      ).status,
    ).toBe("not_configured");
    expect(net.seen).toEqual([]);
  });

  it("searches by GTIN on EBAY_CA; validation keeps only new, CAD-priced offers", async () => {
    resetEbayTokens();
    const net = stubNet({ ...token });
    const routes = (url: string) =>
      url.startsWith("https://api.ebay.com/buy/browse/v1/item_summary/search")
        ? JSON.stringify(summaries)
        : null;
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = routes(String(input));
      return body
        ? new Response(body, { headers: { "content-type": "application/json" } })
        : net.fetchImpl(input, init);
    }) as typeof fetch;
    const ctx = makeCtx("ebay-ca", wrapped, keys);
    const r = await ADAPTERS.ebay_browse_api.search!(
      ctx,
      luggagePack.parseQuery("043202927614"),
      10,
    );
    expect(r.status).toBe("ok");
    expect(r.offers).toHaveLength(3);
    expect(r.offers[0].url).toBe("https://www.ebay.ca/itm/1234567890");
    const outcomes = r.offers.map(
      (o) => validateOffer(o, { source: ctx.source, pack: luggagePack, now: ctx.now() }).outcome,
    );
    expect(outcomes).toEqual(["accepted", "rejected", "rejected"]);
  });

  it("verifies an item and reads GTIN, seller and stock", async () => {
    resetEbayTokens();
    const item = {
      itemId: "v1|1234567890|0",
      title: "Samsonite Outline Pro Medium Spinner Black",
      gtin: "043202927614",
      brand: "Samsonite",
      mpn: "137394-1041",
      price: { value: "309.99", currency: "CAD" },
      condition: "New",
      seller: { username: "luggage_outlet_ca" },
      itemWebUrl: "https://www.ebay.ca/itm/1234567890",
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
    };
    const net = stubNet({
      ...token,
      "https://api.ebay.com/buy/browse/v1/item/v1%7C1234567890%7C0": { body: JSON.stringify(item) },
    });
    const r = await ADAPTERS.ebay_browse_api.verify(
      makeCtx("ebay-ca", net.fetchImpl, keys),
      listing("https://www.ebay.ca/itm/1234567890", { externalId: "v1|1234567890|0" }),
    );
    expect(r.status).toBe("ok");
    const o = r.offers[0];
    expect([o.price, o.currency, o.seller, o.availability]).toEqual([
      309.99,
      "CAD",
      "luggage_outlet_ca",
      "in_stock",
    ]);
    expect(ids(o, "gtin")).toEqual(["00043202927614"]);
    expect(ids(o, "model")).toEqual(["samsonite:137394"]);
    expect(net.seen.every((s) => new URL(s.url).hostname === "api.ebay.com")).toBe(true);
    expect(net.seen.find((s) => s.url.includes("/item/"))!.headers["X-EBAY-C-MARKETPLACE-ID"]).toBe(
      "EBAY_CA",
    );
  });

  it("rejected keys → not_configured; 5xx → error", async () => {
    resetEbayTokens();
    const bad = stubNet({
      "https://api.ebay.com/identity/v1/oauth2/token": {
        status: 401,
        body: '{"error":"invalid_client"}',
      },
    });
    expect(
      (
        await ADAPTERS.ebay_browse_api.search!(
          makeCtx("ebay-ca", bad.fetchImpl, keys),
          luggagePack.parseQuery("x"),
          5,
        )
      ).status,
    ).toBe("not_configured");
  });
});

/* ── amazon_creators_api (doc-shaped) ─────────────────────────────── */

describe("amazon_creators_api (doc-shaped, inactive by default)", () => {
  const amazon = {
    amazon: {
      credentialId: "AKIDEXAMPLE",
      credentialSecret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      partnerTag: "luggagedepot-20",
    },
  };

  it("is not configured without an eligible account", async () => {
    const net = stubNet({});
    expect(
      (
        await ADAPTERS.amazon_creators_api.verify(
          makeCtx("amazon-ca", net.fetchImpl),
          listing("https://www.amazon.ca/dp/B0TEST", { externalId: "B0TEST" }),
        )
      ).status,
    ).toBe("not_configured");
    expect(net.seen).toEqual([]);
  });

  it("signs requests with SigV4 for the NA region", () => {
    const h = signPaapi(
      "GetItems",
      '{"ItemIds":["B0TEST"]}',
      "AKIDEXAMPLE",
      "secret",
      new Date("2026-10-07T21:30:00Z"),
    );
    expect(h.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261007\/us-east-1\/ProductAdvertisingAPI\/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/,
    );
    const other = signPaapi(
      "GetItems",
      '{"ItemIds":["B0OTHER"]}',
      "AKIDEXAMPLE",
      "secret",
      new Date("2026-10-07T21:30:00Z"),
    );
    expect(other.Authorization).not.toBe(h.Authorization);
  });

  it("reads the buy-box offer: price, list price, seller, condition, UPC", async () => {
    const resp = {
      ItemsResult: {
        Items: [
          {
            ASIN: "B0TEST",
            DetailPageURL: "https://www.amazon.ca/dp/B0TEST?tag=luggagedepot-20",
            ItemInfo: {
              Title: { DisplayValue: "Samsonite Outline Pro Hardside Medium Spinner, Black" },
              ByLineInfo: { Brand: { DisplayValue: "Samsonite" } },
              ExternalIds: { UPCs: { DisplayValues: ["043202927614"] } },
            },
            Offers: {
              Listings: [
                {
                  Price: { Amount: 299.99, Currency: "CAD" },
                  SavingBasis: { Amount: 405 },
                  Availability: { Type: "Now" },
                  Condition: { Value: "New" },
                  MerchantInfo: { Name: "Amazon.ca" },
                },
              ],
            },
          },
        ],
      },
    };
    const ctx = makeCtx(
      "amazon-ca",
      stubNet({ "https://webservices.amazon.ca/paapi5/getitems": { body: JSON.stringify(resp) } })
        .fetchImpl,
      amazon,
    );
    const r = await ADAPTERS.amazon_creators_api.verify(
      ctx,
      listing("https://www.amazon.ca/dp/B0TEST", { externalId: "B0TEST" }),
    );
    expect(r.status).toBe("ok");
    const o = r.offers[0];
    expect([o.price, o.listPrice, o.currency, o.availability, o.seller, o.condition]).toEqual([
      299.99,
      405,
      "CAD",
      "in_stock",
      "Amazon.ca",
      "New",
    ]);
    expect(
      validateOffer(o, { source: ctx.source, pack: luggagePack, now: ctx.now() }).outcome,
    ).toBe("accepted");
  });
});

/* ── feed_import and manual_entry ─────────────────────────────────── */

describe("feed_import", () => {
  it("parses RFC 4180 CSV (quotes, commas, doubled quotes)", () => {
    expect(parseCsv('title,price\n"Outline Pro, Medium",324.95\n"The ""Classic""",10\n')).toEqual([
      ["title", "price"],
      ["Outline Pro, Medium", "324.95"],
      ['The "Classic"', "10"],
    ]);
  });

  it("turns a dealer list into dated offers and reports bad rows", () => {
    const csv = [
      "Item Number,UPC,Product Name,Dealer Price,MSRP,Stock,As Of",
      '137394-1041,043202927614,"Samsonite Outline Pro Spinner Medium, Black",259.00,405.00,Y,2026-10-01',
      "137392-1041,,Samsonite Outline Pro Spinner Carry-On,,349.99,Y,2026-10-01",
      ",,,",
    ].join("\n");
    const feed = parseFeed(
      csv,
      "csv",
      source("samsonite-ca"),
      luggagePack,
      "2026-10-05",
      "dealer-oct.csv",
      Date.parse("2026-10-07T00:00:00Z"),
    );
    expect(feed.offers).toHaveLength(1);
    const o = feed.offers[0];
    expect([o.price, o.listPrice, o.currency, o.availability, o.asOf]).toEqual([
      259,
      405,
      "CAD",
      "in_stock",
      "2026-10-01T00:00:00.000Z",
    ]);
    expect(o.url).toBe("feed:samsonite-ca:137394-1041");
    expect(ids(o, "mpn")).toEqual(["samsonite:137394-1041"]);
    expect(feed.errors).toEqual([{ row: 3, reason: "no usable price" }]);
    expect(
      validateOffer(o, {
        source: source("samsonite-ca"),
        pack: luggagePack,
        now: Date.parse("2026-10-07T00:00:00Z"),
      }).outcome,
    ).toBe("accepted");
  });

  it("an off-domain URL in a feed is not used as the listing link", () => {
    const feed = parseFeed(
      JSON.stringify([
        { title: "Wagram Carry-On", price: 300, url: "https://delseyluggagecanada.ca/p/1" },
      ]),
      "json",
      source("delsey-ca"),
      luggagePack,
      "2026-10-05",
      "f.json",
    );
    expect(feed.offers[0].url.startsWith("feed:delsey-ca:")).toBe(true);
  });

  it("feeds aren't fetched", async () => {
    const net = stubNet({});
    expect(
      (
        await ADAPTERS.feed_import.verify(
          makeCtx("samsonite-ca", net.fetchImpl),
          listing("feed:samsonite-ca:137394-1041"),
        )
      ).status,
    ).toBe("not_configured");
    expect(net.seen).toEqual([]);
  });
});

describe("manual_entry", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  it("records a checked price with its date", () => {
    const r = manualOffer(
      source("costco-ca"),
      luggagePack,
      {
        title: "Samsonite 2-Piece Hardside Set",
        price: 299.99,
        checkedAt: "2026-10-06",
        enteredBy: "admin",
      },
      now,
    );
    expect(r.ok && [r.offer.price, r.offer.asOf, r.offer.pageType]).toEqual([
      299.99,
      "2026-10-06T00:00:00.000Z",
      "manual",
    ]);
  });
  it("keeps the stock a salesperson saw, unknown when they didn't say (R6)", () => {
    const entry = (availability?: "in_stock" | "out_of_stock" | "unknown") =>
      manualOffer(
        source("costco-ca"),
        luggagePack,
        { title: "Samsonite Set", price: 199, checkedAt: "2026-10-06", enteredBy: "admin", availability },
        now,
      );
    const stockOfEntry = (r: ReturnType<typeof entry>) => (r.ok ? r.offer.availability : null);
    expect(stockOfEntry(entry("in_stock"))).toBe("in_stock");
    expect(stockOfEntry(entry("out_of_stock"))).toBe("out_of_stock");
    expect(stockOfEntry(entry())).toBe("unknown");
  });
  it("refuses future dates, bad prices and links to other sites", () => {
    expect(
      manualOffer(
        source("costco-ca"),
        luggagePack,
        { title: "x", price: 10, checkedAt: "2026-12-01", enteredBy: "a" },
        now,
      ).ok,
    ).toBe(false);
    expect(
      manualOffer(
        source("costco-ca"),
        luggagePack,
        { title: "x", price: -1, checkedAt: "2026-10-01", enteredBy: "a" },
        now,
      ).ok,
    ).toBe(false);
    expect(
      manualOffer(
        source("costco-ca"),
        luggagePack,
        {
          title: "x",
          price: 10,
          checkedAt: "2026-10-01",
          url: "https://www.amazon.ca/dp/1",
          enteredBy: "a",
        },
        now,
      ).ok,
    ).toBe(false);
  });
});
