/* ------------------------------------------------------------------ */
/*  Offline verification of research + search                        */
/*                                                                     */
/*    npm run verify:search                                            */
/*                                                                     */
/*  Drives the REAL pipeline with `fetch` stubbed, using realistic     */
/*  Tavily responses (retailer pages with nav junk, list prices,       */
/*  "orders over $75", "Customers also viewed" rows, US storefronts,   */
/*  category pages). Asserts the things that matter:                   */
/*                                                                     */
/*    • no fake prices — every price is on the page, with evidence     */
/*    • no paid usage — the credit cap refuses before any request      */
/*    • no wasted credits — caching, de-duplication, negative cache    */
/*    • errors, rate limits, timeouts and empty results handled        */
/*    • research never touches the Add Product workflow                */
/*                                                                     */
/*  Costs nothing. Makes no network call.                              */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { search } from "../src/lib/search/index";
import { isCanadianStorefront, matchRetailer } from "../src/lib/retailers";
import {
  analyzePage,
  cleanPageTitle,
  extractDetails,
  pickListingPrice,
} from "../src/lib/search/extract";
import { ProviderError } from "../src/lib/search/errors";
import { resetTavilyState, tavilyCreditStatus, tavilyExtract, tavilySearch } from "../src/lib/tavily";
import { brandStoreFor } from "../src/lib/retailers";
import type { SearchProduct } from "../src/lib/search/types";

/* ------------------------------------------------------------------ */
/*  Realistic retailer pages, as Tavily returns them                  */
/* ------------------------------------------------------------------ */

type TavilyRow = {
  title: string;
  url: string;
  content: string;
  score: number;
  raw_content: string | null;
};

type PageSpec = {
  name: string;
  site: string;
  url: string;
  /** Exactly as the page prints it, e.g. "$229.99", "CA$219.00", "164,97 $". */
  price?: string;
  /** Extra lines inside the product section (specs, stock notes…). */
  extra?: string;
};

/**
 * A product page the way a text extractor sees it: header junk with its
 * own amounts, breadcrumbs, the product, its price, then a "customers also
 * viewed" row of OTHER products' prices that must be ignored.
 */
function productPage(p: PageSpec): TavilyRow {
  const priceLine = p.price ? `Sale price ${p.price}` : "See price in cart";
  const raw = [
    "Skip to main content",
    "Free shipping on orders over $75",
    "Sign in | Cart $0.00",
    `Home > Luggage > ${p.name}`,
    p.name,
    "4.6 out of 5 stars (3,121 reviews)",
    priceLine,
    "Add to cart",
    p.extra ?? "",
    "Customers also viewed",
    "Travel Pillow $24.99",
    "Garment Bag $189.99",
  ].join("\n");

  return {
    title: `${p.name} | ${p.site}`,
    url: p.url,
    content: `${p.name} ${priceLine} Add to cart`,
    score: 0.8,
    raw_content: raw,
  };
}

/** 16 good pages (order matters: the Gemini stub groups by index), then junk. */
const PAGES: TavilyRow[] = [
  // ── Samsonite Freeform 21" carry-on, at six retailers ──
  productPage({ name: 'Samsonite Freeform Hardside Expandable Spinner Carry-On 21"', site: "Amazon.ca", url: "https://www.amazon.ca/dp/B07FPBNBZF", price: "$229.99" }),
  productPage({ name: 'Samsonite Freeform 21" Spinner Carry-On Luggage - Black', site: "Walmart Canada", url: "https://www.walmart.ca/en/ip/samsonite-freeform/6000202334455", price: "$249.99" }),
  productPage({ name: "Samsonite Freeform Spinner Carry-On 21 inch", site: "Samsonite Canada", url: "https://www.samsonite.ca/freeform-carry-on-spinner/12345.html", price: "$279.99" }),
  productPage({ name: 'Samsonite Freeform 21" Carry-On Spinner, Coral Red', site: "Hudson's Bay", url: "https://www.thebay.com/product/samsonite-freeform-21-spinner-0600089", price: "$264.00" }),
  productPage({ name: 'SAMSONITE Freeform 21" Hardside Spinner - New, Free Shipping', site: "eBay", url: "https://www.ebay.ca/itm/226611882314", price: "$198.50" }),
  // Same retailer, same bag, listed twice — the dearer one must vanish.
  productPage({ name: 'Samsonite Freeform 21" Spinner Carry-On (Renewed)', site: "Amazon.ca", url: "https://www.amazon.ca/dp/B07FPBNBZG", price: "$259.99" }),
  productPage({ name: 'Samsonite Freeform Carry-On Spinner 21"', site: "Luggage Depot", url: "https://www.luggagedepot.ca/products/samsonite-freeform-21", price: "$239.00" }),

  // ── Samsonite Freeform 28" — SAME model, DIFFERENT size ──
  productPage({ name: 'Samsonite Freeform Hardside Expandable Spinner 28" Large Check-In', site: "Amazon.ca", url: "https://www.amazon.ca/dp/B07FPCCCC1", price: "$329.99" }),
  productPage({ name: 'Samsonite Freeform 28" Spinner Checked Luggage', site: "Costco", url: "https://www.costco.ca/samsonite-freeform-28-spinner.product.100512345.html", price: "$299.99" }),
  productPage({ name: "Samsonite Freeform Spinner 28 inch Check-In Suitcase", site: "Canadian Tire", url: "https://www.canadiantire.ca/en/pdp/samsonite-freeform-28-0871234p.html", price: "$349.99" }),

  // ── Samsonite Omni PC 20" ──
  productPage({ name: 'Samsonite Omni PC Hardside Spinner 20" Carry-On', site: "Amazon.ca", url: "https://www.amazon.ca/dp/B00N3RXRXO", price: "$149.99" }),
  productPage({ name: "Samsonite Omni PC 20 inch Spinner Carry On - Teal", site: "Bentley", url: "https://www.bentley.ca/en/samsonite-omni-pc-20-spinner", price: "$169.99" }),
  productPage({ name: 'Samsonite Omni PC 20" Hardside Carry-On Spinner', site: "London Drugs", url: "https://www.londondrugs.com/samsonite-omni-pc-20-spinner/L1234567.html", price: "$179.99" }),

  // ── Competing brands in the same search ──
  productPage({ name: 'American Tourister Moonlight Hardside Spinner 21" Carry-On', site: "Walmart Canada", url: "https://www.walmart.ca/en/ip/american-tourister-moonlight/6000200112233", price: "$99.97" }),
  productPage({ name: 'American Tourister Moonlight 21" Spinner Luggage', site: "Amazon.ca", url: "https://www.amazon.ca/dp/B01MSGF9VB", price: "$109.99" }),
  // A .com retailer — accepted only because the page states CA$.
  productPage({ name: 'Travelpro Maxlite 5 21" Expandable Carry-On Spinner', site: "Travelpro", url: "https://www.travelpro.com/products/maxlite-5-carry-on-spinner", price: "CA$219.00" }),

  // ── Pages that must NOT become offers ──
  productPage({ name: 'Samsonite Freeform 21" Carry-On Spinner', site: "Sport Chek", url: "https://www.sportchek.ca/product/samsonite-freeform.html" }), // no price
  productPage({ name: "Samsonite Luggage Set 3 Piece", site: "Deals Depot", url: "https://example-store.ca/products/set", price: "$0.00" }), // implausible
  productPage({ name: 'Samsonite Freeform 21" Spinner', site: "Google Shopping", url: "https://www.google.com/shopping/product/1234567890", price: "$231.00" }), // not a retailer
  { ...productPage({ name: "", site: "", url: "https://www.walmart.ca/en/ip/unknown/6000209999999", price: "$89.99" }), title: "" }, // no title
  productPage({ name: 'Samsonite Freeform 21" Spinner', site: "Amazon.com", url: "https://www.amazon.com/dp/B07USA", price: "$179.99" }), // USD storefront
  {
    title: "Search results for samsonite | Walmart Canada",
    url: "https://www.walmart.ca/search?q=samsonite",
    content: "Samsonite Freeform $249.99 Samsonite Omni $149.99",
    score: 0.6,
    raw_content: "Samsonite Freeform $249.99\nSamsonite Omni $149.99\nSamsonite Winfield $199.99",
  }, // search page
];

/* ------------------------------------------------------------------ */
/*  fetch stub                                                        */
/* ------------------------------------------------------------------ */

type SearchHandler = (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>;

type StubOpts = {
  /** Handles POST api.tavily.com/search. Default: return PAGES. */
  search?: SearchHandler;
  /** Handles GET api.tavily.com/usage. Default: a fresh free account (0 of 1,000). */
  usage?: () => Response;
  /** Emulate Gemini answering. */
  gemini?: boolean;
  /** Emulate Gemini returning 503 high demand on every model. */
  geminiBusy?: boolean;
  /** Emulate Gemini hanging until aborted. */
  geminiHangs?: boolean;
  /** Handles POST api.tavily.com/extract. Default: every page fails (free). */
  extract?: (body: Record<string, unknown>, init?: RequestInit) => Response | Promise<Response>;
};

const calls = {
  search: 0,
  usage: 0,
  gemini: 0,
  extract: 0,
  bodies: [] as Record<string, unknown>[],
  headers: [] as Headers[],
  extractBodies: [] as Record<string, unknown>[],
};

function extractJson(ok: { url: string; text: string }[], failed: string[] = [], credits?: number): Response {
  return new Response(
    JSON.stringify({
      results: ok.map((r) => ({ url: r.url, raw_content: r.text })),
      failed_results: failed.map((url) => ({ url, error: "blocked" })),
      response_time: 0.8,
      ...(credits === undefined ? {} : { usage: { credits } }),
      request_id: "ext-test",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function tavilyJson(results: TavilyRow[], credits = 1): Response {
  return new Response(
    JSON.stringify({
      query: "q",
      results,
      response_time: 1.2,
      usage: { credits },
      request_id: "req-test",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function usageJson(used: number, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      key: { usage: used, limit: null },
      account: { current_plan: "Researcher", plan_usage: used, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0, ...extra },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function tavilyError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ detail: { error: message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function hangUntilAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    const fail = () => {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      reject(e);
    };
    if (signal?.aborted) return fail();
    signal?.addEventListener("abort", fail, { once: true });
  });
}

/** Install a fresh stub and clear every in-process cache and ledger. */
function installStub(opts: StubOpts = {}) {
  resetTavilyState();
  calls.search = 0;
  calls.usage = 0;
  calls.gemini = 0;
  calls.extract = 0;
  calls.bodies = [];
  calls.headers = [];
  calls.extractBodies = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url === "https://api.tavily.com/usage") {
      calls.usage += 1;
      return opts.usage ? opts.usage() : usageJson(0);
    }

    if (url === "https://api.tavily.com/search") {
      calls.search += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.bodies.push(body);
      calls.headers.push(new Headers(init?.headers));
      return opts.search ? opts.search(body, init) : tavilyJson(PAGES);
    }

    if (url === "https://api.tavily.com/extract") {
      calls.extract += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.extractBodies.push(body);
      if (opts.extract) return opts.extract(body, init);
      return extractJson([], (body.urls as string[]) ?? []);
    }

    if (url.includes("generativelanguage.googleapis.com")) {
      calls.gemini += 1;
      if (opts.geminiHangs) return hangUntilAborted(init);
      if (opts.geminiBusy) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: "The model is overloaded. UNAVAILABLE" } }),
          { status: 503 },
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt: string = body.contents?.[0]?.parts?.[0]?.text ?? "";
      if (prompt.includes("Group these listings")) {
        return geminiJson({
          products: [
            { name: 'Samsonite Freeform 21" Carry-On Spinner', brand: "Samsonite", model: "Freeform", color: "Black", size: "21 inch", productType: "carry-on", offerIndexes: [0, 1, 2, 3, 4, 5, 6] },
            { name: 'Samsonite Freeform 28" Large Check-In Spinner', brand: "Samsonite", model: "Freeform", size: "28 inch", productType: "checked", offerIndexes: [7, 8, 9] },
            { name: 'Samsonite Omni PC 20" Carry-On Spinner', brand: "Samsonite", model: "Omni PC", size: "20 inch", productType: "carry-on", offerIndexes: [10, 11, 12] },
            { name: 'American Tourister Moonlight 21" Spinner', brand: "American Tourister", model: "Moonlight", size: "21 inch", offerIndexes: [13, 14] },
            // Deliberately drops index 15 (Travelpro): recovery must pick it up.
          ],
        });
      }
      return geminiJson({ terms: "samsonite carry on luggage", brand: "Samsonite", explanation: "Samsonite carry-ons." });
    }

    throw new Error(`Unexpected fetch in verification: ${url}`);
  }) as typeof fetch;
}

function geminiJson(payload: unknown): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/* ------------------------------------------------------------------ */
/*  Assertions                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function isAscending(values: number[]): boolean {
  return values.every((v, i) => i === 0 || values[i - 1] <= v);
}

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function show(products: SearchProduct[]) {
  for (const p of products) {
    console.log(
      `\n    \x1b[1m${p.name}\x1b[0m` +
        `\n      $${p.lowestPrice.toFixed(2)}–$${p.highestPrice.toFixed(2)}  ${p.retailerCount} retailer(s)  size="${p.size}"`,
    );
    for (const o of p.offers) {
      console.log(`        ${o.retailer.padEnd(20)} $${o.price.toFixed(2).padStart(8)}  ${o.url.slice(0, 58)}`);
    }
  }
  console.log("");
}

const MAJORS = ["Amazon.ca", "Walmart.ca", "Costco.ca", "Hudson's Bay", "Canadian Tire", "Bentley", "Best Buy Canada", "London Drugs"];

/** Invariants that must hold for EVERY product, on every path. */
function checkProductInvariants(products: SearchProduct[], label: string) {
  const allOffers = products.flatMap((p) => p.offers);

  check(`${label}: every offer links to a real retailer page`, allOffers.every((o) => /^https?:\/\//.test(o.url) && !/google\./.test(o.url)));
  check(`${label}: every offer has a positive, plausible price`, allOffers.every((o) => o.price >= 15 && o.price <= 6000));
  check(
    `${label}: every price appears in the page words kept as evidence`,
    allOffers.every((o) => {
      const ev = o.evidence ?? "";
      const [whole, cents] = o.price.toFixed(2).split(".");
      const withCommas = Number(whole).toLocaleString("en-US");
      return ev.includes(`${whole}.${cents}`) || ev.includes(`${withCommas}.${cents}`) || ev.includes(`${whole},${cents}`);
    }),
    allOffers.find((o) => !o.evidence)?.url,
  );
  check(
    `${label}: every offer is from a Canadian storefront`,
    allOffers.every((o) => isCanadianStorefront(o.url, o.evidence ?? "")),
  );
  check(`${label}: no offer is attributed to Google`, allOffers.every((o) => !/google/i.test(o.retailer)));
  check(`${label}: no offer has an empty title`, allOffers.every((o) => o.title.trim().length > 0));
  check(
    `${label}: lowestPrice equals the cheapest displayed offer`,
    products.every((p) => p.lowestPrice === Math.min(...p.offers.map((o) => o.price))),
  );
  check(
    `${label}: highestPrice equals the dearest displayed offer`,
    products.every((p) => p.highestPrice === Math.max(...p.offers.map((o) => o.price))),
  );
  check(`${label}: retailerCount equals the offers shown`, products.every((p) => p.retailerCount === p.offers.length));
  check(`${label}: spread equals highest − lowest`, products.every((p) => Math.abs(p.spread - (p.highestPrice - p.lowestPrice)) < 0.005));
  check(`${label}: offers sorted cheapest first`, products.every((p) => p.offers.every((o, i) => i === 0 || p.offers[i - 1].price <= o.price)));
  check(
    `${label}: no retailer appears twice within one product`,
    products.every((p) => new Set(p.offers.map((o) => o.retailer)).size === p.offers.length),
  );
  check(
    `${label}: hasMajorRetailer agrees with the offers shown`,
    products.every((p) => p.hasMajorRetailer === p.offers.some((o) => o.retailerKey !== null && MAJORS.includes(o.retailerKey))),
  );
}

async function expectProviderError(fn: () => Promise<unknown>): Promise<ProviderError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof ProviderError ? err : null;
  }
}

/* ------------------------------------------------------------------ */

async function main() {
  process.env.TAVILY_API_KEY = "tvly-test-key";
  for (const k of ["SERPAPI_KEY", "SERPER_API_KEY", "ENABLE_GEMINI_GROUNDED_SEARCH", "GEMINI_API_KEY"]) delete process.env[k];

  /* ============ A. Reading pages ==================================== */

  section("A1. Retailer identification");
  const idCases: [string, string, string | null][] = [
    ["", "https://www.amazon.ca/dp/x", "Amazon.ca"],
    ["", "https://www.walmart.ca/en/ip/x", "Walmart.ca"],
    ["", "https://www.costco.ca/x", "Costco.ca"],
    ["", "https://www.thebay.com/x", "Hudson's Bay"],
    ["", "https://www.canadiantire.ca/x", "Canadian Tire"],
    ["", "https://www.samsonite.ca/x", "Samsonite.ca"],
    ["", "https://www.ebay.ca/itm/1", "eBay.ca"],
    ["", "https://www.bentley.ca/x", "Bentley"],
    ["", "https://www.londondrugs.com/x", "London Drugs"],
    ["Walmart Canada", "", "Walmart.ca"],
    ["", "https://www.luggagedepot.ca/x", null],
  ];
  for (const [source, url, expected] of idCases) {
    const got = matchRetailer(source, url);
    check(`${source || url} → ${expected ?? "null"}`, got === expected, `got ${got}`);
  }

  section("A2. Only Canadian storefronts count");
  const storefronts: [string, string, boolean][] = [
    ["https://www.amazon.ca/dp/X", "", true],
    ["https://www.thebay.com/p", "", true],
    ["https://www.londondrugs.com/p", "", true],
    ["https://www.amazon.com/dp/X", "$179.99", false],
    ["https://www.samsonite.com/p", "CA$229.99", false],
    ["https://www.rimowa.com/ca/en/luggage/123.html", "", true],
    ["https://www.travelpro.com/p", "$219.00", false],
    ["https://www.travelpro.com/p", "CA$219.00", true],
    ["https://www.bagagesmira.com/p", "Prix 179,95 $", true],
  ];
  for (const [url, text, expected] of storefronts) {
    check(`${url}${text ? ` ("${text}")` : ""} → ${expected ? "Canadian" : "rejected"}`, isCanadianStorefront(url, text) === expected);
  }

  section("A3. Picking THE price from a real-looking page");
  const priceCases: [string, string, string, number | null][] = [
    [
      "Amazon: list price and savings around the real price",
      "Samsonite Freeform Carry-On",
      "Samsonite Freeform Carry-On Spinner\nList Price: $299.99\nPrice: $229.99\nYou Save: $70.00 (23%)\nFREE delivery",
      229.99,
    ],
    ["Was / Now", "Samsonite Freeform 28", "Samsonite Freeform 28\nWas $329.99\nNow $279.99", 279.99],
    [
      "Instalments are not the price",
      "Samsonite Omni PC 20",
      "Samsonite Omni PC 20 Hardside\n$149.99\nor 4 payments of $37.50\nas low as $14/mo with Affirm",
      149.99,
    ],
    [
      "Shipping threshold before the product is ignored",
      "Travelpro Maxlite 5",
      "Free shipping on orders over $75\nTravelpro Maxlite 5 21\" Carry-On\n$219.00\nAdd to cart",
      219.0,
    ],
    ["French-Canadian format", "Samsonite Omni PC 20", "Samsonite Omni PC 20 po\nPrix 164,97 $\nAjouter au panier", 164.97],
    ["Thousands separator", "TUMI Alpha 3 International", "TUMI Alpha 3 International Carry-On\nPrice $1,129.00", 1129.0],
    [
      "Only 'customers also viewed' prices → no price",
      "Samsonite Winfield 3",
      "Samsonite Winfield 3 DLX Spinner\nSee price in cart\nCustomers also viewed\nWinfield 2 $199.99\nOmni $149.99",
      null,
    ],
    ["USD is never a Canadian price", "Samsonite Freeform", "Samsonite Freeform Spinner\nUS$179.99", null],
    ["A variant range with no single price → none", "Samsonite Ziplite", "Choose a size: from $199.99 to $249.99", null],
  ];
  for (const [label, title, text, expected] of priceCases) {
    const got = pickListingPrice(text, title);
    check(`${label} → ${expected ?? "no price"}`, (got?.price ?? null) === expected, `got ${got?.price ?? "null"}`);
  }

  section("A4. Whole-page decisions");
  {
    const category = analyzePage({
      url: "https://www.samsonite.ca/collections/carry-on-luggage",
      title: "Carry-On Luggage | Samsonite Canada",
      content: "",
      rawContent: Array.from({ length: 10 }, (_, i) => `Bag ${i} $${199 + i * 10}.99`).join("\n"),
    });
    check("category page with many prices → skipped", category.offer === null, category.reason ?? "");

    const brandSuffix = analyzePage({
      url: "https://www.luggagedepot.ca/products/freeform-21",
      title: "Samsonite Freeform 21 - Samsonite | Luggage Depot",
      content: "Samsonite Freeform 21 Sale price $239.00",
      rawContent: null,
    });
    check(
      "a reseller's page is credited to the reseller, not the brand in its title",
      brandSuffix.offer?.retailer === "Luggage Depot" && brandSuffix.offer?.retailerKey === null,
      `${brandSuffix.offer?.retailer} / ${brandSuffix.offer?.retailerKey}`,
    );

    const oos = analyzePage({
      url: "https://www.bestbuy.ca/en-ca/product/samsonite-omni/1234567",
      title: "Samsonite Omni PC 24 Spinner | Best Buy Canada",
      content: "",
      rawContent: "Samsonite Omni PC 24 Spinner\nSale price $199.99\nSold out online",
    });
    check("'sold out' is reported as out of stock", oos.offer?.inStock === false);

    const amazonTitle = cleanPageTitle("Samsonite Freeform Hardside Expandable Spinner : Amazon.ca: Luggage & Bags");
    check("Amazon page title cleaned", amazonTitle.name === "Samsonite Freeform Hardside Expandable Spinner", amazonTitle.name);
    const walmartTitle = cleanPageTitle('Samsonite Winfield 2 28" Spinner | Walmart Canada');
    check("Walmart page title cleaned", walmartTitle.name === 'Samsonite Winfield 2 28" Spinner' && walmartTitle.site === "Walmart Canada");
  }

  section("A5. Specs from the same page (no extra searches)");
  {
    const d = extractDetails(
      "Samsonite Freeform Carry-On\nDimensions: 21.5 x 15 x 9 in\nItem weight: 6.8 lbs\nCapacity 41 L\n" +
        "Polycarbonate shell with 4 spinner wheels. Expandable. TSA lock. 10-year limited warranty.\n" +
        "Airline checked bag weight limit 50 lb",
      "Samsonite Freeform Carry-On",
    );
    check("dimensions", d?.dimensions === "21.5 x 15 x 9 in", d?.dimensions);
    check("weight (and NOT the airline weight limit)", d?.weight === "6.8 lb", d?.weight);
    check("capacity", d?.capacity === "41 L", d?.capacity);
    check("material", d?.material === "Polycarbonate", d?.material);
    check("wheels", d?.wheels === "Spinner (4 wheels)", d?.wheels);
    check("expandable + TSA lock", d?.expandable === true && d?.tsaLock === true);
    check("warranty", d?.warranty === "10-year", d?.warranty);
    check("a page with no specs yields none", extractDetails("Samsonite bag $99.99", "Samsonite bag") === undefined || !extractDetails("Samsonite bag $99.99", "Samsonite bag")?.weight);
  }

  /* ============ B. The Tavily client: cost and reliability ========== */

  section("B1. The request itself — cheapest settings, key in a header only");
  installStub();
  await search("samsonite carry on luggage");
  {
    const body = calls.bodies.find((b) => b.include_domains_mode === "prefer") ?? {};
    const headers = calls.headers[0];
    check("two searches for one lookup (general + major chains), sent together", calls.search === 2, `${calls.search}`);
    const sweep = calls.bodies.find((b) => b.include_domains_mode === "restrict");
    const sweepDomains = (sweep?.include_domains as string[] | undefined) ?? [];
    check("second search is restricted to the big chains", sweepDomains.includes("walmart.ca") && sweepDomains.includes("amazon.ca") && sweepDomains.includes("bestbuy.ca"), sweepDomains.join(","));
    check("…without the brand store (it leads the general search already)", !sweepDomains.includes("samsonite.ca"));
    check("…and without any US storefront", !sweepDomains.some((d) => d.endsWith(".com") && !["thebay.com", "hbc.com", "hudsonsbay.com", "londondrugs.com"].includes(d)), sweepDomains.join(","));
    check("…at the same 1-credit depth", sweep?.search_depth === "basic" && sweep?.auto_parameters === false);
    check("search_depth is basic (1 credit)", body.search_depth === "basic", String(body.search_depth));
    check("auto_parameters is off (it can silently double the cost)", body.auto_parameters === false);
    check("include_usage is on (real cost is metered)", body.include_usage === true);
    check("20 results for the price of 1", body.max_results === 20);
    check("page text requested — price AND specs from one call", body.include_raw_content === "text");
    check("country is canada", body.country === "canada");
    check("Canadian retailers preferred, not required", body.include_domains_mode === "prefer" && Array.isArray(body.include_domains));
    check("US storefronts excluded up front", Array.isArray(body.exclude_domains) && (body.exclude_domains as string[]).includes("amazon.com"));
    check("no answer/images requested", body.include_answer === false && body.include_images === false);
    check("API key sent as a Bearer header", headers?.get("authorization") === "Bearer tvly-test-key");
    check("API key never in the body", !JSON.stringify(body).includes("tvly-test-key"));
  }

  section("B2. Credits are metered from Tavily's own figure");
  installStub({ search: () => tavilyJson(PAGES, 1) });
  await tavilySearch({ query: "credit test one" });
  check("1 credit recorded", tavilyCreditStatus().usedEstimate === 1, `${tavilyCreditStatus().usedEstimate}`);
  installStub({ search: () => tavilyJson(PAGES, 2) });
  await tavilySearch({ query: "credit test two" });
  check("a call Tavily says cost 2 is recorded as 2", tavilyCreditStatus().usedEstimate === 2, `${tavilyCreditStatus().usedEstimate}`);

  section("B3. A repeat question costs nothing");
  installStub();
  await search("samsonite luggage");
  await search("samsonite luggage");
  check("same search twice → the 2 searches are sent once", calls.search === 2, `${calls.search}`);
  await search("Luggage  SAMSONITE!");
  check("different word order / casing / punctuation → still no new call", calls.search === 2, `${calls.search}`);
  check("credits spent: 2", tavilyCreditStatus().usedEstimate === 2, `${tavilyCreditStatus().usedEstimate}`);

  section("B4. Two identical searches at once share one call");
  installStub({
    search: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return tavilyJson(PAGES);
    },
  });
  await Promise.all([search("travelpro maxlite"), search("travelpro maxlite")]);
  check("concurrent duplicates → sent once (2 searches, not 4)", calls.search === 2, `${calls.search}`);

  section("B5. An empty answer isn't bought twice");
  installStub({ search: () => tavilyJson([]) });
  await tavilySearch({ query: "zzqx nothing here" });
  await tavilySearch({ query: "zzqx nothing here" });
  check("empty result cached briefly → 1 HTTP call", calls.search === 1, `${calls.search}`);

  section("B6. The monthly cap refuses BEFORE any request is sent");
  process.env.TAVILY_MONTHLY_CREDIT_CAP = "3";
  installStub();
  await tavilySearch({ query: "cap one" });
  await tavilySearch({ query: "cap two" });
  await tavilySearch({ query: "cap three" });
  const before = calls.search;
  const capErr = await expectProviderError(() => tavilySearch({ query: "cap four" }));
  check("4th call refused at a cap of 3", capErr?.kind === "quota", capErr?.message);
  check("…and no HTTP request was made", calls.search === before, `${calls.search - before} extra`);
  check("…and the user is told nothing was charged", /nothing is charged/i.test(capErr?.userMessage ?? ""), capErr?.userMessage);
  const viaSearch = await search("cap five").then(() => null, (e: Error) => e.message);
  check("the search page gets a clear message, not a crash", !!viaSearch && /credit|allowance/i.test(viaSearch), viaSearch ?? "");
  delete process.env.TAVILY_MONTHLY_CREDIT_CAP;

  section("B7. Tavily's own usage figure is honoured");
  installStub({
    usage: () =>
      new Response(JSON.stringify({ key: { usage: 949, limit: null }, account: { current_plan: "Researcher", plan_usage: 949, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }), { status: 200 }),
  });
  await tavilySearch({ query: "usage one" });
  check("949 used + 1 = 950 → allowed (cap 950)", calls.search === 1, `${calls.search}`);
  const overErr = await expectProviderError(() => tavilySearch({ query: "usage two" }));
  check("the next call is refused locally", overErr?.kind === "quota" && calls.search === 1, overErr?.message);
  check("status reads from Tavily", tavilyCreditStatus().source === "tavily");
  check("/usage fetched once, not per search", calls.usage === 1, `${calls.usage}`);

  section("B8. Pay-as-you-go ON → research refuses to run at all");
  installStub({
    usage: () =>
      new Response(JSON.stringify({ key: { usage: 10 }, account: { plan_usage: 10, plan_limit: 1000, paygo_usage: 0, paygo_limit: 100 } }), { status: 200 }),
  });
  {
    const e = await expectProviderError(() => tavilySearch({ query: "paygo" }));
    check("paygo detected", tavilyCreditStatus().paygoEnabled === true);
    check("refused even with 990 free credits left", e?.kind === "policy" && calls.search === 0, `${e?.kind}, ${calls.search} sent`);
    check("tells you exactly what to switch off", /turn pay-as-you-go off/i.test(e?.userMessage ?? ""), e?.userMessage);
  }

  section("B9. Out of credits (432 / 433) — no retry, then stop asking");
  installStub({ search: () => tavilyError(432, "This request exceeds your plan's set usage limit.") });
  const e432 = await expectProviderError(() => tavilySearch({ query: "limit" }));
  check("432 → quota error", e432?.kind === "quota");
  check("432 is not retried", calls.search === 1, `${calls.search}`);
  await expectProviderError(() => tavilySearch({ query: "limit again" }));
  check("the next call is refused without asking Tavily again", calls.search === 1, `${calls.search}`);
  installStub({ search: () => tavilyError(433, "PayGo limit exceeded") });
  const e433 = await expectProviderError(() => tavilySearch({ query: "paygo limit" }));
  check("433 → quota error, not retried", e433?.kind === "quota" && calls.search === 1);

  section("B10. Bad key (401) — clear message, no retry");
  installStub({ search: () => tavilyError(401, "Unauthorized: missing or invalid API key.") });
  const e401 = await expectProviderError(() => tavilySearch({ query: "auth" }));
  check("401 → auth error", e401?.kind === "auth");
  check("401 not retried", calls.search === 1);
  check("message points at TAVILY_API_KEY", /TAVILY_API_KEY/.test(e401?.message ?? ""), e401?.message);
  check("no credit counted for a rejected key", tavilyCreditStatus().usedEstimate === 0);

  section("B10b. Blocked by a firewall/proxy (403) — not blamed on the key");
  installStub({ search: () => new Response("Host not in allowlist: api.tavily.com", { status: 403 }) });
  const e403 = await expectProviderError(() => tavilySearch({ query: "blocked" }));
  check("403 → network, not auth", e403?.kind === "network", e403?.kind);
  check("message mentions firewall/proxy", /firewall|proxy|VPN/i.test(e403?.message ?? ""), e403?.message);
  check("no credit counted", tavilyCreditStatus().usedEstimate === 0);

  section("B11. Rate limited (429) — wait Retry-After once, then succeed");
  {
    let n = 0;
    installStub({ search: () => (++n === 1 ? tavilyError(429, "Too many requests", { "retry-after": "1" }) : tavilyJson(PAGES)) });
    const started = Date.now();
    const r = await tavilySearch({ query: "rate limited" });
    check("retried once and succeeded", calls.search === 2 && r.results.length > 0, `${calls.search} calls`);
    check("waited for Retry-After (~1s)", Date.now() - started >= 900, `${Date.now() - started}ms`);
    check("only the successful call is counted", tavilyCreditStatus().usedEstimate === 1, `${tavilyCreditStatus().usedEstimate}`);
  }
  installStub({ search: () => tavilyError(429, "Too many requests", { "retry-after": "1" }) });
  const e429 = await expectProviderError(() => tavilySearch({ query: "still limited" }));
  check("persistent 429 → gives up after one retry", e429?.kind === "rate_limit" && calls.search === 2, `${calls.search}`);
  check("…with a plain message", /wait a few seconds/i.test(e429?.userMessage ?? ""));

  section("B12. Rejected option (400) — resent once with essentials only");
  {
    let n = 0;
    installStub({ search: () => (++n === 1 ? tavilyError(400, "include_domains_mode is not a valid option") : tavilyJson(PAGES)) });
    const r = await tavilySearch({ query: "bad option", includeDomains: ["amazon.ca"], includeDomainsMode: "prefer", chunksPerSource: 3 });
    check("recovered on the second attempt", r.results.length > 0 && calls.search === 2);
    check("the retry dropped the optional options", !("include_domains" in (calls.bodies[1] ?? {})) && !("chunks_per_source" in (calls.bodies[1] ?? {})));
    check("the retry kept the cost-critical settings", calls.bodies[1]?.search_depth === "basic" && calls.bodies[1]?.auto_parameters === false);
  }

  section("B13. Server error (5xx) — one retry");
  {
    let n = 0;
    installStub({ search: () => (++n === 1 ? tavilyError(502, "Bad gateway") : tavilyJson(PAGES)) });
    const r = await tavilySearch({ query: "flaky" });
    check("recovered after one 5xx", r.results.length > 0 && calls.search === 2);
  }

  section("B14. Timeout — bounded, clear error");
  process.env.TAVILY_TIMEOUT_MS = "1000";
  installStub({ search: (_b, init) => hangUntilAborted(init) });
  {
    const started = Date.now();
    const eTimeout = await expectProviderError(() => tavilySearch({ query: "slow" }));
    const elapsed = Date.now() - started;
    check("timeout → timeout error", eTimeout?.kind === "timeout", eTimeout?.message);
    check("a timeout is NOT retried (it may already have been billed)", calls.search === 1, `${calls.search} calls`);
    check("gave up in bounded time", elapsed < 2_500, `${elapsed}ms`);
  }
  delete process.env.TAVILY_TIMEOUT_MS;

  section("B14b. Balance can't be confirmed → no request is sent");
  installStub({ usage: () => new Response("upstream error", { status: 500 }) });
  {
    const e = await expectProviderError(() => tavilySearch({ query: "unverified" }));
    check("refused", !!e, e?.message);
    check("no research request was sent", calls.search === 0, `${calls.search}`);
    check("the message says why", /couldn't confirm/i.test(e?.message ?? ""), e?.message);
    check("/usage isn't hammered (retried at most once a minute)", (await expectProviderError(() => tavilySearch({ query: "unverified 2" })), calls.usage === 1), `${calls.usage}`);
  }
  installStub({ usage: () => new Response(JSON.stringify({ detail: { error: "Unauthorized" } }), { status: 401 }) });
  {
    const e = await expectProviderError(() => tavilySearch({ query: "bad key usage" }));
    check("a rejected key on /usage is reported as a key problem", e?.kind === "auth" && calls.search === 0, `${e?.kind}`);
  }
  installStub({ usage: () => new Response(JSON.stringify({ something: "else" }), { status: 200 }) });
  {
    const e = await expectProviderError(() => tavilySearch({ query: "odd usage shape" }));
    check("a /usage reply without a usage figure confirms nothing → refused", !!e && calls.search === 0, e?.message);
  }

  section("B14c. Concurrent searches can't squeeze past the last credit");
  installStub({
    usage: () => usageJson(949),
    search: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return tavilyJson(PAGES);
    },
  });
  {
    const outcomes = await Promise.allSettled([
      tavilySearch({ query: "race one" }),
      tavilySearch({ query: "race two" }),
      tavilySearch({ query: "race three" }),
    ]);
    const sent = calls.search;
    const refused = outcomes.filter((o) => o.status === "rejected").length;
    check("only 1 of 3 simultaneous calls was sent (949 used, cap 950)", sent === 1, `${sent} sent`);
    check("the other 2 were refused locally", refused === 2, `${refused} refused`);
  }

  section("B14d. 433 (pay-as-you-go cap) pauses research for the month");
  installStub({ search: () => tavilyError(433, "PayGo limit exceeded") });
  {
    await expectProviderError(() => tavilySearch({ query: "paygo hit" }));
    const again = await expectProviderError(() => tavilySearch({ query: "paygo again" }));
    check("the next call is refused without a request", again?.kind === "quota" && calls.search === 1, `${calls.search}`);
  }

  section("B15. Depth is only ever raised on purpose");
  process.env.TAVILY_SEARCH_DEPTH = "advanced";
  installStub({ search: () => tavilyJson(PAGES, 2) });
  await search("depth check advanced");
  check("TAVILY_SEARCH_DEPTH=advanced is honoured", calls.bodies[0]?.search_depth === "advanced");
  process.env.TAVILY_SEARCH_DEPTH = "ultra-expensive";
  installStub();
  await search("depth check junk");
  check("an unknown depth falls back to basic", calls.bodies[0]?.search_depth === "basic");
  delete process.env.TAVILY_SEARCH_DEPTH;

  /* ============ C. The full search pipeline ========================= */

  section("C1. Full pipeline — no Gemini (heuristic grouping)");
  installStub();
  const heuristic = await search("samsonite carry on luggage");
  show(heuristic.products);
  check("two Tavily searches, nothing else", calls.search === 2, `${calls.search}`);
  check("provider reported as tavily", heuristic.provider === "tavily");
  check("16 of 22 pages became offers (6 junk pages rejected)", heuristic.offersFound === 16, `got ${heuristic.offersFound}`);
  check("returned products", heuristic.products.length > 0);
  checkProductInvariants(heuristic.products, "heuristic");
  {
    const ff21 = heuristic.products.find((p) => /freeform/i.test(p.name) && p.size === "21 inch");
    check("heuristic groups the 21\" Freeform across retailers", (ff21?.retailerCount ?? 0) >= 5, `${ff21?.retailerCount}`);
    const maxlite = heuristic.products.find((p) => /maxlite/i.test(p.name));
    check("a brand that is also a retailer keeps its name (Travelpro)", /^Travelpro\b/.test(maxlite?.name ?? "") && maxlite?.brand === "Travelpro", `${maxlite?.name} / ${maxlite?.brand}`);
    const ff28 = heuristic.products.filter((p) => /freeform/i.test(p.name) && p.size === "28 inch");
    check("…and the 28\" listings into one product", ff28.length === 1 && ff28[0].retailerCount === 3, `${ff28.length} products`);
  }

  section("C2. Full pipeline — Gemini grouping (opt-in)");
  process.env.GEMINI_API_KEY = "test-key";
  process.env.SEARCH_AI_GROUPING = "true";
  installStub({ gemini: true });
  const llm = await search("samsonite carry on luggage");
  show(llm.products);
  checkProductInvariants(llm.products, "llm");
  const ff21 = llm.products.find((p) => /freeform/i.test(p.name) && p.size === "21 inch");
  check("the same suitcase at 6 retailers became ONE product", !!ff21);
  check(
    "  …Amazon's duplicate listing deduped to the cheaper one",
    ff21?.offers.filter((o) => o.retailer === "Amazon.ca").length === 1 && ff21?.offers.find((o) => o.retailer === "Amazon.ca")?.price === 229.99,
  );
  check("  …6 retailers, cheapest $198.50 (eBay.ca)", ff21?.retailerCount === 6 && ff21?.lowestPrice === 198.5, `${ff21?.retailerCount}, ${ff21?.lowestPrice}`);
  check("the 28\" stayed a SEPARATE product", !!llm.products.find((p) => /freeform/i.test(p.name) && p.size === "28 inch"));
  check("the listing Gemini forgot (Travelpro) was recovered", llm.products.some((p) => p.offers.some((o) => o.retailerKey === "Travelpro")));
  const shown = llm.products.reduce((n, p) => n + p.offers.length, 0);
  check("no real listing vanished", shown === 15, `${shown} shown (16 found, 1 Amazon duplicate)`);
  check("full matches ranked cheapest first", isAscending(llm.products.filter((p) => (p.relevance ?? 1) >= 0.99).map((p) => p.lowestPrice)));
  delete process.env.GEMINI_API_KEY;
  delete process.env.SEARCH_AI_GROUPING;

  section("C3. Retailer settings filter");
  installStub();
  const filtered = await search("samsonite carry on luggage", { allowedRetailers: ["Amazon.ca", "Walmart.ca"] });
  const keys = new Set(filtered.products.flatMap((p) => p.offers.map((o) => o.retailerKey)));
  check("disabled retailers are gone", !keys.has("Costco.ca") && !keys.has("Hudson's Bay"), [...keys].join(", "));
  check("unrecognised retailers are kept", keys.has(null));
  checkProductInvariants(filtered.products, "filtered");

  section("C4. Price ceiling from the query");
  installStub();
  const cheap = await search("samsonite carry on under $200");
  check("maxPrice parsed", cheap.intent.maxPrice === 200, `${cheap.intent.maxPrice}`);
  check("'under $200' stripped from the research query", !/200|under/i.test(String(calls.bodies[0]?.query)), String(calls.bodies[0]?.query));
  check("every product shown is under $200", cheap.products.every((p) => p.lowestPrice <= 200));

  section("C5. Specs attached to products");
  installStub({
    search: () =>
      tavilyJson([
        productPage({ name: "Samsonite Omni PC 24 Spinner", site: "Samsonite Canada", url: "https://www.samsonite.ca/omni-pc-24/1001.html", price: "$219.99", extra: "Dimensions: 27 x 18.5 x 11 in\nWeight: 9.5 lbs\nPolycarbonate. Expandable. TSA lock. 10-year warranty." }),
        productPage({ name: "Samsonite Omni PC 24 Spinner", site: "Walmart Canada", url: "https://www.walmart.ca/en/ip/omni-pc-24/600111", price: "$199.97" }),
      ]),
  });
  const withSpecs = await search("samsonite omni pc 24");
  const omni = withSpecs.products[0];
  check("one product, two retailers", withSpecs.products.length === 1 && omni?.retailerCount === 2);
  check("specs merged onto the product", omni?.details?.dimensions === "27 x 18.5 x 11 in" && omni?.details?.weight === "9.5 lb", JSON.stringify(omni?.details));
  check("specs cost no extra call", calls.search === 2 && calls.extract === 0, `${calls.search} searches, ${calls.extract} reads`);

  section("C6. Nothing found → ONE broader query, then stop");
  {
    installStub({
      search: (body) => {
        const words = String(body.query).split(/\s+/).length;
        return words > 4
          ? tavilyJson([])
          : tavilyJson([
              productPage({ name: 'Samsonite Rhapsody 360 Spinner Expandable Medium 25"', site: "Amazon.ca", url: "https://www.amazon.ca/dp/RHAP1", price: "$329.99" }),
              productPage({ name: "Samsonite Rhapsody 360 Medium Spinner", site: "Hudson's Bay", url: "https://www.thebay.com/product/rhapsody-360", price: "$379.99" }),
            ]);
      },
    });
    const r = await search("Samsonite Rhapsody 360 Spinner Expandable Medium Luggage Black");
    check("recovered with a broader query", r.products.length > 0);
    check("one broader rung at most (2 searches per rung)", calls.search === 4, `${calls.search}`);
    check("the user is told the wording changed", r.warnings.some((w) => /instead/i.test(w)), r.warnings.join(" | "));
    checkProductInvariants(r.products, "broadened");
  }

  section("C7. Pages found but no readable price → NO extra credit spent");
  installStub({
    search: () =>
      tavilyJson([
        { title: "Best carry-on luggage 2026 | Travel blog", url: "https://travelblog.ca/best-carry-on", content: "Our favourite carry-ons this year", score: 0.7, raw_content: "Our favourite carry-ons this year, reviewed." },
        { title: "Samsonite Freeform review", url: "https://reviews.ca/freeform", content: "A solid bag.", score: 0.6, raw_content: "A solid bag with good wheels." },
      ]),
  });
  {
    const r = await search("samsonite freeform review");
    check("no broadening when pages exist", calls.search === 2, `${calls.search}`);
    check("explains what happened", r.warnings.some((w) => /none showed a clear Canadian price/i.test(w)), r.warnings.join(" | "));
    check("returns empty, not fake", r.products.length === 0);
  }

  section("C8. Genuinely nothing anywhere");
  installStub({ search: () => tavilyJson([]) });
  {
    const r = await search("Zzzqx Nonexistent 9000 Spinner Purple");
    check("empty result, not an error", r.products.length === 0);
    check("never more than 2 rungs (4 searches)", calls.search <= 4, `${calls.search}`);
    check("tells the user what to type", r.warnings.some((w) => /Try just the brand and model/i.test(w)), r.warnings.join(" | "));
  }

  section("C9. catalog keeps colours apart; compare merges them");
  {
    const variants = ["Black", "Teal", "Burgundy"].map((c, i) =>
      productPage({ name: `Samsonite Omni PC 20" Spinner Carry-On ${c}`, site: i === 2 ? "Walmart Canada" : "Amazon.ca", url: i === 2 ? "https://www.walmart.ca/en/ip/v3/600300" : `https://www.amazon.ca/dp/V${i}`, price: `$${[149.99, 159.99, 154.99][i]}` }),
    );
    installStub({ search: () => tavilyJson(variants) });
    const compare = await search("Samsonite Omni PC 20", { mode: "compare" });
    const catalog = await search("Samsonite Omni PC 20", { mode: "catalog" });
    check("compare merges the three colours", compare.products.length === 1, `${compare.products.length}`);
    check("catalog lists all three", catalog.products.length === 3, `${catalog.products.length}`);
    check("catalog products name their colour", catalog.products.every((p) => p.color.length > 0));
    checkProductInvariants(catalog.products, "catalog");
  }

  section("C10. 13 retailers for one bag — capped at 10, majors kept");
  {
    const many: [string, string, string][] = [
      ["Amazon.ca", "https://www.amazon.ca/dp/A", "$229.99"],
      ["Walmart Canada", "https://www.walmart.ca/en/ip/a/600001", "$249.99"],
      ["Costco", "https://www.costco.ca/a.product.100001.html", "$239.99"],
      ["Hudson's Bay", "https://www.thebay.com/product/a", "$264.00"],
      ["Canadian Tire", "https://www.canadiantire.ca/en/pdp/a-0001p.html", "$269.99"],
      ["Bentley", "https://www.bentley.ca/en/a", "$259.99"],
      ["London Drugs", "https://www.londondrugs.com/a/L1.html", "$274.99"],
      ["Best Buy Canada", "https://www.bestbuy.ca/en-ca/product/a/1000001", "$254.99"],
      ["Samsonite Canada", "https://www.samsonite.ca/a/1.html", "$279.99"],
      ["eBay", "https://www.ebay.ca/itm/1", "$198.50"],
      ["Travelpro", "https://www.travelpro.com/products/a", "CA$289.99"],
      ["Luggage Depot", "https://www.luggagedepot.ca/products/a", "$234.00"],
      ["Bag King", "https://bagking.ca/products/a", "$349.00"],
    ];
    installStub({ search: () => tavilyJson(many.map(([site, url, price]) => productPage({ name: 'Samsonite Freeform Hardside Spinner Carry-On 21"', site, url, price }))) });
    const capped = await search("samsonite freeform 21");
    const big = capped.products[0];
    show([big]);
    check("capped at 10", big.offers.length === 10, `${big.offers.length}`);
    check("all 8 majors survived", MAJORS.every((k) => big.offers.some((o) => o.retailerKey === k)));
    check("cheapest ($198.50) kept", big.offers.some((o) => o.price === 198.5));
    checkProductInvariants([big], "capped");
  }

  section("C11. A misread price is dropped, not shown as a 'deal'");
  installStub({
    search: () =>
      tavilyJson([
        productPage({ name: "Samsonite Winfield 3 DLX Medium", site: "Amazon.ca", url: "https://www.amazon.ca/dp/W1", price: "$299.99" }),
        productPage({ name: "Samsonite Winfield 3 DLX Medium", site: "Walmart Canada", url: "https://www.walmart.ca/en/ip/w/600010", price: "$319.99" }),
        productPage({ name: "Samsonite Winfield 3 DLX Medium", site: "Bentley", url: "https://www.bentley.ca/en/w", price: "$309.99" }),
        productPage({ name: "Samsonite Winfield 3 DLX Medium", site: "Some Shop", url: "https://someshop.ca/products/w", price: "$29.99" }),
      ]),
  });
  {
    const r = await search("samsonite winfield 3 dlx medium");
    check("$29.99 among ~$300 prices is discarded", r.products[0]?.lowestPrice === 299.99, `${r.products[0]?.lowestPrice}`);
  }

  section("C12. Gemini hanging never starves the research call");
  process.env.GEMINI_API_KEY = "test-key";
  process.env.SEARCH_AI_GROUPING = "true";
  process.env.SEARCH_BUDGET_MS = "50000";
  installStub({ geminiHangs: true });
  {
    const started = Date.now();
    const r = await search("Samsonite Rhapsody 360");
    const elapsed = Date.now() - started;
    check("research still returned real prices", r.products.length > 0);
    check("Gemini tried once, not once per model", calls.gemini === 1, `${calls.gemini}`);
    check("finished inside the budget", elapsed < 20_000, `${elapsed}ms`);
    const { geminiCircuitOpen } = await import("../src/lib/gemini");
    check("Gemini breaker opened", geminiCircuitOpen());
  }
  delete process.env.SEARCH_BUDGET_MS;
  delete process.env.GEMINI_API_KEY;
  delete process.env.SEARCH_AI_GROUPING;

  section("C13. A hanging database never blocks research");
  process.env.SEARCH_DB_TIMEOUT_MS = "300";
  installStub();
  {
    const never = () => new Promise(() => {});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hangingDb = { rpc: never, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: never, eq: () => ({ maybeSingle: never }) }) }), upsert: never }) } as any;
    const started = Date.now();
    const r = await search("samsonite carry on luggage", { db: hangingDb });
    const elapsed = Date.now() - started;
    check("completed despite the database hanging", r.products.length > 0);
    check("wasn't held up by it", elapsed < 3_000, `${elapsed}ms`);
  }
  delete process.env.SEARCH_DB_TIMEOUT_MS;

  section("C14. No provider key → clear setup message");
  delete process.env.TAVILY_API_KEY;
  installStub();
  {
    const msg = await search("anything").then(() => "", (e: Error) => e.message);
    check("tells you to add TAVILY_API_KEY", /TAVILY_API_KEY/.test(msg), msg);
    check("no call attempted", calls.search === 0);
  }
  process.env.TAVILY_API_KEY = "tvly-test-key";

  /* ============ E. A REAL Tavily response ============================ */

  section("E1. Real response (samsonite freeform 21) — page by page");
  const realFixture = JSON.parse(
    readFileSync(resolve("scripts/fixtures/tavily-samsonite-freeform-21.json"), "utf8"),
  ) as { results: TavilyRow[] };
  {
    const { analyzeResults } = await import("../src/lib/search/providers/tavily");
    const analysed = analyzeResults(
      realFixture.results.map((r) => ({ title: r.title, url: r.url, content: r.content, score: r.score, rawContent: r.raw_content })),
    );
    const byUrl = (part: string) => analysed.find((a) => a.url.includes(part));

    const expectAccepted: [string, number, string][] = [
      ["B01M0A3BKH", 191.49, "Amazon.ca"],
      ["B07BKLHKD9", 100.24, "Amazon.ca"],
      ["88379XXXX", 320.0, "Samsonite.ca"],
    ];
    for (const [part, price, retailer] of expectAccepted) {
      const a = byUrl(part);
      check(`${retailer} ${part} → $${price.toFixed(2)}`, a?.offer?.price === price && a?.offer?.retailer === retailer, `${a?.offer?.price ?? a?.reason}`);
    }

    const expectRejected: [string, string][] = [
      ["luggageonline.com", "US store"],
      ["luxurycheckin.com", "US review blog"],
      ["ebay.ca/b/", "eBay browse page ($138.47 was one listing among many)"],
      ["/en/samsonite/freeform", "collection page"],
      ["88386XXXX", "3-piece set: $50/$16 are accessories, set's own price not in excerpt"],
      ["88384XXXX", "Freeform Large: $35 sits after a '...' gap, beside an RFID passport"],
      ["https://www.samsonite.ca", "home page"],
      ["https://www.samsonite.ca/en/luggage/carry-on", "category page"],
      ["/en/luggage/sets", "category page with a '$150 - $299.99' price filter"],
      ["lock-instructions", "help page"],
      ["travelpro.com", "US site"],
    ];
    for (const [part, why] of expectRejected) {
      const a = part.startsWith("https://") ? analysed.find((x) => x.url.replace(/\/$/, "") === part) : byUrl(part);
      check(`rejected: ${why}`, !!a && a.offer === null, a?.offer ? `accepted at $${a.offer.price}` : "not found");
    }

    const samsonite = byUrl("88379XXXX")?.offer;
    check("brand store title gets its brand back", samsonite?.title.startsWith("Samsonite ") === true, samsonite?.title);
  }

  section("E2. Real response through the whole pipeline");
  installStub({ search: () => tavilyJson(realFixture.results) });
  {
    const r = await search("samsonite freeform 21");
    show(r.products);
    check("the three real listings group into ONE product", r.products.length === 1, `${r.products.length} products`);
    const p = r.products[0];
    check("…carried by Amazon.ca and Samsonite.ca", !!p && p.offers.some((o) => o.retailer === "Amazon.ca") && p.offers.some((o) => o.retailer === "Samsonite.ca"));
    check("no $35 / $50 / $150 accessory or filter prices anywhere", r.products.every((x) => x.offers.every((o) => o.price >= 90)));
    checkProductInvariants(r.products, "real");
  }

  /* ============ D. Separation from the Add Product workflow ========= */

  /* ============ F. More stores: brand store, big chains, page reading = */

  const OUTLINE_SAMSONITE = "https://www.samsonite.ca/en/luggage/carry-on/outline-pro-carry-on-spinner/1330471041.html";
  const OUTLINE_WALMART = "https://www.walmart.ca/en/ip/samsonite-outline-pro-carry-on/6000205";
  const OUTLINE_HELP = "https://www.samsonite.ca/en/lock-instructions.html";
  const outlinePages = (): TavilyRow[] => [
    productPage({ name: "Samsonite Outline Pro Spinner Carry-On", site: "Amazon.ca", url: "https://www.amazon.ca/dp/OUTLINE1", price: "$289.95" }),
    { title: "Outline Pro Carry-On Spinner | Samsonite Canada", url: OUTLINE_SAMSONITE, content: "Outline Pro Carry-On Spinner. Ultra-light Roxkin shell with a 10-year warranty.", score: 0.9, raw_content: null },
    { title: "Samsonite Outline Pro Carry-On Spinner - Walmart.ca", url: OUTLINE_WALMART, content: "Samsonite Outline Pro Carry-On Spinner, hardside.", score: 0.8, raw_content: null },
    { title: "Lock instructions | Samsonite", url: OUTLINE_HELP, content: "How to set your TSA lock combination.", score: 0.4, raw_content: null },
    productPage({ name: "Samsonite Outline Pro Luggage Cover Carry-On", site: "Amazon.ca", url: "https://www.amazon.ca/dp/COVER1", price: "$39.99" }),
    productPage({ name: "Samsonite Freeform Carry-On Spinner", site: "Walmart Canada", url: "https://www.walmart.ca/en/ip/freeform/600099", price: "$199.99" }),
  ];
  const samsoniteProductText = [
    "Home / Luggage / Carry-On",
    "Outline Pro Carry-On Spinner",
    "$339.99",
    "Colour: Black Ice Blue Sage",
    "Add to cart",
    "10-year warranty",
    "You may also like",
    "Freeform Carry-On Spinner $249.99",
  ].join("\n");

  section("F1. Store pages without a price are read — brand store first");
  installStub({
    search: () => tavilyJson(outlinePages()),
    extract: () => extractJson([{ url: OUTLINE_SAMSONITE, text: samsoniteProductText }], [OUTLINE_WALMART], 0),
  });
  {
    const partials: SearchProduct[][] = [];
    const r = await search("samsonite outline pro", { onPartial: (p) => partials.push(p.products) });
    show(r.products);
    const urls = (calls.extractBodies[0]?.urls as string[] | undefined) ?? [];
    check("one page-reading call", calls.extract === 1, `${calls.extract}`);
    check("the brand store's page is read first", urls[0] === OUTLINE_SAMSONITE, urls.join(", "));
    check("the Walmart product page is read too", urls.includes(OUTLINE_WALMART));
    check("a help page that isn't the product is NOT read (no credit wasted)", !urls.includes(OUTLINE_HELP));
    check("reading uses basic depth (1 credit per 5 pages)", calls.extractBodies[0]?.extract_depth === "basic");

    const outline = r.products.find((p) => /outline pro/i.test(p.name) && !/cover/i.test(p.name));
    const sam = outline?.offers.find((o) => o.retailer === "Samsonite.ca");
    check("Samsonite.ca price read from its own page", sam?.price === 339.99, `${sam?.price}`);
    check("…next to Amazon, cheapest first", outline?.offers[0]?.retailer === "Amazon.ca" && outline?.lowestPrice === 289.95, outline?.offers.map((o) => `${o.retailer} ${o.price}`).join(", "));
    check("the colours Samsonite offers are listed", ["Black", "Ice Blue", "Sage"].every((c) => outline?.colours?.includes(c)), JSON.stringify(outline?.colours));
    check("the bag is named the way the brand store names it", outline?.name === "Samsonite Outline Pro Carry-On Spinner", outline?.name);
    check("\"You may also like\" prices are ignored", !outline?.offers.some((o) => o.price === 249.99));

    check("first results were sent before the pages were read", partials.length === 1 && !partials[0].some((p) => p.offers.some((o) => o.retailer === "Samsonite.ca")));
    check("the page that couldn't be read is offered as a link, not a price", r.alsoCheck?.some((a) => a.retailer === "Walmart.ca" && a.url === OUTLINE_WALMART) === true, JSON.stringify(r.alsoCheck));
    check("result says it's final", r.phase === "final");

    const cover = r.products.findIndex((p) => /cover/i.test(p.name));
    const freeform = r.products.findIndex((p) => /freeform/i.test(p.name));
    check("a $39.99 cover is NOT merged into the suitcase", !outline?.offers.some((o) => o.price === 39.99));
    check("the searched bag is listed first", r.products[0] === outline, r.products.map((p) => p.name).join(" | "));
    check("a different model (partial match) comes after it", freeform > 0);
    check("the accessory comes last", cover === r.products.length - 1, `${cover} of ${r.products.length}`);
  }

  section("F2. Page reading never crosses the credit cap");
  process.env.TAVILY_MONTHLY_CREDIT_CAP = "2";
  installStub({ search: () => tavilyJson(outlinePages()), extract: () => extractJson([{ url: OUTLINE_SAMSONITE, text: samsoniteProductText }]) });
  {
    const r = await search("samsonite outline pro");
    check("the 2 searches fit the cap and ran", calls.search === 2, `${calls.search}`);
    check("reading would cross it → not sent at all", calls.extract === 0, `${calls.extract}`);
    check("search results are still shown", r.products.length > 0);
    check("the brand store is offered as a link instead", r.alsoCheck?.some((a) => a.retailer === "Samsonite.ca") === true, JSON.stringify(r.alsoCheck));
  }
  delete process.env.TAVILY_MONTHLY_CREDIT_CAP;

  section("F3. Page reading is billed the way Tavily bills it");
  installStub({ extract: (body) => extractJson(((body.urls as string[]) ?? []).map((url) => ({ url, text: "page" }))) });
  {
    const five = ["a", "b", "c", "d", "e"].map((x) => `https://shop.ca/p/${x}`);
    const r1 = await tavilyExtract({ urls: five });
    check("5 pages read, no usage figure → 1 credit", r1.creditsUsed === 1 && tavilyCreditStatus().usedEstimate === 1, `${r1.creditsUsed}`);
    const r2 = await tavilyExtract({ urls: five });
    check("the same pages again → served from cache, free", r2.creditsUsed === 0 && r2.cachedCount === 5 && calls.extract === 1, `${calls.extract} calls`);
    const three = ["f", "g", "h"].map((x) => `https://shop.ca/p/${x}`);
    await tavilyExtract({ urls: three });
    check("3 more pages → carried, not yet a credit", tavilyCreditStatus().usedEstimate === 1, `${tavilyCreditStatus().usedEstimate}`);
    await tavilyExtract({ urls: ["i", "j"].map((x) => `https://shop.ca/p/${x}`) });
    check("…2 more make 5 → 1 more credit", tavilyCreditStatus().usedEstimate === 2, `${tavilyCreditStatus().usedEstimate}`);
  }
  installStub({ extract: (body) => extractJson([], (body.urls as string[]) ?? []) });
  {
    const r = await tavilyExtract({ urls: ["https://shop.ca/p/fail"] });
    check("pages that fail aren't charged", r.creditsUsed === 0 && tavilyCreditStatus().usedEstimate === 0 && r.failed.length === 1);
  }
  installStub({ extract: (_body, init) => hangUntilAborted(init) });
  {
    const r = await tavilyExtract({ urls: ["https://shop.ca/p/slow"], timeoutSeconds: 1 });
    check("a timed-out read counts as spent (Tavily may have billed it)", r.creditsUsed === 1 && tavilyCreditStatus().usedEstimate === 1, `${r.creditsUsed}`);
  }
  installStub({ usage: () => usageJson(0, { paygo_limit: 100 }) });
  {
    const r = await tavilyExtract({ urls: ["https://shop.ca/p/paygo"] });
    check("pay-as-you-go on → page reading refused, nothing sent", calls.extract === 0 && r.failed.length === 1);
  }

  section("F4. Brand store detection and title clean-up");
  check("samsonite outline pro → Samsonite.ca", brandStoreFor("samsonite outline pro") === "Samsonite.ca");
  check("Briggs & Riley Baseline → Briggs & Riley", brandStoreFor("Briggs & Riley Baseline") === "Briggs & Riley");
  check("a generic search has no brand store", brandStoreFor("hardside luggage set under $400") === null);
  check(
    "Amazon's \"Model Number\" tail is dropped",
    cleanPageTitle("Amazon.ca: Samsonite Outline Pro Spinner Carry-On, Model Number: 143310-1041").name === "Samsonite Outline Pro Spinner Carry-On",
    cleanPageTitle("Amazon.ca: Samsonite Outline Pro Spinner Carry-On, Model Number: 143310-1041").name,
  );

  section("F5. Sweep can be turned off; reading can be turned off");
  process.env.SEARCH_RETAILER_SWEEP = "false";
  process.env.TAVILY_EXTRACT_MAX_PAGES = "0";
  installStub({ search: () => tavilyJson(outlinePages()) });
  await search("samsonite outline pro");
  check("SEARCH_RETAILER_SWEEP=false → 1 search", calls.search === 1, `${calls.search}`);
  check("TAVILY_EXTRACT_MAX_PAGES=0 → no page reading", calls.extract === 0, `${calls.extract}`);
  delete process.env.SEARCH_RETAILER_SWEEP;
  delete process.env.TAVILY_EXTRACT_MAX_PAGES;

  section("F6. Daily price checks use the economical depth");
  installStub({ search: () => tavilyJson(outlinePages()), extract: (body) => extractJson([], (body.urls as string[]) ?? []) });
  {
    await search("samsonite outline pro", { depth: "lite" });
    const urls = (calls.extractBodies[0]?.urls as string[] | undefined) ?? [];
    check("lite → 1 search (no major-chains sweep)", calls.search === 1, `${calls.search}`);
    check("lite → at most 3 pages read", urls.length <= 3, `${urls.length}`);
    await search("samsonite outline pro");
    // The full search must run its own major-chains search (a lite answer
    // is never served in its place) — but the identical general search is
    // reused from cache, so only 1 new call is paid for.
    check("a lite result is never served to a full search; the shared search is reused free", calls.search === 2, `${calls.search}`);
  }

  section("D1. Research never creates, imports or stores products");
  {
    const files = [
      "src/lib/tavily.ts",
      "src/lib/search/providers/tavily.ts",
      "src/lib/search/extract.ts",
      "src/lib/search/index.ts",
    ];
    for (const f of files) {
      const src = readFileSync(resolve(f), "utf8");
      check(`${f} doesn't import the product store`, !/@\/lib\/db\/products|lib\/db\/products/.test(src));
      check(`${f} writes no product/offer/tracking tables`, !/from\(\s*["'](?:products|offers|price_history|tracked_products)["']\s*\)/.test(src));
    }
  }

  /* ---------------- Summary --------------------------------------- */
  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
    process.exit(1);
  }
  console.log("\x1b[32mResearch pipeline verified end to end.\x1b[0m\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
