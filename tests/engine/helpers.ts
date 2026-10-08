/* ------------------------------------------------------------------ */
/*  Test helpers: a stub network that serves fixtures, a fetcher whose  */
/*  limiter doesn't really sleep, and an adapter context.               */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdapterContext } from "@/lib/engine/adapters";
import { engineConfig, type EngineConfig } from "@/lib/engine/config";
import { PoliteFetcher, memoryHealth } from "@/lib/engine/politeness/fetcher";
import { HostLimiter } from "@/lib/engine/politeness/limiter";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import type { FetchAttempt, SourceRecord } from "@/lib/engine/types";

export const fixture = (path: string) => readFileSync(resolve("scripts/fixtures", path), "utf8");

export type StubResponse = { status?: number; body: string; headers?: Record<string, string> };
export type Seen = { url: string; method: string; headers: Record<string, string>; body: string | null };

/** Serves `routes` by exact URL; robots.txt allows everything unless a route overrides it. */
export function stubNet(routes: Record<string, StubResponse | ((init: RequestInit) => StubResponse)>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, method: init.method ?? "GET", headers: { ...((init.headers ?? {}) as Record<string, string>) }, body: typeof init.body === "string" ? init.body : null });
    const route = routes[url];
    if (route) {
      const r = typeof route === "function" ? route(init) : route;
      return new Response(r.body, { status: r.status ?? 200, headers: r.headers });
    }
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

/** A limiter that keeps ordering and spacing bookkeeping but never actually waits. */
export function instantLimiter(): HostLimiter {
  return new HostLimiter({ now: () => Date.now(), sleep: async () => undefined });
}

export const source = (id: string): SourceRecord => {
  const s = SOURCE_SEED.find((x) => x.id === id);
  if (!s) throw new Error(`no source ${id}`);
  return s;
};

export function makeCtx(
  sourceId: string,
  fetchImpl: typeof fetch,
  config: Partial<EngineConfig> = {},
  attempts: FetchAttempt[] = [],
): AdapterContext {
  const fetcher = new PoliteFetcher({
    fetchImpl,
    resolve: async () => ["23.227.38.65"],
    limiter: instantLimiter(),
    health: memoryHealth(),
    onAttempt: (a) => attempts.push(a),
  });
  return {
    source: source(sourceId),
    fetcher,
    config: { ...engineConfig(), ucpAgentProfileUrl: null, ebay: null, amazon: null, ...config },
    pack: luggagePack,
    now: () => Date.parse("2026-10-07T21:30:00Z"),
  };
}

type ProbeVariant = { id: string; title: string | null; sku: string | null; barcode: string | null; price: number | null; compareAt: number | null; available: boolean | null; inventory: number | null; options: string[] };
type ProbeProduct = { id: string | null; title: string | null; vendor: string | null; type: string | null; variants: ProbeVariant[] };

/**
 * Rebuild a Shopify .json / .js body from the values the 7 Oct probe
 * recorded (docs/probe-results.json) for stores whose product JSON we may
 * not fetch again until a human reads their terms.
 */
export function probeShopifyBodies(storeId: string, handle: string): { json: string; js: string } {
  const probe = JSON.parse(readFileSync(resolve("docs/probe-results.json"), "utf8")) as {
    stores: { id: string; channels: { channel: string; product?: ProbeProduct }[] }[];
  };
  const store = probe.stores.find((s) => s.id === storeId)!;
  const json = store.channels.find((c) => c.channel === "json")!.product!;
  const js = store.channels.find((c) => c.channel === "js")!.product!;
  return {
    json: JSON.stringify({
      product: {
        id: Number(json.id),
        title: json.title,
        vendor: json.vendor,
        product_type: json.type,
        handle,
        variants: json.variants.map((v) => ({
          id: Number(v.id),
          title: v.title,
          price: v.price?.toFixed(2),
          compare_at_price: v.compareAt?.toFixed(2) ?? null,
          sku: v.sku,
          barcode: v.barcode,
          price_currency: "CAD",
          option1: v.options[0] ?? v.title,
          ...(v.inventory !== null ? { inventory_quantity: v.inventory, inventory_management: "shopify", inventory_policy: "deny" } : {}),
        })),
      },
    }),
    js: JSON.stringify({
      id: Number(js.id),
      title: js.title,
      vendor: js.vendor,
      type: js.type,
      handle,
      variants: js.variants.map((v) => ({
        id: Number(v.id),
        title: v.title,
        price: v.price === null ? null : Math.round(v.price * 100),
        compare_at_price: v.compareAt === null ? null : Math.round(v.compareAt * 100),
        sku: v.sku,
        barcode: v.barcode,
        available: v.available,
        options: v.options,
      })),
    }),
  };
}
