/* ------------------------------------------------------------------ */
/*  Offline verification of the whole search pipeline                  */
/*                                                                     */
/*    npm run verify:search                                            */
/*                                                                     */
/*  Feeds a realistic 20-result Google Shopping (Canada) payload        */
/*  through the REAL pipeline with `fetch` stubbed, and asserts the     */
/*  things a client would notice: every offer links to the merchant,    */
/*  prices are real, the same suitcase at six retailers becomes ONE     */
/*  product, majors are never dropped, and the numbers on the card      */
/*  match the offers underneath it.                                    */
/*                                                                     */
/*  Costs nothing. Makes no network call.                              */
/* ------------------------------------------------------------------ */

import { search } from "../src/lib/search/index";
import { matchRetailer } from "../src/lib/retailers";
import type { SearchProduct } from "../src/lib/search/types";

/* ------------------------------------------------------------------ */
/*  A realistic SerpAPI google_shopping response                      */
/*                                                                     */
/*  Modelled on what Google Shopping Canada actually returns for       */
/*  "samsonite carry on": the same three or four suitcases repeated    */
/*  across retailers, inconsistent title formats, a couple of rows     */
/*  with no price, one with no merchant link, one retailer listing     */
/*  the same bag twice, and several sellers we don't have in the       */
/*  registry.                                                          */
/* ------------------------------------------------------------------ */

const SHOPPING_RESULTS = [
  // ── Samsonite Freeform 21" carry-on, at six retailers ──
  {
    title: 'Samsonite Freeform Hardside Expandable Spinner Carry-On 21"',
    link: "https://www.amazon.ca/dp/B07FPBNBZF",
    source: "Amazon.ca",
    price: "$229.99",
    extracted_price: 229.99,
    thumbnail: "https://serpapi.example/thumb1.jpg",
    rating: 4.6,
    reviews: 3121,
  },
  {
    title: 'Samsonite Freeform 21" Spinner Carry-On Luggage - Black',
    link: "https://www.walmart.ca/en/ip/samsonite-freeform/6000202334455",
    source: "Walmart Canada",
    price: "$249.99",
    extracted_price: 249.99,
  },
  {
    title: "Samsonite Freeform Spinner Carry-On 21 inch",
    link: "https://www.samsonite.ca/freeform-carry-on-spinner/12345.html",
    source: "Samsonite",
    price: "$279.99",
    extracted_price: 279.99,
    thumbnail: "https://serpapi.example/thumb1b.jpg",
  },
  {
    title: 'Samsonite Freeform 21" Carry-On Spinner, Coral Red',
    link: "https://www.thebay.com/product/samsonite-freeform-21-spinner-0600089",
    source: "Hudson's Bay",
    price: "$264.00",
    extracted_price: 264.0,
  },
  {
    title: 'SAMSONITE Freeform 21" Hardside Spinner - New, Free Shipping',
    link: "https://www.ebay.ca/itm/226611882314",
    source: "eBay",
    price: "$198.50",
    extracted_price: 198.5,
  },
  {
    // Same retailer, same bag, listed twice — the dearer one must vanish.
    title: 'Samsonite Freeform 21" Spinner Carry-On (Renewed)',
    link: "https://www.amazon.ca/dp/B07FPBNBZG",
    source: "Amazon.ca",
    price: "$259.99",
    extracted_price: 259.99,
  },
  {
    title: 'Samsonite Freeform Carry-On Spinner 21"',
    link: "https://www.luggagedepot.ca/products/samsonite-freeform-21",
    source: "Luggage Depot",
    price: "$239.00",
    extracted_price: 239.0,
  },

  // ── Samsonite Freeform 28" — SAME model, DIFFERENT size ──
  {
    title: 'Samsonite Freeform Hardside Expandable Spinner 28" Large Check-In',
    link: "https://www.amazon.ca/dp/B07FPCCCC1",
    source: "Amazon.ca",
    price: "$329.99",
    extracted_price: 329.99,
  },
  {
    title: 'Samsonite Freeform 28" Spinner Checked Luggage',
    link: "https://www.costco.ca/samsonite-freeform-28-spinner.product.100512345.html",
    source: "Costco Wholesale Canada",
    price: "$299.99",
    extracted_price: 299.99,
  },
  {
    title: 'Samsonite Freeform Spinner 28 inch Check-In Suitcase',
    link: "https://www.canadiantire.ca/en/pdp/samsonite-freeform-28-0871234p.html",
    source: "Canadian Tire",
    price: "$349.99",
    extracted_price: 349.99,
  },

  // ── Samsonite Omni PC 20" ──
  {
    title: 'Samsonite Omni PC Hardside Spinner 20" Carry-On',
    link: "https://www.amazon.ca/dp/B00N3RXRXO",
    source: "Amazon.ca",
    price: "$149.99",
    extracted_price: 149.99,
    rating: 4.5,
    reviews: 18422,
  },
  {
    title: "Samsonite Omni PC 20 inch Spinner Carry On - Teal",
    link: "https://www.bentley.ca/en/samsonite-omni-pc-20-spinner",
    source: "Bentley",
    price: "$169.99",
    extracted_price: 169.99,
  },
  {
    title: 'Samsonite Omni PC 20" Hardside Carry-On Spinner',
    link: "https://www.londondrugs.com/samsonite-omni-pc-20-spinner/L1234567.html",
    source: "London Drugs",
    price: "$179.99",
    extracted_price: 179.99,
  },

  // ── Competing brands that legitimately show up in the same search ──
  {
    title: 'American Tourister Moonlight Hardside Spinner 21" Carry-On',
    link: "https://www.walmart.ca/en/ip/american-tourister-moonlight/6000200112233",
    source: "Walmart Canada",
    price: "$99.97",
    extracted_price: 99.97,
  },
  {
    title: 'American Tourister Moonlight 21" Spinner Luggage',
    link: "https://www.amazon.ca/dp/B01MSGF9VB",
    source: "Amazon.ca",
    price: "$109.99",
    extracted_price: 109.99,
  },
  {
    title: 'Travelpro Maxlite 5 21" Expandable Carry-On Spinner',
    link: "https://www.travelpro.com/products/maxlite-5-carry-on-spinner",
    source: "Travelpro",
    price: "$219.00",
    extracted_price: 219.0,
  },

  // ── Rows the mapper MUST reject ──
  {
    // No price at all — Google shows "See price in cart".
    title: 'Samsonite Freeform 21" Carry-On Spinner',
    link: "https://www.sportchek.ca/product/samsonite-freeform.html",
    source: "Sport Chek",
    price: "See price in cart",
  },
  {
    // extracted_price present but zero.
    title: "Samsonite Luggage Set 3 Piece",
    link: "https://example-store.ca/set",
    source: "Deals Depot",
    price: "$0.00",
    extracted_price: 0,
  },
  {
    // No merchant link — only a Google Shopping product page.
    title: 'Samsonite Freeform 21" Spinner',
    product_link: "https://www.google.com/shopping/product/1234567890",
    source: "Various sellers",
    price: "$231.00",
    extracted_price: 231.0,
  },
  {
    // Empty title.
    title: "",
    link: "https://www.walmart.ca/en/ip/unknown/6000209999999",
    source: "Walmart Canada",
    price: "$89.99",
    extracted_price: 89.99,
  },
];

/* ------------------------------------------------------------------ */
/*  fetch stub                                                        */
/* ------------------------------------------------------------------ */

type StubOpts = {
  /** Emulate Gemini being configured and answering. */
  gemini?: boolean;
  /** Emulate Gemini returning 503 high demand on every model. */
  geminiBusy?: boolean;
  /** Count SerpAPI HTTP requests actually made. */
  onSerpApiCall?: () => void;
  /** Force SerpAPI to fail this many times before succeeding. */
  serpApiFailures?: number;
};

function installFetchStub(opts: StubOpts) {
  let failuresLeft = opts.serpApiFailures ?? 0;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.includes("serpapi.com")) {
      opts.onSerpApiCall?.();
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return new Response("upstream timeout", { status: 503 });
      }
      return new Response(JSON.stringify({ shopping_results: SHOPPING_RESULTS }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("generativelanguage.googleapis.com")) {
      if (opts.geminiBusy) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: "The model is overloaded. UNAVAILABLE" } }),
          { status: 503 },
        );
      }

      const body = JSON.parse(String(init?.body ?? "{}"));
      const prompt: string = body.contents?.[0]?.parts?.[0]?.text ?? "";

      // Clustering prompt → group by the model line + size, the way a
      // competent model would.
      if (prompt.includes("Group these listings")) {
        return geminiJson({
          products: [
            {
              name: 'Samsonite Freeform 21" Carry-On Spinner',
              brand: "Samsonite",
              model: "Freeform",
              color: "Black",
              size: "21 inch",
              productType: "carry-on",
              offerIndexes: [0, 1, 2, 3, 4, 5, 6],
            },
            {
              name: 'Samsonite Freeform 28" Large Check-In Spinner',
              brand: "Samsonite",
              model: "Freeform",
              size: "28 inch",
              productType: "checked",
              offerIndexes: [7, 8, 9],
            },
            {
              name: 'Samsonite Omni PC 20" Carry-On Spinner',
              brand: "Samsonite",
              model: "Omni PC",
              size: "20 inch",
              productType: "carry-on",
              offerIndexes: [10, 11, 12],
            },
            {
              name: 'American Tourister Moonlight 21" Spinner',
              brand: "American Tourister",
              model: "Moonlight",
              size: "21 inch",
              offerIndexes: [13, 14],
            },
            // Deliberately drops index 15 (Travelpro) — the recovery path
            // must pick it up rather than silently losing a real listing.
          ],
        });
      }

      // Intent-parsing prompt.
      return geminiJson({
        terms: "samsonite carry on luggage",
        brand: "Samsonite",
        productType: "carry-on",
        maxPrice: null,
        minPrice: null,
        features: [],
        explanation: "Searching for Samsonite carry-on luggage across Canadian retailers.",
      });
    }

    throw new Error(`Unexpected fetch in verification: ${url}`);
  }) as typeof fetch;
}

function geminiJson(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/* ------------------------------------------------------------------ */
/*  Assertions                                                        */
/* ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? ` — ${detail}` : ""}`);
  }
}

function show(products: SearchProduct[]) {
  for (const p of products) {
    console.log(
      `\n    \x1b[1m${p.name}\x1b[0m` +
        `\n      $${p.lowestPrice.toFixed(2)}–$${p.highestPrice.toFixed(2)}` +
        `  spread $${p.spread.toFixed(2)}` +
        `  ${p.retailerCount} retailer(s)` +
        `  size="${p.size}"` +
        `  major=${p.hasMajorRetailer}`,
    );
    for (const o of p.offers) {
      console.log(`        ${o.retailer.padEnd(20)} $${o.price.toFixed(2).padStart(8)}  ${o.url.slice(0, 58)}`);
    }
  }
  console.log("");
}

/** Invariants that must hold for EVERY product, on every path. */
function checkProductInvariants(products: SearchProduct[], label: string) {
  const allOffers = products.flatMap((p) => p.offers);

  check(
    `${label}: every offer has a real http(s) merchant URL`,
    allOffers.every((o) => /^https?:\/\//.test(o.url)),
    allOffers.find((o) => !/^https?:\/\//.test(o.url))?.url,
  );

  check(
    `${label}: no offer links to a Google Shopping page`,
    allOffers.every((o) => !/(^|\.)google\.com/.test(new URL(o.url).hostname)),
    allOffers.find((o) => /google\.com/.test(o.url))?.url,
  );

  check(
    `${label}: every offer has a positive price`,
    allOffers.every((o) => o.price > 0),
  );

  check(
    `${label}: no offer has an empty title`,
    allOffers.every((o) => o.title.trim().length > 0),
  );

  check(
    `${label}: lowestPrice equals the cheapest displayed offer`,
    products.every((p) => p.lowestPrice === Math.min(...p.offers.map((o) => o.price))),
    products
      .filter((p) => p.lowestPrice !== Math.min(...p.offers.map((o) => o.price)))
      .map((p) => `${p.name}: card says ${p.lowestPrice}, cheapest offer ${Math.min(...p.offers.map((o) => o.price))}`)
      .join("; "),
  );

  check(
    `${label}: highestPrice equals the dearest displayed offer`,
    products.every((p) => p.highestPrice === Math.max(...p.offers.map((o) => o.price))),
    products
      .filter((p) => p.highestPrice !== Math.max(...p.offers.map((o) => o.price)))
      .map((p) => `${p.name}: card says ${p.highestPrice}, dearest offer ${Math.max(...p.offers.map((o) => o.price))}`)
      .join("; "),
  );

  check(
    `${label}: retailerCount equals the number of displayed offers`,
    products.every((p) => p.retailerCount === p.offers.length),
    products
      .filter((p) => p.retailerCount !== p.offers.length)
      .map((p) => `${p.name}: says ${p.retailerCount}, shows ${p.offers.length}`)
      .join("; "),
  );

  check(
    `${label}: spread equals highest − lowest`,
    products.every(
      (p) => Math.abs(p.spread - (p.highestPrice - p.lowestPrice)) < 0.005,
    ),
  );

  check(
    `${label}: offers are sorted cheapest first`,
    products.every((p) => p.offers.every((o, i) => i === 0 || p.offers[i - 1].price <= o.price)),
  );

  check(
    `${label}: no retailer appears twice within one product`,
    products.every((p) => new Set(p.offers.map((o) => o.retailer)).size === p.offers.length),
    products
      .filter((p) => new Set(p.offers.map((o) => o.retailer)).size !== p.offers.length)
      .map((p) => p.name)
      .join("; "),
  );

  check(
    `${label}: hasMajorRetailer agrees with the offers shown`,
    products.every((p) => {
      const actual = p.offers.some((o) => {
        const k = o.retailerKey;
        return k !== null && ["Amazon.ca", "Walmart.ca", "Costco.ca", "Hudson's Bay", "Canadian Tire", "Bentley", "Best Buy Canada", "London Drugs"].includes(k);
      });
      return p.hasMajorRetailer === actual;
    }),
  );
}

/* ------------------------------------------------------------------ */

async function main() {
  process.env.SERPAPI_KEY = "test-key";
  delete process.env.SERPER_API_KEY;
  delete process.env.ENABLE_GEMINI_GROUNDED_SEARCH;

  /* ---------------- 1. Retailer identification ------------------- */
  console.log("\n\x1b[1m1. Retailer identification from Google's `source` labels\x1b[0m");
  const idCases: [string, string, string | null][] = [
    ["Amazon.ca", "https://www.amazon.ca/dp/x", "Amazon.ca"],
    ["Walmart Canada", "https://www.walmart.ca/en/ip/x", "Walmart.ca"],
    ["Costco Wholesale Canada", "https://www.costco.ca/x", "Costco.ca"],
    ["Hudson's Bay", "https://www.thebay.com/x", "Hudson's Bay"],
    ["Canadian Tire", "https://www.canadiantire.ca/x", "Canadian Tire"],
    ["Samsonite", "https://www.samsonite.ca/x", "Samsonite.ca"],
    ["eBay", "https://www.ebay.ca/itm/1", "eBay.ca"],
    ["Bentley", "https://www.bentley.ca/x", "Bentley"],
    ["London Drugs", "https://www.londondrugs.com/x", "London Drugs"],
    ["Travelpro", "https://www.travelpro.com/x", "Travelpro"],
    // Unknown source label, but the URL gives it away.
    ["Some Reseller", "https://www.amazon.ca/dp/y", "Amazon.ca"],
    // Genuinely unknown — must be null, not a wrong guess.
    ["Luggage Depot", "https://www.luggagedepot.ca/x", null],
  ];
  for (const [source, url, expected] of idCases) {
    const got = matchRetailer(source, url);
    check(`"${source}" → ${expected ?? "null"}`, got === expected, `got ${got}`);
  }

  /* ---------------- 2. Full pipeline, heuristic path -------------- */
  console.log("\n\x1b[1m2. Full pipeline — no Gemini key (heuristic parse + grouping)\x1b[0m");
  delete process.env.GEMINI_API_KEY;
  let serpCalls = 0;
  installFetchStub({ onSerpApiCall: () => (serpCalls += 1) });

  const heuristic = await search("samsonite carry on luggage");
  show(heuristic.products);

  check("exactly one SerpAPI HTTP call was made", serpCalls === 1, `made ${serpCalls}`);
  check("provider reported as serpapi", heuristic.provider === "serpapi");
  check(
    "16 of 20 raw rows survived mapping (4 junk rows rejected)",
    heuristic.offersFound === 16,
    `got ${heuristic.offersFound}`,
  );
  check("returned at least one product", heuristic.products.length > 0);
  checkProductInvariants(heuristic.products, "heuristic");

  /* ---------------- 3. Full pipeline, LLM path -------------------- */
  console.log("\n\x1b[1m3. Full pipeline — Gemini answering (LLM parse + grouping)\x1b[0m");
  process.env.GEMINI_API_KEY = "test-key";
  serpCalls = 0;
  installFetchStub({ gemini: true, onSerpApiCall: () => (serpCalls += 1) });

  const llm = await search("samsonite carry on luggage");
  show(llm.products);

  check("exactly one SerpAPI HTTP call was made", serpCalls === 1, `made ${serpCalls}`);
  checkProductInvariants(llm.products, "llm");

  const freeform21 = llm.products.find((p) => /freeform/i.test(p.name) && p.size === "21 inch");
  check("the same suitcase at 6 retailers became ONE product", !!freeform21);
  check(
    "  …and Amazon's duplicate listing was deduped to the cheaper one",
    freeform21?.offers.filter((o) => o.retailer === "Amazon.ca").length === 1 &&
      freeform21?.offers.find((o) => o.retailer === "Amazon.ca")?.price === 229.99,
  );
  check(
    "  …showing 6 distinct retailers, cheapest $198.50 (eBay.ca)",
    freeform21?.retailerCount === 6 && freeform21?.lowestPrice === 198.5,
    `${freeform21?.retailerCount} retailers, lowest ${freeform21?.lowestPrice}`,
  );

  const freeform28 = llm.products.find((p) => /freeform/i.test(p.name) && p.size === "28 inch");
  check("the 28\" Freeform stayed a SEPARATE product from the 21\"", !!freeform28);

  check(
    "the listing Gemini forgot (Travelpro) was recovered, not lost",
    llm.products.some((p) => p.offers.some((o) => o.retailerKey === "Travelpro")),
  );

  const llmOfferCount = llm.products.reduce((n, p) => n + p.offers.length, 0);
  check(
    "no real listing vanished between fetch and display",
    llmOfferCount === 15,
    `${llmOfferCount} shown (16 fetched, 1 is Amazon's deduped duplicate)`,
  );

  check(
    "a major-retailer product ranks first",
    llm.products[0]?.hasMajorRetailer === true,
  );

  /* ---------------- 4. Retailer filter ---------------------------- */
  console.log("\n\x1b[1m4. Retailer settings filter\x1b[0m");
  installFetchStub({ gemini: true });
  const filtered = await search("samsonite carry on luggage", {
    allowedRetailers: ["Amazon.ca", "Walmart.ca"],
  });
  const filteredKeys = new Set(
    filtered.products.flatMap((p) => p.offers.map((o) => o.retailerKey)),
  );
  check(
    "disabled retailers are gone",
    !filteredKeys.has("Costco.ca") && !filteredKeys.has("Hudson's Bay"),
    [...filteredKeys].join(", "),
  );
  check(
    "unrecognised retailers are KEPT (the user disabled named ones, not unknown ones)",
    filteredKeys.has(null),
  );
  checkProductInvariants(filtered.products, "filtered");

  /* ---------------- 5. Price filter ------------------------------- */
  console.log("\n\x1b[1m5. Price ceiling from the query\x1b[0m");
  delete process.env.GEMINI_API_KEY; // heuristic price extraction
  installFetchStub({});
  const cheap = await search("samsonite carry on under $200");
  check("maxPrice parsed from the query", cheap.intent.maxPrice === 200, `got ${cheap.intent.maxPrice}`);
  check("'under $200' stripped from the keywords", !/200|under/i.test(cheap.intent.terms), cheap.intent.terms);
  check(
    "every product shown is actually under $200",
    cheap.products.every((p) => p.lowestPrice <= 200),
  );

  /* ---------------- 6. Transient failure + retry ------------------ */
  console.log("\n\x1b[1m6. One transient 503, then success\x1b[0m");
  serpCalls = 0;
  installFetchStub({ serpApiFailures: 1, onSerpApiCall: () => (serpCalls += 1) });
  const retried = await search("samsonite carry on luggage");
  check("retried once and recovered", serpCalls === 2 && retried.products.length > 0, `${serpCalls} calls`);

  /* ---------------- 6a. The query that failed in production ------- */
  //
  // Real failure, 2026-09-15: three searches burned, all red-errored with
  // "SerpAPI: Google hasn't returned any results for this query." That is
  // a 200 response meaning Google had nothing for those exact eight words.
  console.log("\n\x1b[1m6a. Long retailer product title (the live failure)\x1b[0m");
  {
    const { broadenLadder } = await import("../src/lib/search/broaden");
    const real = "Samsonite Rhapsody 360 Spinner Expandable Medium Luggage Black";
    const ladder = broadenLadder(real);
    console.log(ladder.map((q, i) => `      ${i + 1}. ${q}`).join("\n"));

    check("original query is the first rung", ladder[0] === real);
    check("every rung is distinct", new Set(ladder.map((q) => q.toLowerCase())).size === ladder.length);
    check(
      "each rung is shorter than the last",
      ladder.every((q, i) => i === 0 || q.split(" ").length <= ladder[i - 1].split(" ").length),
    );
    check(
      'reaches "Samsonite Rhapsody 360"',
      ladder.includes("Samsonite Rhapsody 360"),
      ladder.join(" | "),
    );
    check("colour is dropped by rung 2", !ladder[1].toLowerCase().includes("black"));
    check("a long title reaches brand+model in ONE extra call", ladder[1] === "Samsonite Rhapsody 360", ladder[1]);
    check("brand survives every rung", ladder.every((q) => /samsonite/i.test(q)));
    check("a short query isn't padded with junk rungs", broadenLadder("Samsonite").length === 1);
  }

  console.log("\n\x1b[1m6a-ii. Pipeline recovers from an empty first result\x1b[0m");
  {
    delete process.env.GEMINI_API_KEY;
    const asked: string[] = [];

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const q = url.searchParams.get("q") ?? "";
      asked.push(q);

      // Exactly what SerpAPI sends for a query Google can't match:
      // HTTP 200, with the miss reported through the `error` field.
      if (q.split(" ").length > 3) {
        return new Response(
          JSON.stringify({ error: "Google hasn't returned any results for this query." }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          shopping_results: [
            {
              title: 'Samsonite Rhapsody 360 Spinner Expandable Medium 25"',
              link: "https://www.amazon.ca/dp/RHAP1",
              source: "Amazon.ca",
              price: "$329.99",
              extracted_price: 329.99,
            },
            {
              title: "Samsonite Rhapsody 360 Medium Spinner",
              link: "https://www.thebay.com/rhapsody-360",
              source: "Hudson's Bay",
              price: "$379.99",
              extracted_price: 379.99,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const recovered = await search("Samsonite Rhapsody 360 Spinner Expandable Medium Luggage Black");

    console.log(asked.map((q, i) => `      call ${i + 1}: "${q}"`).join("\n"));

    check(
      "an empty result no longer throws",
      recovered.products.length > 0,
      `${recovered.products.length} products`,
    );
    check("it widened rather than giving up", asked.length > 1, `${asked.length} call(s)`);
    check(
      "and stopped as soon as it found something",
      asked.length <= 3,
      `${asked.length} calls — allowance guard`,
    );
    check(
      "the user is told the wording changed",
      recovered.warnings.some((w) => /instead/i.test(w)),
      recovered.warnings.join(" | "),
    );
    checkProductInvariants(recovered.products, "broadened");
  }

  console.log("\n\x1b[1m6a-iii. Genuinely nothing anywhere\x1b[0m");
  {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ error: "Google hasn't returned any results for this query." }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const empty = await search("Zzzqx Nonexistent 9000 Spinner Purple");
    check("returns an empty result, not an error", empty.products.length === 0);
    check("never exceeds the attempt budget", calls <= 3, `${calls} calls`);
    check(
      "tells the user what to type instead",
      empty.warnings.some((w) => /Try just the brand and model/i.test(w)),
      empty.warnings.join(" | "),
    );
    check(
      "no raw SerpAPI error text is shown",
      !empty.warnings.some((w) => /SerpAPI:/i.test(w)),
      empty.warnings.join(" | "),
    );
  }

  /* ---------------- 6a-iv. catalog vs compare mode ---------------- */
  console.log("\n\x1b[1m6a-iv. catalog mode keeps colour variants separate\x1b[0m");
  {
    delete process.env.GEMINI_API_KEY;
    const variants = [
      ["Samsonite Omni PC 20\" Spinner Carry-On Black", 149.99, "https://www.amazon.ca/dp/V1"],
      ["Samsonite Omni PC 20\" Spinner Carry-On Teal", 159.99, "https://www.amazon.ca/dp/V2"],
      ["Samsonite Omni PC 20\" Spinner Carry-On Burgundy", 154.99, "https://www.walmart.ca/en/ip/v3"],
    ].map(([title, extracted_price, link]) => ({
      title,
      link,
      source: String(link).includes("amazon") ? "Amazon.ca" : "Walmart Canada",
      price: `$${extracted_price}`,
      extracted_price,
    }));

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ shopping_results: variants }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const compare = await search("Samsonite Omni PC 20", { mode: "compare" });
    const catalog = await search("Samsonite Omni PC 20", { mode: "catalog" });

    check(
      "compare mode merges the three colours into one comparable product",
      compare.products.length === 1,
      `${compare.products.length} products`,
    );
    check(
      "catalog mode lists all three colours to pick from",
      catalog.products.length === 3,
      `${catalog.products.length} products`,
    );
    check(
      "catalog products name their colour",
      catalog.products.every((p) => p.color.length > 0),
      catalog.products.map((p) => `${p.name}="${p.color}"`).join(", "),
    );
    check(
      "the two modes don't share a cache entry",
      compare.products.length !== catalog.products.length,
    );
    checkProductInvariants(catalog.products, "catalog");
  }

  /* ---------------- 6a-v. Slow Gemini must not starve the fetch --- */
  //
  // Real failure, 2026-09-16: "The price service took too long to respond"
  // on a short query. SerpAPI was never the problem — Gemini got the FULL
  // timeout for EACH of five candidate models, so it could spend 45s of a
  // 50s budget before the shopping call started.
  console.log("\n\x1b[1m6a-v. Gemini hanging must not starve the shopping call\x1b[0m");
  {
    process.env.GEMINI_API_KEY = "test-key";
    // The real default budget — this is the production scenario.
    process.env.SEARCH_BUDGET_MS = "50000";

    let geminiCalls = 0;
    let serpCalled = false;
    let serpTimeBudget = 0;
    const startedAt = Date.now();

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("generativelanguage")) {
        geminiCalls += 1;
        // Hang until aborted, exactly like an unresponsive endpoint. Real
        // fetch rejects with AbortError when its signal fires, so honour it.
        return new Promise<Response>((_, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          const fail = () => {
            const e = new Error("The operation was aborted.");
            e.name = "AbortError";
            reject(e);
          };
          if (signal?.aborted) return fail();
          signal?.addEventListener("abort", fail, { once: true });
        });
      }

      if (url.includes("serpapi.com")) {
        serpCalled = true;
        serpTimeBudget = 50_000 - (Date.now() - startedAt);
        return new Response(
          JSON.stringify({
            shopping_results: [
              {
                title: 'Samsonite Rhapsody 360 Medium Spinner 25"',
                link: "https://www.amazon.ca/dp/RHAP",
                source: "Amazon.ca",
                price: "$329.99",
                extracted_price: 329.99,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error("unexpected fetch");
    }) as typeof fetch;

    const result = await search("Samsonite Rhapsody 360");
    const elapsed = Date.now() - startedAt;

    check("SerpAPI still got called", serpCalled);
    check(
      "…with a usable window, not the scraps",
      serpTimeBudget > 30_000,
      `only ${serpTimeBudget}ms left when it was called`,
    );
    check(
      "Gemini was tried once, not once per candidate model",
      geminiCalls === 1,
      `${geminiCalls} Gemini calls`,
    );
    check("the search returned real prices", result.products.length > 0);
    check(
      "and finished inside the budget",
      elapsed < 20_000,
      `${elapsed}ms`,
    );

    // The breaker should now be open, so the NEXT search skips Gemini
    // entirely rather than paying the wait again.
    const { geminiCircuitOpen } = await import("../src/lib/gemini");
    check("the Gemini circuit breaker opened after the failure", geminiCircuitOpen());

    const before = geminiCalls;
    await search("Samsonite Freeform");
    check(
      "the next search skips Gemini entirely while the breaker is open",
      geminiCalls === before,
      `${geminiCalls - before} extra Gemini call(s)`,
    );

    delete process.env.SEARCH_BUDGET_MS;
    delete process.env.GEMINI_API_KEY;
  }

  /* ---------------- 6a-vi. Slow Supabase must not block ----------- */
  //
  // Real failure, 2026-09-16: the dev log showed a plain
  // `GET /api/products` taking 11.6s and another 5.2s — every Supabase round
  // trip on this connection is slow. A search makes several (cache read,
  // quota reserve per attempt, cache write), so the database alone could
  // spend the whole 50s budget before Google was asked for a price.
  //
  // Caching and metering are optimisations. They must fail open.
  console.log("\n\x1b[1m6a-vi. A hanging database must not block the search\x1b[0m");
  {
    delete process.env.GEMINI_API_KEY;
    process.env.SEARCH_DB_TIMEOUT_MS = "300";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("serpapi.com")) {
        return new Response(JSON.stringify({ shopping_results: SHOPPING_RESULTS }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("unexpected fetch");
    }) as typeof fetch;

    // A Supabase client whose every call never settles.
    const neverSettles = () => new Promise(() => {});
    const hangingDb = {
      rpc: neverSettles,
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: neverSettles }) }),
        upsert: neverSettles,
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const startedAt = Date.now();
    const result = await search("samsonite carry on luggage", { db: hangingDb });
    const elapsed = Date.now() - startedAt;

    check("the search completed despite the database hanging", result.products.length > 0);
    check(
      "and wasn't held up by it",
      elapsed < 3_000,
      `${elapsed}ms — each bounded call should cost ~300ms, not forever`,
    );
    checkProductInvariants(result.products, "slow-db");

    delete process.env.SEARCH_DB_TIMEOUT_MS;
  }

  /* ---------------- 6b. Query anchoring --------------------------- */
  console.log("\n\x1b[1m6b. Keywords sent to Google\x1b[0m");
  {
    const { anchorToLuggage } = await import("../src/lib/search/parse");
    const cases: [string, string][] = [
      // Brand/model queries would otherwise return shelving and car parts.
      ["Freeform 21", "Freeform 21 luggage"],
      ["Samsonite Omni PC", "Samsonite Omni PC luggage"],
      ["Monos", "Monos luggage"],
      // Already unambiguous — must not be padded.
      ["hard shell carry-on", "hard shell carry-on"],
      ["samsonite luggage", "samsonite luggage"],
      ["travelpro spinner", "travelpro spinner"],
      ["large checked suitcase", "large checked suitcase"],
    ];
    for (const [input, expected] of cases) {
      const got = anchorToLuggage(input);
      check(`"${input}" → "${expected}"`, got === expected, `got "${got}"`);
    }
  }

  /* ---------------- 7. One product at 13 retailers ---------------- */
  //
  // A narrow query ("samsonite freeform 21") returns the SAME bag at every
  // retailer. The offer list is capped at 10, and the card's headline
  // numbers have to describe the 10 that are shown — not the 13 that were
  // found. Majors must survive the cap.
  console.log("\n\x1b[1m7. One product carried by 13 retailers (offer cap)\x1b[0m");
  delete process.env.GEMINI_API_KEY;
  const many = [
    ["Amazon.ca", "https://www.amazon.ca/dp/A", 229.99],
    ["Walmart Canada", "https://www.walmart.ca/en/ip/a/1", 249.99],
    ["Costco Wholesale Canada", "https://www.costco.ca/a.html", 239.99],
    ["Hudson's Bay", "https://www.thebay.com/a", 264.0],
    ["Canadian Tire", "https://www.canadiantire.ca/a.html", 269.99],
    ["Bentley", "https://www.bentley.ca/a", 259.99],
    ["London Drugs", "https://www.londondrugs.com/a.html", 274.99],
    ["Best Buy Canada", "https://www.bestbuy.ca/a", 254.99],
    ["Samsonite", "https://www.samsonite.ca/a.html", 279.99],
    ["eBay", "https://www.ebay.ca/itm/1", 198.5],
    ["Travelpro", "https://www.travelpro.com/a", 289.99],
    ["Luggage Depot", "https://www.luggagedepot.ca/a", 234.0],
    ["Bag King", "https://bagking.ca/a", 549.0],
  ].map(([source, link, extracted_price]) => ({
    title: 'Samsonite Freeform Hardside Spinner Carry-On 21"',
    link,
    source,
    price: `$${extracted_price}`,
    extracted_price,
  }));

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("serpapi.com")) {
      return new Response(JSON.stringify({ shopping_results: many }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected fetch");
  }) as typeof fetch;

  const capped = await search("samsonite freeform 21");
  const big = capped.products[0];
  show([big]);

  check("offer list capped at 10", big.offers.length === 10, `${big.offers.length}`);
  check(
    "all 8 major retailers survived the cap",
    ["Amazon.ca", "Walmart.ca", "Costco.ca", "Hudson's Bay", "Canadian Tire", "Bentley", "London Drugs", "Best Buy Canada"].every(
      (k) => big.offers.some((o) => o.retailerKey === k),
    ),
  );
  check(
    "the cheapest offer overall ($198.50 eBay) was not capped away",
    big.offers.some((o) => o.price === 198.5),
  );
  checkProductInvariants([big], "capped");

  /* ---------------- 8. Gemini 503 on every model ------------------ */
  console.log("\n\x1b[1m8. Gemini 503 'high demand' on every model\x1b[0m");
  process.env.GEMINI_API_KEY = "test-key";
  serpCalls = 0;
  installFetchStub({ geminiBusy: true, onSerpApiCall: () => (serpCalls += 1) });
  const degraded = await search("samsonite carry on luggage");
  check(
    "search still returns real products when Gemini is down",
    degraded.products.length > 0,
    `${degraded.products.length} products`,
  );
  check("SerpAPI was still called exactly once", serpCalls === 1, `${serpCalls} calls`);
  checkProductInvariants(degraded.products, "gemini-down");

  /* ---------------- Summary --------------------------------------- */
  console.log(`\n\x1b[1m${passed} passed, ${failures.length} failed\x1b[0m`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  \x1b[31m✗\x1b[0m ${f}`);
    process.exit(1);
  }
  console.log("\x1b[32mSearch pipeline verified end to end.\x1b[0m\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
