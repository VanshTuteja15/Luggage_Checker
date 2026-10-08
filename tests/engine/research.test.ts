/* ------------------------------------------------------------------ */
/*  Research sessions end to end, with stubbed sources (P4 check)      */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { engineConfig } from "@/lib/engine/config";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime, type EngineRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { freshnessLabel } from "@/lib/engine/research/answer";
import { checkRateLimit, createSession, parseResearchInput } from "@/lib/engine/research/api";
import { followSession } from "@/lib/engine/research/follow";
import { ResearchManager } from "@/lib/engine/research/manager";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { EXTRACTOR_VERSION, VALIDATOR_VERSION, type EngineStore } from "@/lib/engine/store/port";
import type { SessionEvent } from "@/lib/engine/types";
import { fixture, instantLimiter } from "./helpers";

const CLD_HANDLE = "samsonite-omni-3-0-large-spinner-expandable-luggage";
const CLD = `https://www.canadaluggagedepot.ca/products/${CLD_HANDLE}`;
const UNL = `https://unluggage.com/products/${CLD_HANDLE}`;
const CLD_JSON = fixture(`shopify/canadaluggagedepot__${CLD_HANDLE.slice(0, 60)}.product.json`);
// U.N. Luggage carrying the same bag $10 cheaper (test data, same shape as CLD's real JSON).
const UNL_JSON = CLD_JSON.replace(/"279\.99"/g, '"269.99"');

type Route = { body: string; status?: number; delayMs?: number };

function network(routes: Record<string, Route>) {
  const hits: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    hits.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
    const r = routes[url];
    if (!r) return new Response("", { status: 404 });
    if (r.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, r.delayMs);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    return new Response(r.body, { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, hits };
}

async function setup(routes: Record<string, Route>, opts: { singleFlightMs?: number } = {}) {
  const store = new MemoryEngineStore(SOURCE_SEED);
  const net = network(routes);
  const rt: EngineRuntime = createRuntime(store, { fetchImpl: net.fetchImpl, resolve: async () => ["23.227.38.65"], limiter: instantLimiter() });
  rt.config = { ...rt.config, singleFlightMs: opts.singleFlightMs ?? 90_000 };
  // The human decision recorded as a flag (terms read): lets the test use U.N. Luggage.
  await (store as EngineStore).setFlag("source.unluggage.product_json", true, null);

  const omni = { title: "Samsonite Omni 3.0 Large Spinner Expandable Luggage", brand: "Samsonite", sizeClass: "large", colour: null, identifiers: [], imageUrl: null, discoveredVia: "sitemap" as const, lastmod: null, active: true };
  await store.upsertListing({ ...omni, sourceId: "canadaluggagedepot", url: CLD, externalId: CLD_HANDLE });
  await store.upsertListing({ ...omni, sourceId: "unluggage", url: UNL, externalId: CLD_HANDLE });
  // Samsonite.ca is blocked; its price comes from a dealer feed, dated.
  const feedListing = await store.upsertListing({ ...omni, sourceId: "samsonite-ca", url: "feed:samsonite-ca:135955", externalId: "135955", discoveredVia: "feed" });
  await store.insertObservation({
    listingId: feedListing.id, sourceId: "samsonite-ca", adapter: "feed_import", price: 299.95, listPrice: 440, currency: "CAD", availability: "in_stock",
    seller: null, condition: null, validation: { outcome: "accepted", confidence: 0.85, reasons: [] }, evidence: { feed: "dealer-oct.csv", row: 2 },
    extractorVersion: EXTRACTOR_VERSION, validatorVersion: VALIDATOR_VERSION, fetchedAt: "2026-10-05T12:00:00.000Z", asOf: "2026-10-01T00:00:00.000Z", sessionId: null,
  });
  const manager = new ResearchManager(rt, luggagePack, { maxConcurrent: 4 });
  const user = randomUUID();
  const start = async (query: string, extra: { deadlineMs?: number; reverifyOf?: string } = {}) => {
    const cfg = { ...engineConfig(), sessionDeadlineMs: extra.deadlineMs ?? 8_000 };
    const created = await createSession(store, user, { query, reverifyOf: extra.reverifyOf }, cfg, "inline");
    if (!created.ok) throw new Error(created.error);
    const events: SessionEvent[] = [];
    manager.subscribe(created.session.id, (e) => events.push(e));
    return { id: created.session.id, events, done: manager.start(created.session.id) };
  };
  return { store, rt, manager, net, start, user };
}

describe("research session (stubbed sources)", () => {
  it("streams fast stores first, slow stores later, and labels every store and price", async () => {
    const { store, net, start } = await setup({
      [`${CLD}.json`]: { body: CLD_JSON, delayMs: 50 },
      [`${UNL}.json`]: { body: UNL_JSON, delayMs: 900 },
    });
    const s = await start("Samsonite Omni 3.0 Large");
    const answer = await s.done;
    expect(answer).not.toBeNull();

    const types = s.events.map((e) => e.type);
    expect(types[0]).toBe("session_started");
    expect(types[1]).toBe("plan");
    expect(types.at(-1)).toBe("session_done");
    const offerEvents = s.events.filter((e) => e.type === "store_offers").map((e) => e.sourceId);
    expect(offerEvents.indexOf("canadaluggagedepot")).toBeLessThan(offerEvents.indexOf("unluggage"));
    // Sequence numbers are gapless and ordered (the stream can resume by seq).
    expect(s.events.map((e) => e.seq)).toEqual(s.events.map((_, i) => i + 1));

    const product = answer!.products[0];
    expect(product.sizeClass).toBe("large");
    const live = product.offers.filter((o) => o.freshness.kind === "live");
    expect(new Set(live.map((o) => o.sourceId))).toEqual(new Set(["canadaluggagedepot", "unluggage"]));
    expect(product.offers[0].price).toBe(269.99); // cheapest first
    const feed = product.offers.find((o) => o.sourceId === "samsonite-ca")!;
    expect(feed.freshness).toEqual({ kind: "feed", asOf: "2026-10-01T00:00:00.000Z" });
    expect(freshnessLabel(feed.freshness)).toMatch(/^Feed as of Oct 1, 2026$/);

    // Zero unlabelled prices.
    for (const p of answer!.products) for (const o of p.offers) expect(freshnessLabel(o.freshness).length).toBeGreaterThan(5);

    const row = (id: string) => answer!.stores.find((r) => r.sourceId === id)!;
    expect(row("canadaluggagedepot").state).toBe("verified");
    expect(row("unluggage").state).toBe("verified");
    expect(row("tumi-ca").state).toBe("blocked");
    expect(row("amazon-ca")).toMatchObject({ state: "link_only", url: "https://www.amazon.ca/s?k=Samsonite%20Omni%203.0%20Large" });
    expect(row("walmart-ca").state).toBe("link_only");
    expect(row("travelpro-ca").state).toBe("not_configured");
    expect(row("travelpro-ca").message).toMatch(/agent profile/);
    expect(answer!.stores.some((r) => r.sourceId === "thebay")).toBe(false);

    expect(answer!.firstPriceMs).not.toBeNull();
    expect(answer!.firstPriceMs!).toBeLessThan(3_000);
    expect(answer!.totalMs).toBeLessThan(12_000);
    expect(answer!.deadlineHit).toBe(false);
    expect((await store.getSession(s.id))?.status).toBe("done");
    // Evidence: one observation per variant per verified store, fetch attempts recorded.
    expect(store.allAttempts().filter((a) => a.adapter === "shopify_product_json").length).toBe(2);
    expect(net.hits.filter((u) => u.includes("samsonite.ca") || u.includes("amazon")).length).toBe(0);
  });

  it("answers at the deadline; a late store is reported timed out and its result is stored, not added", async () => {
    const { store, start } = await setup({
      [`${CLD}.json`]: { body: CLD_JSON },
      [`${UNL}.json`]: { body: UNL_JSON, delayMs: 2_500 },
    });
    const t0 = Date.now();
    const s = await start("Samsonite Omni 3.0 Large", { deadlineMs: 1_200 });
    const answer = await s.done;
    expect(Date.now() - t0).toBeLessThan(2_200);
    expect(answer!.deadlineHit).toBe(true);
    expect(answer!.stores.find((r) => r.sourceId === "unluggage")!.state).toBe("timed_out");
    expect(answer!.products[0].offers.some((o) => o.sourceId === "unluggage")).toBe(false);

    await new Promise((r) => setTimeout(r, 2_200));
    const late = await store.findListingByUrl("unluggage", `${UNL}?variant=42742339010736`);
    expect(late).not.toBeNull();
    expect((await store.latestObservation(late!.id))?.price).toBe(269.99);
    const final = await store.getSession(s.id);
    expect(final!.answer!.products[0].offers.some((o) => o.sourceId === "unluggage")).toBe(false);
  });

  it("shares one verification between concurrent sessions (single-flight)", async () => {
    const { net, start } = await setup({ [`${CLD}.json`]: { body: CLD_JSON, delayMs: 300 }, [`${UNL}.json`]: { body: UNL_JSON } });
    const [a, b] = await Promise.all([start("Samsonite Omni 3.0 Large"), start("Samsonite Omni 3.0 Large")]);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(net.hits.filter((u) => u === `${CLD}.json`).length).toBe(1);
    const ta = ra!.products[0].offers.find((o) => o.sourceId === "canadaluggagedepot")!;
    const tb = rb!.products[0].offers.find((o) => o.sourceId === "canadaluggagedepot")!;
    expect(tb.freshness).toEqual(ta.freshness);
  });

  it("re-verify checks the same listings again", async () => {
    const { net, start } = await setup({ [`${CLD}.json`]: { body: CLD_JSON }, [`${UNL}.json`]: { body: UNL_JSON } }, { singleFlightMs: 0 });
    const first = await start("Samsonite Omni 3.0 Large");
    await first.done;
    const again = await start("ignored: re-verify uses the parent's query", { reverifyOf: first.id });
    const answer = await again.done;
    expect(answer!.query).toBe("Samsonite Omni 3.0 Large");
    expect(net.hits.filter((u) => u === `${CLD}.json`).length).toBe(2);
    expect(answer!.products[0].offers.filter((o) => o.freshness.kind === "live").length).toBeGreaterThan(0);
  });

  it("can be cancelled", async () => {
    const { store, manager, start } = await setup({ [`${CLD}.json`]: { body: CLD_JSON, delayMs: 3_000 }, [`${UNL}.json`]: { body: UNL_JSON, delayMs: 3_000 } });
    const s = await start("Samsonite Omni 3.0 Large");
    await new Promise((r) => setTimeout(r, 200));
    expect(manager.cancel(s.id)).toBe(true);
    expect(await s.done).toBeNull();
    expect((await store.getSession(s.id))?.status).toBe("cancelled");
    expect(s.events.at(-1)?.type).toBe("session_cancelled");
  });

  it("readings that fail validation are stored as evidence and never shown", async () => {
    const usd = CLD_JSON.replace(/"price_currency":"CAD"/g, '"price_currency":"USD"');
    const { store, start } = await setup({ [`${CLD}.json`]: { body: usd }, [`${UNL}.json`]: { body: UNL_JSON } });
    const answer = await (await start("Samsonite Omni 3.0 Large")).done;
    expect(answer!.products.flatMap((p) => p.offers).some((o) => o.sourceId === "canadaluggagedepot")).toBe(false);
    expect(answer!.stores.find((r) => r.sourceId === "canadaluggagedepot")!.state).toBe("error");
    const rejections = await store.recentRejections(20);
    expect(rejections.some((r) => r.sourceId === "canadaluggagedepot" && r.reasons.some((x) => /USD/.test(x)))).toBe(true);
  });

  it("follows events from the store (the NDJSON stream's source)", async () => {
    const { rt, manager, start } = await setup({ [`${CLD}.json`]: { body: CLD_JSON }, [`${UNL}.json`]: { body: UNL_JSON } });
    const s = await start("Samsonite Omni 3.0 Large");
    const seen: SessionEvent[] = [];
    const end = await followSession({ rt, manager }, s.id, 0, (e) => seen.push(e), { pollMs: 20 });
    expect(end).toBe("done");
    expect(seen.at(-1)?.type).toBe("session_done");
    const resumed: SessionEvent[] = [];
    await followSession({ rt, manager }, s.id, 2, (e) => resumed.push(e), { pollMs: 20 });
    expect(resumed[0].seq).toBe(3);
  });
});

describe("research API rules", () => {
  it("validates input", () => {
    expect(parseResearchInput({ query: "Samsonite Omni" }).ok).toBe(true);
    expect(parseResearchInput({ query: "  " }).ok).toBe(false);
    expect(parseResearchInput({ query: "x".repeat(201) }).ok).toBe(false);
    expect(parseResearchInput({ query: "x", admin: true }).ok).toBe(false);
    expect(parseResearchInput({ query: "x", reverifyOf: "../etc" }).ok).toBe(false);
    expect(parseResearchInput(null).ok).toBe(false);
  });

  it("limits sessions per user per window and concurrent sessions", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const cfg = { ...engineConfig(), rateLimit: { perWindow: 2, windowMs: 600_000, maxConcurrent: 1 } };
    const user = randomUUID();
    expect((await checkRateLimit(store, user, cfg)).ok).toBe(true);
    const s1 = await store.createSession({ userId: user, query: "a", deadlineMs: 11_000, mode: "inline" });
    expect(await checkRateLimit(store, user, cfg)).toMatchObject({ ok: false, retryAfterSec: 5 });
    await store.updateSession(s1.id, { status: "done" });
    await store.createSession({ userId: user, query: "b", deadlineMs: 11_000, mode: "inline" }).then((s) => store.updateSession(s.id, { status: "done" }));
    const denied = await checkRateLimit(store, user, cfg);
    expect(denied.ok).toBe(false);
    expect(await checkRateLimit(store, randomUUID(), cfg)).toEqual({ ok: true });
  });

  it("re-verify of someone else's session is refused", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const other = await store.createSession({ userId: randomUUID(), query: "a", deadlineMs: 11_000, mode: "inline" });
    const r = await createSession(store, randomUUID(), { query: "x", reverifyOf: other.id }, engineConfig(), "inline");
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
