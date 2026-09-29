/* ------------------------------------------------------------------ */
/*  Tavily — web research client (REST, no SDK dependency)            */
/*                                                                     */
/*  Generic and reusable: nothing in here knows about luggage. Any     */
/*  research feature calls tavilySearch() and automatically gets:      */
/*                                                                     */
/*    • a hard monthly credit cap   — it will not spend past the free  */
/*                                    allowance, so it cannot cost     */
/*                                    money                            */
/*    • caching                     — a repeat question costs nothing  */
/*    • in-flight de-duplication    — two identical requests at once   */
/*                                    make one HTTP call               */
/*    • negative caching            — an empty answer isn't re-bought  */
/*    • exact credit metering       — from Tavily's own usage figure   */
/*    • bounded retries             — 429 / 5xx / rejected options     */
/*    • timeouts that respect the caller's deadline                    */
/*                                                                     */
/*  Cost model (docs.tavily.com, API credits):                        */
/*    search basic / fast / ultra-fast = 1 credit, advanced = 2.       */
/*    auto_parameters can silently switch to advanced — so it is       */
/*    never sent. Free plan: 1,000 credits/month, no card.             */
/*    Over the limit Tavily answers 432 (433 for a pay-as-you-go cap). */
/* ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import { ProviderError, classifyHttp } from "@/lib/search/errors";
import type { Deadline, Meter } from "@/lib/search/deadline";

const API_BASE = "https://api.tavily.com";

export type TavilyDepth = "basic" | "fast" | "ultra-fast" | "advanced";

export type TavilySearchRequest = {
  query: string;
  /** Defaults to "basic" (1 credit). "advanced" costs 2. */
  searchDepth?: TavilyDepth;
  /** 0–20. Does not change the credit cost. */
  maxResults?: number;
  /** 1–3 relevant chunks (≤500 chars each) per result. */
  chunksPerSource?: number;
  /** Full page text alongside each result. */
  includeRawContent?: false | "text" | "markdown";
  includeDomains?: string[];
  /** "prefer" ranks includeDomains first without excluding others. */
  includeDomainsMode?: "prefer" | "restrict";
  excludeDomains?: string[];
  /** Full lowercase country name, e.g. "canada". Only with topic "general". */
  country?: string;
  topic?: "general" | "news" | "finance";
  timeRange?: "day" | "week" | "month" | "year";
};

export type TavilyResult = {
  title: string;
  url: string;
  /** Tavily's query-relevant excerpt(s) from the page. */
  content: string;
  /** 0–1 relevance. */
  score: number;
  /** Full page text when requested and available. */
  rawContent: string | null;
};

export type TavilySearchResponse = {
  query: string;
  results: TavilyResult[];
  /** Credits this call cost. 0 when served from cache. */
  creditsUsed: number;
  /** Server-side processing time, when Tavily reports it. */
  responseTimeMs: number | null;
  requestId: string | null;
  /** True when no HTTP request was made. */
  cached: boolean;
};

export type TavilyCallOptions = {
  /** Shared pipeline clock — attempts never outlive it. */
  deadline?: Deadline;
  /** Persistent (database) credit meter, if the caller has one. */
  meter?: Meter;
  /** Skip the cache and force a fresh (billable) call. */
  bypassCache?: boolean;
};

/* ------------------------------------------------------------------ */
/*  Configuration                                                     */
/* ------------------------------------------------------------------ */

export function tavilyConfigured(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

function apiKey(): string {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new ProviderError("tavily", "auth", "TAVILY_API_KEY is not configured");
  return key;
}

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The most credits the app will spend in a calendar month. Stops short of
 * the 1,000 free credits on purpose: calls made outside the app (the
 * dashboard playground, a teammate's machine) also count against the
 * account, and "past the free limit" is the only place money could enter.
 */
export function monthlyCreditCap(): number {
  return envNumber("TAVILY_MONTHLY_CREDIT_CAP", 950);
}

function timeoutMs(): number {
  return envNumber("TAVILY_TIMEOUT_MS", 15_000);
}

function cacheTtlMs(): number {
  return envNumber("TAVILY_CACHE_TTL_MINUTES", 360) * 60_000;
}

/** An empty answer is cached briefly, so the same dead end isn't re-bought. */
const NEGATIVE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 300;

/** Credits a request will cost, per Tavily's published pricing. */
export function expectedCredits(depth: TavilyDepth = "basic"): number {
  return depth === "advanced" ? 2 : 1;
}

/* ------------------------------------------------------------------ */
/*  Credit ledger                                                     */
/*                                                                     */
/*  Two sources, and the guard trusts whichever says MORE was spent:  */
/*                                                                     */
/*    remote — Tavily's own /usage figure. Free to read, but limited   */
/*             to 10 calls per 10 minutes, so it's refreshed at most   */
/*             every 5 minutes and cached.                             */
/*    local  — credits this server process has spent since.            */
/*                                                                     */
/*  The caller's database meter (when present) is a third, persistent  */
/*  check on top of these.                                             */
/* ------------------------------------------------------------------ */

type RemoteUsage = {
  fetchedAt: number;
  /** Credits used this billing period, per Tavily. */
  used: number;
  /** Plan limit, per Tavily (null when unlimited / not reported). */
  limit: number | null;
  /** Per-key limit set in the dashboard, if any. */
  keyLimit: number | null;
  /** Best-effort: whether the account looks able to bill past the plan. */
  paygoEnabled: boolean;
  plan: string | null;
};

/**
 * The spend policy is "verified before spending":
 *
 *   • No research call is sent unless Tavily's own balance was read within
 *     the last TRUST_WINDOW. If it can't be confirmed, the call is refused —
 *     never sent on a guess. (/usage costs nothing, so this is free.)
 *   • Credits are RESERVED before a request goes out and released if it
 *     wasn't billed, so ten searches fired at once can't all squeeze past
 *     the last remaining credit.
 *   • If the account has pay-as-you-go enabled, the app's cap is the only
 *     thing between a search and a bill — so the balance must be fresher.
 */
const USAGE_BACKGROUND_REFRESH_MS = 3 * 60_000;
const USAGE_TRUST_WINDOW_MS = 30 * 60_000;
const USAGE_TRUST_WINDOW_PAYGO_MS = 5 * 60_000;
const USAGE_RETRY_AFTER_FAILURE_MS = 60_000;
const USAGE_FETCH_TIMEOUT_MS = 4_000;

let remoteUsage: RemoteUsage | null = null;
/** Credits recorded since remoteUsage was read (Tavily's figure excludes them). */
let creditsSinceRemote = 0;
/** Credits reserved by requests currently on the wire. */
let pendingCredits = 0;
let lastUsageFailureAt = 0;
let lastUsageError: { status: number | null; message: string } | null = null;
let usageInFlight: Promise<RemoteUsage | null> | null = null;

/** Credits this process has spent, keyed by calendar month. */
let localLedger = { period: currentPeriod(), credits: 0 };

/** Credits this process has spent, ever. Never resets — safe across month boundaries. */
let processCredits = 0;

/** Set after a 432/433 — stop calling until this time. */
let exhaustedUntil = 0;

function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

function recordLocalCredits(credits: number): void {
  const period = currentPeriod();
  if (localLedger.period !== period) localLedger = { period, credits: 0 };
  localLedger.credits += credits;
  creditsSinceRemote += credits;
  processCredits += credits;
}

/**
 * Credits spent by this server process since it started. Monotonic, so a
 * job can measure its own spend even if Tavily's monthly count resets
 * mid-run.
 */
export function processCreditsSpent(): number {
  return processCredits;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function endOfMonthUtc(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * Read Tavily's /usage. Costs no credits (rate-limited to 10 calls per 10
 * minutes, so it's cached and never retried more than once a minute).
 * Never throws; returns the latest snapshot, or null if none.
 */
export async function fetchTavilyUsage(force = false): Promise<RemoteUsage | null> {
  if (!tavilyConfigured()) return null;

  const now = Date.now();
  if (!force) {
    if (remoteUsage && now - remoteUsage.fetchedAt < USAGE_BACKGROUND_REFRESH_MS) return remoteUsage;
    if (now - lastUsageFailureAt < USAGE_RETRY_AFTER_FAILURE_MS) return remoteUsage;
  }
  if (usageInFlight) return usageInFlight;

  // Credits recorded before this read started are (at most) what Tavily's
  // answer will already include. Anything recorded while it's in flight
  // must survive the reset below.
  const sinceAtStart = creditsSinceRemote;

  usageInFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_BASE}/usage`, {
        headers: { Authorization: `Bearer ${apiKey()}` },
        signal: controller.signal,
        cache: "no-store",
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        lastUsageFailureAt = Date.now();
        lastUsageError = { status: res.status, message: extractErrorMessage(text) };
        return remoteUsage;
      }

      const body = (await res.json().catch(() => null)) as {
        key?: { usage?: unknown; limit?: unknown };
        account?: {
          current_plan?: unknown;
          plan_usage?: unknown;
          plan_limit?: unknown;
          paygo_usage?: unknown;
          paygo_limit?: unknown;
        };
      } | null;

      const planUsed = numberOrNull(body?.account?.plan_usage);
      const keyUsed = numberOrNull(body?.key?.usage);
      if (!body || (planUsed === null && keyUsed === null)) {
        // An answer without a usage figure confirms nothing.
        lastUsageFailureAt = Date.now();
        lastUsageError = { status: res.status, message: "usage figure missing from Tavily's reply" };
        return remoteUsage;
      }

      const paygoLimit = numberOrNull(body.account?.paygo_limit);
      const paygoUsed = numberOrNull(body.account?.paygo_usage);

      remoteUsage = {
        fetchedAt: Date.now(),
        used: Math.max(planUsed ?? 0, keyUsed ?? 0),
        limit: numberOrNull(body.account?.plan_limit),
        keyLimit: numberOrNull(body.key?.limit),
        paygoEnabled: (paygoLimit !== null && paygoLimit > 0) || (paygoUsed ?? 0) > 0,
        plan: typeof body.account?.current_plan === "string" ? body.account.current_plan : null,
      };
      creditsSinceRemote = Math.max(0, creditsSinceRemote - sinceAtStart);
      lastUsageError = null;

      if (remoteUsage.paygoEnabled) {
        console.error(
          "[tavily] Pay-as-you-go appears to be ENABLED on this Tavily account. The app still refuses any call past " +
            `${monthlyCreditCap()} credits, but turn pay-as-you-go off in the Tavily dashboard so $0 doesn't rely on the app alone.`,
        );
      }
      return remoteUsage;
    } catch (err) {
      lastUsageFailureAt = Date.now();
      lastUsageError = {
        status: null,
        message: err instanceof Error && err.name === "AbortError" ? "timed out" : err instanceof Error ? err.message : "failed",
      };
      return remoteUsage;
    } finally {
      clearTimeout(timer);
      usageInFlight = null;
    }
  })();

  return usageInFlight;
}

/** Last known Tavily usage, without any network call. */
export function lastKnownTavilyUsage(): { used: number; limit: number | null } | null {
  if (!remoteUsage) return null;
  return { used: remoteUsage.used + creditsSinceRemote, limit: remoteUsage.limit };
}

/** Everything the guard knows, for diagnostics and the UI. */
export function tavilyCreditStatus(): {
  cap: number;
  usedEstimate: number;
  remaining: number;
  source: "tavily" | "local";
  paygoEnabled: boolean | null;
} {
  const cap = effectiveCap();
  const used = usedEstimate();
  return {
    cap,
    usedEstimate: used,
    remaining: Math.max(0, cap - used),
    source: remoteUsage ? "tavily" : "local",
    paygoEnabled: remoteUsage ? remoteUsage.paygoEnabled : null,
  };
}

/** Spent + reserved, by the most pessimistic of our two ledgers. */
function usedEstimate(): number {
  const local = localLedger.period === currentPeriod() ? localLedger.credits : 0;
  const remote = remoteUsage ? remoteUsage.used + creditsSinceRemote : 0;
  return Math.max(local, remote) + pendingCredits;
}

/**
 * The ceiling actually enforced: our cap, or Tavily's plan/key limit if
 * that is lower. Never higher than the free plan unless someone raises
 * TAVILY_MONTHLY_CREDIT_CAP on purpose.
 */
function effectiveCap(): number {
  let cap = monthlyCreditCap();
  if (remoteUsage?.limit !== null && remoteUsage?.limit !== undefined) {
    cap = Math.min(cap, remoteUsage.limit);
  }
  if (remoteUsage?.keyLimit !== null && remoteUsage?.keyLimit !== undefined) {
    cap = Math.min(cap, remoteUsage.keyLimit);
  }
  return cap;
}

/**
 * Reserve `credits` for a request about to be sent, or refuse — without any
 * HTTP request — when the balance can't be confirmed or the call would take
 * the month past the cap. This is what makes paid usage impossible from the
 * app: the request that would cross the line is never sent.
 *
 * Returns a release function: call it once the request has finished.
 */
async function reserveCredits(credits: number): Promise<() => void> {
  if (Date.now() < exhaustedUntil) {
    throw new ProviderError(
      "tavily",
      "quota",
      "Tavily reported the free credit limit as reached; research is paused until it resets.",
    );
  }

  // Keep Tavily's figure fresh. Only wait for it when the snapshot is too
  // old to trust; otherwise refresh quietly in the background.
  const trustWindow = remoteUsage?.paygoEnabled ? USAGE_TRUST_WINDOW_PAYGO_MS : USAGE_TRUST_WINDOW_MS;
  const age = remoteUsage ? Date.now() - remoteUsage.fetchedAt : Infinity;
  // (Not forced: after a failure, /usage is retried at most once a minute —
  // it's limited to 10 calls per 10 minutes.)
  if (age > trustWindow) await fetchTavilyUsage();
  else if (age > USAGE_BACKGROUND_REFRESH_MS) void fetchTavilyUsage();

  const freshAge = remoteUsage ? Date.now() - remoteUsage.fetchedAt : Infinity;
  const window = remoteUsage?.paygoEnabled ? USAGE_TRUST_WINDOW_PAYGO_MS : USAGE_TRUST_WINDOW_MS;
  if (freshAge > window) {
    // Unverified balance → no request. Name the actual cause.
    const status = lastUsageError?.status;
    if (status === 401) {
      throw new ProviderError("tavily", "auth", "Tavily rejected the API key. Check TAVILY_API_KEY in .env.local and restart.");
    }
    throw new ProviderError(
      "tavily",
      "network",
      `Couldn't confirm the research credit balance with Tavily${
        lastUsageError ? ` (${status ? `HTTP ${status}: ` : ""}${lastUsageError.message})` : ""
      }, so no request was sent.`,
    );
  }

  // With pay-as-you-go ON, going past the free plan is billed instead of
  // refused. No app-side counter can be airtight across several server
  // instances, so on a strict $0 budget the only safe answer is: don't
  // call at all until pay-as-you-go is switched off.
  if (remoteUsage?.paygoEnabled) {
    throw new ProviderError(
      "tavily",
      "policy",
      "Research is paused: pay-as-you-go is enabled on the Tavily account, which could allow paid usage. " +
        "Turn pay-as-you-go off in the Tavily dashboard and research resumes automatically.",
    );
  }

  const cap = effectiveCap();
  const used = usedEstimate();
  if (used + credits > cap) {
    throw new ProviderError(
      "tavily",
      "quota",
      `Monthly research credit cap reached (${used} of ${cap} used or reserved). No request was sent.`,
    );
  }

  pendingCredits += credits;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingCredits = Math.max(0, pendingCredits - credits);
  };
}

/* ------------------------------------------------------------------ */
/*  Cache + in-flight de-duplication                                  */
/* ------------------------------------------------------------------ */

type CacheEntry = { expiresAt: number; response: TavilySearchResponse };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TavilySearchResponse>>();

/** Normalise a request so trivially different spellings share a key. */
function requestKey(req: TavilySearchRequest): string {
  const normalised = {
    ...req,
    // Word order and punctuation don't change what the web has to say.
    query: [...new Set(req.query.toLowerCase().replace(/[^a-z0-9$.\s-]/g, " ").split(/\s+/).filter(Boolean))]
      .sort()
      .join(" "),
    includeDomains: req.includeDomains ? [...req.includeDomains].sort() : undefined,
    excludeDomains: req.excludeDomains ? [...req.excludeDomains].sort() : undefined,
  };
  return createHash("sha256").update(JSON.stringify(normalised)).digest("hex").slice(0, 40);
}

function readCache(key: string): TavilySearchResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return { ...hit.response, creditsUsed: 0, cached: true };
}

function writeCache(key: string, response: TavilySearchResponse): void {
  const ttl = response.results.length > 0 ? cacheTtlMs() : NEGATIVE_TTL_MS;
  cache.set(key, { expiresAt: Date.now() + ttl, response });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Clear all in-process state. For tests and diagnostics only. */
export function resetTavilyState(): void {
  cache.clear();
  inFlight.clear();
  remoteUsage = null;
  creditsSinceRemote = 0;
  pendingCredits = 0;
  lastUsageFailureAt = 0;
  lastUsageError = null;
  usageInFlight = null;
  localLedger = { period: currentPeriod(), credits: 0 };
  processCredits = 0;
  exhaustedUntil = 0;
  pageCache.clear();
  extractSuccessCarry = 0;
}

/* ------------------------------------------------------------------ */
/*  Request                                                           */
/* ------------------------------------------------------------------ */

/**
 * The JSON body. Only what's asked for is sent, and the two settings that
 * could raise the price are pinned: explicit depth, auto_parameters off.
 * `minimal` drops the optional focusing options — used once if Tavily
 * rejects the full request, so a renamed or retired option can't break
 * research outright.
 */
function buildBody(req: TavilySearchRequest, minimal: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: req.query,
    search_depth: req.searchDepth ?? "basic",
    auto_parameters: false,
    max_results: Math.max(0, Math.min(20, req.maxResults ?? 10)),
    include_answer: false,
    include_images: false,
    include_usage: true,
    topic: req.topic ?? "general",
  };

  if (req.includeRawContent) body.include_raw_content = req.includeRawContent;
  if (req.country && (req.topic ?? "general") === "general") body.country = req.country;
  if (req.timeRange) body.time_range = req.timeRange;

  if (!minimal) {
    if (req.chunksPerSource) {
      body.chunks_per_source = Math.max(1, Math.min(3, req.chunksPerSource));
    }
    if (req.includeDomains?.length) {
      body.include_domains = req.includeDomains.slice(0, 300);
      if (req.includeDomainsMode) body.include_domains_mode = req.includeDomainsMode;
    }
    if (req.excludeDomains?.length) body.exclude_domains = req.excludeDomains.slice(0, 150);
  }

  return body;
}

function hasOptionalFocus(req: TavilySearchRequest): boolean {
  return !!(req.chunksPerSource || req.includeDomains?.length || req.excludeDomains?.length);
}

type RawTavilyResponse = {
  query?: string;
  results?: {
    title?: string;
    url?: string;
    content?: string;
    score?: number;
    raw_content?: string | null;
  }[];
  response_time?: number | string;
  usage?: { credits?: number };
  request_id?: string;
};

function parseResponse(raw: RawTavilyResponse, fallbackQuery: string, credits: number): TavilySearchResponse {
  const responseTime = Number(raw.response_time);
  return {
    query: raw.query ?? fallbackQuery,
    results: (raw.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https?:\/\//i.test(r.url))
      .map((r) => ({
        title: (r.title ?? "").trim(),
        url: r.url as string,
        content: r.content ?? "",
        score: typeof r.score === "number" ? r.score : 0,
        rawContent: typeof r.raw_content === "string" ? r.raw_content : null,
      })),
    creditsUsed: credits,
    responseTimeMs: Number.isFinite(responseTime) ? Math.round(responseTime * 1000) : null,
    requestId: raw.request_id ?? null,
    cached: false,
  };
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2_000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Longest we'll wait before retrying after a 429. */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

/**
 * One Tavily search, with every guard applied.
 *
 * Attempts, at most:
 *   1. the request as asked
 *   2. one retry — only for 429 (after Retry-After, if short), a 5xx or a
 *      network drop, or a 400/422 caused by optional options (resent
 *      without them)
 * Never retried: 401 (bad key), 432/433 (no credits), timeouts that have
 * exhausted the caller's deadline.
 */
export async function tavilySearch(
  req: TavilySearchRequest,
  opts: TavilyCallOptions = {},
): Promise<TavilySearchResponse> {
  const query = req.query.trim();
  if (!query) throw new ProviderError("tavily", "bad_request", "Empty research query");

  const key = requestKey({ ...req, query });

  if (!opts.bypassCache) {
    const hit = readCache(key);
    if (hit) return hit;
  }

  // Identical request already on the wire: share it instead of paying twice.
  const pending = inFlight.get(key);
  if (pending) {
    const shared = await pending;
    return { ...shared, creditsUsed: 0, cached: true };
  }

  const promise = runSearch({ ...req, query }, opts).then((response) => {
    writeCache(key, response);
    return response;
  });

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function runSearch(
  req: TavilySearchRequest,
  opts: TavilyCallOptions,
): Promise<TavilySearchResponse> {
  const depth = req.searchDepth ?? "basic";
  const expected = expectedCredits(depth);
  const deadline = opts.deadline;

  /**
   * A research call with 20 pages of text can take several seconds. An
   * attempt squeezed into less time than this would likely time out AFTER
   * Tavily had done (and billed) the work — so it isn't started at all.
   */
  const MIN_ATTEMPT_MS = 8_000;

  let minimal = false;
  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (deadline && !deadline.hasAtLeast(MIN_ATTEMPT_MS)) {
      throw (
        lastError ??
        new ProviderError("tavily", "budget", "Not enough time left for a research call; no request was sent.")
      );
    }

    // Budget first — a refused call never touches the network. Reserved
    // credits count against the cap until the request finishes.
    const release = await reserveCredits(expected);

    // The balance check can itself take a moment. If it ate into the
    // window, don't send a request that would likely be billed and then
    // time out.
    if (deadline && !deadline.hasAtLeast(MIN_ATTEMPT_MS)) {
      release();
      throw (
        lastError ??
        new ProviderError("tavily", "budget", "Not enough time left for a research call; no request was sent.")
      );
    }

    let failure: ProviderError | null = null;
    let raw: RawTavilyResponse | null = null;
    let status = 0;
    let detail = "";
    let retryAfter = 0;

    try {
      await opts.meter?.beforeAttempt(expected);

      const timeout = deadline
        ? Math.max(1_000, Math.min(timeoutMs(), deadline.budget(timeoutMs(), 1_000)))
        : timeoutMs();

      const controller = new AbortController();
      // The timer stays armed until the BODY is read — a server that sends
      // headers and then stalls can't hang the request.
      const timer = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetch(`${API_BASE}/search`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey()}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(buildBody(req, minimal)),
          signal: controller.signal,
          cache: "no-store",
        });
        status = res.status;
        if (res.ok) {
          raw = (await res.json().catch(() => null)) as RawTavilyResponse | null;
          if (!raw) failure = new ProviderError("tavily", "unknown", "Tavily returned an unreadable response");
        } else {
          detail = await res.text().catch(() => "");
          retryAfter = retryAfterMs(res);
        }
      } catch (err) {
        failure =
          err instanceof ProviderError
            ? err
            : err instanceof Error && err.name === "AbortError"
              ? new ProviderError("tavily", "timeout", `Tavily timed out after ${timeout}ms`)
              : new ProviderError(
                  "tavily",
                  "network",
                  err instanceof Error ? err.message : "Network error reaching Tavily",
                );
      } finally {
        clearTimeout(timer);
      }

      /* ── Success ─────────────────────────────────────────────── */
      if (raw && !failure) {
        // Tavily states the real cost when include_usage is set. Trust it
        // over our estimate, and correct the persistent meter to match.
        const reported = numberOrNull(raw.usage?.credits);
        const credits = reported ?? expected;
        recordLocalCredits(credits);
        if (credits !== expected) await opts.meter?.reconcile?.(credits - expected);
        return parseResponse(raw, req.query, credits);
      }

      /* ── HTTP error ──────────────────────────────────────────── */
      if (!failure && status) {
        // Tavily signals a bad key with 401. A 403 almost always comes from
        // something in between — a firewall, proxy or VPN refusing the host.
        const kind = status === 403 ? "network" : classifyHttp(status, detail);
        failure = new ProviderError(
          "tavily",
          kind,
          kind === "auth"
            ? "Tavily rejected the API key. Check TAVILY_API_KEY in .env.local and restart."
            : status === 403
              ? `Access to api.tavily.com was blocked (HTTP 403: ${extractErrorMessage(detail)}). A firewall, proxy or VPN may be blocking it.`
              : `Tavily error ${status}: ${extractErrorMessage(detail)}`,
        );

        if (status === 432 || status === 433) {
          // Out of credits. Refused, not billed — hand the reservation
          // back, and stop asking. A 433 means a pay-as-you-go cap was hit,
          // i.e. paid usage was already happening outside this app's cap:
          // stop for the rest of the month and say so loudly.
          exhaustedUntil = status === 433 ? endOfMonthUtc() : Date.now() + 30 * 60_000;
          if (status === 433) {
            console.error("[tavily] 433 pay-as-you-go limit reached — pay-as-you-go is ENABLED on this account. Turn it off in the Tavily dashboard. Research paused until next month.");
          }
          await opts.meter?.refundAttempt(expected);
          throw failure;
        }

        if (kind === "rate_limit") {
          await opts.meter?.refundAttempt(expected);
          lastError = failure;
          if (
            attempt === 0 &&
            retryAfter <= MAX_RATE_LIMIT_WAIT_MS &&
            (!deadline || deadline.hasAtLeast(retryAfter + MIN_ATTEMPT_MS))
          ) {
            release();
            await sleep(retryAfter);
            continue;
          }
          throw failure;
        }

        if (kind === "bad_request" && attempt === 0 && hasOptionalFocus(req)) {
          // Probably an optional option Tavily no longer accepts. Refused
          // requests aren't billed; try once with just the essentials.
          console.warn(`[tavily] request rejected (${status}); retrying without optional options. ${detail.slice(0, 200)}`);
          await opts.meter?.refundAttempt(expected);
          lastError = failure;
          minimal = true;
          release();
          continue;
        }
      }

      /* ── Other failures ──────────────────────────────────────── */
      if (failure) {
        lastError = failure;
        if (failure.consumedQuota) recordLocalCredits(expected);
        else await opts.meter?.refundAttempt(expected);

        // A timeout may already have been billed by Tavily — retrying would
        // risk paying twice for one answer. Only 5xx and dropped
        // connections, which fail before any work is done, get one retry.
        const retry =
          attempt === 0 &&
          (failure.kind === "server" || failure.kind === "network") &&
          status !== 403 &&
          (!deadline || deadline.hasAtLeast(800 + MIN_ATTEMPT_MS));

        if (!retry) throw failure;
        release();
        await sleep(800);
      }
    } finally {
      release();
    }
  }

  throw lastError ?? new ProviderError("tavily", "unknown", "Tavily search failed");
}

function extractErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: { error?: string } | { msg?: string }[] };
    if (Array.isArray(parsed.detail)) return parsed.detail.map((d) => d.msg).filter(Boolean).join("; ");
    if (parsed.detail && "error" in parsed.detail && parsed.detail.error) return parsed.detail.error;
  } catch {
    // not JSON
  }
  return body.slice(0, 200) || "no detail";
}

/* ------------------------------------------------------------------ */
/*  Extract — read specific pages                                     */
/*                                                                     */
/*  A search returns each store page as a ~150-character excerpt. When */
/*  the price isn't in that excerpt, the page itself has to be read.   */
/*  /extract does that for up to 20 URLs in one request.               */
/*                                                                     */
/*  Cost (docs.tavily.com): basic = 1 credit per 5 SUCCESSFUL pages,   */
/*  advanced = 2 per 5. Pages that fail to load aren't charged.        */
/*  The same cap, reservation and pay-as-you-go refusal as search      */
/*  apply — an extract that could cross the cap is never sent.         */
/* ------------------------------------------------------------------ */

export type TavilyExtractRequest = {
  /** 1–20 page URLs. */
  urls: string[];
  depth?: "basic" | "advanced";
  format?: "text" | "markdown";
  /** Seconds Tavily may spend fetching, 1–60. */
  timeoutSeconds?: number;
};

export type TavilyExtractResponse = {
  /** Pages read, with their full text. Order is not guaranteed. */
  results: { url: string; rawContent: string }[];
  /** Pages Tavily couldn't read (not charged). */
  failed: { url: string; error: string }[];
  /** Credits this call cost, per Tavily (or our conservative estimate). */
  creditsUsed: number;
  /** Pages served from this process's cache — no request made for them. */
  cachedCount: number;
};

/** Upper bound on what an extract of `pages` pages can cost. */
export function expectedExtractCredits(pages: number, depth: "basic" | "advanced" = "basic"): number {
  if (pages <= 0) return 0;
  return Math.ceil(pages / 5) * (depth === "advanced" ? 2 : 1);
}

type PageCacheEntry = { expiresAt: number; rawContent: string | null };
const pageCache = new Map<string, PageCacheEntry>();
const MAX_PAGE_CACHE_ENTRIES = 500;
/** A page that failed to load is skipped for a while rather than retried at once. */
const FAILED_PAGE_TTL_MS = 30 * 60_000;
/**
 * Tavily bills 1 credit per 5 successful pages, carried across calls. When
 * a response doesn't state its cost, this carry reproduces Tavily's count.
 */
let extractSuccessCarry = 0;

function pageKey(url: string, depth: string, format: string): string {
  return `${depth}:${format}:${url.split("#")[0]}`;
}

function rememberPage(key: string, rawContent: string | null): void {
  pageCache.set(key, {
    expiresAt: Date.now() + (rawContent ? cacheTtlMs() : FAILED_PAGE_TTL_MS),
    rawContent,
  });
  while (pageCache.size > MAX_PAGE_CACHE_ENTRIES) {
    const oldest = pageCache.keys().next().value;
    if (oldest === undefined) break;
    pageCache.delete(oldest);
  }
}

/**
 * Read pages' full text. Never throws for an ordinary failure — reading is
 * an enrichment step, so a timeout or a refused budget returns what it has
 * (possibly nothing) with the reason in `failed`.
 */
export async function tavilyExtract(
  req: TavilyExtractRequest,
  opts: TavilyCallOptions = {},
): Promise<TavilyExtractResponse> {
  const depth = req.depth ?? "basic";
  const format = req.format ?? "text";
  const out: TavilyExtractResponse = { results: [], failed: [], creditsUsed: 0, cachedCount: 0 };

  // De-duplicate, serve what we already read, skip recent failures.
  const toFetch: string[] = [];
  for (const url of [...new Set(req.urls.filter((u) => /^https?:\/\//i.test(u)))]) {
    const key = pageKey(url, depth, format);
    const hit = opts.bypassCache ? undefined : pageCache.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      out.cachedCount++;
      if (hit.rawContent) out.results.push({ url, rawContent: hit.rawContent });
      else out.failed.push({ url, error: "failed recently; skipped" });
      continue;
    }
    toFetch.push(url);
  }
  const urls = toFetch.slice(0, 20);
  if (urls.length === 0) return out;

  const deadline = opts.deadline;
  const MIN_EXTRACT_MS = 3_000;
  if (deadline && !deadline.hasAtLeast(MIN_EXTRACT_MS)) {
    for (const url of urls) out.failed.push({ url, error: "no time left to read this page" });
    return out;
  }

  const expected = expectedExtractCredits(urls.length, depth);
  let release: () => void;
  try {
    release = await reserveCredits(expected);
  } catch (err) {
    const message = err instanceof Error ? err.message : "credit check failed";
    for (const url of urls) out.failed.push({ url, error: message });
    return out;
  }

  try {
    try {
      await opts.meter?.beforeAttempt(expected);
    } catch (err) {
      const message = err instanceof Error ? err.message : "allowance check failed";
      for (const url of urls) out.failed.push({ url, error: message });
      return out;
    }

    // Tavily's own fetch timeout, and ours a little longer so its answer
    // (with partial results) arrives before we give up on it.
    const budgetMs = deadline ? deadline.budget(12_000, 500) : 12_000;
    const tavilySeconds = Math.max(1, Math.min(req.timeoutSeconds ?? 8, Math.floor((budgetMs - 1_500) / 1000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), tavilySeconds * 1000 + 1_500);

    let raw: {
      results?: { url?: string; raw_content?: string | null }[];
      failed_results?: { url?: string; error?: string }[];
      usage?: { credits?: number };
    } | null = null;
    let status = 0;
    let detail = "";

    try {
      const res = await fetch(`${API_BASE}/extract`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          extract_depth: depth,
          format,
          include_images: false,
          include_usage: true,
          timeout: tavilySeconds,
        }),
        signal: controller.signal,
        cache: "no-store",
      });
      status = res.status;
      if (res.ok) raw = await res.json().catch(() => null);
      else detail = await res.text().catch(() => "");
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      if (timedOut) {
        // Tavily may have read (and billed) pages before we gave up, so
        // the whole reservation counts as spent.
        recordLocalCredits(expected);
        out.creditsUsed = expected;
      } else {
        // The request never got an answer — nothing was read or billed.
        await opts.meter?.refundAttempt(expected);
      }
      for (const url of urls) out.failed.push({ url, error: timedOut ? "timed out" : "network error" });
      return out;
    } finally {
      clearTimeout(timer);
    }

    if (!raw) {
      if (status === 432 || status === 433) {
        exhaustedUntil = status === 433 ? endOfMonthUtc() : Date.now() + 30 * 60_000;
      }
      // Refused requests aren't billed.
      await opts.meter?.refundAttempt(expected);
      const message = status ? `Tavily error ${status}: ${extractErrorMessage(detail)}` : "unreadable response";
      for (const url of urls) out.failed.push({ url, error: message });
      return out;
    }

    const ok = (raw.results ?? []).filter(
      (r): r is { url: string; raw_content: string } =>
        typeof r.url === "string" && typeof r.raw_content === "string" && r.raw_content.trim().length > 0,
    );
    for (const r of ok) {
      out.results.push({ url: r.url, rawContent: r.raw_content });
      rememberPage(pageKey(r.url, depth, format), r.raw_content);
    }
    const okUrls = new Set(ok.map((r) => r.url));
    for (const f of raw.failed_results ?? []) {
      if (typeof f.url !== "string") continue;
      out.failed.push({ url: f.url, error: f.error ?? "failed" });
      rememberPage(pageKey(f.url, depth, format), null);
    }
    for (const url of urls) {
      if (!okUrls.has(url) && !out.failed.some((f) => f.url === url)) {
        out.failed.push({ url, error: "no content returned" });
      }
    }

    // Cost: Tavily's figure when stated; otherwise its 1-per-5 rule applied
    // to the pages actually read, carried across calls like Tavily does.
    const reported = numberOrNull(raw.usage?.credits);
    let credits: number;
    if (reported !== null) {
      credits = reported;
    } else {
      extractSuccessCarry += ok.length;
      credits = Math.floor(extractSuccessCarry / 5) * (depth === "advanced" ? 2 : 1);
      extractSuccessCarry %= 5;
    }
    recordLocalCredits(credits);
    if (credits !== expected) await opts.meter?.reconcile?.(credits - expected);
    out.creditsUsed = credits;
    return out;
  } finally {
    release();
  }
}
