/* ------------------------------------------------------------------ */
/*  Offline checks for the probe's parsers — no network.              */
/* ------------------------------------------------------------------ */

import { classify } from "./http";
import { isAllowed, parseRobots } from "./robots";
import { extractStructured, looksJsOnly } from "./structured";
import { parseProductJs, parseProductJson } from "./shopify";
import {
  findMcpEndpoint,
  findProducts,
  normaliseUcpProduct,
  parseMcpBody,
  toolResult,
} from "./ucp";

export function selftest(): boolean {
  let pass = 0;
  let fail = 0;
  const check = (label: string, ok: boolean, detail = "") => {
    if (ok) pass++;
    else fail++;
    console.log(
      `  ${ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${label}${!ok && detail ? ` — ${detail}` : ""}`,
    );
  };

  console.log("\nrobots.txt");
  const shopifyRobots = parseRobots(
    [
      "# we use Shopify",
      "User-agent: *",
      "Disallow: /admin",
      "Disallow: /cart",
      "Disallow: /search",
      "Disallow: /collections/*sort_by*",
      "Disallow: /*/collections/*+*",
      "Allow: /search$",
      "Sitemap: https://shop.ca/sitemap.xml",
      "",
      "User-agent: AhrefsBot",
      "Crawl-delay: 10",
      "Disallow: /",
    ].join("\n"),
    "LuggageTrackerProbe",
  );
  check("uses the * group when we aren't named", shopifyRobots.group === "*");
  check("product pages allowed", isAllowed(shopifyRobots, "https://shop.ca/products/outline-pro"));
  check(
    "product JSON allowed",
    isAllowed(shopifyRobots, "https://shop.ca/products/outline-pro.json"),
  );
  check("/search?q= disallowed", !isAllowed(shopifyRobots, "https://shop.ca/search?q=bag"));
  check(
    "wildcard rule disallows sorted collections",
    !isAllowed(shopifyRobots, "https://shop.ca/collections/all?sort_by=price"),
  );
  check("another bot's crawl-delay isn't ours", shopifyRobots.crawlDelaySec === null);
  check("sitemap captured", shopifyRobots.sitemaps[0] === "https://shop.ca/sitemap.xml");

  const named = parseRobots(
    [
      "User-agent: *",
      "Crawl-delay: 10",
      "Disallow: /on/demandware.store/",
      "",
      "User-agent: LuggageTrackerProbe",
      "Disallow: /",
    ].join("\n"),
    "LuggageTrackerProbe",
  );
  check(
    "a group naming us wins over *",
    named.group === "named" && !isAllowed(named, "https://x.ca/en/p/1.html"),
  );
  const delay = parseRobots(
    ["User-agent: *", "Crawl-delay: 10", "Disallow: /dw/shop/"].join("\n"),
    "LuggageTrackerProbe",
  );
  check("crawl-delay read from * group", delay.crawlDelaySec === 10);
  check(
    "encoded path still matches",
    isAllowed(
      delay,
      "https://x.ca/en/luggage/samsonite-outline-pro-spinner-carry-on%E2%84%A2/137392XXXX.html",
    ),
  );
  check(
    "longest match: Allow beats shorter Disallow",
    isAllowed(
      parseRobots("User-agent: *\nDisallow: /p\nAllow: /products/", "x"),
      "https://x.ca/products/a",
    ),
  );

  console.log("\nBlock classification");
  const px =
    '<html><head><meta name="description" content="px-captcha"><title>Access to this page has been denied</title></head><body><script>window._pxAppId="PX1";</script></body></html>';
  check("307 PerimeterX CAPTCHA page → challenge", classify(307, px, {}) === "challenge");
  check(
    "cf-mitigated header → challenge",
    classify(403, "<html>Just a moment...</html>", { "cf-mitigated": "challenge" }) === "challenge",
  );
  check("plain 403 → blocked", classify(403, "Forbidden", {}) === "blocked");
  check("429 → rate_limited", classify(429, "", {}) === "rate_limited");
  check("404 → not_found", classify(404, "", {}) === "not_found");
  check(
    "200 product page → ok",
    classify(200, "<html><title>Outline Pro</title></html>", {}) === "ok",
  );

  console.log("\nJSON-LD / meta");
  const shopifyHtml = `<html><head>
    <meta property="og:type" content="product">
    <meta property="og:price:amount" content="324.95">
    <meta property="og:price:currency" content="CAD">
    <script type="application/ld+json">{"@context":"http://schema.org/","@type":"Product","name":"Samsonite Outline Pro Medium Spinner","sku":"137394-Black","gtin12":"043202927614","brand":{"@type":"Brand","name":"Samsonite"},
      "offers":[{"@type":"Offer","price":"324.95","priceCurrency":"CAD","availability":"http://schema.org/InStock","sku":"137394-Black","gtin12":"043202927614","url":"https://unluggage.com/products/x?variant=1"},
                {"@type":"Offer","price":"324.95","priceCurrency":"CAD","availability":"http://schema.org/OutOfStock","sku":"137394-Stone Grey","gtin12":"840359609796"}]}</script>
  </head></html>`;
  const s1 = extractStructured(shopifyHtml);
  check(
    "one Product found",
    s1.products.length === 1 && s1.products[0].name === "Samsonite Outline Pro Medium Spinner",
  );
  check("brand object → name", s1.products[0].brand === "Samsonite");
  check(
    "two offers with price, currency, availability",
    s1.products[0].offers.length === 2 &&
      s1.products[0].offers[0].price === 324.95 &&
      s1.products[0].offers[0].priceCurrency === "CAD" &&
      /OutOfStock/.test(s1.products[0].offers[1].availability ?? ""),
  );
  check(
    "GTIN read from gtin12",
    s1.products[0].gtin === "043202927614" && s1.products[0].offers[1].gtin === "840359609796",
  );
  check(
    "og:price meta read",
    s1.meta["og:price:amount"] === "324.95" && s1.meta["og:price:currency"] === "CAD",
  );

  const sfccHtml = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList"},{"@type":"ProductGroup","name":"Outline Pro Spinner Medium","productGroupID":"137394","hasVariant":[
      {"@type":"Product","sku":"1373941041","gtin13":"0043202927614","color":"Black","offers":{"@type":"Offer","priceCurrency":"CAD","price":324.95,"availability":"https://schema.org/InStock",
        "priceSpecification":[{"@type":"UnitPriceSpecification","priceType":"https://schema.org/StrikethroughPrice","price":405.00,"priceCurrency":"CAD"}]}},
      {"@type":"Product","sku":"1373941830","color":"Stone Grey","offers":{"@type":"Offer","priceCurrency":"CAD","price":"324.95","availability":"https://schema.org/OutOfStock"}}]}]}</script>`;
  const s2 = extractStructured(sfccHtml);
  check(
    "ProductGroup inside @graph found",
    s2.products.length === 1 && s2.products[0].type.includes("ProductGroup"),
  );
  check(
    "variants read from hasVariant",
    s2.products[0].variants.length === 2 && s2.products[0].variants[0].color === "Black",
  );
  check(
    "strikethrough price read as list price",
    s2.products[0].variants[0].offers[0].listPrice === 405 &&
      s2.products[0].variants[0].offers[0].price === 324.95,
  );
  check(
    "bad JSON-LD counted, not thrown",
    extractStructured('<script type="application/ld+json">{oops</script>').jsonLdParseErrors === 1,
  );
  check(
    "JS-only page detected",
    looksJsOnly("<html><noscript>You need to enable JavaScript to run this app.</noscript></html>"),
  );

  console.log("\nShopify product data");
  const pj = parseProductJson(
    JSON.stringify({
      product: {
        id: 1,
        title: "Outline Pro Medium",
        vendor: "Samsonite",
        updated_at: "2026-10-01T10:00:00-04:00",
        variants: [
          {
            id: 11,
            title: "Black",
            price: "324.95",
            compare_at_price: "405.00",
            sku: "137394-Black",
            barcode: "043202927614",
            inventory_quantity: 1,
            option1: "Black",
          },
        ],
      },
    }),
  );
  check(
    ".json parsed (decimal prices)",
    pj?.variants[0].price === 324.95 &&
      pj.variants[0].compareAt === 405 &&
      pj.variants[0].barcode === "043202927614" &&
      pj.updatedAt !== null,
  );
  const pjs = parseProductJs(
    JSON.stringify({
      id: 1,
      title: "Outline Pro Medium",
      vendor: "Samsonite",
      variants: [
        {
          id: 11,
          price: 32495,
          compare_at_price: 40500,
          available: true,
          sku: "137394-Black",
          barcode: "043202927614",
          options: ["Black"],
        },
      ],
    }),
  );
  check(
    ".js parsed (cents → dollars, available)",
    pjs?.variants[0].price === 324.95 &&
      pjs.variants[0].compareAt === 405 &&
      pjs.variants[0].available === true,
  );
  check("not-a-product JSON → null", parseProductJson('{"errors":"Not Found"}') === null);

  console.log("\nUCP / MCP");
  check(
    "MCP endpoint found in /.well-known/ucp",
    findMcpEndpoint(
      {
        ucp: {
          services: {
            "dev.ucp.shopping": [
              { transport: "mcp", endpoint: "https://x.myshopify.com/api/ucp/mcp" },
            ],
          },
        },
      },
      "x.ca",
    ) === "https://x.myshopify.com/api/ucp/mcp",
  );
  check(
    "endpoint falls back to store host",
    findMcpEndpoint({}, "x.ca") === "https://x.ca/api/ucp/mcp",
  );
  const sse =
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\\"products\\":[{\\"id\\":\\"gid://shopify/Product/9\\",\\"title\\":\\"Outline Pro\\"}]}"}]}}\n\n';
  const parsed = toolResult(parseMcpBody(sse, "text/event-stream"));
  check("SSE response parsed", parsed.ok && findProducts(parsed.result).length === 1);
  check(
    "JSON-RPC error surfaced",
    toolResult({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid agent profile" },
    }).error?.includes("Invalid agent profile") === true,
  );
  check(
    "tool isError surfaced",
    toolResult({ result: { isError: true, content: [{ type: "text", text: "profile required" }] } })
      .error === "profile required",
  );
  const norm = normaliseUcpProduct({
    id: "gid://shopify/Product/9",
    title: "Outline Pro",
    variants: [
      {
        id: "gid://shopify/ProductVariant/11",
        sku: "137394-Black",
        barcodes: [{ type: "UPC", value: "043202927614" }],
        price: { amount: 32495, currency: "CAD" },
        list_price: { amount: 40500, currency: "CAD" },
        availability: { available: true },
        options: [{ name: "Color", label: "Black" }],
      },
    ],
  });
  check(
    "UCP variant normalised (minor units, barcode, availability)",
    norm.variants[0].price === 324.95 &&
      norm.variants[0].compareAt === 405 &&
      norm.variants[0].currency === "CAD" &&
      norm.variants[0].barcode === "043202927614" &&
      norm.variants[0].available === true,
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);
  return fail === 0;
}
