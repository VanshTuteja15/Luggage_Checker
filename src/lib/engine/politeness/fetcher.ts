/* ------------------------------------------------------------------ */
/*  PoliteFetcher: the only way the engine touches the network        */
/*                                                                     */
/*  For every request, in order:                                       */
/*    1. SSRF guard     registry host, https, public address           */
/*    2. visit window   stores that state one (TUMI)                    */
/*    3. circuit        stop knocking after repeated blocks             */
/*    4. robots.txt     honoured, crawl-delay included                  */
/*    5. host limiter   one at a time, spaced by the crawl delay        */
/*    6. fetch          honest User-Agent, timeout, redirects re-checked */
/*    7. classify       ok / not_found / blocked / challenge / …        */
/*    8. record         every attempt, including refusals, is evidence   */
/* ------------------------------------------------------------------ */

import { engineConfig, userAgent, BOT_TOKEN } from "../config";
import type { AdapterId, FetchAttempt, FetchOutcome, SourceHealth, SourceRecord } from "../types";
import { circuitAllows, closedHealth, inVisitWindow, recordOutcome } from "./circuit";
import { classifyResponse } from "./classify";
import { HostLimiter, LimiterAborted, LimiterTimeout } from "./limiter";
import {
  RobotsCache,
  isAllowed,
  parseRobots,
  unavailableRobots,
  unreachableRobots,
  type RobotsRules,
} from "./robots";
import { assertFetchable, SsrfRejected, systemResolver, type Resolver } from "./ssrf";

export type HealthPort = {
  get(sourceId: string): Promise<SourceHealth>;
  save(h: SourceHealth): Promise<void>;
};

export type FetcherDeps = {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  now?: () => number;
  limiter?: HostLimiter;
  robots?: RobotsCache;
  health?: HealthPort;
  /** Every attempt (including ones refused before the network) lands here. */
  onAttempt?: (a: FetchAttempt) => void;
  userAgent?: string;
  timeoutMs?: number;
};

export type PoliteRequest = {
  source: SourceRecord;
  url: string;
  adapter: AdapterId | "robots" | "sitemap";
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Credentialed official APIs (eBay, Amazon) aren't crawled pages: no robots check. */
  respectRobots?: boolean;
  deadlineAt?: number;
  signal?: AbortSignal;
  sessionId?: string | null;
  maxBytes?: number;
};

export type PoliteResponse = {
  outcome: FetchOutcome;
  status: number | null;
  body: string;
  headers: Record<string, string>;
  finalUrl: string;
  durationMs: number;
  cacheAgeSec: number | null;
  error: string | null;
};

const MAX_REDIRECTS = 3;
const LATE_GRACE_MS = 4_000;
const KEEP_HEADERS = [
  "content-type",
  "age",
  "last-modified",
  "etag",
  "cache-control",
  "cf-cache-status",
  "cf-mitigated",
  "retry-after",
  "location",
  "content-language",
  "x-cache",
];

/** In-process health when no store is wired (tests, scripts). */
export function memoryHealth(): HealthPort {
  const m = new Map<string, SourceHealth>();
  return {
    get: async (id) => m.get(id) ?? closedHealth(id),
    save: async (h) => {
      m.set(h.sourceId, h);
    },
  };
}

export class PoliteFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly resolve: Resolver;
  private readonly now: () => number;
  private readonly limiter: HostLimiter;
  private readonly robots: RobotsCache;
  private readonly health: HealthPort;
  private readonly onAttempt: (a: FetchAttempt) => void;
  private readonly ua: string;
  private readonly timeoutMs: number;
  private readonly fromHeader: string | null;

  constructor(deps: FetcherDeps = {}) {
    const cfg = engineConfig();
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.resolve = deps.resolve ?? systemResolver;
    this.now = deps.now ?? Date.now;
    this.limiter = deps.limiter ?? new HostLimiter();
    this.robots = deps.robots ?? new RobotsCache(this.now);
    this.health = deps.health ?? memoryHealth();
    this.onAttempt = deps.onAttempt ?? (() => undefined);
    this.ua = deps.userAgent ?? userAgent(cfg.contact);
    this.timeoutMs = deps.timeoutMs ?? cfg.fetchTimeoutMs;
    // RFC 9110 From: an email address for the person responsible.
    this.fromHeader = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(cfg.contact) ? cfg.contact : null;
  }

  get userAgent(): string {
    return this.ua;
  }

  estimateWaitMs(source: SourceRecord, url: string): number {
    try {
      return this.limiter.estimateWaitMs(new URL(url).hostname, source.crawlDelaySec * 1000);
    } catch {
      return 0;
    }
  }

  async fetch(req: PoliteRequest): Promise<PoliteResponse> {
    const startedAt = new Date(this.now()).toISOString();
    const refuse = (outcome: FetchOutcome, error: string): PoliteResponse => {
      const res: PoliteResponse = {
        outcome,
        status: null,
        body: "",
        headers: {},
        finalUrl: req.url,
        durationMs: 0,
        cacheAgeSec: null,
        error,
      };
      this.record(req, res, startedAt);
      return res;
    };

    // 1. SSRF guard
    try {
      await assertFetchable(req.url, req.source, this.resolve);
    } catch (err) {
      return refuse("ssrf_rejected", err instanceof Error ? err.message : "rejected");
    }

    // 2. visit window (robots.txt itself may be read any time)
    if (req.adapter !== "robots" && !inVisitWindow(req.source.visitWindow, new Date(this.now()))) {
      return refuse(
        "outside_visit_window",
        `${req.source.retailerLabel} asks crawlers to visit ${req.source.visitWindow?.start}–${req.source.visitWindow?.end} ${req.source.visitWindow?.timeZone}`,
      );
    }

    // 3. circuit breaker
    const health = await this.health.get(req.source.id);
    if (!circuitAllows(health, this.now()).allowed) {
      return refuse(
        "circuit_open",
        `paused after repeated refusals: ${health.circuitReason ?? "blocked"}`,
      );
    }

    // 4. robots.txt
    let spacingMs = Math.max(1, req.source.crawlDelaySec) * 1000;
    if (req.respectRobots !== false && req.adapter !== "robots") {
      const rules = await this.robots.get(req.url, (origin) => this.loadRobots(origin, req));
      if (!isAllowed(rules, req.url)) {
        return refuse(
          "robots_disallowed",
          rules.state === "unreachable"
            ? "robots.txt could not be read (blocked or down), so we don't crawl"
            : "robots.txt disallows this path",
        );
      }
      if (rules.crawlDelaySec) spacingMs = Math.max(spacingMs, rules.crawlDelaySec * 1000);
    }

    // 5. host limiter
    const host = new URL(req.url).hostname;
    let release: (() => void) | null = null;
    try {
      release = await this.limiter.acquire(host, spacingMs, {
        deadlineAt: req.deadlineAt,
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof LimiterTimeout)
        return refuse("timeout", "the store's crawl delay doesn't fit before the deadline");
      if (err instanceof LimiterAborted) return refuse("timeout", "cancelled");
      throw err;
    }

    // 6–8.
    try {
      const res = await this.send(req);
      const next = recordOutcome(health, res.outcome, this.now());
      if (next !== health) await this.health.save(next);
      this.record(req, res, startedAt);
      return res;
    } finally {
      release?.();
    }
  }

  private async loadRobots(origin: string, req: PoliteRequest): Promise<RobotsRules> {
    const res = await this.fetch({
      ...req,
      url: `${origin}/robots.txt`,
      adapter: "robots",
      method: "GET",
      body: undefined,
      headers: {},
      maxBytes: 512_000,
    });
    if (res.outcome === "ok") return parseRobots(res.body, BOT_TOKEN, this.now());
    if (res.status !== null && res.status >= 400 && res.status < 500 && res.outcome === "not_found")
      return unavailableRobots(this.now());
    // 401/403, challenges, 5xx, timeouts: we can't read the rules, so we don't crawl.
    return unreachableRobots(this.now());
  }

  private async send(req: PoliteRequest): Promise<PoliteResponse> {
    const started = this.now();
    const controller = new AbortController();
    // A request may finish a little after the session deadline: the answer
    // is already sent by then, but the reading is still stored as evidence.
    const timeoutMs = req.deadlineAt
      ? Math.max(500, Math.min(this.timeoutMs, req.deadlineAt - this.now() + LATE_GRACE_MS))
      : this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });

    let url = req.url;
    try {
      for (let hop = 0; ; hop++) {
        const headers: Record<string, string> = {
          "User-Agent": this.ua,
          Accept: "*/*",
          "Accept-Language": "en-CA,en;q=0.8,fr-CA;q=0.5",
          ...(this.fromHeader ? { From: this.fromHeader } : {}),
          ...req.headers,
        };
        const res = await this.fetchImpl(url, {
          method: req.method ?? "GET",
          headers,
          body: req.body,
          redirect: "manual",
          signal: controller.signal,
        });
        const kept: Record<string, string> = {};
        for (const h of KEEP_HEADERS) {
          const v = res.headers.get(h);
          if (v) kept[h] = v.slice(0, 300);
        }
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location && hop < MAX_REDIRECTS) {
          const next = new URL(location, url).toString();
          // Every hop must pass the same guard: no redirect to an internal or foreign host.
          await assertFetchable(next, req.source, this.resolve);
          await res.body?.cancel().catch(() => undefined);
          url = next;
          continue;
        }
        const body = await readCapped(res, req.maxBytes ?? 3_000_000);
        const outcome = classifyResponse(res.status, body, kept);
        const age = Number(kept.age);
        return {
          outcome,
          status: res.status,
          body,
          headers: kept,
          finalUrl: url,
          durationMs: this.now() - started,
          cacheAgeSec: Number.isFinite(age) ? age : null,
          error: outcome === "ok" ? null : `HTTP ${res.status}`,
        };
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      return {
        outcome: err instanceof SsrfRejected ? "ssrf_rejected" : aborted ? "timeout" : "error",
        status: null,
        body: "",
        headers: {},
        finalUrl: url,
        durationMs: this.now() - started,
        cacheAgeSec: null,
        error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err),
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
    }
  }

  private record(req: PoliteRequest, res: PoliteResponse, startedAt: string): void {
    try {
      this.onAttempt({
        sourceId: req.source.id,
        adapter: req.adapter,
        url: req.url,
        method: req.method ?? "GET",
        status: res.status,
        outcome: res.outcome,
        durationMs: res.durationMs,
        bytes: res.body.length,
        error: res.error,
        startedAt,
        sessionId: req.sessionId ?? null,
        cacheAgeSec: res.cacheAgeSec,
      });
    } catch {
      /* recording must never break a fetch */
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (bytes >= maxBytes) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return out + decoder.decode();
}
