/* ------------------------------------------------------------------ */
/*  Admin / observability (P7 check: source health and recent failures */
/*  visible), plus flag, feed and manual-entry rules.                   */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  adminOverview,
  importFeedAdmin,
  recordManualAdmin,
  setFlagAdmin,
} from "@/lib/engine/admin-actions";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";

function setup() {
  const store = new MemoryEngineStore(SOURCE_SEED);
  const rt = createRuntime(store, {
    fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    resolve: async () => ["23.227.38.65"],
  });
  return { store, rt };
}

const attempt = (sourceId: string, outcome: "ok" | "challenge", status: number) => ({
  sourceId,
  adapter: "html_structured" as const,
  url: `https://example/${sourceId}`,
  method: "GET",
  status,
  outcome,
  durationMs: 90,
  bytes: 5000,
  error: outcome === "ok" ? null : `HTTP ${status}`,
  startedAt: new Date().toISOString(),
  sessionId: null,
  cacheAgeSec: null,
});

describe("admin overview", () => {
  it("shows source health, block rates, recent failures and route usability", async () => {
    const { store, rt } = setup();
    await store.insertFetchAttempts([
      attempt("samsonite-ca", "challenge", 307),
      attempt("samsonite-ca", "challenge", 307),
      attempt("delsey-ca", "ok", 200),
    ]);
    const o = await adminOverview(rt);
    const sam = o.sources.find((s) => s.sourceId === "samsonite-ca")!;
    expect(sam.attempts24h).toBe(2);
    expect(sam.blockRate24h).toBe(1);
    expect(sam.liveClass).toBe("blocked");
    expect(o.sources.find((s) => s.sourceId === "delsey-ca")!.successRate7d).toBe(1);
    expect(o.failures.map((f) => f.outcome)).toEqual(["challenge", "challenge"]);
    const cld = o.sources.find((s) => s.sourceId === "canadaluggagedepot")!;
    expect(cld.routes.find((r) => r.adapter === "shopify_product_json")!.usable).toBe(true);
    expect(cld.routes.find((r) => r.adapter === "shopify_ucp")!.reason).toMatch(/agent profile/);
    expect(o.flags.find((f) => f.key === "engine.default_search")!.enabled).toBe(true);
    expect(o.flags.find((f) => f.key === "discovery.tavily")!.enabled).toBe(false);
  });

  it("only known flags can be flipped", async () => {
    const { rt } = setup();
    expect((await setFlagAdmin(rt, "made.up", true, randomUUID())).ok).toBe(false);
    expect((await setFlagAdmin(rt, "discovery.tavily", true, randomUUID())).ok).toBe(true);
    expect((await rt.flags())["discovery.tavily"]).toBe(true);
  });
});

describe("admin data entry", () => {
  it("imports a dealer feed as dated, validated observations", async () => {
    const { store, rt } = setup();
    const csv = [
      "Item Number,UPC,Product Name,Dealer Price,MSRP,Stock",
      "137394-1041,043202927614,Samsonite Outline Pro Spinner Medium Black,259.00,405.00,Y",
      "bad,,No Price Row,,,",
    ].join("\n");
    const r = await importFeedAdmin(
      rt,
      luggagePack,
      {
        sourceId: "samsonite-ca",
        format: "csv",
        asOf: "2026-10-01",
        name: "dealer.csv",
        content: csv,
      },
      randomUUID(),
    );
    expect(r).toMatchObject({ ok: true, accepted: 1, rejected: 1 });
    expect((await store.sourcesWithAdapter("feed_import")).has("samsonite-ca")).toBe(true);
    expect(
      (
        await importFeedAdmin(
          rt,
          luggagePack,
          { sourceId: "samsonite-ca", format: "csv", asOf: "Oct 1", name: "x", content: csv },
          "u",
        )
      ).ok,
    ).toBe(false);
  });

  it("records a manual price and refuses links to other sites", async () => {
    const { rt } = setup();
    const ok = await recordManualAdmin(
      rt,
      luggagePack,
      "costco-ca",
      { title: "Samsonite 2-Piece Hardside Set", price: 299.99, checkedAt: "2026-10-06" },
      randomUUID(),
    );
    expect(ok.ok).toBe(true);
    const bad = await recordManualAdmin(
      rt,
      luggagePack,
      "costco-ca",
      { title: "x", price: 10, checkedAt: "2026-10-06", url: "https://www.amazon.ca/dp/1" },
      randomUUID(),
    );
    expect(bad.ok).toBe(false);
  });
});
