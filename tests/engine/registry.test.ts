import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { engineConfig, type EngineConfig } from "@/lib/engine/config";
import { resolveFlags } from "@/lib/engine/flags";
import {
  SOURCE_SEED,
  checkRoutes,
  isFetchHost,
  linkOnlyUrl,
  normaliseHost,
  sourceForUrl,
  usableRoutes,
} from "@/lib/engine/registry";

type AuditStore = { id: string; domains: string[]; liveVerification: string; status: string };
const audit = JSON.parse(readFileSync(resolve("docs/store-audit.json"), "utf8")) as { stores: AuditStore[] };

const byId = (id: string) => {
  const s = SOURCE_SEED.find((x) => x.id === id);
  if (!s) throw new Error(`no source ${id}`);
  return s;
};

const baseConfig: EngineConfig = { ...engineConfig(), ucpAgentProfileUrl: null, ebay: null, amazon: null };
const withProfile: EngineConfig = { ...baseConfig, ucpAgentProfileUrl: "https://example.org/.well-known/ucp-agent" };
const flags = resolveFlags();

describe("registry seed vs the store audit", () => {
  it("has every audited store, and no store the audit doesn't know", () => {
    expect(new Set(SOURCE_SEED.map((s) => s.id))).toEqual(new Set(audit.stores.map((s) => s.id)));
  });

  it("uses the audited domains (host part), corrected where the audit said so", () => {
    for (const a of audit.stores) {
      const s = byId(a.id);
      for (const d of a.domains) {
        const host = normaliseHost(d.split("/")[0]);
        expect(s.allowedDomains.map(normaliseHost), `${a.id} should list ${host}`).toContain(host);
      }
    }
  });

  it("never lists look-alike or wrong-market domains", () => {
    const bad = ["delseyluggagecanada.ca", "delseyluggageca.ca", "bentley.ca", "monos.com", "briggs-riley.com", "thebay.com"];
    for (const s of SOURCE_SEED) {
      for (const h of [...s.allowedDomains, ...s.fetchHosts]) expect(bad, `${s.id}: ${h}`).not.toContain(normaliseHost(h));
    }
  });

  it("has unique ids and unique listing domains", () => {
    const ids = SOURCE_SEED.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const domains = SOURCE_SEED.flatMap((s) => s.allowedDomains.map(normaliseHost));
    expect(new Set(domains).size).toBe(domains.length);
  });

  it("honours the robots.txt crawl delay at minimum", () => {
    for (const s of SOURCE_SEED) {
      if (s.robots.crawlDelaySec !== null) expect(s.crawlDelaySec).toBeGreaterThanOrEqual(s.robots.crawlDelaySec);
      expect(s.crawlDelaySec).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("rule 2: stores whose terms forbid automated access", () => {
  const forbidden = ["amazon-ca", "walmart-ca", "costco-ca", "ebay-ca", "bestbuy-ca", "canadiantire", "londondrugs"];

  it("never list their storefront as a fetch host", () => {
    for (const id of forbidden) {
      const s = byId(id);
      for (const d of s.allowedDomains) expect(isFetchHost(s, d), `${id} storefront ${d}`).toBe(false);
      expect(s.permission).toBe("forbidden");
    }
  });

  it("have no storefront routes, even with every flag on", () => {
    const allOn = Object.fromEntries(Object.keys(flags).map((k) => [k, true]));
    const ctx = { flags: allOn, config: { ...withProfile, ebay: { clientId: "x", clientSecret: "y" }, amazon: { credentialId: "a", credentialSecret: "b", partnerTag: "c" } } };
    for (const id of forbidden) {
      const adapters = usableRoutes(byId(id), ctx).map((r) => r.adapter);
      expect(adapters).not.toContain("html_structured");
      expect(adapters).not.toContain("shopify_product_json");
      expect(adapters).not.toContain("shopify_ucp");
    }
  });

  it("are linked, not priced, when nothing official is configured", () => {
    for (const id of ["amazon-ca", "walmart-ca", "bestbuy-ca", "costco-ca"]) {
      expect(usableRoutes(byId(id), { flags, config: baseConfig })).toEqual([]);
      expect(linkOnlyUrl(byId(id), "Samsonite Outline Pro")).toMatch(/^https:\/\//);
    }
  });
});

describe("exact host matching", () => {
  it("maps a listing URL to its store", () => {
    expect(sourceForUrl("https://www.canadaluggagedepot.ca/products/x")?.id).toBe("canadaluggagedepot");
    expect(sourceForUrl("https://delsey.ca/products/x")?.id).toBe("delsey-ca");
  });

  it("rejects look-alikes, sub-domain tricks, and plain http", () => {
    expect(sourceForUrl("https://delseyluggagecanada.ca/products/x")).toBeNull();
    expect(sourceForUrl("https://delsey.ca.evil.example/products/x")).toBeNull();
    expect(sourceForUrl("https://evil-delsey.ca/products/x")).toBeNull();
    expect(sourceForUrl("http://delsey.ca/products/x")).toBeNull();
    expect(sourceForUrl("not a url")).toBeNull();
  });
});

describe("route policy", () => {
  it("Canada Luggage Depot: product JSON now, UCP first once the profile exists", () => {
    expect(usableRoutes(byId("canadaluggagedepot"), { flags, config: baseConfig }).map((r) => r.adapter)).toEqual(["shopify_product_json"]);
    expect(usableRoutes(byId("canadaluggagedepot"), { flags, config: withProfile }).map((r) => r.adapter)).toEqual(["shopify_ucp", "shopify_product_json"]);
  });

  it("U.N. Luggage: product JSON only after a human flips the per-store flag", () => {
    expect(usableRoutes(byId("unluggage"), { flags, config: baseConfig })).toEqual([]);
    const on = resolveFlags([{ key: "source.unluggage.product_json", enabled: true }]);
    expect(usableRoutes(byId("unluggage"), { flags: on, config: baseConfig }).map((r) => r.adapter)).toEqual(["shopify_product_json"]);
  });

  it("restricted Shopify stores: UCP only, and only under the policy flag", () => {
    expect(usableRoutes(byId("travelpro-ca"), { flags, config: withProfile }).map((r) => r.adapter)).toEqual(["shopify_ucp"]);
    const off = resolveFlags([{ key: "policy.ucp_on_restricted_stores", enabled: false }]);
    expect(usableRoutes(byId("travelpro-ca"), { flags: off, config: withProfile })).toEqual([]);
    expect(usableRoutes(byId("luggagecity"), { flags, config: withProfile })).toEqual([]);
  });

  it("blocked stores: no live route until a human re-enables it", () => {
    for (const id of ["samsonite-ca", "tumi-ca", "sportinglife", "simons"]) {
      const s = byId(id);
      expect(s.liveClass).toBe("blocked");
      expect(usableRoutes(s, { flags, config: withProfile }).filter((r) => r.adapter === "html_structured")).toEqual([]);
    }
  });

  it("eBay: Browse API only, and only with keys", () => {
    expect(usableRoutes(byId("ebay-ca"), { flags, config: baseConfig })).toEqual([]);
    const keyed = { ...baseConfig, ebay: { clientId: "x", clientSecret: "y" } };
    expect(usableRoutes(byId("ebay-ca"), { flags, config: keyed }).map((r) => r.adapter)).toEqual(["ebay_browse_api"]);
  });

  it("explains why a route is unusable", () => {
    const checks = checkRoutes(byId("canadaluggagedepot"), { flags, config: baseConfig });
    expect(checks[0].reason).toBe("not_configured");
    expect(checks[0].message).toMatch(/agent profile/i);
  });

  it("Hudson's Bay is defunct and never used", () => {
    expect(byId("thebay").status).toBe("defunct");
    expect(usableRoutes(byId("thebay"), { flags, config: withProfile })).toEqual([]);
  });
});
