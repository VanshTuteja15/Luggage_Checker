/* ------------------------------------------------------------------ */
/*  npm run probe:sources            — live, read-only probe           */
/*  npm run probe:sources -- --selftest   — offline parser checks      */
/*                                                                     */
/*  Validates the acquisition protocols from OUR machine before the    */
/*  architecture is final. For every store/channel it records what     */
/*  data actually comes back and classifies it as:                     */
/*    accessible  — we got a usable response with a price              */
/*    reliable    — identity + price + currency + availability present, */
/*                  and channels/reads agree                           */
/*    permitted   — robots.txt + the store's terms/official channel    */
/*                                                                     */
/*  ~60–80 requests in total, honest User-Agent, robots.txt honoured,  */
/*  crawl delays respected (min 3 s per host). Writes                  */
/*  docs/probe-results.json.                                           */
/* ------------------------------------------------------------------ */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROBE_UA_TOKEN, probeFetch, setHostDelay, userAgent, type FetchRecord } from "./http";
import { isAllowed, parseRobots, unreachableRobots, type RobotsRules } from "./robots";
import { extractStructured, looksJsOnly, type StructuredResult } from "./structured";
import { parseProductJs, parseProductJson, type NormProduct } from "./shopify";
import { callTool, findMcpEndpoint, findProducts, normaliseUcpProduct, type McpCall } from "./ucp";
import { probeEbay, type EbayResult } from "./ebay";
import { EBAY_GTIN, EBAY_QUERY, TARGETS, type Channel, type Target, type Tos } from "./targets";
import { selftest } from "./selftest";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

/* ── env (.env.local, values never printed) ─────────────────────── */
function loadEnv(): void {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

/* ── result shapes ──────────────────────────────────────────────── */
type ChannelResult = {
  channel: Channel | "sitemap";
  attempted: boolean;
  skippedReason?: string;
  requests: FetchRecord[];
  product?: NormProduct | null;
  structured?: Omit<StructuredResult, "products"> & { products: StructuredResult["products"] };
  ucp?: { endpoint: string; wellKnown: FetchRecord | null; calls: Omit<McpCall, "record">[] };
  sitemap?: { urls: number; productLike: number; lastmod: boolean; sample: string[] };
  /** Price read on each repeated read of the first page (HTML repeat test). */
  repeatPrices?: (number | null)[];
  notes: string[];
  verdict?: Verdict;
};

type Verdict = {
  accessible: string;
  reliable: string;
  permitted: string;
  fields: {
    identity: boolean;
    barcode: string;
    price: boolean;
    salePrice: string;
    currency: string;
    availability: string;
    variants: string;
    timestamps: string;
  };
};

type StoreResult = {
  id: string;
  name: string;
  host: string;
  tos: Tos;
  robots: RobotsRules & { record: FetchRecord | null };
  channels: ChannelResult[];
  agreement: string[];
};

/* ── helpers ─────────────────────────────────────────────────────── */
const has = (v: unknown) => v !== null && v !== undefined && v !== "";

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
}

function bestMatch(products: Record<string, unknown>[], query: string, handle: string | null): Record<string, unknown> | null {
  if (products.length === 0) return null;
  const want = tokens(query);
  let best = products[0];
  let bestScore = -1;
  for (const p of products) {
    const title = String(p.title ?? p.name ?? "");
    const h = String(p.handle ?? "");
    let score = want.filter((t) => tokens(title).includes(t)).length;
    if (handle && h === handle) score += 100;
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

const numericId = (id: string | null | undefined) => (id ? (String(id).match(/(\d+)\s*$/)?.[1] ?? null) : null);

function timestampSummary(records: FetchRecord[], extra: string[] = []): string {
  const r = records.find((x) => x.outcome === "ok") ?? records[0];
  if (!r) return "none";
  const parts: string[] = [];
  if (r.headers["last-modified"]) parts.push("Last-Modified");
  if (r.headers.etag) parts.push("ETag");
  if (r.headers.age) parts.push(`Age=${r.headers.age}s (CDN-cached)`);
  if (r.headers["cache-control"]) parts.push(`Cache-Control: ${r.headers["cache-control"].slice(0, 60)}`);
  if (r.headers["cf-cache-status"]) parts.push(`cf-cache=${r.headers["cf-cache-status"]}`);
  parts.push(...extra);
  return parts.length ? parts.join("; ") : "only our fetch time";
}

function permittedFor(channel: Channel | "sitemap", tos: Tos, robotsOk: boolean): string {
  if (!robotsOk) return "NO — robots.txt disallows this path for our agent";
  if (channel === "ucp") {
    return tos === "restricts"
      ? "YES (store-published agent channel) — ⚖ terms carry a generic anti-scrape clause; get sign-off"
      : "YES — store-published agent channel";
  }
  switch (tos) {
    case "sanctions_json":
      return channel === "json" || channel === "js" ? "YES — the store's agents.md lists product JSON for agents" : "LIKELY — robots allows; agents.md invites agents";
    case "silent":
      return "LIKELY — robots allows; terms have no anti-robot clause (not legal advice)";
    case "unknown":
      return "UNCLEAR — robots allows; terms not yet read by a human";
    case "restricts":
      return "NO for production — terms restrict scraping (evaluation only)";
  }
}

/* ── per-store probing ───────────────────────────────────────────── */
async function probeRobots(host: string): Promise<StoreResult["robots"]> {
  const { record, body } = await probeFetch(`https://${host}/robots.txt`, { skipPacing: true, maxBytes: 500_000 });
  if (record.outcome !== "ok") return { ...unreachableRobots(record.status), record };
  const rules = parseRobots(body, PROBE_UA_TOKEN, record.status);
  if (rules.crawlDelaySec) setHostDelay(host, rules.crawlDelaySec * 1000);
  return { ...rules, record };
}

async function getAllowed(robots: RobotsRules, url: string, notes: string[], maxBytes?: number) {
  if (!isAllowed(robots, url)) {
    notes.push(`robots.txt disallows ${new URL(url).pathname}`);
    return null;
  }
  return probeFetch(url, { maxBytes });
}

async function probeUcp(t: Target, robots: RobotsRules): Promise<ChannelResult> {
  const res: ChannelResult = { channel: "ucp", attempted: true, requests: [], notes: [] };
  const profile = process.env.UCP_AGENT_PROFILE_URL?.trim();

  const wk = await getAllowed(robots, `https://${t.host}/.well-known/ucp`, res.notes);
  let endpoint = `https://${t.host}/api/ucp/mcp`;
  if (wk) {
    res.requests.push(wk.record);
    try {
      endpoint = findMcpEndpoint(JSON.parse(wk.body), t.host);
    } catch {
      res.notes.push("/.well-known/ucp did not parse as JSON");
    }
  }
  res.ucp = { endpoint, wellKnown: wk?.record ?? null, calls: [] };

  if (!profile) {
    res.attempted = false;
    res.skippedReason = "UCP_AGENT_PROFILE_URL not set — catalog calls need our published agent profile (see docs/PROBE_SETUP.md)";
    return res;
  }
  if (!isAllowed(robots, endpoint)) {
    res.notes.push("robots.txt disallows the MCP endpoint path");
    res.attempted = false;
    res.skippedReason = "robots.txt";
    return res;
  }

  const context = { address_country: "CA" };
  const search = await callTool(endpoint, profile, "search_catalog", { query: t.shopify!.query, context }, 1);
  res.requests.push(search.record);
  res.ucp.calls.push({ tool: search.tool, ok: search.ok, error: search.error, result: undefined, rawSample: search.rawSample });
  if (!search.ok) {
    res.notes.push(`search_catalog failed: ${search.error}`);
    return res;
  }
  const hits = findProducts(search.result);
  res.notes.push(`search_catalog returned ${hits.length} product(s)`);
  const pick = bestMatch(hits, t.shopify!.query, t.shopify!.handle);
  if (!pick) return res;

  const detail = await callTool(endpoint, profile, "get_product", { id: pick.id, context }, 2);
  res.requests.push(detail.record);
  res.ucp.calls.push({ tool: detail.tool, ok: detail.ok, error: detail.error, result: undefined, rawSample: detail.rawSample });
  const full = detail.ok ? (findProducts(detail.result)[0] ?? (detail.result as Record<string, unknown>)?.product ?? null) : null;
  res.product = normaliseUcpProduct((full as Record<string, unknown>) ?? pick);
  if (!detail.ok) res.notes.push(`get_product failed (${detail.error}); using the search hit`);
  return res;
}

async function probeShopifyJson(t: Target, robots: RobotsRules, kind: "json" | "js"): Promise<ChannelResult> {
  const res: ChannelResult = { channel: kind, attempted: true, requests: [], notes: [] };
  const handle = t.shopify!.handle;
  if (!handle) {
    res.attempted = false;
    res.skippedReason = "no handle (agent channel only for this store)";
    return res;
  }
  const r = await getAllowed(robots, `https://${t.host}/products/${handle}.${kind}`, res.notes);
  if (!r) {
    res.attempted = false;
    res.skippedReason = "robots.txt";
    return res;
  }
  res.requests.push(r.record);
  res.product = r.record.outcome === "ok" ? (kind === "json" ? parseProductJson(r.body) : parseProductJs(r.body)) : null;
  if (r.record.outcome === "ok" && !res.product) res.notes.push("response did not parse as Shopify product data");
  return res;
}

async function probeHtml(t: Target, robots: RobotsRules, urls: string[], repeatFirst = 1): Promise<ChannelResult> {
  const res: ChannelResult = { channel: "html", attempted: true, requests: [], notes: [] };
  const plan = [...urls];
  for (let i = 1; i < repeatFirst; i++) plan.push(urls[0]);
  const structuredAll: StructuredResult[] = [];
  const repeatPrices: (number | null)[] = [];
  for (const url of plan) {
    const r = await getAllowed(robots, url, res.notes);
    if (!r) continue;
    res.requests.push(r.record);
    if (r.record.outcome !== "ok") {
      if (url === urls[0]) repeatPrices.push(null);
      continue;
    }
    const s = extractStructured(r.body);
    if (url === urls[0]) repeatPrices.push(firstPrice(s));
    structuredAll.push(s);
    if (looksJsOnly(r.body)) res.notes.push(`${new URL(url).pathname.slice(0, 60)}: page appears to need JavaScript`);
  }
  if (structuredAll.length) {
    res.structured = {
      jsonLdBlocks: structuredAll.reduce((n, s) => n + s.jsonLdBlocks, 0),
      jsonLdParseErrors: structuredAll.reduce((n, s) => n + s.jsonLdParseErrors, 0),
      products: structuredAll.flatMap((s) => s.products),
      meta: Object.assign({}, ...structuredAll.map((s) => s.meta)),
    };
    // Same page read several times: did the price stay the same?
    if (repeatFirst > 1) {
      res.repeatPrices = repeatPrices;
      const firstUrlReads = res.requests.filter((r) => r.url === urls[0]);
      const blocked = firstUrlReads.filter((r) => r.outcome !== "ok").length;
      res.notes.push(`repeat reads of first page: ${firstUrlReads.length} (${blocked} not ok)`);
    }
  }
  return res;
}

async function probeSitemap(robots: RobotsRules): Promise<ChannelResult> {
  const res: ChannelResult = { channel: "sitemap", attempted: true, requests: [], notes: [] };
  const index = robots.sitemaps[0];
  if (!index) {
    res.attempted = false;
    res.skippedReason = "no Sitemap line in robots.txt";
    return res;
  }
  const first = await getAllowed(robots, index, res.notes, 20_000_000);
  if (!first) return res;
  res.requests.push(first.record);
  let body = first.body;
  // A sitemap index points at child sitemaps; read the first child.
  if (/<sitemapindex/i.test(body)) {
    const child = body.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
    if (child) {
      const c = await getAllowed(robots, child, res.notes, 20_000_000);
      if (c) {
        res.requests.push(c.record);
        body = c.body;
      }
    }
  }
  const locs = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
  const productLike = locs.filter((u) => /\/\d{4,}[A-Z]*\.html|\/products\/|\/p\//i.test(u));
  res.sitemap = { urls: locs.length, productLike: productLike.length, lastmod: /<lastmod>/i.test(body), sample: productLike.slice(0, 3) };
  return res;
}

/** The page's own price: first Offer price, else the meta price. */
function firstPrice(s: StructuredResult): number | null {
  for (const p of s.products) {
    for (const o of [...p.offers, ...p.variants.flatMap((v) => v.offers)]) if (o.price !== null) return o.price;
  }
  const m = Number(s.meta["og:price:amount"] ?? s.meta["product:price:amount"] ?? NaN);
  return Number.isFinite(m) ? m : null;
}

/* ── verdicts ────────────────────────────────────────────────────── */
function verdictForProduct(ch: ChannelResult, tos: Tos, robotsOk: boolean, reference: NormProduct | null): Verdict {
  const p = ch.product;
  const okReq = ch.requests.some((r) => r.outcome === "ok");
  const v = p?.variants ?? [];
  const priced = v.filter((x) => x.price !== null);
  const withBarcode = v.filter((x) => has(x.barcode));
  const withSku = v.filter((x) => has(x.sku));
  const withAvail = v.filter((x) => x.available !== null);
  const sale = v.some((x) => x.compareAt !== null && x.price !== null && x.compareAt > x.price);
  const currency = v.find((x) => x.currency)?.currency ?? null;

  const missing: string[] = [];
  if (!priced.length) missing.push("price");
  if (!withSku.length && !withBarcode.length) missing.push("identity");
  if (!currency) missing.push("explicit currency");
  if (!withAvail.length) missing.push("availability");

  // Agreement with the reference channel (same variant id).
  let disagreement = "";
  if (reference && p && reference !== p) {
    for (const x of v) {
      const ref = reference.variants.find((r) => numericId(r.id) === numericId(x.id));
      if (ref && ref.price !== null && x.price !== null && Math.abs(ref.price - x.price) > 0.005) {
        disagreement = `price differs from ${reference.source} (${x.price} vs ${ref.price})`;
        break;
      }
    }
  }

  const accessible = !ch.attempted
    ? `NOT TESTED — ${ch.skippedReason}`
    : okReq && priced.length
      ? "YES"
      : okReq
        ? "PARTIAL — responded, but no price parsed"
        : `NO — ${ch.requests.map((r) => `${r.status ?? ""} ${r.outcome}`).join(", ") || ch.notes.join("; ")}`;

  const reliable = !priced.length
    ? "NO"
    : disagreement
      ? `NO — ${disagreement}`
      : missing.length
        ? `PARTIAL — missing ${missing.join(", ")}`
        : "YES (single sample)";

  return {
    accessible,
    reliable,
    permitted: permittedFor(ch.channel, tos, robotsOk),
    fields: {
      identity: withSku.length > 0 || withBarcode.length > 0,
      barcode: v.length ? `${withBarcode.length}/${v.length} variants` : "n/a",
      price: priced.length > 0,
      salePrice: sale ? "yes (compare-at/list price above price)" : v.some((x) => x.compareAt !== null) ? "field present, no sale now" : "not provided",
      currency: currency ?? "not stated (implied by storefront)",
      availability: withAvail.length ? `${withAvail.length}/${v.length} variants` : "not provided",
      variants: `${v.length}`,
      timestamps: timestampSummary(ch.requests, p?.updatedAt ? [`product updated_at ${p.updatedAt}`] : []),
    },
  };
}

function verdictForHtml(ch: ChannelResult, tos: Tos, robotsOk: boolean): Verdict {
  const s = ch.structured;
  const okReqs = ch.requests.filter((r) => r.outcome === "ok");
  const prods = s?.products ?? [];
  const offers = prods.flatMap((p) => [...p.offers, ...p.variants.flatMap((v) => v.offers)]);
  const prices = offers.map((o) => o.price).filter((x): x is number => x !== null);
  const metaPrice = s?.meta["og:price:amount"] ?? s?.meta["product:price:amount"] ?? null;
  const currency = offers.find((o) => o.priceCurrency)?.priceCurrency ?? s?.meta["og:price:currency"] ?? s?.meta["product:price:currency"] ?? null;
  const gtins = [...prods.map((p) => p.gtin), ...prods.flatMap((p) => p.variants.map((v) => v.gtin)), ...offers.map((o) => o.gtin)].filter(Boolean);
  const skus = [...prods.map((p) => p.sku ?? p.mpn), ...prods.flatMap((p) => p.variants.map((v) => v.sku))].filter(Boolean);
  const avail = offers.filter((o) => o.availability).length || (s?.meta["product:availability"] ? 1 : 0);
  const blocked = ch.requests.filter((r) => r.outcome !== "ok");

  // Repeated reads of the same page must give the same price.
  const seen = (ch.repeatPrices ?? []).filter((x): x is number => x !== null);
  const unstable = new Set(seen).size > 1;

  const anyPrice = prices.length > 0 || metaPrice !== null;
  const missing: string[] = [];
  if (!anyPrice) missing.push("price");
  if (!gtins.length && !skus.length) missing.push("identity");
  if (!currency) missing.push("currency");
  if (!avail) missing.push("availability");

  const accessible = !ch.attempted
    ? `NOT TESTED — ${ch.skippedReason}`
    : !okReqs.length
      ? `NO — ${ch.requests.map((r) => `${r.status ?? ""} ${r.outcome}`).join(", ") || ch.notes.join("; ")}`
      : blocked.length
        ? `PARTIAL — ${okReqs.length}/${ch.requests.length} reads ok (${blocked.map((r) => r.outcome).join(", ")})`
        : anyPrice
          ? "YES"
          : "PARTIAL — page loads, but no price in structured data or meta";

  const reliable = !anyPrice ? "NO" : unstable ? "NO — price changed between reads" : missing.length ? `PARTIAL — missing ${missing.join(", ")}` : blocked.length ? `PARTIAL — ${blocked.length} of ${ch.requests.length} reads blocked/failed` : "YES";

  return {
    accessible,
    reliable,
    permitted: permittedFor("html", tos, robotsOk),
    fields: {
      identity: gtins.length > 0 || skus.length > 0,
      barcode: gtins.length ? `GTIN in JSON-LD (${gtins.length})` : "none in structured data",
      price: anyPrice,
      salePrice: offers.some((o) => o.listPrice !== null && o.price !== null && o.listPrice > o.price) ? "yes (list price in priceSpecification)" : "not in structured data",
      currency: currency ?? "not stated",
      availability: avail ? "yes" : "not provided",
      variants: `${prods.reduce((n, p) => n + Math.max(1, p.variants.length), 0)} product node(s)`,
      timestamps: timestampSummary(ch.requests, offers.some((o) => o.priceValidUntil) ? ["priceValidUntil"] : []),
    },
  };
}

/* ── main ────────────────────────────────────────────────────────── */
async function probeStore(t: Target): Promise<StoreResult> {
  const robots = await probeRobots(t.host);
  const store: StoreResult = { id: t.id, name: t.name, host: t.host, tos: t.tos, robots, channels: [], agreement: [] };
  if (t.robotsOnly) return store;

  if (t.shopify) {
    for (const c of t.shopify.channels) {
      if (c === "ucp") store.channels.push(await probeUcp(t, robots));
      else if (c === "json" || c === "js") store.channels.push(await probeShopifyJson(t, robots, c));
      else if (c === "html" && t.shopify.handle) store.channels.push(await probeHtml(t, robots, [`https://${t.host}/products/${t.shopify.handle}`]));
    }
  }
  if (t.html) store.channels.push(await probeHtml(t, robots, t.html.urls, t.html.repeatFirst));
  if (t.sitemap) store.channels.push(await probeSitemap(robots));

  // Verdicts. The reference for price agreement is UCP when it worked, else product.json.
  const ucp = store.channels.find((c) => c.channel === "ucp")?.product ?? null;
  const json = store.channels.find((c) => c.channel === "json")?.product ?? null;
  const reference = ucp ?? json;
  for (const ch of store.channels) {
    if (ch.channel === "sitemap") continue;
    const path = ch.requests[0]?.url ?? `https://${t.host}/`;
    const robotsOk = isAllowed(robots, path);
    ch.verdict = ch.channel === "html" ? verdictForHtml(ch, t.tos, robotsOk) : verdictForProduct(ch, t.tos, robotsOk, reference);
  }

  // Cross-channel agreement: the displayed (meta/JSON-LD) price vs data channels.
  const html = store.channels.find((c) => c.channel === "html")?.structured;
  const metaPrice = Number(html?.meta["og:price:amount"] ?? html?.meta["product:price:amount"] ?? NaN);
  for (const p of [ucp, json, store.channels.find((c) => c.channel === "js")?.product ?? null]) {
    if (!p || !Number.isFinite(metaPrice)) continue;
    const prices = p.variants.map((v) => v.price).filter((x): x is number => x !== null);
    if (prices.length && !prices.some((x) => Math.abs(x - metaPrice) < 0.005)) {
      store.agreement.push(`${p.source} price(s) ${[...new Set(prices)].join("/")} ≠ page price ${metaPrice}`);
    }
  }
  return store;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

function printStore(s: StoreResult): void {
  const rb = s.robots.record?.outcome === "ok"
    ? `robots ok (${s.robots.group} group${s.robots.crawlDelaySec ? `, crawl-delay ${s.robots.crawlDelaySec}s` : ""})`
    : `robots ${s.robots.record?.status ?? ""} ${s.robots.record?.outcome ?? "?"}`;
  console.log(`\n${B}${s.name}${X} ${D}${s.host} · ${rb} · terms: ${s.tos}${X}`);
  for (const ch of s.channels) {
    if (ch.channel === "sitemap") {
      console.log(`  sitemap   ${ch.sitemap ? `${ch.sitemap.urls} URLs, ${ch.sitemap.productLike} product-like, lastmod ${ch.sitemap.lastmod ? "yes" : "no"}` : ch.skippedReason ?? ch.notes.join("; ")}`);
      continue;
    }
    const v = ch.verdict!;
    const colour = (t: string) => (t.startsWith("YES") ? G : t.startsWith("NO") ? R : Y);
    console.log(`  ${ch.channel.padEnd(8)} accessible ${colour(v.accessible)}${v.accessible}${X}`);
    console.log(`  ${"".padEnd(8)} reliable   ${colour(v.reliable)}${v.reliable}${X}`);
    console.log(`  ${"".padEnd(8)} permitted  ${colour(v.permitted)}${v.permitted}${X}`);
    const f = v.fields;
    console.log(`  ${"".padEnd(8)} ${D}barcode ${f.barcode} · sale ${f.salePrice} · currency ${f.currency} · availability ${f.availability} · variants ${f.variants}${X}`);
    console.log(`  ${"".padEnd(8)} ${D}timestamps: ${f.timestamps}${X}`);
    for (const n of ch.notes) console.log(`  ${"".padEnd(8)} ${D}• ${n}${X}`);
  }
  for (const a of s.agreement) console.log(`  ${Y}! ${a}${X}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) {
    process.exit(selftest() ? 0 : 1);
  }
  loadEnv();
  const started = new Date();
  console.log(`\n${B}Source probe${X} ${D}(read-only · UA: ${userAgent()})${X}`);
  console.log(`${D}UCP agent profile: ${process.env.UCP_AGENT_PROFILE_URL ? "set" : "NOT SET — UCP calls will be skipped"} · eBay keys: ${process.env.EBAY_CLIENT_ID ? "set" : "not set"}${X}`);
  console.log(`${D}Spacing requests per host (≥3 s, longer where robots.txt asks). This takes a few minutes.${X}`);

  const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7).split(",");
  const targets = only ? TARGETS.filter((t) => only.includes(t.id)) : TARGETS;

  const stores = await pool(targets, 5, probeStore);
  stores.forEach(printStore);

  let ebay: EbayResult | null = null;
  if (!only || only.includes("ebay")) {
    ebay = await probeEbay(EBAY_QUERY, EBAY_GTIN);
    console.log(`\n${B}eBay Browse API (EBAY_CA)${X}`);
    if (!ebay.configured || !ebay.token.ok) console.log(`  ${Y}${ebay.token.error}${X}`);
    for (const s of ebay.searches) {
      const cad = s.items.filter((i) => i.currency === "CAD").length;
      console.log(`  ${s.label}: ${s.record.status} · total ${s.total ?? "?"} · ${s.items.length} shown, ${cad} priced in CAD${s.error ? ` · ${s.error}` : ""}`);
    }
    if (ebay.item) console.log(`  getItem: gtin ${ebay.item.gtin ?? "—"} · mpn ${ebay.item.mpn ?? "—"} · ${ebay.item.price} ${ebay.item.currency}`);
  }

  // Identity check: does the same UPC appear in more than one source?
  const barcodes = new Map<string, string[]>();
  for (const s of stores) {
    for (const ch of s.channels) {
      for (const v of ch.product?.variants ?? []) if (v.barcode) barcodes.set(v.barcode, [...(barcodes.get(v.barcode) ?? []), `${s.id}/${ch.channel}`]);
      for (const p of ch.structured?.products ?? []) {
        for (const g of [p.gtin, ...p.variants.map((x) => x.gtin), ...p.offers.map((o) => o.gtin)]) {
          if (g) barcodes.set(g, [...(barcodes.get(g) ?? []), `${s.id}/html`]);
        }
      }
    }
  }
  if (ebay?.item?.gtin) barcodes.set(ebay.item.gtin, [...(barcodes.get(ebay.item.gtin) ?? []), "ebay/api"]);
  const shared = [...barcodes.entries()].filter(([, where]) => new Set(where.map((w) => w.split("/")[0])).size > 1);
  console.log(`\n${B}Identity${X}: ${barcodes.size} distinct barcodes seen; ${shared.length} shared across stores${shared.length ? ` (${shared.slice(0, 5).map(([b, w]) => `${b}: ${[...new Set(w)].join(", ")}`).join(" | ")})` : ""}`);

  const out = {
    probe: {
      startedAt: started.toISOString(),
      finishedAt: new Date().toISOString(),
      userAgent: userAgent(),
      node: process.version,
      ucpProfileSet: !!process.env.UCP_AGENT_PROFILE_URL,
      ebayConfigured: !!process.env.EBAY_CLIENT_ID,
      requestCount: stores.reduce((n, s) => n + 1 + s.channels.reduce((m, c) => m + c.requests.length, 0), 0),
    },
    stores,
    ebay,
    identity: { distinctBarcodes: barcodes.size, sharedAcrossStores: shared },
  };
  mkdirSync(resolve("docs"), { recursive: true });
  writeFileSync(resolve("docs/probe-results.json"), JSON.stringify(out, null, 2));
  console.log(`\n${D}${out.probe.requestCount} requests · results written to docs/probe-results.json${X}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
