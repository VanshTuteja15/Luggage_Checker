/* ------------------------------------------------------------------ */
/*  Source Registry: lookups and the access policy                    */
/*                                                                     */
/*  The policy is code, not convention. A route is usable only when    */
/*    • the store's permission status allows that kind of adapter,     */
/*    • the route's feature flag (if any) is on, and                   */
/*    • the adapter has what it needs (agent profile, API keys).       */
/*  Everything else becomes a labelled "couldn't verify" or "link only" */
/*  row, never a silent attempt.                                       */
/* ------------------------------------------------------------------ */

import type { EngineConfig } from "../config";
import { flagOn, type FlagSet } from "../flags";
import type { AdapterId, PermissionStatus, RouteSpec, SourceRecord } from "../types";
import { SOURCE_SEED } from "./seed";

export { SOURCE_SEED, SEED_VERSION } from "./seed";

/** Adapters that read a live price from the store or its official API. */
export const LIVE_ADAPTERS: ReadonlySet<AdapterId> = new Set([
  "shopify_ucp",
  "shopify_product_json",
  "html_structured",
  "ebay_browse_api",
  "amazon_creators_api",
]);

/** Adapters that read the store's public web pages / storefront JSON. */
const STOREFRONT_ADAPTERS: ReadonlySet<AdapterId> = new Set([
  "shopify_product_json",
  "html_structured",
]);

/** Official, credentialed APIs. */
const OFFICIAL_API_ADAPTERS: ReadonlySet<AdapterId> = new Set([
  "ebay_browse_api",
  "amazon_creators_api",
]);

export function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/** Exact host match only: `delseyluggagecanada.ca` never matches `delsey.ca`. */
export function sourceForUrl(
  url: string,
  sources: SourceRecord[] = SOURCE_SEED,
): SourceRecord | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = normaliseHost(u.hostname);
  return (
    sources.find(
      (s) => s.status !== "defunct" && s.allowedDomains.some((d) => normaliseHost(d) === host),
    ) ?? null
  );
}

export function isFetchHost(source: SourceRecord, host: string): boolean {
  const h = normaliseHost(host);
  return source.fetchHosts.some((d) => normaliseHost(d) === h);
}

/** Does this permission level allow this kind of adapter at all? */
export function permissionAllows(
  permission: PermissionStatus,
  adapter: AdapterId,
  flagEnabled: boolean,
): boolean {
  if (adapter === "manual_entry" || adapter === "feed_import") return true;
  switch (permission) {
    case "sanctioned":
    case "allowed":
      return true;
    case "unclear":
      // The store's own agent channel is fine; storefront reads need a human
      // decision, recorded as a per-source flag.
      return adapter === "shopify_ucp" || (STOREFRONT_ADAPTERS.has(adapter) && flagEnabled);
    case "restricted":
      return adapter === "shopify_ucp";
    case "forbidden":
      return OFFICIAL_API_ADAPTERS.has(adapter);
    case "not_applicable":
      return false;
  }
}

export type RouteCheck = {
  route: RouteSpec;
  usable: boolean;
  /** Why not, in words a store-status row can show. */
  reason: "ok" | "flag_off" | "not_configured" | "not_permitted" | "source_disabled";
  message: string;
};

export type RouteContext = {
  flags: FlagSet;
  config: EngineConfig;
  /** Source ids that have at least one active feed loaded. */
  feedSources?: ReadonlySet<string>;
  /** Source ids with manual entries on file. */
  manualSources?: ReadonlySet<string>;
};

function configured(adapter: AdapterId, source: SourceRecord, ctx: RouteContext): string | null {
  switch (adapter) {
    case "shopify_ucp":
      if (!source.ucpEndpoint) return "no UCP endpoint on record";
      return ctx.config.ucpAgentProfileUrl
        ? null
        : "UCP agent profile not published yet (UCP_AGENT_PROFILE_URL)";
    case "ebay_browse_api":
      return ctx.config.ebay ? null : "eBay API keys not configured";
    case "amazon_creators_api":
      return ctx.config.amazon ? null : "Amazon Creators API not configured";
    case "feed_import":
      return ctx.feedSources?.has(source.id) ? null : "no feed loaded for this store";
    case "manual_entry":
      return ctx.manualSources?.has(source.id) ? null : "no manual price on file";
    default:
      return null;
  }
}

export function checkRoutes(source: SourceRecord, ctx: RouteContext): RouteCheck[] {
  return [...source.routes]
    .sort((a, b) => a.rank - b.rank)
    .map((route): RouteCheck => {
      if (!source.enabled || source.status !== "active") {
        return {
          route,
          usable: false,
          reason: "source_disabled",
          message: "store disabled in the registry",
        };
      }
      const flagEnabled = route.flag ? flagOn(ctx.flags, route.flag) : true;
      if (!permissionAllows(source.permission, route.adapter, route.flag ? flagEnabled : false)) {
        return {
          route,
          usable: false,
          reason: "not_permitted",
          message: "not permitted by the store's terms / our policy",
        };
      }
      if (route.flag && !flagEnabled) {
        return {
          route,
          usable: false,
          reason: "flag_off",
          message: `switched off (${route.flag})`,
        };
      }
      const missing = configured(route.adapter, source, ctx);
      if (missing) return { route, usable: false, reason: "not_configured", message: missing };
      return { route, usable: true, reason: "ok", message: "ok" };
    });
}

/** Usable routes, best first. Cross-check-only routes are excluded. */
export function usableRoutes(source: SourceRecord, ctx: RouteContext): RouteSpec[] {
  return checkRoutes(source, ctx)
    .filter((c) => c.usable && !c.route.crossCheckOnly)
    .map((c) => c.route);
}

/** Usable live (fresh-price) routes, best first. */
export function liveRoutes(source: SourceRecord, ctx: RouteContext): RouteSpec[] {
  return usableRoutes(source, ctx).filter((r) => LIVE_ADAPTERS.has(r.adapter));
}

export function crossCheckRoute(source: SourceRecord, ctx: RouteContext): RouteSpec | null {
  return checkRoutes(source, ctx).find((c) => c.usable && c.route.crossCheckOnly)?.route ?? null;
}

/** The store's own search page for a human to open. Never fetched by us. */
export function linkOnlyUrl(source: SourceRecord, query: string): string | null {
  if (!source.linkOnlySearchUrl) return null;
  return source.linkOnlySearchUrl.replace("{q}", encodeURIComponent(query.trim().slice(0, 120)));
}

/** Short reason a store can't be verified live, for "couldn't verify" rows. */
export function unverifiableReason(source: SourceRecord, ctx: RouteContext): string {
  if (source.liveClass === "blocked")
    return `${source.retailerLabel} blocks automated requests from our network`;
  // A store can forbid reading its pages yet offer an official API (eBay):
  // then the API route, not the terms, decides what the row says.
  if (source.permission === "forbidden" && source.liveClass !== "official_api")
    return `${source.retailerLabel}'s terms don't allow automated price checks`;
  if (source.liveClass === "none") return `${source.retailerLabel} doesn't publish prices online`;
  const checks = checkRoutes(source, ctx).filter(
    (c) => LIVE_ADAPTERS.has(c.route.adapter) && !c.route.crossCheckOnly,
  );
  const first = checks[0];
  if (!first) return "no live route on record";
  // Shoppers see these rows: keep setup details (env names, flag keys) for /admin.
  if (first.reason === "not_configured" || first.reason === "flag_off") return "not connected yet";
  if (first.reason === "not_permitted")
    return `${source.retailerLabel}'s terms don't allow automated price checks`;
  return first.message;
}
