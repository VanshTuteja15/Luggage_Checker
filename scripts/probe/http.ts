/* ------------------------------------------------------------------ */
/*  Polite, honest HTTP for the source probe                          */
/*                                                                     */
/*  • identifies itself (User-Agent with a contact), never disguises   */
/*  • one request at a time per host, spaced by the host's crawl delay */
/*  • records status, timing and the freshness-related headers         */
/*  • classifies challenge/block pages instead of retrying around them */
/* ------------------------------------------------------------------ */

export const PROBE_UA_TOKEN = "LuggageTrackerProbe";

export function userAgent(): string {
  const contact = process.env.PROBE_CONTACT?.trim();
  return `${PROBE_UA_TOKEN}/0.1 (price-comparison research for a Canadian retailer; read-only${contact ? `; contact: ${contact}` : ""})`;
}

export type FetchRecord = {
  url: string;
  finalUrl: string;
  method: string;
  status: number | null;
  ms: number;
  bytes: number;
  contentType: string | null;
  /** Headers that matter for freshness and blocking. */
  headers: Record<string, string>;
  /** "ok" | "challenge" | "blocked" | "rate_limited" | "not_found" | "error" | "timeout" */
  outcome: string;
  error?: string;
  at: string;
};

const KEEP_HEADERS = [
  "date", "last-modified", "etag", "age", "cache-control", "expires",
  "cf-cache-status", "cf-ray", "cf-mitigated", "server", "x-cache", "x-served-by",
  "content-language", "x-shopify-stage", "retry-after", "set-cookie-count",
];

const CHALLENGE_MARKERS = [
  /<title>\s*just a moment/i,
  /cf-chl|challenge-platform|__cf_chl/i,
  /captcha/i,
  /access denied/i,
  /px-captcha|perimeterx/i,
  /robot or human/i,
  /request unsuccessful\. incapsula/i,
  /access to this page has been denied/i,
];

/** Per-host spacing, set from robots.txt crawl-delay (minimum 3 s). */
const nextSlot = new Map<string, number>();
const hostDelayMs = new Map<string, number>();
export const DEFAULT_HOST_DELAY_MS = 3_000;

export function setHostDelay(host: string, ms: number): void {
  hostDelayMs.set(host, Math.max(DEFAULT_HOST_DELAY_MS, ms));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSlot(host: string): Promise<void> {
  const delay = hostDelayMs.get(host) ?? DEFAULT_HOST_DELAY_MS;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, at + delay);
  if (at > now) await sleep(at - now);
}

export type ProbeResponse = { record: FetchRecord; body: string };

export async function probeFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number; skipPacing?: boolean } = {},
): Promise<ProbeResponse> {
  const host = new URL(url).hostname;
  if (!init.skipPacing) await waitForSlot(host);

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  const record: FetchRecord = {
    url,
    finalUrl: url,
    method: init.method ?? "GET",
    status: null,
    ms: 0,
    bytes: 0,
    contentType: null,
    headers: {},
    outcome: "error",
    at: new Date().toISOString(),
  };

  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: { "User-Agent": userAgent(), Accept: "*/*", "Accept-Language": "en-CA,en;q=0.8", ...init.headers },
      body: init.body,
      redirect: "follow",
      signal: controller.signal,
    });
    record.status = res.status;
    record.finalUrl = res.url || url;
    record.contentType = res.headers.get("content-type");
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v) record.headers[h] = v.slice(0, 200);
    }
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length) record.headers["set-cookie-count"] = String(setCookies.length);

    const text = await res.text();
    const max = init.maxBytes ?? 4_000_000;
    const body = text.length > max ? text.slice(0, max) : text;
    record.bytes = text.length;
    record.ms = Date.now() - started;
    record.outcome = classify(res.status, body, record.headers);
    return { record, body };
  } catch (err) {
    record.ms = Date.now() - started;
    const aborted = err instanceof Error && err.name === "AbortError";
    record.outcome = aborted ? "timeout" : "error";
    record.error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err);
    return { record, body: "" };
  } finally {
    clearTimeout(timer);
  }
}

export function classify(status: number, body: string, headers: Record<string, string>): string {
  const head = body.slice(0, 20_000);
  if (headers["cf-mitigated"]) return "challenge";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 410) return "not_found";
  if ((status === 403 || status === 503) && CHALLENGE_MARKERS.some((re) => re.test(head))) return "challenge";
  // fetch follows real redirects, so a 3xx that reaches us had no usable
  // Location. Bot managers answer like this: samsonite.ca and ca.tumi.com
  // return a 307 PerimeterX CAPTCHA page that never redirects (7 Oct probe).
  if (status >= 300 && status < 400 && CHALLENGE_MARKERS.some((re) => re.test(head))) return "challenge";
  if (status === 401 || status === 403) return "blocked";
  if (status >= 200 && status < 300) {
    // A 200 can still be an interstitial.
    if (/<title>\s*just a moment/i.test(head) || /cf-chl/i.test(head)) return "challenge";
    return "ok";
  }
  return "error";
}
