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
