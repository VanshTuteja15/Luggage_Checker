/* ------------------------------------------------------------------ */
/*  Registry → SQL                                                     */
/*                                                                     */
/*  Idempotent upserts for the `sources` table and default rows for    */
/*  `feature_flags`. Runtime state an admin controls (enabled, circuit */
/*  breaker, flag values) is never overwritten by a re-seed.           */
/* ------------------------------------------------------------------ */

import { FLAG_DEFAULTS } from "../flags";
import type { SourceRecord } from "../types";
import { SEED_VERSION, SOURCE_SEED } from "./seed";

/** SQL literal for a value. Strings are escaped; never interpolate raw input. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in SQL literal");
    return String(v);
  }
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  throw new Error(`unsupported SQL literal type: ${typeof v}`);
}

function textArray(values: string[]): string {
  return values.length ? `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]` : "'{}'::text[]";
}

function jsonb(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
}

const FLAG_DESCRIPTIONS: Record<string, string> = {
  "engine.enabled": "New price engine available (research API, worker jobs)",
  "engine.default_search": "Search opens on verified prices (the engine) instead of web research",
  "discovery.tavily": "Tavily as a discovery fallback: URLs only, never prices",
  "chat.enabled": "AI assistant: answers only from stored, dated prices (off by default)",
  "estimates.web": "Web estimates from search results for stores we can't read live (free credits only)",
  "policy.ucp_on_restricted_stores":
    "Use the store-published UCP channel on stores whose terms carry a generic anti-scrape clause (legal sign-off pending)",
  "source.luggagecity.ucp": "Luggage City UCP (audit: legal review first)",
  "source.unluggage.product_json": "U.N. Luggage product JSON (turn on after reading the terms)",
  "source.bentley.product_json": "Bentley product JSON (turn on after reading the terms)",
  "source.samsonite-ca.html_structured":
    "Samsonite.ca pages (blocked by PerimeterX from our network)",
  "source.tumi-ca.html_structured": "TUMI.ca pages (blocked by PerimeterX from our network)",
  "source.sportinglife.html_structured": "Sporting Life pages (Cloudflare challenge)",
  "source.simons.html_structured": "Simons pages (Cloudflare challenge)",
  "adapter.amazon_creators_api": "Amazon Creators API (needs an eligible Associates account)",
  "adapter.browser_tier": "Playwright tier for permitted JS-only stores (none qualify today)",
  "feed.walmart-ca": "Walmart.ca affiliate feed (Rakuten), once approved",
  "feed.bestbuy-ca": "Best Buy affiliate feed (Impact) + written price permission",
  "feed.canadiantire": "Canadian Tire / SportChek affiliate feed, once approved",
};

function sourceUpsert(s: SourceRecord): string {
  const cols: [string, string][] = [
    ["id", sqlLiteral(s.id)],
    ["name", sqlLiteral(s.name)],
    ["retailer_label", sqlLiteral(s.retailerLabel)],
    ["category", sqlLiteral(s.category)],
    ["status", sqlLiteral(s.status)],
    ["platform", sqlLiteral(s.platform)],
    ["allowed_domains", textArray(s.allowedDomains)],
    ["fetch_hosts", textArray(s.fetchHosts)],
    ["market_host", sqlLiteral(s.marketHost)],
    ["market_path_prefix", sqlLiteral(s.marketPathPrefix)],
    ["currency", sqlLiteral(s.currency)],
    ["live_class", sqlLiteral(s.liveClass)],
    ["permission", sqlLiteral(s.permission)],
    ["terms", jsonb(s.terms)],
    ["robots", jsonb(s.robots)],
    ["crawl_delay_sec", sqlLiteral(s.crawlDelaySec)],
    ["visit_window", s.visitWindow ? jsonb(s.visitWindow) : "NULL"],
    ["ucp_endpoint", sqlLiteral(s.ucpEndpoint)],
    ["identity_quality", jsonb(s.identityQuality)],
    ["routes", jsonb(s.routes)],
    ["link_only_search_url", sqlLiteral(s.linkOnlySearchUrl)],
    ["domain_warnings", textArray(s.domainWarnings)],
    ["evidence", jsonb(s.evidence)],
    ["enabled", sqlLiteral(s.enabled)],
    ["seed_version", sqlLiteral(SEED_VERSION)],
  ];
  // Runtime state (enabled, circuit breaker) belongs to the admin, not the seed.
  const updatable = cols.map(([c]) => c).filter((c) => c !== "id" && c !== "enabled");
  return [
    `INSERT INTO sources (${cols.map(([c]) => c).join(", ")})`,
    `VALUES (${cols.map(([, v]) => v).join(", ")})`,
    `ON CONFLICT (id) DO UPDATE SET ${updatable.map((c) => `${c} = EXCLUDED.${c}`).join(", ")};`,
  ].join("\n");
}

export function registrySeedSql(sources: SourceRecord[] = SOURCE_SEED): string {
  const flagRows = Object.entries(FLAG_DEFAULTS).map(
    ([key, enabled]) =>
      `(${sqlLiteral(key)}, ${sqlLiteral(enabled)}, ${sqlLiteral(FLAG_DESCRIPTIONS[key] ?? null)})`,
  );
  return [
    "-- ============================================================",
    `-- Source registry seed ${SEED_VERSION}. Generated by \`npm run db:seed\`;`,
    "-- do not edit by hand (edit src/lib/engine/registry/seed.ts).",
    "-- Idempotent: safe to run again. Admin-controlled state is kept.",
    "-- ============================================================",
    "",
    "BEGIN;",
    "",
    ...sources.map(sourceUpsert).flatMap((s) => [s, ""]),
    "-- Default flags: inserted once, never overwritten (admins own them).",
    "INSERT INTO feature_flags (key, enabled, description) VALUES",
    `${flagRows.join(",\n")}`,
    "ON CONFLICT (key) DO NOTHING;",
    "",
    "COMMIT;",
    "",
  ].join("\n");
}
