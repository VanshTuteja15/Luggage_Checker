/* ------------------------------------------------------------------ */
/*  Engine configuration                                              */
/*                                                                     */
/*  Read from the environment once per call (cheap) so tests can set   */
/*  process.env and the worker can be reconfigured by restart. Values   */
/*  are never logged: `describeConfig()` reports only set / not set.    */
/* ------------------------------------------------------------------ */

/** Robots.txt token and first word of our User-Agent. */
export const BOT_TOKEN = "LuggageTrackerBot";
export const BOT_VERSION = "1.0";

/**
 * Public, monitored contact for store operators. The project's issue
 * tracker is public; CRAWLER_CONTACT overrides it (an email address the
 * business monitors is better, see docs/HUMAN_ACTIONS.md).
 */
export const DEFAULT_CONTACT = "https://github.com/VanshTuteja15/Luggage_Checker/issues";

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function str(name: string): string | null {
  const v = process.env[name]?.trim();
  return v ? v : null;
}

export type EngineConfig = {
  contact: string;
  /** Public URL of our UCP agent profile JSON. Required by Shopify's catalog MCP. */
  ucpAgentProfileUrl: string | null;
  ebay: { clientId: string; clientSecret: string } | null;
  amazon: { credentialId: string; credentialSecret: string; partnerTag: string } | null;
  /** Hard stop for a research session (MASTER_PROMPT: 10–12 s). */
  sessionDeadlineMs: number;
  /** A listing verified within this window is shared, not re-fetched. */
  singleFlightMs: number;
  fetchTimeoutMs: number;
  /** Per-user research limits. */
  rateLimit: { perWindow: number; windowMs: number; maxConcurrent: number };
  worker: { url: string; secret: string } | null;
  databaseUrl: string | null;
  /** Daily tracked-product verification caps. */
  cron: { maxFetchesPerRun: number; maxProductsPerRun: number };
  /** Discovery caps per store per run. */
  discovery: { maxProductFetchesPerStore: number; maxSitemapUrls: number };
};

export function engineConfig(): EngineConfig {
  const ebayId = str("EBAY_CLIENT_ID");
  const ebaySecret = str("EBAY_CLIENT_SECRET");
  const amzId = str("AMAZON_CREATORS_CREDENTIAL_ID");
  const amzSecret = str("AMAZON_CREATORS_CREDENTIAL_SECRET");
  const amzTag = str("AMAZON_ASSOCIATE_TAG");
  const workerUrl = str("WORKER_URL");
  const workerSecret = str("WORKER_SHARED_SECRET");

  return {
    contact: str("CRAWLER_CONTACT") ?? str("PROBE_CONTACT") ?? DEFAULT_CONTACT,
    ucpAgentProfileUrl: str("UCP_AGENT_PROFILE_URL"),
    ebay: ebayId && ebaySecret ? { clientId: ebayId, clientSecret: ebaySecret } : null,
    amazon:
      amzId && amzSecret && amzTag
        ? { credentialId: amzId, credentialSecret: amzSecret, partnerTag: amzTag }
        : null,
    sessionDeadlineMs: int("ENGINE_SESSION_DEADLINE_MS", 8_000, 3_000, 12_000),
    singleFlightMs: int("ENGINE_SINGLE_FLIGHT_MS", 90_000, 0, 600_000),
    fetchTimeoutMs: int("ENGINE_FETCH_TIMEOUT_MS", 8_000, 1_000, 30_000),
    rateLimit: {
      perWindow: int("ENGINE_RATE_LIMIT_PER_WINDOW", 20, 1, 1_000),
      windowMs: int("ENGINE_RATE_LIMIT_WINDOW_MS", 10 * 60_000, 10_000, 24 * 3_600_000),
      maxConcurrent: int("ENGINE_MAX_CONCURRENT_SESSIONS", 2, 1, 20),
    },
    worker:
      workerUrl && workerSecret
        ? { url: workerUrl.replace(/\/+$/, ""), secret: workerSecret }
        : null,
    databaseUrl: str("DATABASE_URL"),
    cron: {
      maxFetchesPerRun: int("ENGINE_CRON_MAX_FETCHES", 300, 0, 10_000),
      maxProductsPerRun: int("ENGINE_CRON_MAX_PRODUCTS", 100, 0, 5_000),
    },
    discovery: {
      maxProductFetchesPerStore: int("ENGINE_DISCOVERY_MAX_FETCHES_PER_STORE", 150, 0, 10_000),
      maxSitemapUrls: int("ENGINE_DISCOVERY_MAX_SITEMAP_URLS", 20_000, 0, 200_000),
    },
  };
}

/** Honest identification: who we are, why, and how to reach us. */
export function userAgent(contact = engineConfig().contact): string {
  return `${BOT_TOKEN}/${BOT_VERSION} (+${contact}; price comparison for a Canadian luggage retailer; read-only, honours robots.txt)`;
}

/** What's configured, without values. Safe to log and to show admins. */
export function describeConfig(c: EngineConfig = engineConfig()): Record<string, string> {
  return {
    contact: c.contact === DEFAULT_CONTACT ? "default (project issue tracker)" : "custom",
    ucpAgentProfile: c.ucpAgentProfileUrl ? "set" : "not set",
    ebay: c.ebay ? "set" : "not set",
    amazonCreators: c.amazon ? "set" : "not set",
    worker: c.worker ? "set" : "not set (inline mode)",
    database: c.databaseUrl ? "set" : "not set (in-memory store)",
    sessionDeadlineMs: String(c.sessionDeadlineMs),
    singleFlightMs: String(c.singleFlightMs),
  };
}
