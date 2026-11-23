/* ------------------------------------------------------------------ */
/*  v5 F1: web estimates on as an honest second source                 */
/*                                                                     */
/*  - guards added after the Pass 2 re-check (03_REVIEW.md): used or    */
/*    refurbished items, discontinued products, out-of-stock wording;   */
/*  - the app works fully with TAVILY_API_KEY unset (the real finder    */
/*    skips, nothing is fetched, verified prices still come back);      */
/*  - the owner's switch (flag estimates.web) stops every estimate;     */
/*  - the Usage tab says which of the three states it is in.            */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineConfig } from "@/lib/engine/config";
import { createEstimateFinder } from "@/lib/engine/estimates/deps";
import { findEstimates, type EstimateDeps } from "@/lib/engine/estimates/run";
import { MemoryEstimateStore } from "@/lib/engine/estimates/store";
import {
  availabilityFromResult,
  conditionReasons,
  expectedFromQuery,
  identityReasons,
  readEstimatePrice,
  validateEstimates,
  type EstimateCandidate,
} from "@/lib/engine/estimates/validate";
import { luggagePack as pack } from "@/lib/engine/packs/luggage";
import { createRuntime, type EngineRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { compareOffers } from "@/lib/engine/research/answer";
import { createSession } from "@/lib/engine/research/api";
import { ResearchManager } from "@/lib/engine/research/manager";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import type { EngineStore } from "@/lib/engine/store/port";
import type { AnswerOffer, SessionEvent } from "@/lib/engine/types";
import { estimatesLine, usageLines } from "@/lib/store-status-view";
import { resetTavilyState } from "@/lib/tavily";
import { fixture, instantLimiter } from "./helpers";

const SOURCES = new Map(SOURCE_SEED.map((s) => [s.id, s]));
const expected = expectedFromQuery(pack.parseQuery("Samsonite Paralux Medium"));
const references = [{ price: 434.95, sizeClass: "medium", inches: null }];

const cand = (over: Partial<EstimateCandidate>): EstimateCandidate => ({
  sourceId: "amazon-ca",
  url: "https://www.amazon.ca/dp/B0PARALUXM",
  title: "Samsonite Paralux Hardside Expandable Spinner Medium : Amazon.ca",
  snippet: "Samsonite Paralux Spinner Medium. $419.99 FREE delivery",
  query: "Samsonite Paralux Medium",
  foundAt: "2026-11-23T15:01:00Z",
  ...over,
});

const verdictOf = (c: EstimateCandidate) =>
  validateEstimates([c], SOURCES, expected, references, pack)[0].verdict;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetTavilyState();
});

describe("F1.2 new guards: only a new bag the store still sells", () => {
  it("refuses renewed, pre-owned, open-box and used-condition results with a plain reason", () => {
    for (const c of [
      cand({ title: "Samsonite Paralux Hardside Spinner Medium (Renewed) : Amazon.ca" }),
      cand({
        sourceId: "ebay-ca",
        url: "https://www.ebay.ca/itm/1234567890",
        title: "Samsonite Paralux Spinner Medium | eBay",
        snippet: "Pre-Owned · Samsonite Paralux Spinner Medium C $299.00",
      }),
      cand({ snippet: "Samsonite Paralux Spinner Medium. Open-box $329.99" }),
      cand({ snippet: "Used - Like New: Samsonite Paralux Spinner Medium $329.99" }),
    ]) {
      const v = verdictOf(c);
      expect(v.outcome, c.title + c.snippet).toBe("rejected");
      expect(v.reasons).toContain("a used or refurbished item");
    }
  });

  it("refuses a product the store says it no longer sells", () => {
    const v = verdictOf(
      cand({ snippet: "This item has been discontinued. Samsonite Paralux Medium $419.99" }),
    );
    expect(v.outcome).toBe("rejected");
    expect(v.reasons).toContain("the store no longer sells it");
  });

  it("doesn't mistake ordinary words for a condition", () => {
    expect(conditionReasons("Samsonite Paralux Spinner Medium", "Used by millions. $419.99")).toEqual(
      [],
    );
    expect(verdictOf(cand({})).outcome).toBe("accepted");
  });

  it("keeps an estimate the result calls unavailable, marked out of stock, and sorts it after in-stock prices", () => {
    const v = verdictOf(
      cand({ snippet: "Samsonite Paralux Spinner Medium $419.99 Currently unavailable." }),
    );
    expect(v).toMatchObject({ outcome: "accepted", price: 419.99, availability: "out_of_stock" });
    expect(availabilityFromResult("x", "Sold out")).toBe("out_of_stock");
    expect(availabilityFromResult("x", "In stock, ships today")).toBe("unknown");

    const offer = (sourceId: string, availability: AnswerOffer["availability"]): AnswerOffer => ({
      sourceId,
      retailer: sourceId,
      url: `https://example.test/${sourceId}`,
      title: "Samsonite Paralux Spinner Medium",
      brand: "Samsonite",
      sizeClass: "medium",
      identifiers: [],
      imageUrl: null,
      reasons: [],
      price: 419.99,
      listPrice: null,
      currency: "CAD",
      availability,
      colour: null,
      freshness: { kind: "estimate", foundAt: "2026-11-23T15:01:00Z" },
      confidence: 0.7,
      lowConfidence: false,
      method: "web_estimate",
      observationId: null,
      listingId: null,
      productId: null,
      evidence: null,
    });
    const sorted = [offer("a", "out_of_stock"), offer("b", "unknown")].sort(compareOffers);
    expect(sorted.map((o) => o.sourceId)).toEqual(["b", "a"]);
  });

  it("stores the stock the result states on the observation and the shown offer", async () => {
    const engine = new MemoryEngineStore(SOURCE_SEED);
    const d: EstimateDeps = {
      engine,
      estimates: new MemoryEstimateStore(),
      pack,
      sources: SOURCE_SEED,
      search: async () => ({
        creditsUsed: 1,
        results: [
          {
            url: "https://www.amazon.ca/dp/B0PARALUXM",
            title: "Samsonite Paralux Hardside Expandable Spinner Medium : Amazon.ca",
            content: "Samsonite Paralux Spinner Medium. $419.99 Currently unavailable.",
            score: 0.9,
            rawContent: null,
          },
        ],
      }),
      usage: async () => ({ cap: 950, used: 100 }),
      emailDailyNeed: async () => 0,
      emailDoneToday: async () => false,
      now: () => Date.parse("2026-11-23T15:01:00Z"),
    };
    const res = await findEstimates(
      {
        purpose: "interactive",
        query: "Samsonite Paralux Medium",
        expected,
        stores: [SOURCES.get("amazon-ca")!],
        references: async () => references,
      },
      d,
    );
    expect(res.offers).toHaveLength(1);
    expect(res.offers[0].availability).toBe("out_of_stock");
    const obs = await engine.latestObservation(res.offers[0].listingId!, { shownOnly: true });
    expect(obs?.availability).toBe("out_of_stock");
  });
});

/* ── false rejections seen in the 2026-11-23 coverage run (real snippets) ── */

describe("F1.2 real results that were refused for the wrong reason", () => {
  const baselineMedium = expectedFromQuery(pack.parseQuery("briggs riley baseline medium"));
  const judge = (c: EstimateCandidate, refs = [{ price: 999, sizeClass: "medium", inches: null }]) =>
    validateEstimates([c], SOURCES, baselineMedium, refs, pack)[0].verdict;

  it("a Shopify instalment line is not a second price (briggs-riley.ca)", () => {
    const v = judge({
      sourceId: "briggs-riley-ca",
      url: "https://briggs-riley.ca/products/baseline-medium-expandable-spinner-chocolate",
      title: "Baseline Medium Expandable Spinner",
      snippet:
        "Regular price Sale price $999.00 CAD / Free shipping over $99 & Free returns … no proof of purchase needed. Sample plans for $999.00 $166.50 every monthfor 6",
      query: "briggs riley baseline medium",
      foundAt: "2026-11-23T14:59:01Z",
    });
    expect(v).toMatchObject({ outcome: "accepted", price: 999 });
  });

  it('a lone "Regular price" is the price when nothing speaks of a sale (unluggage.com)', () => {
    const v = judge({
      sourceId: "unluggage",
      url: "https://unluggage.com/products/briggs-riley-new-baseline-medium-expandable-upright",
      title: 'Briggs & Riley Baseline Medium 26" Expandable Spinner',
      snippet: 'Briggs & Riley Baseline Medium 26" Expandable Spinner. Regular price $999.00 CAD.',
      query: "briggs riley baseline medium",
      foundAt: "2026-11-23T14:59:01Z",
    });
    expect(v).toMatchObject({ outcome: "accepted", price: 999 });
    // …but not when the result also talks about a sale we can't see the amount of.
    expect(readPrice("Regular price $599.99 Sale")).toEqual({
      reason: "no clear price in the search result",
    });
  });

  it("an amount converted from US dollars, or written in another currency, is never the price (ebay.ca)", () => {
    expect(readPrice("Approx. C $743.21. US $518.75. Was C $895.44 (17% off)")).toEqual({
      reason: "no clear price in the search result",
    });
    expect(readPrice("EUR 32.36 · C $299.00")).toMatchObject({ price: 299 });
  });

  it('the brand survives a title the search engine wrote as "TUMI - …" (amazon.ca)', () => {
    const reasons = identityReasonsFor(
      {
        sourceId: "amazon-ca",
        url: "https://www.amazon.ca/TUMI-Lightweight-Suitcase-Continental-Carry/dp/B0DP9YTJPF",
        title: "TUMI - 19 Degree Lite 4 Wheel Luggage",
        snippet: "TUMI - 19 Degree Lite 4 Wheel Luggage - Lightweight, Continental Carry",
        query: "tumi 19 degree lite",
        foundAt: "2026-11-23T14:58:24Z",
      },
      "tumi 19 degree lite",
    );
    expect(reasons).not.toContain("brand not named");
  });

  it("a shortened title takes its size from the snippet only when the snippet names exactly one size", () => {
    const amazon = {
      sourceId: "amazon-ca",
      url: "https://www.amazon.ca/Travelpro-Platinum-Expandable-Spinner-21-Inch/dp/B07DL64SYP",
      title: "Travelpro Platinum Elite Softside Expandable Spinner ...",
      query: "Travelpro Platinum Elite carry-on",
      foundAt: "2026-11-23T14:58:31Z",
    };
    const ok = identityReasonsFor(
      {
        ...amazon,
        snippet:
          "Travelpro Platinum Elite Carry-On Luggage Spinner, Grey, 21-Inch | Expandable Softside With USB Port",
      },
      "Travelpro Platinum Elite carry-on",
    );
    expect(ok).not.toContain("size not stated");
    const two = identityReasonsFor(
      { ...amazon, snippet: "Available as Carry-On and Large Check-In sizes" },
      "Travelpro Platinum Elite carry-on",
    );
    expect(two).toContain("size not stated");
    // A full (not shortened) title still has to state its size itself.
    const full = identityReasonsFor(
      { ...amazon, title: "Travelpro Platinum Elite Softside Expandable Spinner", snippet: "Carry-On" },
      "Travelpro Platinum Elite carry-on",
    );
    expect(full).toContain("size not stated");
  });
});

function readPrice(snippet: string) {
  return readEstimatePrice("Briggs & Riley Baseline Medium Expandable Spinner", snippet);
}

function identityReasonsFor(c: EstimateCandidate, query: string) {
  return identityReasons(c, SOURCES.get(c.sourceId)!, expectedFromQuery(pack.parseQuery(query)), pack);
}

describe("F1 the brand store's own search fits in the time when Tavily is slow", () => {
  const slowDeps = (over: Partial<EstimateDeps> = {}) => {
    const started: string[] = [];
    const search = vi.fn(async (req: { includeDomains?: string[] }) => {
      const brandOnly = req.includeDomains?.length === 1;
      started.push(brandOnly ? "brand" : "combined");
      // The combined search is slow (Tavily took 3–4 s in the 2026-11-23 run).
      await new Promise((r) => setTimeout(r, brandOnly ? 5 : 80));
      return {
        creditsUsed: 1,
        results: brandOnly
          ? [
              {
                url: "https://www.samsonite.ca/en/luggage/medium-luggage/paralux-spinner-medium/1502071041.html",
                title: "Paralux Spinner Medium | Samsonite Canada",
                content: "Paralux Spinner Medium. Sale price $419.99",
                score: 0.8,
                rawContent: null,
              },
            ]
          : [],
      };
    });
    const d: EstimateDeps = {
      engine: new MemoryEngineStore(SOURCE_SEED),
      estimates: new MemoryEstimateStore(),
      pack,
      sources: SOURCE_SEED,
      search,
      usage: async () => ({ cap: 950, used: 100 }),
      emailDailyNeed: async () => 0,
      emailDoneToday: async () => false,
      now: () => Date.parse("2026-11-23T15:01:00Z"),
      brandHeadStartMs: 10,
      ...over,
    };
    return { d, search, started };
  };
  const req = (over: Record<string, unknown> = {}) => ({
    purpose: "interactive" as const,
    query: "Samsonite Paralux Medium",
    expected,
    stores: [SOURCES.get("amazon-ca")!, SOURCES.get("samsonite-ca")!],
    references: async () => references,
    ...over,
  });

  it("starts the brand-store search while the slow combined search is still out, and uses its result", async () => {
    const { d, started } = slowDeps();
    const res = await findEstimates(req(), d);
    expect(started).toEqual(["combined", "brand"]);
    expect(res.brandSearch).toBe("searched");
    expect(res.offers.map((o) => [o.sourceId, o.price])).toEqual([["samsonite-ca", 419.99]]);
    expect(res.credits).toBe(2);
  });

  it("never lets the two searches together pass the call's credit limit", async () => {
    const { d, search } = slowDeps();
    const res = await findEstimates(req({ maxCredits: 1 }), d);
    expect(search).toHaveBeenCalledTimes(1);
    expect(res.credits).toBeLessThanOrEqual(1);
  });

  it("a fast combined search keeps the old order (no extra search when it isn't needed)", async () => {
    const { d, started } = slowDeps({ brandHeadStartMs: 10_000 });
    await findEstimates(req(), d);
    // Combined answered first and had nothing from Samsonite.ca: one brand search after it.
    expect(started).toEqual(["combined", "brand"]);
  });
});

/* ── a research session with the real finder and no search key ────── */

const CLD_HANDLE = "samsonite-omni-3-0-large-spinner-expandable-luggage";
const CLD = `https://www.canadaluggagedepot.ca/products/${CLD_HANDLE}`;
const CLD_JSON = fixture(`shopify/canadaluggagedepot__${CLD_HANDLE.slice(0, 60)}.product.json`);

async function omniSession(opts: { estimatesFlag?: boolean; finder?: "real" | "spy" }) {
  const store = new MemoryEngineStore(SOURCE_SEED);
  const hits: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    hits.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
    if (url === `${CLD}.json`)
      return new Response(CLD_JSON, { headers: { "content-type": "application/json" } });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const rt: EngineRuntime = createRuntime(store, {
    fetchImpl,
    resolve: async () => ["23.227.38.65"],
    limiter: instantLimiter(),
  });
  if (opts.estimatesFlag === false)
    await (store as EngineStore).setFlag("estimates.web", false, null);
  await store.upsertListing({
    sourceId: "canadaluggagedepot",
    url: CLD,
    externalId: CLD_HANDLE,
    title: "Samsonite Omni 3.0 Large Spinner Expandable Luggage",
    brand: "Samsonite",
    sizeClass: "large",
    colour: null,
    identifiers: [],
    imageUrl: null,
    discoveredVia: "sitemap",
    lastmod: null,
    active: true,
  });
  const spy = vi.fn(async () => ({
    offers: [],
    accepted: 0,
    rejected: 0,
    credits: 0,
    fromCache: false,
    skipped: null,
    brandSearch: null,
  }));
  const manager = new ResearchManager(rt, pack, {
    maxConcurrent: 2,
    estimates: opts.finder === "spy" ? spy : createEstimateFinder(rt, pack),
  });
  const created = await createSession(
    store,
    randomUUID(),
    { query: "Samsonite Omni 3.0 Large" },
    { ...engineConfig(), sessionDeadlineMs: 8_000 },
    "inline",
  );
  if (!created.ok) throw new Error(created.error);
  const events: SessionEvent[] = [];
  manager.subscribe(created.session.id, (e) => events.push(e));
  const answer = await manager.start(created.session.id);
  return { answer, events, hits, spy };
}

describe("F1.1 the app works fully without the web search key", () => {
  it("a session with the real finder and TAVILY_API_KEY unset: verified prices, no estimates, no error, no search request", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { answer, events, hits } = await omniSession({ finder: "real" });

    expect(answer).not.toBeNull();
    const offers = answer!.products.flatMap((p) => p.offers);
    expect(offers.some((o) => o.sourceId === "canadaluggagedepot" && o.price === 279.99)).toBe(true);
    expect(offers.some((o) => o.method === "web_estimate")).toBe(false);
    expect(events.map((e) => e.type)).not.toContain("session_failed");
    const done = events.find((e) => e.type === "estimates_done");
    expect(done?.payload).toMatchObject({ skipped: "not_configured" });
    // Nothing went to the web search service, through either fetch.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(hits.some((u) => /tavily/i.test(u))).toBe(false);
  });

  it("the owner's switch off: the finder is never asked", async () => {
    const { answer, events, spy } = await omniSession({ estimatesFlag: false, finder: "spy" });
    expect(answer).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).not.toContain("estimates_started");
  });

  it("the switch on (the default): the finder is asked for the stores we can't read live", async () => {
    const { spy } = await omniSession({ finder: "spy" });
    expect(spy).toHaveBeenCalledTimes(1);
    const stores = (spy.mock.calls[0] as unknown as [{ stores: { id: string }[] }])[0].stores.map(
      (s) => s.id,
    );
    expect(stores).toEqual(expect.arrayContaining(["amazon-ca", "walmart-ca", "samsonite-ca"]));
    expect(stores).not.toContain("canadaluggagedepot");
  });
});

describe("F1.1 Store status → Usage says which state estimates are in", () => {
  it("three plain sentences", () => {
    expect(estimatesLine({ configured: true, on: true, left: 412, cap: 950 })).toBe(
      "Web estimates left this month: 412",
    );
    expect(estimatesLine({ configured: true, on: false, left: 412, cap: 950 })).toBe(
      "Web estimates are switched off, so none are used.",
    );
    expect(estimatesLine({ configured: false, on: true, left: 0, cap: 0 })).toBe(
      "Web estimates aren't set up, so none are used.",
    );
    expect(
      usageLines({ estimates: { configured: true, on: true, left: 1200, cap: 950 }, emails: null })[0],
    ).toBe("Web estimates left this month: 1,200");
  });
});
