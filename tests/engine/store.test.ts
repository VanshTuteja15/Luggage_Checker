/* ------------------------------------------------------------------ */
/*  EngineStore contract: the same behaviour from both implementations */
/*  Memory always runs; Postgres runs under `npm run test:db`, which    */
/*  sets ENGINE_TEST_DATABASE_URL to a freshly migrated database.       */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { PgEngineStore } from "@/lib/engine/store/pg";
import type { EngineStore } from "@/lib/engine/store/port";
import type { ListingInput, ObservationInput } from "@/lib/engine/types";

const PG_URL = process.env.ENGINE_TEST_DATABASE_URL;

type Harness = {
  name: string;
  make: () => Promise<{ store: EngineStore; newUser: () => Promise<string> }>;
};

const harnesses: Harness[] = [
  {
    name: "MemoryEngineStore",
    make: async () => ({
      store: new MemoryEngineStore(SOURCE_SEED),
      newUser: async () => randomUUID(),
    }),
  },
];
if (PG_URL) {
  harnesses.push({
    name: "PgEngineStore",
    make: async () => {
      const store = new PgEngineStore(PG_URL, 3);
      return {
        store,
        newUser: async () => {
          const { rows } = await store.pool.query(
            "INSERT INTO auth.users (email) VALUES ($1) RETURNING id",
            [`${randomUUID()}@example.test`],
          );
          return rows[0].id as string;
        },
      };
    },
  });
}

const tag = () => randomUUID().slice(0, 8);

function listing(overrides: Partial<ListingInput> = {}): ListingInput {
  return {
    sourceId: "canadaluggagedepot",
    url: `https://www.canadaluggagedepot.ca/products/${tag()}`,
    externalId: null,
    title: "Samsonite Outline Pro Medium Spinner",
    brand: "Samsonite",
    sizeClass: "medium",
    colour: null,
    identifiers: [],
    imageUrl: null,
    discoveredVia: "sitemap",
    lastmod: null,
    active: true,
    ...overrides,
  };
}

function observation(
  listingId: string,
  price: number,
  fetchedAt: string,
  outcome: "accepted" | "rejected" = "accepted",
): ObservationInput {
  return {
    listingId,
    sourceId: "canadaluggagedepot",
    adapter: "shopify_product_json",
    price,
    listPrice: null,
    currency: "CAD",
    availability: "in_stock",
    seller: null,
    condition: null,
    validation: {
      outcome,
      confidence: outcome === "accepted" ? 0.95 : 0.1,
      reasons: outcome === "accepted" ? [] : ["test"],
    },
    evidence: { field: "variants[0].price" },
    extractorVersion: "x",
    validatorVersion: "y",
    fetchedAt,
    asOf: null,
    sessionId: null,
  };
}

for (const h of harnesses) {
  describe(h.name, () => {
    let store: EngineStore;
    let newUser: () => Promise<string>;

    beforeAll(async () => {
      ({ store, newUser } = await h.make());
    });
    afterAll(async () => {
      await store.close();
    });

    it("lists the seeded registry", async () => {
      const sources = await store.listSources();
      expect(sources.length).toBe(SOURCE_SEED.length);
      const cld = sources.find((s) => s.id === "canadaluggagedepot")!;
      expect(cld.fetchHosts).toContain("canadaluggagedepot.myshopify.com");
      expect(cld.routes[0].adapter).toBe("shopify_ucp");
    });

    it("upserts listings without losing what it already knew", async () => {
      const a = await store.upsertListing(
        listing({ identifiers: [{ kind: "gtin", value: "00043202927614" }], externalId: "123" }),
      );
      const b = await store.upsertListing({
        ...listing({ url: a.url }),
        identifiers: [],
        externalId: null,
        title: "Outline Pro Medium (renamed)",
      });
      expect(b.id).toBe(a.id);
      expect(b.firstSeenAt).toBe(a.firstSeenAt);
      expect(b.title).toBe("Outline Pro Medium (renamed)");
      expect(b.identifiers).toEqual([{ kind: "gtin", value: "00043202927614" }]);
      expect(b.externalId).toBe("123");
      expect((await store.findListingByUrl("canadaluggagedepot", a.url))?.id).toBe(a.id);
    });

    it("searches the index by brand + line, by GTIN, and never across size classes", async () => {
      const t = tag();
      const gtin = `0${String(Date.now()).slice(-13)}`;
      await store.upsertListing(
        listing({
          title: `Samsonite Zephyrline${t} Carry-On Spinner`,
          sizeClass: "carry_on",
          identifiers: [{ kind: "gtin", value: gtin }],
        }),
      );
      await store.upsertListing(
        listing({ title: `Samsonite Zephyrline${t} Large Spinner`, sizeClass: "large" }),
      );
      const both = await store.searchListings(luggagePack.parseQuery(`Samsonite Zephyrline${t}`), {
        limit: 10,
      });
      expect(both.length).toBe(2);
      const carry = await store.searchListings(
        luggagePack.parseQuery(`Samsonite Zephyrline${t} carry-on`),
        { limit: 10 },
      );
      expect(carry.map((l) => l.sizeClass)).toEqual(["carry_on"]);
      const byGtin = await store.searchListings(luggagePack.parseQuery(gtin), { limit: 10 });
      expect(byGtin.length).toBe(1);
      const other = await store.searchListings(luggagePack.parseQuery(`Samsonite Zephyrline${t}`), {
        limit: 10,
        sourceIds: ["delsey-ca"],
      });
      expect(other).toEqual([]);
    });

    it("creates products idempotently by identity key and resolves identifiers", async () => {
      const key = `samsonite|zz${tag()}|medium`;
      const p1 = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: "zz",
        name: "Samsonite ZZ Medium",
        sizeClass: "medium",
        identityKey: key,
      });
      const p2 = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: "zz",
        name: "dup",
        sizeClass: "medium",
        identityKey: key,
      });
      expect(p2.id).toBe(p1.id);
      const gtin = `9${String(Date.now()).slice(-13)}`;
      expect(await store.addIdentifier(p1.id, null, "gtin", gtin)).toBe("added");
      expect(await store.addIdentifier(p1.id, null, "gtin", gtin)).toBe("exists");
      const other = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: "yy",
        name: "Other",
        sizeClass: "medium",
        identityKey: null,
      });
      expect(await store.addIdentifier(other.id, null, "gtin", gtin)).toBe("conflict");
      expect(await store.findProductsByIdentifier("gtin", gtin)).toEqual([p1.id]);
      // Store SKUs are scoped to their store.
      expect(await store.addIdentifier(p1.id, null, "store_sku", "SKU-1", "delsey-ca")).toBe(
        "added",
      );
      expect(await store.addIdentifier(other.id, null, "store_sku", "SKU-1", "bentley")).toBe(
        "added",
      );
      const v1 = await store.findOrCreateVariant(p1.id, "Black", "1041", "Black", null);
      const v2 = await store.findOrCreateVariant(p1.id, "Jet Black", "1041", null, null);
      expect(v2.id).toBe(v1.id);
      expect(
        (await store.candidateProducts("Samsonite", "medium")).some((p) => p.id === p1.id),
      ).toBe(true);
      expect(
        (await store.candidateProducts("Samsonite", "large")).some((p) => p.id === p1.id),
      ).toBe(false);
    });

    it("never merges products of different size classes; merges and splits otherwise", async () => {
      const t = tag();
      const carry = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: t,
        name: "C",
        sizeClass: "carry_on",
        identityKey: null,
      });
      const large = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: t,
        name: "L",
        sizeClass: "large",
        identityKey: null,
      });
      await expect(store.mergeProducts(carry.id, large.id)).rejects.toThrow(/size/);
      const dup = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: t,
        name: "C2",
        sizeClass: "carry_on",
        identityKey: null,
      });
      const l = await store.upsertListing(listing({ title: `X ${t}`, sizeClass: "carry_on" }));
      await store.linkListing(l.id, dup.id, null);
      await store.mergeProducts(dup.id, carry.id);
      expect((await store.getListing(l.id))?.productId).toBe(carry.id);
      expect((await store.getProduct(dup.id))?.status).toBe("merged");
      const split = await store.splitListing(l.id);
      expect(split.id).not.toBe(carry.id);
      expect((await store.getListing(l.id))?.productId).toBe(split.id);
    });

    it("keeps observations and collapses unchanged prices into ranges", async () => {
      const l = await store.upsertListing(listing());
      await store.insertObservation(observation(l.id, 324.95, "2026-10-01T10:00:00.000Z"));
      await store.insertObservation(observation(l.id, 324.95, "2026-10-02T10:00:00.000Z"));
      await store.insertObservation(observation(l.id, 1, "2026-10-02T11:00:00.000Z", "rejected"));
      await store.insertObservation(observation(l.id, 299.95, "2026-10-03T10:00:00.000Z"));
      const ranges = await store.priceRanges(l.id, 10);
      expect(ranges.map((r) => [r.price, r.observationCount])).toEqual([
        [299.95, 1],
        [324.95, 2],
      ]);
      expect((await store.latestObservation(l.id, { shownOnly: true }))?.price).toBe(299.95);
      expect((await store.recentRejections(50)).some((r) => r.listingId === l.id)).toBe(true);
    });

    it("reads the latest shown reading and recent ranges of many listings at once", async () => {
      const a = await store.upsertListing(listing());
      const b = await store.upsertListing(listing());
      const none = await store.upsertListing(listing());
      await store.insertObservation(observation(a.id, 410, "2026-10-01T10:00:00.000Z"));
      await store.insertObservation(observation(a.id, 400, "2026-10-05T10:00:00.000Z"));
      await store.insertObservation(observation(a.id, 1, "2026-10-06T10:00:00.000Z", "rejected"));
      await store.insertObservation(observation(b.id, 350, "2026-10-04T10:00:00.000Z"));
      const latest = await store.latestObservations([a.id, b.id, none.id]);
      expect(Object.fromEntries(latest.map((o) => [o.listingId, o.price]))).toEqual({
        [a.id]: 400,
        [b.id]: 350,
      });
      const ranges = await store.priceRangesSince([a.id, b.id], "2026-10-03T00:00:00.000Z");
      expect(ranges.map((r) => [r.listingId, r.price])).toEqual([
        [a.id, 400],
        [b.id, 350],
      ]);
      expect(await store.latestObservations([])).toEqual([]);
    });

    it("extends the latest range only for the same price and stock, never backwards (v4 A3.4)", async () => {
      const l = await store.upsertListing(listing());
      expect(await store.touchPriceRange(l.id, 300, "in_stock", "2026-10-01T10:00:00.000Z")).toBe(
        false,
      );
      await store.insertObservation(observation(l.id, 300, "2026-10-01T10:00:00.000Z"));
      expect(await store.touchPriceRange(l.id, 300, "in_stock", "2026-10-02T10:00:00.000Z")).toBe(
        true,
      );
      expect(await store.touchPriceRange(l.id, 290, "in_stock", "2026-10-03T10:00:00.000Z")).toBe(
        false,
      );
      expect(
        await store.touchPriceRange(l.id, 300, "out_of_stock", "2026-10-03T10:00:00.000Z"),
      ).toBe(false);
      expect(await store.touchPriceRange(l.id, 300, "in_stock", "2026-09-30T10:00:00.000Z")).toBe(
        false,
      );
      expect(await store.priceRanges(l.id, 5)).toMatchObject([
        { price: 300, observationCount: 2, lastSeenAt: "2026-10-02T10:00:00.000Z" },
      ]);
    });

    it("keeps one row per promotion, current only while the latest reading shows it (v4 A4.2)", async () => {
      const l = await store.upsertListing(listing());
      const sale = {
        kind: "sale_price" as const,
        method: "compare_at" as const,
        percentOff: null,
        upTo: false,
        amountOff: null,
        salePrice: 299.95,
        wasPrice: 399.95,
        threshold: null,
        code: null,
        endsText: null,
        endsAt: null,
        evidence: ["compare_at_price 399.95", "price 299.95"],
      };
      const t1 = "2026-10-01T10:00:00.000Z";
      const t2 = "2026-10-02T10:00:00.000Z";
      const o1 = await store.insertObservation(observation(l.id, 299.95, t1));
      expect(await store.recordPromotions(l.id, "canadaluggagedepot", [sale], t1, o1.id)).toEqual({
        opened: 1,
        extended: 0,
      });
      await store.insertObservation(observation(l.id, 299.95, t2));
      expect(await store.recordPromotions(l.id, "canadaluggagedepot", [sale], t2, null)).toEqual({
        opened: 0,
        extended: 1,
      });
      const at = "2026-10-02T12:00:00.000Z";
      const now = await store.currentPromotions({ at, listingIds: [l.id], limit: 10 });
      expect(now).toMatchObject([
        {
          kind: "sale_price",
          salePrice: 299.95,
          wasPrice: 399.95,
          firstSeenAt: t1,
          lastSeenAt: t2,
        },
      ]);
      expect(now[0].evidence).toEqual(sale.evidence);
      expect(
        await store.currentPromotions({
          at,
          listingIds: [l.id],
          sourceIds: ["delsey-ca"],
          limit: 10,
        }),
      ).toEqual([]);
      // A later reading without it: no longer current (nothing was written for it).
      await store.insertObservation(observation(l.id, 399.95, "2026-10-03T10:00:00.000Z"));
      expect(await store.currentPromotions({ at, listingIds: [l.id], limit: 10 })).toEqual([]);

      // Its own end date passed: never current, even while still shown.
      const m = await store.upsertListing(listing());
      const t3 = "2026-10-04T10:00:00.000Z";
      await store.insertObservation(observation(m.id, 299.95, t3));
      await store.recordPromotions(
        m.id,
        "canadaluggagedepot",
        [{ ...sale, method: "jsonld", endsText: "2026-10-05", endsAt: "2026-10-05T23:59:59.000Z" }],
        t3,
        null,
      );
      const current = (iso: string) =>
        store.currentPromotions({ at: iso, listingIds: [m.id], limit: 5 });
      expect(await current("2026-10-05T12:00:00.000Z")).toHaveLength(1);
      expect(await current("2026-10-06T00:00:00.000Z")).toEqual([]);
      // A listing that left the store: its promotions aren't current.
      await store.upsertListing({ ...listing(), url: m.url, active: false });
      expect(await current("2026-10-05T12:00:00.000Z")).toEqual([]);
    });

    it("merges variant attributes: new fields, the same store restating, or a better method (v4 A4.1)", async () => {
      const p = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: `attr ${tag()}`,
        name: "Samsonite Attr Test Carry-On",
        sizeClass: "carry_on",
        identityKey: `samsonite|attr-${tag()}|carry_on`,
      });
      const v = await store.findOrCreateVariant(p.id, "Black", null, null, null);
      expect(v.attributes).toEqual({});
      const dims = (
        value: number[],
        sourceId = "canadaluggagedepot",
        evidence = "55 x 40 x 20 cm",
        method = "rules",
      ) => ({
        dimsCm: {
          value,
          method,
          evidence,
          confidence: 0.9,
          sourceId,
          url: "https://www.canadaluggagedepot.ca/products/x",
          firstReadAt: "2026-10-01T10:00:00.000Z",
        },
      });
      expect(await store.mergeVariantAttributes(v.id, dims([55, 40, 20]))).toBe(true);
      expect(await store.mergeVariantAttributes(v.id, dims([55, 40, 20]))).toBe(false);
      // Another store's rules don't flip it; the same store restating it does.
      expect(
        await store.mergeVariantAttributes(
          v.id,
          dims([56, 40, 20], "delsey-ca", "56 x 40 x 20 cm"),
        ),
      ).toBe(false);
      expect(
        await store.mergeVariantAttributes(
          v.id,
          dims([55, 40, 23], "canadaluggagedepot", "55 x 40 x 23 cm"),
        ),
      ).toBe(true);
      // JSON-LD from another store beats rules.
      expect(
        await store.mergeVariantAttributes(
          v.id,
          dims([55, 40, 24], "delsey-ca", "height: 55 CMT", "jsonld"),
        ),
      ).toBe(true);
      const [after] = await store.variantsForProduct(p.id);
      expect(after.attributes).toMatchObject({
        dimsCm: { value: [55, 40, 24], method: "jsonld", sourceId: "delsey-ca" },
      });
    });

    it("runs sessions with ordered, resumable events and per-user counts", async () => {
      const user = await newUser();
      const s = await store.createSession({
        userId: user,
        query: "outline pro",
        deadlineMs: 11_000,
        mode: "inline",
      });
      expect(s.status).toBe("queued");
      for (const seq of [1, 2, 3]) {
        await store.appendEvent({
          sessionId: s.id,
          seq,
          type: "store_started",
          sourceId: "delsey-ca",
          payload: { n: seq },
          createdAt: new Date().toISOString(),
        });
      }
      await expect(
        store.appendEvent({
          sessionId: s.id,
          seq: 2,
          type: "plan",
          sourceId: null,
          payload: {},
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toThrow();
      expect((await store.listEvents(s.id, 1)).map((e) => e.seq)).toEqual([2, 3]);
      expect(await store.countActiveSessions(user)).toBe(1);
      await store.updateSession(s.id, {
        status: "done",
        finishedAt: new Date().toISOString(),
        error: null,
      });
      expect(await store.countActiveSessions(user)).toBe(0);
      expect(
        await store.countSessionsSince(user, new Date(Date.now() - 60_000).toISOString()),
      ).toBe(1);
      expect((await store.getSession(s.id))?.status).toBe("done");
      expect(await store.getSession("not-a-uuid")).toBeNull();
    });

    it("records fetch attempts, health and flags", async () => {
      await store.insertFetchAttempts([
        {
          sourceId: "samsonite-ca",
          adapter: "html_structured",
          url: "https://www.samsonite.ca/x",
          method: "GET",
          status: 307,
          outcome: "challenge",
          durationMs: 80,
          bytes: 5669,
          error: null,
          startedAt: new Date().toISOString(),
          sessionId: null,
          cacheAgeSec: null,
        },
      ]);
      expect((await store.recentFailures(20)).some((f) => f.outcome === "challenge")).toBe(true);
      const stats = await store.sourceHealthStats();
      expect(stats.find((s) => s.sourceId === "samsonite-ca")!.blocked24h).toBeGreaterThanOrEqual(
        1,
      );
      await store.saveHealth({
        sourceId: "delsey-ca",
        circuit: "open",
        circuitOpenedAt: new Date().toISOString(),
        circuitReason: "test",
        consecutiveFailures: 3,
      });
      expect((await store.getHealth("delsey-ca")).circuit).toBe("open");
      await store.saveHealth({
        sourceId: "delsey-ca",
        circuit: "closed",
        circuitOpenedAt: null,
        circuitReason: null,
        consecutiveFailures: 0,
      });
      await store.setFlag("discovery.tavily", true, null);
      expect((await store.listFlagRows()).find((f) => f.key === "discovery.tavily")?.enabled).toBe(
        true,
      );
      await store.setFlag("discovery.tavily", false, null);
    });

    it("queues identity reviews once and records decisions", async () => {
      const l = await store.upsertListing(listing());
      const p = await store.createProduct({
        category: "luggage",
        brand: "Samsonite",
        line: "q",
        name: "Q",
        sizeClass: "medium",
        identityKey: null,
      });
      await store.enqueueReview(l.id, p.id, 0.6, ["no shared identifier"]);
      await store.enqueueReview(l.id, p.id, 0.6, ["no shared identifier"]);
      const pending = (await store.listReviews("pending", 200)).filter((r) => r.listingId === l.id);
      expect(pending.length).toBe(1);
      expect(pending[0].reasons).toEqual(["no shared identifier"]);
      expect((await store.decideReview(pending[0].id, "approved", null))?.status).toBe("approved");
      expect(await store.decideReview(pending[0].id, "rejected", null)).toBeNull();
    });
  });
}

describe.runIf(!!PG_URL)("PgEngineStore retention", () => {
  it("applies the 180-day policy and refuses under 30 days", async () => {
    const store = new PgEngineStore(PG_URL!, 1);
    try {
      const r = await store.retention(180);
      expect(typeof r.fetchAttempts).toBe("number");
      expect(typeof r.sessionEvents).toBe("number");
      await expect(store.retention(7)).rejects.toThrow(/at least 30 days/);
    } finally {
      await store.close();
    }
  });
});
