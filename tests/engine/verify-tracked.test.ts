/* ------------------------------------------------------------------ */
/*  Scheduler (P6): tracked products verified through the engine,       */
/*  written to the tracking tables, alerts once per day, budgets kept,  */
/*  and the cron route requires CRON_SECRET.                            */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { MemoryTrackedBridge, type TrackedItem } from "@/lib/engine/bridge/tracked";
import { sameBag, verifyTracked } from "@/lib/engine/jobs/verify-tracked";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { fixture, instantLimiter } from "./helpers";

const CLD = "https://www.canadaluggagedepot.ca/products/samsonite-omni-3-0-large-spinner-expandable-luggage";
const OMNI_JSON = fixture("shopify/canadaluggagedepot__samsonite-omni-3-0-large-spinner-expandable-luggage.product.json");

function item(over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    productId: "p-omni",
    name: "Samsonite Omni 3.0 Large Spinner",
    brand: "Samsonite",
    model: "Omni 3.0",
    color: "Blue",
    upc: "043202917998",
    offers: [
      { retailer: "Canada Luggage Depot", url: CLD, price: 299.99 },
      { retailer: "Amazon.ca", url: "https://www.amazon.ca/dp/B0OMNI", price: 289.99 },
    ],
    lastCheckedAt: "2026-10-01T00:00:00.000Z",
    watchers: [{ userId: "u1", targetPrice: 290, alertEnabled: true, email: "buyer@example.test" }],
    ...over,
  };
}

function setup() {
  const store = new MemoryEngineStore(SOURCE_SEED);
  const hits: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    hits.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
    if (url === `${CLD}.json`) return new Response(OMNI_JSON);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const rt = createRuntime(store, { fetchImpl, resolve: async () => ["23.227.38.65"], limiter: instantLimiter() });
  return { store, rt, hits };
}

describe("verifyTracked", () => {
  it("verifies a tracked bag at a permitted store, writes the tracking tables and alerts once a day", async () => {
    const { store, rt, hits } = setup();
    const bridge = new MemoryTrackedBridge([item()]);
    const alerts: unknown[] = [];
    const now = () => Date.parse("2026-10-08T13:00:00Z");
    const r = await verifyTracked(rt, luggagePack, bridge, { sendAlert: async (a) => alerts.push(a), now });
    expect(r.stats).toMatchObject({ products: 1, verified: 1, offersWritten: 1, alertsSent: 1 });
    expect(r.verifiedProductIds).toEqual(["p-omni"]);

    const written = bridge.offers.get("p-omni")!.get("Canada Luggage Depot")!;
    expect(written.price).toBe(279.99); // the Blue variant, the tracked colour, verified live
    expect(written.url).toContain("?variant=42742339010736");
    expect(bridge.history).toEqual([{ productId: "p-omni", retailer: "Canada Luggage Depot", price: 279.99, date: "2026-10-08" }]);
    expect(alerts).toEqual([expect.objectContaining({ to: "buyer@example.test", price: 279.99, target: 290, retailer: "Canada Luggage Depot" })]);
    // Evidence in the engine store; Amazon (terms forbid automated access) never contacted.
    expect((await store.recentFailures(10)).length).toBe(0);
    expect(hits.some((u) => u.includes("amazon"))).toBe(false);
    expect(bridge.runs[0]).toMatchObject({ job: "verify.tracked", ok: true });

    const again = await verifyTracked(rt, luggagePack, bridge, { sendAlert: async (a) => alerts.push(a), now });
    expect(again.stats.alertsSent).toBe(0);
    expect(alerts.length).toBe(1);
    expect(bridge.history.length).toBe(1); // same day: updated, not duplicated
  });

  it("never writes another bag's price (a carry-on tracked, only the large found)", async () => {
    const { rt } = setup();
    const bridge = new MemoryTrackedBridge([item({ productId: "p-carry", name: "Samsonite Omni 3.0 Carry-On Spinner", upc: null, color: "" })]);
    const r = await verifyTracked(rt, luggagePack, bridge, {});
    expect(r.stats.verified).toBe(0);
    expect(bridge.offers.size).toBe(0);
  });

  it("respects the fetch budget", async () => {
    const { rt, hits } = setup();
    const bridge = new MemoryTrackedBridge([
      item({ productId: "a", lastCheckedAt: "2026-10-01T00:00:00Z" }),
      item({ productId: "b", lastCheckedAt: "2026-10-02T00:00:00Z" }),
    ]);
    const r = await verifyTracked(rt, luggagePack, bridge, { maxFetches: 1 });
    expect(r.stats.fetches).toBe(1);
    expect(r.stats.skippedForBudget).toBe(1);
    expect(r.verifiedProductIds).toEqual(["a"]); // stalest first
    expect(hits.filter((u) => u.endsWith(".json")).length).toBe(1);
  });

  it("identity guard: barcode first, then brand + size + line", () => {
    const o = (title: string, gtin?: string) => ({
      sourceId: "x", adapter: "shopify_product_json" as const, url: "https://x/p", externalId: null, variantExternalId: null, title, brand: luggagePack.brandOf(title),
      identifiers: gtin ? [{ kind: "gtin" as const, value: gtin }] : [], colour: null, options: [], price: 1, listPrice: null, currency: "CAD", availability: "unknown" as const,
      seller: null, condition: null, imageUrl: null, displayedPrice: null, pageType: "api" as const, evidence: {}, fetchedAt: "", cacheAgeSec: null, asOf: null,
    });
    expect(sameBag(luggagePack, item(), o("anything", "00043202917998"))).toBe(true);
    expect(sameBag(luggagePack, item(), o("Samsonite Omni 3.0 Large Spinner", "00099999999999"))).toBe(false);
    const noUpc = item({ upc: null });
    expect(sameBag(luggagePack, noUpc, o("Samsonite Omni 3.0 Large Spinner Expandable Luggage - Blue"))).toBe(true);
    expect(sameBag(luggagePack, noUpc, o("Samsonite Omni 2 Large Spinner"))).toBe(false);
    expect(sameBag(luggagePack, noUpc, o("Samsonite Omni 3.0 Medium Spinner"))).toBe(false);
  });
});

describe("cron route", () => {
  it("refuses requests without the right CRON_SECRET", async () => {
    process.env.CRON_SECRET = "test-cron-secret-value";
    const { POST } = await import("@/app/api/cron/fetch-prices/route");
    expect((await POST(new NextRequest("http://localhost/api/cron/fetch-prices", { method: "POST" }))).status).toBe(401);
    expect((await POST(new NextRequest("http://localhost/api/cron/fetch-prices", { method: "POST", headers: { "x-cron-secret": "wrong" } }))).status).toBe(401);
    const authed = await POST(new NextRequest("http://localhost/api/cron/fetch-prices", { method: "POST", headers: { authorization: "Bearer test-cron-secret-value" } }));
    expect(authed.status).not.toBe(401);
  });
});
