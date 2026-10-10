/* ------------------------------------------------------------------ */
/*  Q3 web estimates: every R3.2 rule (A3.1) with the E1/E2 fixtures,  */
/*  snippets only and no page reading of refused stores (A3.2),        */
/*  storage, labels and caching (R3.1, R3.4).                          */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { luggagePack as pack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { findEstimates, type EstimateDeps } from "@/lib/engine/estimates/run";
import { MemoryEstimateStore } from "@/lib/engine/estimates/store";
import {
  expectedFromQuery,
  identityReasons,
  isProductPage,
  plausibility,
  readEstimatePrice,
  validateEstimates,
  type EstimateCandidate,
  type ExpectedProduct,
  type ReferencePrice,
} from "@/lib/engine/estimates/validate";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { extractRefused, resetTavilyState, tavilyExtract } from "@/lib/tavily";

const src = (id: string) => SOURCE_SEED.find((s) => s.id === id)!;
const SOURCES = new Map(SOURCE_SEED.map((s) => [s.id, s]));

type Fixture = {
  query: string;
  references: ReferencePrice[];
  results: { url: string; title: string; content: string }[];
  expect: { url: string; outcome: "accepted" | "rejected"; reasonsInclude: string[] }[];
};
const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve("scripts/fixtures/estimates", name), "utf8")) as Fixture;

function candidatesOf(f: Fixture): EstimateCandidate[] {
  return f.results.map((r) => {
    const host = new URL(r.url).hostname;
    const source = SOURCE_SEED.find((s) => s.allowedDomains.includes(host))!;
    return {
      sourceId: source.id,
      url: r.url,
      title: r.title,
      snippet: r.content,
      query: f.query,
      foundAt: "2026-10-10T15:01:00Z",
    };
  });
}

const cand = (over: Partial<EstimateCandidate>): EstimateCandidate => ({
  sourceId: "amazon-ca",
  url: "https://www.amazon.ca/dp/B0PARALUXM",
  title: "Samsonite Paralux Hardside Expandable Spinner Medium : Amazon.ca",
  snippet: "Samsonite Paralux Spinner Medium. $419.99 FREE delivery",
  query: "Samsonite Paralux Medium",
  foundAt: "2026-10-10T15:01:00Z",
  ...over,
});
const paraluxMedium: ExpectedProduct = expectedFromQuery(
  pack.parseQuery("Samsonite Paralux Medium"),
);

describe("regression fixtures from real failures (R3.3)", () => {
  for (const name of ["e1-paralux-large.json", "e2-aluminum-carry-on.json"]) {
    it(`${name}: every result gets the expected verdict`, () => {
      const f = fixture(name);
      const out = validateEstimates(
        candidatesOf(f),
        SOURCES,
        expectedFromQuery(pack.parseQuery(f.query)),
        f.references,
        pack,
      );
      for (const e of f.expect) {
        const got = out.find((o) => o.candidate.url === e.url)!;
        expect(got.verdict.outcome, `${e.url}: ${got.verdict.reasons.join("; ")}`).toBe(e.outcome);
        for (const r of e.reasonsInclude) expect(got.verdict.reasons.join("; ")).toContain(r);
      }
    });
  }

  it("E1: no wrong price survives (the $150 Large is never shown)", () => {
    const f = fixture("e1-paralux-large.json");
    const out = validateEstimates(
      candidatesOf(f),
      SOURCES,
      expectedFromQuery(pack.parseQuery(f.query)),
      f.references,
      pack,
    );
    expect(out.filter((o) => o.verdict.outcome === "accepted")).toHaveLength(0);
  });

  it("E2: no domino set or pigeon rings survive", () => {
    const f = fixture("e2-aluminum-carry-on.json");
    const out = validateEstimates(
      candidatesOf(f),
      SOURCES,
      expectedFromQuery(pack.parseQuery(f.query)),
      f.references,
      pack,
    );
    const shown = out.filter((o) => o.verdict.outcome === "accepted").map((o) => o.candidate.title);
    expect(shown.some((t) => /domino|pigeon/i.test(t))).toBe(false);
  });
});

describe("rule a: the store's own product page", () => {
  it("accepts product pages and refuses search, category, home and look-alike pages", () => {
    expect(isProductPage(src("amazon-ca"), "https://www.amazon.ca/dp/B0PARALUXM")).toBeNull();
    expect(
      isProductPage(src("amazon-ca"), "https://www.amazon.ca/s?k=samsonite+paralux"),
    ).not.toBeNull();
    expect(
      isProductPage(src("walmart-ca"), "https://www.walmart.ca/en/ip/samsonite-paralux/600123"),
    ).toBeNull();
    expect(
      isProductPage(src("walmart-ca"), "https://www.walmart.ca/search?q=paralux"),
    ).not.toBeNull();
    expect(
      isProductPage(src("travelpro-ca"), "https://travelpro.ca/collections/carry-on"),
    ).not.toBeNull();
    expect(
      isProductPage(src("travelpro-ca"), "https://travelpro.ca/products/maxlite-5-carry-on"),
    ).toBeNull();
    expect(isProductPage(src("samsonite-ca"), "https://www.samsonite.ca/en/")).not.toBeNull();
    expect(
      isProductPage(src("samsonite-ca"), "https://www.samsonite-outlet.ca/paralux/1.html"),
    ).toMatch(/own website/);
  });
});

describe("rule b: identity", () => {
  it("passes the same bag", () => {
    expect(identityReasons(cand({}), src("amazon-ca"), paraluxMedium, pack)).toEqual([]);
  });
  it("refuses another brand, another line, another size, a missing size", () => {
    expect(
      identityReasons(
        cand({ title: "Delsey Paralux Spinner Medium" }),
        src("amazon-ca"),
        paraluxMedium,
        pack,
      ).join(),
    ).toMatch(/different brand/);
    expect(
      identityReasons(
        cand({ title: "Samsonite Omni 3.0 Spinner Medium" }),
        src("amazon-ca"),
        paraluxMedium,
        pack,
      ).join(),
    ).toMatch(/different product line/);
    expect(
      identityReasons(
        cand({ title: "Samsonite Paralux Spinner Large" }),
        src("amazon-ca"),
        paraluxMedium,
        pack,
      ).join(),
    ).toMatch(/different size/);
    expect(
      identityReasons(
        cand({ title: "Samsonite Paralux Spinner" }),
        src("amazon-ca"),
        paraluxMedium,
        pack,
      ).join(),
    ).toMatch(/size not stated/);
  });
  it("requires versions and stated inches to agree", () => {
    const omni3 = expectedFromQuery(pack.parseQuery("Samsonite Omni 3.0 Large"));
    expect(
      identityReasons(
        cand({ title: "Samsonite Omni 2 Hardside Large Spinner" }),
        src("amazon-ca"),
        omni3,
        pack,
      ).join(),
    ).toMatch(/version/);
    const nexis28 = expectedFromQuery(pack.parseQuery('Samsonite Nexis Large 28"'));
    expect(
      identityReasons(
        cand({ title: 'Samsonite Nexis Large Spinner 31"' }),
        src("amazon-ca"),
        nexis28,
        pack,
      ).join(),
    ).toMatch(/stated size/);
  });
  it("refuses a barcode that isn't ours", () => {
    const withUpc = { ...paraluxMedium, gtin: "043202927614" };
    expect(
      identityReasons(
        cand({ snippet: "UPC 043202999999. $419.99" }),
        src("amazon-ca"),
        withUpc,
        pack,
      ).join(),
    ).toMatch(/barcode/);
    expect(
      identityReasons(
        cand({ snippet: "UPC 043202927614. $419.99" }),
        src("amazon-ca"),
        withUpc,
        pack,
      ),
    ).toEqual([]);
  });
  it("lets a brand's own store leave its brand out of the title", () => {
    const tumiQ = expectedFromQuery(pack.parseQuery("TUMI Alpha Bravo Medium"));
    expect(
      identityReasons(
        cand({ sourceId: "tumi-ca", title: "Alpha Bravo Medium Expandable Packing Case" }),
        src("tumi-ca"),
        tumiQ,
        pack,
      ).join(),
    ).not.toMatch(/brand/);
  });
});

describe("rule c: one clear selling price", () => {
  it("reads a plain price with $ or CAD", () => {
    expect(readEstimatePrice("Bag", "Now $1,234.95 at our store")).toMatchObject({
      price: 1234.95,
    });
    expect(readEstimatePrice("Bag", "CAD 299.00 free shipping")).toMatchObject({ price: 299 });
  });
  it("refuses from-prices, ranges, monthly payments and USD", () => {
    expect(readEstimatePrice("Bag", "From $199.99")).toHaveProperty("reason");
    expect(readEstimatePrice("Bag", "$199.99 - $299.99")).toHaveProperty("reason");
    expect(readEstimatePrice("Bag", "$25/mo for 12 months")).toHaveProperty("reason");
    expect(readEstimatePrice("Bag", "US$199.99")).toHaveProperty("reason");
  });
  it("ignores 'save $X' and 'was $X' and keeps the selling price", () => {
    expect(readEstimatePrice("Bag", "Save $50.00! Now $199.99, was $249.99")).toMatchObject({
      price: 199.99,
    });
  });
  it("never reads a model or version number as a price", () => {
    expect(
      readEstimatePrice("Samsonite Sky Max 3.0 Medium", "Sky Max 3.0, 26 inch"),
    ).toHaveProperty("reason");
  });
  it("refuses a result showing two different prices", () => {
    expect(readEstimatePrice("Bag", "$199.99 Carry-on, $259.99 Medium")).toMatchObject({
      reason: expect.stringMatching(/more than one/),
    });
  });
});

describe("rule d: plausibility", () => {
  const ref = (price: number, sizeClass: string | null = "medium"): ReferencePrice => ({
    price,
    sizeClass,
    inches: null,
  });
  it("keeps an estimate within 0.6×–1.5× of the verified price", () => {
    expect(plausibility(419.99, paraluxMedium, [ref(434.95)], [], pack)).toEqual({
      reason: null,
      singleSource: false,
    });
    expect(plausibility(150, paraluxMedium, [ref(434.95)], [], pack).reason).toMatch(
      /verified price/,
    );
    expect(plausibility(800, paraluxMedium, [ref(434.95)], [], pack).reason).toMatch(
      /verified price/,
    );
  });
  it("uses at least two independent estimates when nothing is verified", () => {
    expect(plausibility(400, paraluxMedium, [], [420], pack)).toEqual({
      reason: null,
      singleSource: false,
    });
    expect(plausibility(150, paraluxMedium, [], [420, 410], pack).reason).toMatch(/other stores/);
  });
  it("otherwise needs the category band, marked single source", () => {
    expect(plausibility(400, paraluxMedium, [], [], pack)).toEqual({
      reason: null,
      singleSource: true,
    });
    expect(plausibility(9, paraluxMedium, [], [], pack).reason).toMatch(/price range/);
  });
  it("catches a bigger size priced well under a smaller size (E1)", () => {
    const large = expectedFromQuery(pack.parseQuery("Samsonite Paralux Large"));
    expect(plausibility(150, large, [ref(434.95, "medium")], [], pack).reason).toMatch(
      /smaller size/,
    );
  });
});

describe("rule e: not an accessory", () => {
  it("refuses a cover, tag or lock when the search is for a bag", () => {
    expect(
      identityReasons(
        cand({ title: "Samsonite Paralux Medium Luggage Cover" }),
        src("amazon-ca"),
        paraluxMedium,
        pack,
      ).join(),
    ).toMatch(/accessory/);
  });
});

/* ── the whole path ───────────────────────────────────────────────── */

function deps(over: Partial<EstimateDeps> = {}) {
  const engine = new MemoryEngineStore(SOURCE_SEED);
  const estimates = new MemoryEstimateStore();
  const search = vi.fn<EstimateDeps["search"]>(async () => ({
    creditsUsed: 1,
    results: [
      {
        url: "https://www.amazon.ca/dp/B0PARALUXM",
        title: "Samsonite Paralux Hardside Expandable Spinner Medium : Amazon.ca",
        content: "Samsonite Paralux Spinner Medium. $419.99 FREE delivery",
        score: 0.9,
        rawContent: null,
      },
      {
        url: "https://www.walmart.ca/en/ip/paralux-cover/600111",
        title: "Samsonite Paralux Medium Luggage Cover | Walmart Canada",
        content: "Cover. Current price $39.97",
        score: 0.5,
        rawContent: null,
      },
    ],
  }));
  const d: EstimateDeps = {
    engine,
    estimates,
    pack,
    sources: SOURCE_SEED,
    search,
    usage: async () => ({ cap: 950, used: 100 }),
    emailDailyNeed: async () => 0,
    emailDoneToday: async () => false,
    now: () => Date.parse("2026-10-10T15:01:00Z"),
    ...over,
  };
  return { d, engine, estimates, search };
}

const request = (
  references: ReferencePrice[] = [{ price: 434.95, sizeClass: "medium", inches: null }],
) => ({
  purpose: "interactive" as const,
  query: "Samsonite Paralux Medium",
  expected: paraluxMedium,
  stores: [src("amazon-ca"), src("walmart-ca")],
  references: async () => references,
});

describe("finding estimates (R3.1, R3.4, A3.2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetTavilyState();
  });

  it("searches snippets only, accepts the real bag, stores it as a labelled web estimate, rejects the cover", async () => {
    const { d, engine, estimates, search } = deps();
    const res = await findEstimates(request(), d);
    expect(search).toHaveBeenCalledTimes(1);
    const [req] = search.mock.calls[0];
    expect(req.includeRawContent).toBe(false); // never the page text
    expect(req.includeDomains).toEqual(expect.arrayContaining(["www.amazon.ca", "www.walmart.ca"]));
    expect(res.offers).toHaveLength(1);
    const o = res.offers[0];
    expect(o).toMatchObject({
      retailer: "Amazon.ca",
      price: 419.99,
      method: "web_estimate",
      availability: "unknown",
    });
    expect(o.freshness).toEqual({ kind: "estimate", foundAt: "2026-10-10T15:01:00.000Z" });
    // Stored as an observation with evidence; never extends verified price history.
    const obs = await engine.latestObservation(o.listingId!, { shownOnly: true });
    expect(obs).toMatchObject({ adapter: "web_estimate", price: 419.99 });
    expect(obs!.evidence).toMatchObject({
      query: "Samsonite Paralux Medium",
      resultUrl: "https://www.amazon.ca/dp/B0PARALUXM",
    });
    expect(String((obs!.evidence as { snippet: string }).snippet).length).toBeLessThanOrEqual(300);
    expect(await engine.priceRanges(o.listingId!, 10)).toEqual([]);
    // The cover is stored as a rejection with its reason, never shown.
    expect(estimates.rejections.map((r) => r.reasons.join())).toEqual([
      expect.stringMatching(/accessory/),
    ]);
  });

  it("doesn't spend again within the cache time, and keeps the time it was found", async () => {
    const { d, search } = deps();
    await findEstimates(request(), d);
    const later = { ...d, now: () => Date.parse("2026-10-10T20:00:00Z") };
    const again = await findEstimates(request(), later);
    expect(search).toHaveBeenCalledTimes(1);
    expect(again.fromCache).toBe(true);
    expect(again.credits).toBe(0);
    expect(again.offers[0].freshness).toEqual({
      kind: "estimate",
      foundAt: "2026-10-10T15:01:00.000Z",
    });
    const nextDay = { ...d, now: () => Date.parse("2026-10-11T04:00:00Z") };
    await findEstimates(request(), nextDay); // 13 h later: a named product's cache (12 h) has expired
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("does nothing without Tavily, at the cap, or when the budget is reserved for the email", async () => {
    const off = deps({ usage: async () => null });
    expect((await findEstimates(request(), off.d)).skipped).toBe("not_configured");
    const cap = deps({ usage: async () => ({ cap: 950, used: 950 }) });
    expect((await findEstimates(request(), cap.d)).skipped).toBe("cap");
    const reserved = deps({
      usage: async () => ({ cap: 950, used: 900 }),
      emailDailyNeed: async () => 20,
    });
    expect((await findEstimates(request(), reserved.d)).skipped).toBe("budget");
    for (const x of [off, cap, reserved]) expect(x.search).not.toHaveBeenCalled();
  });

  it("A3.2: the page reader never contacts a store whose terms forbid it or that blocks bots", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const refused = [
      "https://www.amazon.ca/dp/B0PARALUXM",
      "https://www.walmart.ca/en/ip/x/1",
      "https://www.bestbuy.ca/en-ca/product/x/1",
      "https://www.costco.ca/x.product.1.html",
      "https://www.samsonite.ca/en/x/1.html",
      "https://ca.tumi.com/p/x-1.html",
    ];
    for (const u of refused) expect(extractRefused(u)).toBe(true);
    expect(extractRefused("https://www.canadaluggagedepot.ca/products/x")).toBe(false);
    const r = await tavilyExtract({ urls: refused });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(r.results).toEqual([]);
    expect(r.failed).toHaveLength(refused.length);
  });
});
