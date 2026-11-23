/* ------------------------------------------------------------------ */
/*  Discovery v2 (v4 A6): candidate stores, probe, look-alikes, terms   */
/*  quotes, single-page reads (off). Stubbed network; the candidate's   */
/*  pages are recorded/constructed bodies, never a live store.          */
/* ------------------------------------------------------------------ */

import { afterEach, describe, expect, it } from "vitest";
import { termsQuotes } from "@/lib/engine/ai";
import {
  addCandidate,
  candidateHost,
  decideCandidate,
  listCandidates,
  lookalikeOf,
  pageText,
  probeCandidate,
} from "@/lib/engine/discovery/candidates";
import { pickSinglePageRead, readOnce } from "@/lib/engine/discovery/single-page";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { fixture, instantLimiter, stubNet, type StubResponse } from "./helpers";

const HOST = "www.example-luggage-shop.ca";
const ORIGIN = `https://${HOST}`;
const OMNI_HTML = fixture(
  "html/canadaluggagedepot__samsonite-omni-3-0-large-spinner-expandable-luggage.html",
);

function runtime(routes: Record<string, StubResponse> = {}) {
  const net = stubNet(routes);
  const rt = createRuntime(new MemoryEngineStore(SOURCE_SEED), {
    fetchImpl: net.fetchImpl,
    resolve: async () => ["23.227.38.65"],
    limiter: instantLimiter(),
  });
  return { rt, seen: net.seen };
}

const terms = (body: string) => ({
  body: `<html><body><h1>Terms</h1><p>${body}</p></body></html>`,
});

afterEach(() => {
  delete process.env.ENGINE_FLAGS;
});

describe("candidate stores (U-DISC-1, U-DISC-3)", () => {
  it("become an inactive, routeless registry row with their exact host; nothing is fetched", async () => {
    const { rt, seen } = runtime();
    const r = await addCandidate(rt, {
      url: `${ORIGIN}/collections/luggage?page=2`,
      name: "Example Luggage Shop",
      foundVia: "link",
      note: "linked from a brand's dealer page",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toMatchObject({
      status: "inactive",
      enabled: false,
      routes: [],
      permission: "unclear",
      fetchHosts: [HOST],
      allowedDomains: [HOST],
      discovery: { state: "discovered", foundVia: "link", lookalikeOf: null, probe: null },
    });
    expect(seen).toHaveLength(0);
    expect((await listCandidates(rt)).map((s) => s.id)).toEqual([r.source.id]);
    // A store already in the registry, or the same candidate twice, is refused.
    expect(
      await addCandidate(rt, { url: "https://www.canadaluggagedepot.ca", foundVia: "staff" }),
    ).toMatchObject({ ok: false });
    expect(await addCandidate(rt, { url: HOST, foundVia: "staff" })).toMatchObject({ ok: false });
  });

  it("accepts only https domain names", () => {
    expect(candidateHost("https://Shop.Example.ca./x")).toBe("shop.example.ca");
    expect(candidateHost("shop.example.ca")).toBe("shop.example.ca");
    expect(candidateHost("http://shop.example.ca")).toBeNull();
    expect(candidateHost("https://203.0.113.9/")).toBeNull();
    expect(candidateHost("https://shop.example.ca:8443/")).toBeNull();
    expect(candidateHost("localhost")).toBeNull();
  });

  it("flags look-alikes of registry stores and never probes or approves them", async () => {
    expect(lookalikeOf("delseyluggagecanada.ca", SOURCE_SEED)).toMatch(/delsey/);
    expect(lookalikeOf("www.delsy.ca", SOURCE_SEED)).toMatch(/delsey/);
    expect(lookalikeOf("canadaluggagedepot-sale.com", SOURCE_SEED)).toMatch(/canadaluggagedepot/);
    expect(lookalikeOf("xn--dlsey-6qa.ca", SOURCE_SEED)).toMatch(/internationalised/);
    expect(lookalikeOf(HOST, SOURCE_SEED)).toBeNull();
    const { rt, seen } = runtime();
    const r = await addCandidate(rt, {
      url: "https://delseyluggagecanada.ca",
      foundVia: "common_crawl",
    });
    expect(r.ok && r.source.domainWarnings[0]).toMatch(/looks like/);
    const id = r.ok ? r.source.id : "";
    expect(await probeCandidate(rt, id)).toMatchObject({ ok: false });
    expect(await decideCandidate(rt, id, "approved_crawl", null)).toMatchObject({ ok: false });
    expect(seen).toHaveLength(0);
    expect(await decideCandidate(rt, id, "rejected", null)).toMatchObject({ ok: true });
  });
});

describe("probe (U-DISC-2, U-TERMS-1)", () => {
  it("single_page_ok only when robots.txt allows us and the terms quote nothing", async () => {
    const { rt, seen } = runtime({
      [`${ORIGIN}/robots.txt`]: { body: "User-agent: *\nDisallow: /cart\n" },
      [`${ORIGIN}/policies/terms-of-service`]: terms(
        "Prices are in Canadian dollars. Orders ship within two business days.",
      ),
    });
    const r = await addCandidate(rt, { url: ORIGIN, foundVia: "staff" });
    const probed = await probeCandidate(rt, r.ok ? r.source.id : "");
    expect(probed.ok && probed.source.discovery).toMatchObject({
      state: "single_page_ok",
      probe: {
        robots: "allows",
        termsUrl: `${ORIGIN}/policies/terms-of-service`,
        quotes: [],
        requests: 2,
      },
    });
    // Every request went to the candidate's own host, robots.txt first.
    expect(seen.map((s) => new URL(s.url).hostname).every((h) => h === HOST)).toBe(true);
    expect(seen[0].url).toBe(`${ORIGIN}/robots.txt`);
    // Still nothing a search or crawl may use: inactive, disabled, no routes.
    expect(probed.ok && probed.source).toMatchObject({
      status: "inactive",
      enabled: false,
      routes: [],
    });
  });

  it("needs a person when robots.txt says no to our token, or the terms say something", async () => {
    const blocked = runtime({
      [`${ORIGIN}/robots.txt`]: { body: "User-agent: LuggageTrackerBot\nDisallow: /products/\n" },
    });
    const a = await addCandidate(blocked.rt, { url: ORIGIN, foundVia: "staff" });
    const pa = await probeCandidate(blocked.rt, a.ok ? a.source.id : "");
    expect(pa.ok && pa.source.discovery?.state).toBe("needs_review");
    expect(pa.ok && pa.source.discovery?.probe?.robots).toBe("disallows");

    const clause =
      "You may not use any robot, spider or other automated means to access the Site for any purpose without our express written permission.";
    const restricted = runtime({
      [`${ORIGIN}/pages/terms-of-service`]: terms(`Welcome to our store. ${clause} Thank you.`),
    });
    const b = await addCandidate(restricted.rt, { url: ORIGIN, foundVia: "staff" });
    const pb = await probeCandidate(restricted.rt, b.ok ? b.source.id : "");
    expect(pb.ok && pb.source.discovery).toMatchObject({
      state: "needs_review",
      probe: {
        termsUrl: `${ORIGIN}/pages/terms-of-service`,
        quotes: [{ category: "prohibits_automated_access", sentence: clause }],
      },
    });
    expect(pb.ok && pb.source.terms.stance).toBe("prohibits");
    // The owner can still decide; the pre-screen only says what to read.
    expect(
      await decideCandidate(restricted.rt, b.ok ? b.source.id : "", "rejected", "u1"),
    ).toMatchObject({
      ok: true,
      source: { discovery: { state: "rejected", decidedBy: "u1" } },
    });
  });

  it("terms quotes are whole sentences copied verbatim from the page", () => {
    const text = pageText(
      "<div><p>Use of this site is for personal, non-commercial use only.</p><script>var robots=1;</script><p>Content may not be reproduced without written permission. We love luggage!</p></div>",
    );
    const quotes = termsQuotes(text);
    expect(quotes).toEqual([
      {
        category: "non_commercial_only",
        sentence: "Use of this site is for personal, non-commercial use only.",
      },
      {
        category: "requires_permission",
        sentence: "Content may not be reproduced without written permission.",
      },
    ]);
    for (const q of quotes) expect(text.includes(q.sentence)).toBe(true);
  });
});

describe("single-page reads (U-POLICY-1…4)", () => {
  async function passedCandidate(routes: Record<string, StubResponse>) {
    const net = runtime({
      [`${ORIGIN}/robots.txt`]: { body: "User-agent: *\nDisallow: /checkout\n" },
      [`${ORIGIN}/policies/terms-of-service`]: terms("Prices are in Canadian dollars."),
      ...routes,
    });
    const r = await addCandidate(net.rt, { url: ORIGIN, name: "Example Shop", foundVia: "staff" });
    const p = await probeCandidate(net.rt, r.ok ? r.source.id : "");
    if (!p.ok) throw new Error(p.error);
    return { ...net, source: p.source };
  }

  it("off by default: no read, no request", async () => {
    const { rt, seen, source } = await passedCandidate({});
    const before = seen.length;
    const r = await readOnce(rt, luggagePack, source, `${ORIGIN}/products/omni`);
    expect(r).toMatchObject({ status: "off", offers: [] });
    expect(seen.length).toBe(before);
  });

  it("on: one page of one passed store, labelled, without its image", async () => {
    process.env.ENGINE_FLAGS = "discovery.single_page_reads=on";
    const { rt, source } = await passedCandidate({
      [`${ORIGIN}/products/omni`]: { body: OMNI_HTML },
    });
    rt.invalidate();
    const sources = await rt.sources();
    expect(
      pickSinglePageRead(sources, [
        { sourceId: "canadaluggagedepot", url: "https://www.canadaluggagedepot.ca/products/x" },
        { sourceId: source.id, url: `${ORIGIN}/products/omni` },
        { sourceId: source.id, url: `${ORIGIN}/products/other` },
      ]),
    ).toMatchObject({ url: `${ORIGIN}/products/omni` });
    const r = await readOnce(rt, luggagePack, source, `${ORIGIN}/products/omni`);
    expect(r.status).toBe("ok");
    expect(r.offers.length).toBeGreaterThan(0);
    for (const o of r.offers) {
      expect(o.label).toBe("Read once from Example Shop · not reviewed yet");
      expect(o.imageUrl).toBeNull();
      expect(o.url.startsWith(ORIGIN)).toBe(true);
    }
    // Another host, or a store whose probe didn't pass, is never read.
    expect((await readOnce(rt, luggagePack, source, "https://evil.example.com/p")).status).toBe(
      "not_allowed",
    );
    const fresh = await addCandidate(rt, { url: "https://www.another-shop.ca", foundVia: "staff" });
    expect(
      (
        await readOnce(
          rt,
          luggagePack,
          fresh.ok ? fresh.source : source,
          "https://www.another-shop.ca/p",
        )
      ).status,
    ).toBe("not_allowed");
  });

  it("on: robots.txt still decides, and the read stops at its 3 s budget", async () => {
    process.env.ENGINE_FLAGS = "discovery.single_page_reads=on";
    const { source } = await passedCandidate({});
    // robots.txt changed after the probe: the fetcher reads it again and refuses.
    const net = stubNet({ [`${ORIGIN}/robots.txt`]: { body: "User-agent: *\nDisallow: /\n" } });
    const strict = createRuntime(new MemoryEngineStore(SOURCE_SEED), {
      fetchImpl: net.fetchImpl,
      resolve: async () => ["23.227.38.65"],
      limiter: instantLimiter(),
    });
    const r = await readOnce(strict, luggagePack, source, `${ORIGIN}/products/omni`);
    expect(r.status).toBe("failed");
    expect(net.seen.map((s) => s.url)).toEqual([`${ORIGIN}/robots.txt`]);

    const slow = stubNet({ [`${ORIGIN}/products/slow`]: { body: OMNI_HTML } });
    const slowFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      if (String(input).endsWith("/products/slow"))
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 10_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      return slow.fetchImpl(input, init);
    }) as typeof fetch;
    const slowRt = createRuntime(new MemoryEngineStore(SOURCE_SEED), {
      fetchImpl: slowFetch,
      resolve: async () => ["23.227.38.65"],
      limiter: instantLimiter(),
    });
    const started = Date.now();
    const t = await readOnce(slowRt, luggagePack, source, `${ORIGIN}/products/slow`);
    expect(t.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
