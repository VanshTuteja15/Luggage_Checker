/* ------------------------------------------------------------------ */
/*  Price Data API v1 (v4 A7): U-API-1…4 against the memory engine.     */
/* ------------------------------------------------------------------ */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GET as changes } from "@/app/api/v1/changes/route";
import { GET as history } from "@/app/api/v1/products/[id]/history/route";
import { GET as offers } from "@/app/api/v1/products/[id]/offers/route";
import { GET as product } from "@/app/api/v1/products/[id]/route";
import { GET as promotions } from "@/app/api/v1/promotions/route";
import { GET as search } from "@/app/api/v1/search/route";
import { GET as stores } from "@/app/api/v1/stores/route";
import { apiKeys, hashKey, keyName } from "@/lib/engine/api-v1/core";
import { resetPriceApiLimiter } from "@/lib/engine/api-v1/http";
import { getEngine } from "@/lib/engine/server";
import type { ObservationInput } from "@/lib/engine/types";

const KEY = "lt_test_key_for_the_price_api_0123456789";
const OTHER = "lt_second_test_key_9876543210";
const KEYS = `sheet:${hashKey(KEY).toString("hex")},partner:${hashKey(OTHER).toString("hex")}`;

type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const ROUTES: Record<string, Handler> = {
  "/api/v1/search": search as Handler,
  "/api/v1/products/{id}": product,
  "/api/v1/products/{id}/offers": offers,
  "/api/v1/products/{id}/history": history,
  "/api/v1/promotions": promotions as Handler,
  "/api/v1/stores": stores as Handler,
  "/api/v1/changes": changes as Handler,
};

let productId = "";
const since = new Date(Date.now() - 3_600_000).toISOString();

function call(
  path: string,
  query = "",
  key: string | null = KEY,
  header = "authorization",
  id = productId,
) {
  const url = `http://localhost${path.replace("{id}", id)}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {};
  if (key) headers[header] = header === "authorization" ? `Bearer ${key}` : key;
  return ROUTES[path](new NextRequest(url, { headers }), { params: Promise.resolve({ id }) });
}

function reading(over: Partial<ObservationInput>): ObservationInput {
  return {
    listingId: "",
    sourceId: "canadaluggagedepot",
    adapter: "shopify_product_json",
    price: 279.99,
    listPrice: 440,
    currency: "CAD",
    availability: "in_stock",
    seller: null,
    condition: "new",
    validation: { outcome: "accepted", confidence: 0.95, reasons: [] },
    evidence: { url: "test" },
    extractorVersion: "t",
    validatorVersion: "t",
    fetchedAt: new Date(Date.now() - 600_000).toISOString(),
    asOf: null,
    sessionId: null,
    ...over,
  };
}

beforeAll(async () => {
  const { rt } = getEngine();
  const store = rt.store;
  const p = await store.createProduct({
    category: "luggage",
    brand: "Samsonite",
    line: "3.0 omni",
    name: "Samsonite Omni 3.0 Large Spinner Expandable Luggage",
    sizeClass: "large",
    identityKey: "samsonite|3.0 omni|large|api-test",
  });
  productId = p.id;
  const listing = (sourceId: string, url: string, title: string, via: "catalog" | "tavily") =>
    store.upsertListing({
      sourceId,
      url,
      externalId: url,
      title,
      brand: "Samsonite",
      sizeClass: "large",
      colour: "Blue",
      identifiers: [],
      imageUrl: null,
      discoveredVia: via,
      lastmod: null,
      active: true,
      productId: p.id,
    });
  const cld = await listing(
    "canadaluggagedepot",
    "https://www.canadaluggagedepot.ca/products/samsonite-omni-3-0-large-api-test",
    "Samsonite Omni 3.0 Large Spinner Expandable Luggage - Blue",
    "catalog",
  );
  const est = await listing(
    "amazon-ca",
    "https://www.amazon.ca/dp/APITEST01",
    "Samsonite Omni 3.0 Hardside Large Spinner, Blue",
    "tavily",
  );
  await store.insertObservation(
    reading({
      listingId: cld.id,
      price: 299.99,
      fetchedAt: new Date(Date.now() - 1_200_000).toISOString(),
    }),
  );
  await store.insertObservation(reading({ listingId: cld.id, price: 279.99 }));
  await store.insertObservation(
    reading({
      listingId: est.id,
      sourceId: "amazon-ca",
      adapter: "web_estimate",
      price: 289.0,
      listPrice: null,
      validation: { outcome: "accepted", confidence: 0.6, reasons: [] },
    }),
  );
});

afterEach(() => {
  delete process.env.PRICE_API_KEYS;
  delete process.env.PRICE_API_RATE_PER_MIN;
  resetPriceApiLimiter();
});

const PRICE_FIELDS = ["source", "method", "observed_at", "confidence", "label"] as const;

describe("keys (U-API-1)", () => {
  it("answers 503 while no keys are set, 401 without a valid one, 200 with one", async () => {
    expect((await call("/api/v1/stores")).status).toBe(503);
    process.env.PRICE_API_KEYS = KEYS;
    const none = await call("/api/v1/stores", "", null);
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toBe("Bearer");
    expect((await call("/api/v1/stores", "", "lt_wrong")).status).toBe(401);
    expect((await call("/api/v1/stores")).status).toBe(200);
    expect((await call("/api/v1/stores", "", OTHER, "x-api-key")).status).toBe(200);
  });

  it("keeps only hashes, ignores malformed entries and names the key that matched", () => {
    const keys = apiKeys(`${KEYS},broken,also:nothex`);
    expect(keys.map((k) => k.name)).toEqual(["sheet", "partner"]);
    expect(KEYS.includes(KEY)).toBe(false);
    expect(keyName(new Headers({ authorization: `Bearer ${OTHER}` }), keys)).toBe("partner");
    expect(keyName(new Headers({ authorization: "Bearer " }), keys)).toBeNull();
  });
});

describe("every price is labelled (U-API-2)", () => {
  it("offers, history, changes and search: source, method, observed_at, confidence, label; estimates typed", async () => {
    process.env.PRICE_API_KEYS = KEYS;
    const o = await (await call("/api/v1/products/{id}/offers")).json();
    expect(o.offers.map((x: { amount: number }) => x.amount)).toEqual([279.99, 289]);
    const h = await (await call("/api/v1/products/{id}/history", "days=7")).json();
    const c = await (await call("/api/v1/changes", `since=${since}`)).json();
    const s = await (await call("/api/v1/search", "q=samsonite omni 3.0 large")).json();
    const prices = [
      ...o.offers,
      ...h.readings,
      ...c.changes,
      ...s.results.flatMap((r: { offers: unknown[] }) => r.offers),
    ];
    expect(prices.length).toBeGreaterThanOrEqual(7);
    for (const p of prices) {
      for (const f of PRICE_FIELDS) expect(p[f], f).not.toBeUndefined();
      expect(p.currency).toBe("CAD");
      expect(p.type).toBe(p.method === "web_estimate" ? "estimate" : "observed");
    }
    const estimate = o.offers.find((x: { method: string }) => x.method === "web_estimate");
    expect(estimate).toMatchObject({ type: "estimate", source: { id: "amazon-ca" } });
    expect(estimate.label).toMatch(/confirm on site/);
    const live = o.offers.find((x: { method: string }) => x.method === "shopify_product_json");
    expect(live.label).toMatch(/^Verified live/);
    // The CLD page's change from $299.99 to $279.99 is one change, with its previous price.
    expect(c.changes.find((x: { amount: number }) => x.amount === 279.99)).toMatchObject({
      previous_amount: 299.99,
      product_id: productId,
    });
  });
});

describe("parameters and rate (U-API-3)", () => {
  it("refuses bad parameters with one plain sentence; an unknown product is a 404", async () => {
    process.env.PRICE_API_KEYS = KEYS;
    const bad = [
      ["/api/v1/search", ""],
      ["/api/v1/search", "q=omni&limit=999"],
      ["/api/v1/changes", "since=yesterday"],
      ["/api/v1/promotions", "store=Not A Store"],
    ] as const;
    for (const [path, q] of bad) {
      const r = await call(path, q);
      expect(r.status, `${path}?${q}`).toBe(400);
      const { error } = await r.json();
      expect(error).toMatch(/^[a-z_.]+: .+\.$/);
      expect(error).not.toMatch(/ZodError|at \w+ \(/);
    }
    const unknown = await call(
      "/api/v1/products/{id}",
      "",
      KEY,
      "authorization",
      "00000000-0000-0000-0000-000000000000",
    );
    expect(unknown.status).toBe(404);
  });

  it("limits each key on its own", async () => {
    process.env.PRICE_API_KEYS = KEYS;
    process.env.PRICE_API_RATE_PER_MIN = "2";
    expect((await call("/api/v1/stores")).status).toBe(200);
    expect((await call("/api/v1/stores")).status).toBe(200);
    const third = await call("/api/v1/stores");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await call("/api/v1/stores", "", OTHER)).status).toBe(200);
  });
});

describe("the OpenAPI file matches the routes (U-API-4)", () => {
  it("every documented path has a route that answers, and every route is documented", async () => {
    process.env.PRICE_API_KEYS = KEYS;
    const spec = readFileSync("docs/openapi-v1.yaml", "utf8");
    const documented = [...spec.matchAll(/^ {2}(\/api\/v1\/[^:\s]+):\s*$/gm)]
      .map((m) => m[1])
      .sort();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f === "route.ts") files.push(p);
      }
    };
    walk("src/app/api/v1");
    const routes = files
      .map((f) =>
        `/${f
          .replace(/\\/g, "/")
          .replace(/^src\/app\//, "")
          .replace(/\/route\.ts$/, "")}`.replace(/\[(\w+)\]/g, "{$1}"),
      )
      .sort();
    expect(documented).toEqual(routes);
    expect(documented).toEqual(Object.keys(ROUTES).sort());
    for (const path of documented) {
      expect(existsSync(`src/app${path.replace(/\{(\w+)\}/g, "[$1]")}/route.ts`)).toBe(true);
      const q =
        path === "/api/v1/search" ? "q=omni" : path === "/api/v1/changes" ? `since=${since}` : "";
      const r = await call(path, q);
      expect(r.status, path).toBe(200);
    }
  });
});
