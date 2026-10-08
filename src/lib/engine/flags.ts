/* ------------------------------------------------------------------ */
/*  Feature flags                                                     */
/*                                                                     */
/*  Resolution order (last wins):                                      */
/*    1. FLAG_DEFAULTS below (safe defaults: anything that needs a      */
/*       human decision is OFF)                                         */
/*    2. rows in the `feature_flags` table (admins flip these)          */
/*    3. ENGINE_FLAGS env, e.g. "discovery.tavily=on,engine.default_search=off" */
/*       for operators and tests                                        */
/* ------------------------------------------------------------------ */

export type FlagKey = keyof typeof FLAG_DEFAULTS;

export const FLAG_DEFAULTS = {
  /** The new engine is available at all (research API, worker jobs). */
  "engine.enabled": true,
  /**
   * Search opens on verified prices (the engine) instead of web research.
   * ON since the P8 shadow run: the engine matched or beat the old Tavily
   * path on every measure (docs/SHADOW_REPORT.md). Web research stays one
   * click away; turning this off in /admin rolls the default back.
   */
  "engine.default_search": true,
  /** Tavily as a flag-controlled discovery fallback (URLs only, never prices). */
  "discovery.tavily": false,

  /**
   * UCP on Shopify stores whose terms carry the generic anti-scrape clause
   * but whose robots.txt/agents.md invite agents to use UCP. The audit's
   * position: low-volume use of the store-published channel, pending legal
   * sign-off before launch (docs/HUMAN_ACTIONS.md).
   */
  "policy.ucp_on_restricted_stores": true,
  /** Luggage City: the audit asks for a legal read first. */
  "source.luggagecity.ucp": false,
  /** Terms not yet read by a human: product JSON stays off until they are. */
  "source.unluggage.product_json": false,
  "source.bentley.product_json": false,
  /** Blocked by bot management from our network (P0 probe). */
  "source.samsonite-ca.html_structured": false,
  "source.tumi-ca.html_structured": false,
  "source.sportinglife.html_structured": false,
  "source.simons.html_structured": false,

  /** Needs an approved Amazon Associates account with qualifying sales. */
  "adapter.amazon_creators_api": false,
  /** Playwright tier for permitted JS-only stores. No store qualifies today. */
  "adapter.browser_tier": false,

  /** Affiliate feeds, once approved. */
  "feed.walmart-ca": false,
  "feed.bestbuy-ca": false,
  "feed.canadiantire": false,
} as const satisfies Record<string, boolean>;

export type FlagSet = Record<string, boolean>;

export function isKnownFlag(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS, key);
}

function parseEnvFlags(raw: string | undefined): FlagSet {
  const out: FlagSet = {};
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const [k, v] = part.split("=").map((s) => s.trim());
    if (!k || v === undefined) continue;
    if (/^(on|true|1|yes)$/i.test(v)) out[k] = true;
    else if (/^(off|false|0|no)$/i.test(v)) out[k] = false;
  }
  return out;
}

/** Merge defaults, database rows and the env override. */
export function resolveFlags(dbRows: { key: string; enabled: boolean }[] = []): FlagSet {
  const flags: FlagSet = { ...FLAG_DEFAULTS };
  for (const row of dbRows) flags[row.key] = row.enabled;
  Object.assign(flags, parseEnvFlags(process.env.ENGINE_FLAGS));
  return flags;
}

export function flagOn(flags: FlagSet, key: string): boolean {
  return flags[key] === true;
}
