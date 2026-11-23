/* ------------------------------------------------------------------ */
/*  Candidate stores (v4 A6.1)                                         */
/*                                                                     */
/*  A store someone found (staff, a brand's dealer locator, a link on   */
/*  an indexed store, a Common Crawl domain check) first becomes a      */
/*  registry row: its exact host, inactive, disabled, no routes.        */
/*  Nothing is fetched before that (U-DISC-1). Its probe then reads     */
/*  robots.txt and the terms page through the PoliteFetcher:            */
/*    single_page_ok  robots.txt allows our token on product pages and  */
/*                    the terms pre-screen quoted nothing (U-DISC-2)    */
/*    needs_review    anything else; the quotes say what to read        */
/*  A host that looks like a registry store's is flagged and never      */
/*  probed or promoted (U-DISC-3). Crawling needs the owner's approval  */
/*  (approved_crawl) and an engineer adding the store's routes: the     */
/*  pre-screen never decides permission (U-TERMS-1).                    */
/* ------------------------------------------------------------------ */

import { termsQuotes } from "../ai/tasks";
import { BOT_TOKEN } from "../config";
import { isAllowed, parseRobots } from "../politeness/robots";
import type { EngineRuntime } from "../recorder";
import type { CandidateInfo, CandidateProbe, SourceRecord } from "../types";

/** Where stores keep their terms (Shopify first); the probe tries at most three. */
const TERMS_PATHS = [
  "/policies/terms-of-service",
  "/pages/terms-of-service",
  "/pages/terms-and-conditions",
  "/terms-of-use",
  "/terms",
];
const MAX_TERMS_READS = 3;
/** Product paths robots.txt must allow us on (Shopify and most other platforms). */
const PRODUCT_PATHS = ["/products/a-product", "/product/a-product"];

/** The exact host of an https address or a bare domain; null for anything else. */
export function candidateHost(input: string): string | null {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) || /^[\d.]+$/.test(host)) return null;
  return host;
}

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "on", "qc", "bc", "ab"]);

/** The name part of a domain: "www.delsey.ca" → "delsey", "shop.example.co.uk" → "example". */
function labelOf(host: string): string {
  const parts = host.split(".");
  if (parts.length >= 3 && SECOND_LEVEL.has(parts[parts.length - 2]))
    return parts[parts.length - 3];
  return parts[parts.length - 2] ?? host;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/**
 * The registry host a candidate imitates, if any: the same name on another
 * domain, a name within two edits, or a name containing a store's name
 * ("delseyluggagecanada.ca" vs "delsey.ca"). An internationalised name
 * (xn--) can imitate any of them, so it is flagged too.
 */
export function lookalikeOf(host: string, sources: SourceRecord[]): string | null {
  if (host.split(".").some((l) => l.startsWith("xn--"))) return "an internationalised name";
  const label = labelOf(host);
  for (const s of sources) {
    if (s.discovery) continue;
    for (const d of new Set([...s.allowedDomains, ...s.fetchHosts].map((h) => h.toLowerCase()))) {
      const known = labelOf(d);
      if (known.length < 4) continue;
      if (label === known || editDistance(label, known) <= 2 || label.includes(known)) return d;
    }
  }
  return null;
}

/** Visible text of an HTML page (terms pages), for the pre-screen. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&#8217;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

const candidateId = (host: string) =>
  `cand-${host.replace(/[^a-z0-9]+/g, "-")}`.slice(0, 60).replace(/-+$/, "");

export type CandidateInput = {
  url: string;
  name?: string | null;
  foundVia: CandidateInfo["foundVia"];
  note?: string | null;
};

type Outcome = { ok: true; source: SourceRecord } | { ok: false; error: string };

/** Record a store someone found. Only its row is written: nothing is fetched (U-DISC-1). */
export async function addCandidate(
  rt: EngineRuntime,
  input: CandidateInput,
  now: () => Date = () => new Date(),
): Promise<Outcome> {
  const host = candidateHost(input.url);
  if (!host) return { ok: false, error: "That isn't an https web address with a domain name." };
  const sources = await rt.store.listSources();
  const owner = sources.find((s) =>
    [...s.allowedDomains, ...s.fetchHosts].some((h) => h.toLowerCase() === host),
  );
  if (owner)
    return {
      ok: false,
      error: owner.discovery
        ? `${host} is already a candidate store.`
        : `${host} is already in the registry as ${owner.name}.`,
    };
  const lookalike = lookalikeOf(host, sources);
  const name = input.name?.trim().slice(0, 80) || host;
  const rec: SourceRecord = {
    id: candidateId(host),
    name,
    retailerLabel: name,
    category: "specialty_retailer",
    status: "inactive",
    platform: "unknown",
    allowedDomains: [host],
    fetchHosts: [host],
    marketHost: host,
    marketPathPrefix: null,
    currency: "CAD",
    liveClass: "unknown",
    permission: "unclear",
    terms: { stance: "unknown", url: null, clause: null },
    robots: { summary: "not read yet", crawlDelaySec: null, sitemaps: [] },
    crawlDelaySec: 3,
    visitWindow: null,
    ucpEndpoint: null,
    identityQuality: { barcode: "unknown", modelInSku: false },
    routes: [],
    linkOnlySearchUrl: null,
    domainWarnings: lookalike
      ? [`looks like ${lookalike}: confirm by hand before anything else`]
      : [],
    evidence: { probedAt: null, summary: "candidate store, not reviewed" },
    enabled: false,
    discovery: {
      state: "discovered",
      foundVia: input.foundVia,
      note: input.note?.trim().slice(0, 500) || null,
      lookalikeOf: lookalike,
      addedAt: now().toISOString(),
      probe: null,
      decidedBy: null,
      decidedAt: null,
    },
  };
  if (!(await rt.store.saveCandidate(rec)))
    return { ok: false, error: "That id belongs to a store in the registry." };
  rt.invalidate();
  return { ok: true, source: rec };
}

async function candidate(rt: EngineRuntime, id: string): Promise<SourceRecord | null> {
  const s = (await rt.store.listSources()).find((x) => x.id === id);
  return s?.discovery ? s : null;
}

/**
 * robots.txt, then up to three terms pages, through the PoliteFetcher (our
 * honest user agent; robots.txt and the store's crawl delay honoured).
 */
export async function probeCandidate(
  rt: EngineRuntime,
  id: string,
  opts: { signal?: AbortSignal; now?: () => Date } = {},
): Promise<Outcome> {
  const s = await candidate(rt, id);
  if (!s || !s.discovery) return { ok: false, error: "No candidate store with that id." };
  if (s.discovery.lookalikeOf)
    return {
      ok: false,
      error: `It looks like ${s.discovery.lookalikeOf}; confirm the store by hand first.`,
    };
  if (s.discovery.state === "approved_crawl" || s.discovery.state === "rejected")
    return { ok: false, error: "That store has been decided already." };
  const origin = `https://${s.fetchHosts[0]}`;
  const common = { source: s, sessionId: null, signal: opts.signal };
  let requests = 0;

  const r = await rt.fetcher.fetch({
    ...common,
    url: `${origin}/robots.txt`,
    adapter: "robots",
    maxBytes: 512_000,
  });
  if (r.status !== null) requests++;
  let robots: CandidateProbe["robots"];
  if (r.outcome === "ok") {
    const rules = parseRobots(r.body, BOT_TOKEN);
    robots = PRODUCT_PATHS.every((p) => isAllowed(rules, `${origin}${p}`)) ? "allows" : "disallows";
  } else if (r.outcome === "not_found")
    robots = "allows"; // no robots.txt: no rules (RFC 9309)
  else robots = "unreachable";

  let termsUrl: string | null = null;
  let quotes: CandidateProbe["quotes"] = [];
  if (robots !== "unreachable") {
    for (const path of TERMS_PATHS) {
      if (requests >= 1 + MAX_TERMS_READS) break;
      const t = await rt.fetcher.fetch({
        ...common,
        url: `${origin}${path}`,
        adapter: "html_structured",
        maxBytes: 3_000_000,
      });
      if (t.status !== null) requests++;
      if (t.outcome !== "ok") continue;
      termsUrl = `${origin}${path}`;
      quotes = termsQuotes(pageText(t.body));
      break;
    }
  }

  const why: string[] = [];
  if (robots === "unreachable") why.push("robots.txt couldn't be read, so we don't read the store");
  if (robots === "disallows") why.push(`robots.txt doesn't allow ${BOT_TOKEN} on product pages`);
  if (robots !== "unreachable" && !termsUrl)
    why.push("no terms page at the usual addresses; a person should find and read it");
  if (quotes.length)
    why.push(
      `the terms say something a person must read (${[...new Set(quotes.map((q) => q.category))].join(", ")})`,
    );
  const state = why.length === 0 ? "single_page_ok" : "needs_review";
  if (state === "single_page_ok")
    why.push(
      "robots.txt allows us on product pages and the terms pre-screen quoted nothing; crawling still needs the owner's approval",
    );
  const at = (opts.now ?? (() => new Date()))().toISOString();
  const next: SourceRecord = {
    ...s,
    robots: { ...s.robots, summary: `${BOT_TOKEN} on product pages: ${robots}` },
    terms: {
      stance: quotes.some((q) => q.category === "prohibits_automated_access")
        ? "prohibits"
        : quotes.length
          ? "restricts"
          : termsUrl
            ? "silent"
            : "unknown",
      url: termsUrl,
      clause: quotes[0]?.sentence ?? null,
    },
    evidence: { probedAt: at, summary: why.join("; ") },
    discovery: {
      ...s.discovery,
      state,
      probe: { at, robots, termsUrl, quotes, requests, why },
    },
  };
  await rt.store.saveCandidate(next);
  rt.invalidate();
  return { ok: true, source: next };
}

/** The owner's decision. Approval needs a probe first; look-alikes can only be rejected. */
export async function decideCandidate(
  rt: EngineRuntime,
  id: string,
  decision: "approved_crawl" | "rejected",
  userId: string | null,
  now: () => Date = () => new Date(),
): Promise<Outcome> {
  const s = await candidate(rt, id);
  if (!s || !s.discovery) return { ok: false, error: "No candidate store with that id." };
  if (decision === "approved_crawl" && (!s.discovery.probe || s.discovery.lookalikeOf))
    return { ok: false, error: "Probe the store (robots.txt and terms) before approving it." };
  const next: SourceRecord = {
    ...s,
    discovery: {
      ...s.discovery,
      state: decision,
      decidedBy: userId,
      decidedAt: now().toISOString(),
    },
  };
  await rt.store.saveCandidate(next);
  rt.invalidate();
  return { ok: true, source: next };
}

/** What the admin screen shows for a candidate (T-601). */
export function candidateView(s: SourceRecord) {
  return {
    id: s.id,
    name: s.name,
    host: s.fetchHosts[0] ?? null,
    warnings: s.domainWarnings,
    ...s.discovery!,
  };
}

export async function listCandidates(rt: EngineRuntime): Promise<SourceRecord[]> {
  return (await rt.store.listSources())
    .filter((s) => !!s.discovery)
    .sort((a, b) => b.discovery!.addedAt.localeCompare(a.discovery!.addedAt));
}
