import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { userAgent } from "@/lib/engine/config";
import {
  CIRCUIT_COOLDOWN_MS,
  circuitAllows,
  closedHealth,
  inVisitWindow,
  recordOutcome,
} from "@/lib/engine/politeness/circuit";
import { classifyResponse } from "@/lib/engine/politeness/classify";
import { PoliteFetcher, memoryHealth } from "@/lib/engine/politeness/fetcher";
import { HostLimiter, LimiterTimeout } from "@/lib/engine/politeness/limiter";
import {
  isAllowed,
  parseRobots,
  unavailableRobots,
  unreachableRobots,
} from "@/lib/engine/politeness/robots";
import { SingleFlight } from "@/lib/engine/politeness/singleflight";
import { assertFetchable, isPublicAddress } from "@/lib/engine/politeness/ssrf";
import { SOURCE_SEED } from "@/lib/engine/registry";
import type { FetchAttempt, SourceRecord } from "@/lib/engine/types";

const fixture = (f: string) => readFileSync(resolve("scripts/fixtures", f), "utf8");
const delsey = SOURCE_SEED.find((s) => s.id === "delsey-ca")!;
const publicDns = async () => ["23.227.38.65"];

describe("robots.txt", () => {
  const shopify = parseRobots(
    [
      "User-agent: *",
      "Disallow: /admin",
      "Disallow: /search",
      "Disallow: /collections/*sort_by*",
      "Allow: /search$",
      "Sitemap: https://shop.ca/sitemap.xml",
      "",
      "User-agent: AhrefsBot",
      "Crawl-delay: 10",
      "Disallow: /",
    ].join("\n"),
    "LuggageTrackerBot",
  );
  it("uses the * group and matches like RFC 9309", () => {
    expect(isAllowed(shopify, "https://shop.ca/products/outline-pro.json")).toBe(true);
    expect(isAllowed(shopify, "https://shop.ca/search?q=bag")).toBe(false);
    expect(isAllowed(shopify, "https://shop.ca/collections/all?sort_by=price")).toBe(false);
    expect(shopify.crawlDelaySec).toBeNull();
    expect(shopify.sitemaps).toEqual(["https://shop.ca/sitemap.xml"]);
  });
  it("a group naming us wins over *", () => {
    const r = parseRobots(
      "User-agent: *\nCrawl-delay: 10\n\nUser-agent: LuggageTrackerBot\nDisallow: /",
      "LuggageTrackerBot",
    );
    expect(isAllowed(r, "https://x.ca/p")).toBe(false);
  });
  it("reads crawl-delay; longest match wins with Allow on ties", () => {
    expect(
      parseRobots("User-agent: *\nCrawl-delay: 10\nDisallow: /dw/shop/", "x").crawlDelaySec,
    ).toBe(10);
    expect(
      isAllowed(
        parseRobots("User-agent: *\nDisallow: /p\nAllow: /products/", "x"),
        "https://x.ca/products/a",
      ),
    ).toBe(true);
  });
  it("4xx means no rules; unreadable (blocked/5xx) means don't crawl", () => {
    expect(isAllowed(unavailableRobots(), "https://x.ca/p")).toBe(true);
    expect(isAllowed(unreachableRobots(), "https://x.ca/p")).toBe(false);
  });
});

describe("block classifier (recorded block pages)", () => {
  it("Samsonite's 307 PerimeterX CAPTCHA is a challenge", () => {
    expect(classifyResponse(307, fixture("blocks/samsonite-perimeterx-307.html"), {})).toBe(
      "challenge",
    );
  });
  it("Sporting Life's Cloudflare page is a challenge", () => {
    expect(
      classifyResponse(403, fixture("blocks/sportinglife-cloudflare-403.html"), {
        "cf-mitigated": "challenge",
      }),
    ).toBe("challenge");
    expect(classifyResponse(403, fixture("blocks/sportinglife-cloudflare-403.html"), {})).toBe(
      "challenge",
    );
  });
  it("plain refusals, limits and misses", () => {
    expect(classifyResponse(403, "Forbidden", {})).toBe("blocked");
    expect(classifyResponse(429, "", {})).toBe("rate_limited");
    expect(classifyResponse(404, "", {})).toBe("not_found");
    expect(classifyResponse(500, "", {})).toBe("error");
    expect(classifyResponse(200, '{"product":{}}', {})).toBe("ok");
  });
});

describe("host limiter", () => {
  it("spaces requests to one host by the crawl delay", async () => {
    const l = new HostLimiter();
    const starts: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        const release = await l.acquire("delsey.ca", 60);
        starts.push(Date.now());
        release();
      }),
    );
    starts.sort((a, b) => a - b);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(55);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(55);
  });
  it("different hosts don't wait for each other", async () => {
    const l = new HostLimiter();
    const t0 = Date.now();
    await Promise.all(["a.ca", "b.ca", "c.ca"].map(async (h) => (await l.acquire(h, 500))()));
    expect(Date.now() - t0).toBeLessThan(200);
  });
  it("refuses up front when the turn would come after the deadline", async () => {
    const l = new HostLimiter();
    (await l.acquire("www.samsonite.ca", 10_000))();
    await expect(
      l.acquire("www.samsonite.ca", 10_000, { deadlineAt: Date.now() + 2_000 }),
    ).rejects.toBeInstanceOf(LimiterTimeout);
  });
});

describe("single-flight", () => {
  it("shares one in-flight call and reuses it within the window", async () => {
    const sf = new SingleFlight<number>(90_000);
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return 42;
    };
    const [a, b] = await Promise.all([sf.run("k", fn), sf.run("k", fn)]);
    const c = await sf.run("k", fn);
    expect(calls).toBe(1);
    expect([a.shared, b.shared, c.shared].filter(Boolean).length).toBe(2);
    expect(c.value).toBe(42);
  });
  it("never shares a failure", async () => {
    const sf = new SingleFlight<{ ok: boolean }>(90_000);
    let calls = 0;
    const fn = async () => ({ ok: ++calls > 1 });
    await sf.run("k", fn, (v) => v.ok);
    const second = await sf.run("k", fn, (v) => v.ok);
    expect(calls).toBe(2);
    expect(second.value.ok).toBe(true);
  });
});

describe("SSRF guard", () => {
  it("knows public from private addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.9",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ["23.227.38.65", "104.16.1.1", "2606:4700::6810:84e5"])
      expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("only fetches registry hosts over https that resolve publicly", async () => {
    await expect(
      assertFetchable("https://delsey.ca/products/x.json", delsey, publicDns),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertFetchable("http://delsey.ca/products/x.json", delsey, publicDns),
    ).rejects.toThrow(/https/);
    await expect(assertFetchable("https://delsey.ca:8443/x", delsey, publicDns)).rejects.toThrow(
      /443/,
    );
    await expect(
      assertFetchable("https://delseyluggagecanada.ca/x", delsey, publicDns),
    ).rejects.toThrow(/not a registry host/);
    await expect(assertFetchable("https://23.227.38.65/x", delsey, publicDns)).rejects.toThrow(
      /IP literal/,
    );
    await expect(
      assertFetchable("https://delsey.ca/x", delsey, async () => ["127.0.0.1"]),
    ).rejects.toThrow(/non-public/);
    await expect(
      assertFetchable("https://delsey.ca/x", delsey, async () => ["23.227.38.65", "10.0.0.2"]),
    ).rejects.toThrow(/non-public/);
  });
  it("stores whose terms forbid automated access can't be fetched at all", async () => {
    for (const id of [
      "amazon-ca",
      "walmart-ca",
      "costco-ca",
      "bestbuy-ca",
      "canadiantire",
      "londondrugs",
    ]) {
      const s = SOURCE_SEED.find((x) => x.id === id)!;
      await expect(
        assertFetchable(`https://${s.allowedDomains[0]}/`, s, publicDns),
      ).rejects.toThrow(/not a registry host/);
    }
    const ebay = SOURCE_SEED.find((x) => x.id === "ebay-ca")!;
    await expect(assertFetchable("https://www.ebay.ca/itm/1", ebay, publicDns)).rejects.toThrow();
    await expect(
      assertFetchable(
        "https://api.ebay.com/buy/browse/v1/item_summary/search?q=x",
        ebay,
        publicDns,
      ),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("circuit breaker and visit windows", () => {
  it("opens after 3 consecutive blocks, allows a trial after the cool-down, closes on success", () => {
    const t = Date.parse("2026-10-07T12:00:00Z");
    let h = closedHealth("samsonite-ca");
    h = recordOutcome(h, "challenge", t);
    h = recordOutcome(h, "timeout", t); // our own problems don't count
    h = recordOutcome(h, "challenge", t);
    expect(h.circuit).toBe("closed");
    h = recordOutcome(h, "challenge", t);
    expect(h.circuit).toBe("open");
    expect(circuitAllows(h, t + 60_000).allowed).toBe(false);
    expect(circuitAllows(h, t + CIRCUIT_COOLDOWN_MS)).toEqual({ allowed: true, trial: true });
    expect(recordOutcome({ ...h, circuit: "half_open" }, "ok", t).circuit).toBe("closed");
  });
  it("TUMI's 05:15–09:15 ET visit window", () => {
    const w = { start: "05:15", end: "09:15", timeZone: "America/Toronto" };
    expect(inVisitWindow(w, new Date("2026-10-07T10:00:00Z"))).toBe(true); // 06:00 EDT
    expect(inVisitWindow(w, new Date("2026-10-07T16:00:00Z"))).toBe(false); // 12:00 EDT
    expect(inVisitWindow(null, new Date())).toBe(true);
  });
});

/* ── PoliteFetcher end to end with a stub network ─────────────────── */

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;

function stubFetch(
  routes: Record<string, Route>,
  seen: { url: string; headers: Record<string, string> }[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({
      url,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
    });
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route(url, init);
  }) as typeof fetch;
}

function testSource(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    ...delsey,
    id: "test-store",
    crawlDelaySec: 1,
    ...over,
    fetchHosts: over.fetchHosts ?? ["delsey.ca"],
  };
}

describe("PoliteFetcher", () => {
  it("identifies honestly, honours robots and records every attempt", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const attempts: FetchAttempt[] = [];
    const f = new PoliteFetcher({
      fetchImpl: stubFetch(
        {
          "https://delsey.ca/robots.txt": () => new Response("User-agent: *\nDisallow: /search\n"),
          "https://delsey.ca/products/a.json": () =>
            new Response('{"product":{"id":1}}', {
              headers: { "content-type": "application/json" },
            }),
        },
        seen,
      ),
      resolve: publicDns,
      onAttempt: (a) => attempts.push(a),
    });
    const ok = await f.fetch({
      source: testSource(),
      url: "https://delsey.ca/products/a.json",
      adapter: "shopify_product_json",
    });
    expect(ok.outcome).toBe("ok");
    const disallowed = await f.fetch({
      source: testSource(),
      url: "https://delsey.ca/search?q=x",
      adapter: "html_structured",
    });
    expect(disallowed.outcome).toBe("robots_disallowed");
    expect(seen.map((s) => s.url)).toEqual([
      "https://delsey.ca/robots.txt",
      "https://delsey.ca/products/a.json",
    ]);
    expect(seen[1].headers["User-Agent"]).toBe(userAgent());
    expect(seen[1].headers["User-Agent"]).toMatch(/LuggageTrackerBot\/1\.0 \(\+https?:\/\//);
    expect(attempts.map((a) => a.outcome)).toEqual(["ok", "ok", "robots_disallowed"]);
  });

  it("doesn't crawl when robots.txt itself is behind a challenge", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = new PoliteFetcher({
      fetchImpl: stubFetch(
        {
          "https://delsey.ca/robots.txt": () =>
            new Response(fixture("blocks/sportinglife-cloudflare-403.html"), {
              status: 403,
              headers: { "cf-mitigated": "challenge" },
            }),
        },
        seen,
      ),
      resolve: publicDns,
    });
    const r = await f.fetch({
      source: testSource(),
      url: "https://delsey.ca/products/a.json",
      adapter: "shopify_product_json",
    });
    expect(r.outcome).toBe("robots_disallowed");
    expect(seen.length).toBe(1);
  });

  it("re-checks every redirect hop against the registry", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = new PoliteFetcher({
      fetchImpl: stubFetch(
        {
          "https://delsey.ca/robots.txt": () => new Response("", { status: 404 }),
          "https://delsey.ca/products/old.json": () =>
            new Response("", { status: 301, headers: { location: "/products/new.json" } }),
          "https://delsey.ca/products/new.json": () => new Response('{"product":{"id":2}}'),
          "https://delsey.ca/products/evil.json": () =>
            new Response("", {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/meta-data" },
            }),
        },
        seen,
      ),
      resolve: publicDns,
    });
    const moved = await f.fetch({
      source: testSource(),
      url: "https://delsey.ca/products/old.json",
      adapter: "shopify_product_json",
    });
    expect(moved.outcome).toBe("ok");
    expect(moved.finalUrl).toBe("https://delsey.ca/products/new.json");
    const evil = await f.fetch({
      source: testSource(),
      url: "https://delsey.ca/products/evil.json",
      adapter: "shopify_product_json",
    });
    expect(evil.outcome).toBe("ssrf_rejected");
    expect(seen.some((s) => s.url.includes("169.254"))).toBe(false);
  });

  it("opens the circuit after repeated blocks and stops knocking", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const health = memoryHealth();
    const f = new PoliteFetcher({
      fetchImpl: stubFetch(
        {
          "https://delsey.ca/robots.txt": () => new Response("User-agent: *\nAllow: /\n"),
          "https://delsey.ca/p": () =>
            new Response(fixture("blocks/samsonite-perimeterx-307.html"), { status: 307 }),
        },
        seen,
      ),
      resolve: publicDns,
      health,
    });
    const src = testSource();
    const outcomes: string[] = [];
    for (let i = 0; i < 4; i++)
      outcomes.push(
        (await f.fetch({ source: src, url: "https://delsey.ca/p", adapter: "html_structured" }))
          .outcome,
      );
    expect(outcomes).toEqual(["challenge", "challenge", "challenge", "circuit_open"]);
    expect(seen.filter((s) => s.url === "https://delsey.ca/p").length).toBe(3);
    expect((await health.get("test-store")).circuit).toBe("open");
  });

  it("never contacts a host outside the source's fetch hosts", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const amazon = SOURCE_SEED.find((s) => s.id === "amazon-ca")!;
    const f = new PoliteFetcher({ fetchImpl: stubFetch({}, seen), resolve: publicDns });
    const r = await f.fetch({
      source: amazon,
      url: "https://www.amazon.ca/dp/B000",
      adapter: "html_structured",
    });
    expect(r.outcome).toBe("ssrf_rejected");
    expect(seen.length).toBe(0);
  });

  it("gives up early instead of waiting past the deadline for a crawl delay", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = new PoliteFetcher({
      fetchImpl: stubFetch(
        {
          "https://delsey.ca/robots.txt": () => new Response("User-agent: *\nCrawl-delay: 10\n"),
          "https://delsey.ca/a": () => new Response("ok"),
        },
        seen,
      ),
      resolve: publicDns,
    });
    const src = testSource();
    expect(
      (
        await f.fetch({
          source: src,
          url: "https://delsey.ca/a",
          adapter: "html_structured",
          deadlineAt: Date.now() + 20_000,
        })
      ).outcome,
    ).toBe("ok");
    const late = await f.fetch({
      source: src,
      url: "https://delsey.ca/a",
      adapter: "html_structured",
      deadlineAt: Date.now() + 1_000,
    });
    expect(late.outcome).toBe("timeout");
    expect(late.error).toMatch(/crawl delay/);
  });
});
