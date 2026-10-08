/* ------------------------------------------------------------------ */
/*  Discovery / indexing (offline, in the worker)                      */
/*                                                                     */
/*  Builds the listings index so a search needs zero external requests */
/*  to know where a product is sold:                                    */
/*    • sitemaps of stores whose storefront we may read (robots-        */
/*      advertised, read through the PoliteFetcher), indexed from the   */
/*      sitemap's own titles, then enriched from product JSON within a   */
/*      per-run budget: new URLs first, then the stalest. Shopify's      */
/*      <lastmod> is the same for every product (P5 finding), so it is   */
/*      stored but not trusted as a change signal.                       */
/*    • UCP catalog search for stores that only allow their agent        */
/*      channel (needs our published agent profile)                      */
/*    • optional Tavily discovery (flag discovery.tavily): listing URLs  */
/*      on registry domains only, never prices                           */
/* ------------------------------------------------------------------ */

import { ADAPTERS } from "../adapters";
import { canonicalUrl } from "../adapters/base";
import { flagOn } from "../flags";
import { observeOffer } from "../observe";
import type { EngineRuntime } from "../recorder";
import { checkRoutes, sourceForUrl } from "../registry";
import type { CategoryPack, ListingRecord, ParsedQuery, SourceRecord } from "../types";

export type SitemapEntry = {
  loc: string;
  lastmod: string | null;
  title: string | null;
  image: string | null;
};

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

export function parseSitemap(xml: string): {
  kind: "index" | "urlset" | "unknown";
  entries: SitemapEntry[];
} {
  const kind = /<sitemapindex[\s>]/i.test(xml)
    ? "index"
    : /<urlset[\s>]/i.test(xml)
      ? "urlset"
      : "unknown";
  const tag = kind === "index" ? "sitemap" : "url";
  const blocks = xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi")) ?? [];
  const entries = blocks
    .map((b): SitemapEntry | null => {
      const loc = b.match(/<loc>\s*([^<]+?)\s*<\/loc>/i)?.[1];
      if (!loc) return null;
      return {
        loc: decode(loc),
        lastmod: b.match(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/i)?.[1]?.trim() ?? null,
        title: (() => {
          const t = b.match(/<image:title>\s*([\s\S]*?)\s*<\/image:title>/i)?.[1];
          return t ? decode(t.replace(/^<!\[CDATA\[|\]\]>$/g, "")) : null;
        })(),
        image: b.match(/<image:loc>\s*([^<]+?)\s*<\/image:loc>/i)?.[1] ?? null,
      };
    })
    .filter((e): e is SitemapEntry => e !== null);
  return { kind, entries };
}

const isProductSitemap = (url: string) =>
  /sitemap_products_\d+|product[-_]?sitemap|sitemap[-_]?product/i.test(url);
const isProductUrl = (url: string) =>
  /\/products\/[a-z0-9][a-z0-9_-]*\/?$/i.test(new URL(url).pathname);

const LOCALE_PREFIX = /^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/)/i;

/**
 * Stores list every page once per language: /products/x and /fr/products/x
 * are the same product at the same CAD price. Keep one language so the index
 * isn't doubled (it was: 3,096 of 6,263 CLD listings were /fr/ copies) and
 * titles stay comparable. If the store has pages without a language prefix,
 * or under its market prefix (Away's "/en-ca"), only those are kept; if every
 * page carries a prefix (/en/…, /fr/…), one per page is kept, English first.
 */
export function primaryLocale<T>(
  items: T[],
  urlOf: (x: T) => string,
  marketPrefix: string | null,
): T[] {
  const market = marketPrefix?.replace(/^\//, "").toLowerCase() ?? null;
  const parsed = items.flatMap((x) => {
    try {
      const u = new URL(urlOf(x));
      const m = u.pathname.match(LOCALE_PREFIX);
      const prefix = m ? m[1].toLowerCase() : null;
      return [
        { x, prefix, key: u.host + (m ? u.pathname.slice(m[0].length) : u.pathname) + u.search },
      ];
    } catch {
      return [];
    }
  });
  const primary = (p: string | null) => p === null || p === market;
  if (parsed.some((p) => primary(p.prefix)))
    return parsed.filter((p) => primary(p.prefix)).map((p) => p.x);
  const rank = (p: string | null) => (p?.startsWith("en") ? 0 : 1);
  const best = new Map<string, (typeof parsed)[number]>();
  for (const p of parsed) {
    const cur = best.get(p.key);
    if (!cur || rank(p.prefix) < rank(cur.prefix)) best.set(p.key, p);
  }
  return [...best.values()].map((p) => p.x);
}

function titleFromHandle(url: string): string {
  const h = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
  return h.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export type DiscoveryResult = {
  sourceId: string;
  method: "sitemap" | "ucp" | "skipped";
  sitemapUrls: number;
  productUrls: number;
  newListings: number;
  enriched: number;
  deactivated: number;
  requests: number;
  skippedReason: string | null;
  errors: string[];
};

/** Brand/category terms for UCP catalog discovery (agent-channel stores). */
const UCP_TERMS = [
  "luggage",
  "carry-on",
  "checked luggage",
  "spinner",
  "Samsonite",
  "Travelpro",
  "Delsey",
  "Briggs & Riley",
  "Heys",
  "TUMI",
];

export async function discoverSource(
  rt: EngineRuntime,
  pack: CategoryPack,
  sourceId: string,
  opts: { maxFetches?: number; maxUrls?: number; signal?: AbortSignal } = {},
): Promise<DiscoveryResult> {
  const out: DiscoveryResult = {
    sourceId,
    method: "skipped",
    sitemapUrls: 0,
    productUrls: 0,
    newListings: 0,
    enriched: 0,
    deactivated: 0,
    requests: 0,
    skippedReason: null,
    errors: [],
  };
  const source = (await rt.sources()).find((s) => s.id === sourceId);
  if (!source || source.status !== "active" || !source.enabled) {
    out.skippedReason = "unknown or disabled source";
    return out;
  }
  const flags = await rt.flags();
  const routeCtx = { flags, config: rt.config };
  const usable = checkRoutes(source, routeCtx).filter((c) => c.usable);
  const storefront = usable.find(
    (c) =>
      !c.route.crossCheckOnly &&
      (c.route.adapter === "shopify_product_json" || c.route.adapter === "html_structured"),
  );
  const ucp = usable.find((c) => c.route.adapter === "shopify_ucp");

  if (storefront) {
    const adapterId =
      storefront.route.adapter === "html_structured" ? "html_structured" : "shopify_product_json";
    return discoverFromSitemaps(rt, pack, source, adapterId, out, opts);
  }
  if (ucp) return discoverFromUcp(rt, pack, source, out, opts);
  out.skippedReason =
    checkRoutes(source, routeCtx).find(
      (c) => c.route.adapter !== "manual_entry" && c.route.adapter !== "feed_import",
    )?.message ?? "no route permits discovery";
  return out;
}

async function discoverFromSitemaps(
  rt: EngineRuntime,
  pack: CategoryPack,
  source: SourceRecord,
  adapterId: "shopify_product_json" | "html_structured",
  out: DiscoveryResult,
  opts: { maxFetches?: number; maxUrls?: number; signal?: AbortSignal },
): Promise<DiscoveryResult> {
  out.method = "sitemap";
  const maxUrls = opts.maxUrls ?? rt.config.discovery.maxSitemapUrls;
  const maxFetches = opts.maxFetches ?? rt.config.discovery.maxProductFetchesPerStore;
  const roots = source.robots.sitemaps.length
    ? source.robots.sitemaps
    : source.marketHost
      ? [`https://${source.marketHost}/sitemap.xml`]
      : [];

  const entries: SitemapEntry[] = [];
  let complete = true;
  for (const root of roots) {
    if (opts.signal?.aborted) break;
    const res = await rt.fetcher.fetch({
      source,
      url: root,
      adapter: "sitemap",
      maxBytes: 20_000_000,
      signal: opts.signal,
    });
    out.requests++;
    if (res.outcome !== "ok") {
      out.errors.push(`${root}: ${res.outcome}`);
      complete = false;
      continue;
    }
    const parsed = parseSitemap(res.body);
    if (parsed.kind === "urlset") entries.push(...parsed.entries);
    else {
      const children = primaryLocale(
        parsed.entries.map((e) => e.loc).filter(isProductSitemap),
        (u) => u,
        source.marketPathPrefix,
      );
      for (const child of children) {
        if (opts.signal?.aborted || entries.length >= maxUrls) {
          complete = false;
          break;
        }
        const c = await rt.fetcher.fetch({
          source,
          url: child,
          adapter: "sitemap",
          maxBytes: 20_000_000,
          signal: opts.signal,
        });
        out.requests++;
        if (c.outcome !== "ok") {
          out.errors.push(`${child}: ${c.outcome}`);
          complete = false;
          continue;
        }
        entries.push(...parseSitemap(c.body).entries);
      }
    }
  }
  out.sitemapUrls = entries.length;

  // Only this store's own product pages, in one language.
  const products = primaryLocale(
    entries.filter((e) => {
      try {
        return sourceForUrl(e.loc)?.id === source.id && isProductUrl(e.loc);
      } catch {
        return false;
      }
    }),
    (e) => e.loc,
    source.marketPathPrefix,
  ).slice(0, maxUrls);
  out.productUrls = products.length;

  const known = new Map<string, ListingRecord>();
  const variants: ListingRecord[] = [];
  for (const l of await rt.store.listingsBySource(source.id, 100_000)) {
    if (!/^https:/.test(l.url)) continue;
    if (new URL(l.url).search) variants.push(l);
    else known.set(canonicalUrl(l.url), l);
  }

  const fresh: ListingRecord[] = [];
  for (const e of products) {
    const url = canonicalUrl(e.loc);
    const title = e.title ?? titleFromHandle(url);
    const brand = pack.brandOf(title) ?? source.identityQuality.houseBrand ?? null;
    const listing = await rt.store.upsertListing({
      sourceId: source.id,
      url,
      externalId: new URL(url).pathname.split("/").pop() ?? null,
      title,
      brand,
      sizeClass: pack.sizeClassOf(title),
      colour: pack.colourOf(title),
      identifiers: [],
      imageUrl: e.image,
      discoveredVia: "sitemap",
      lastmod:
        e.lastmod && Number.isFinite(Date.parse(e.lastmod))
          ? new Date(e.lastmod).toISOString()
          : null,
      active: true,
    });
    if (!known.has(url)) {
      out.newListings++;
      fresh.push(listing);
    }
    known.delete(url);
  }

  // A full crawl that no longer lists a product page: it's gone from the store.
  if (complete && products.length > 0) {
    for (const gone of known.values()) {
      if (!gone.active) continue;
      await rt.store.upsertListing({ ...gone, active: false });
      out.deactivated++;
    }
    // …and so are the variant listings read from that page.
    for (const v of variants) {
      if (!v.active || !known.has(canonicalUrl(v.url))) continue;
      await rt.store.upsertListing({ ...v, active: false });
      out.deactivated++;
    }
  }

  // Enrich within budget: new pages first, then the stalest without identifiers.
  const enrichQueue = [
    ...fresh,
    ...(await rt.store.listingsBySource(source.id, 100_000))
      .filter(
        (l) =>
          l.active &&
          /^https:/.test(l.url) &&
          !new URL(l.url).search &&
          l.identifiers.length === 0 &&
          !fresh.some((f) => f.id === l.id),
      )
      .sort((a, b) => a.lastSeenAt.localeCompare(b.lastSeenAt)),
  ].slice(0, maxFetches);

  const adapter = ADAPTERS[adapterId];
  for (const l of enrichQueue) {
    if (opts.signal?.aborted) break;
    const ctx = {
      source,
      fetcher: rt.fetcher,
      config: rt.config,
      pack,
      now: Date.now,
      signal: opts.signal,
      sessionId: null,
    };
    const r = await adapter.verify(ctx, {
      url: l.url,
      externalId: l.externalId,
      identifiers: l.identifiers,
      title: l.title,
      brand: l.brand,
    });
    out.requests++;
    if (r.status !== "ok") {
      if (r.status === "blocked") {
        out.errors.push(
          `${source.retailerLabel} refused enrichment (${r.message ?? "blocked"}); stopping this run`,
        );
        break;
      }
      continue;
    }
    for (const o of r.offers) {
      await observeOffer(rt.store, pack, source, o, {
        sessionId: null,
        discoveredVia: "sitemap",
        parent: l,
        persist: true,
        resolve: true,
      });
    }
    // The product page itself now carries what the variants taught us.
    const first = r.offers[0];
    await rt.store.upsertListing({
      ...l,
      title: first.title.replace(/\s+-\s+[^-]{2,30}$/, "") || l.title,
      brand: first.brand ?? l.brand,
      identifiers: r.offers
        .flatMap((o) => o.identifiers.filter((i) => i.kind === "model"))
        .slice(0, 1),
      externalId: first.externalId ?? l.externalId,
      imageUrl: first.imageUrl ?? l.imageUrl,
    });
    out.enriched++;
  }
  await rt.recorder.flush();
  return out;
}

async function discoverFromUcp(
  rt: EngineRuntime,
  pack: CategoryPack,
  source: SourceRecord,
  out: DiscoveryResult,
  opts: { maxFetches?: number; signal?: AbortSignal },
): Promise<DiscoveryResult> {
  out.method = "ucp";
  const search = ADAPTERS.shopify_ucp.search!;
  const budget = Math.min(UCP_TERMS.length, opts.maxFetches ?? UCP_TERMS.length);
  for (const term of UCP_TERMS.slice(0, budget)) {
    if (opts.signal?.aborted) break;
    const ctx = {
      source,
      fetcher: rt.fetcher,
      config: rt.config,
      pack,
      now: Date.now,
      signal: opts.signal,
      sessionId: null,
    };
    const r = await search(ctx, pack.parseQuery(term), 20);
    out.requests++;
    if (r.status === "not_configured") {
      out.method = "skipped";
      out.skippedReason = r.message;
      break;
    }
    if (r.status !== "ok") continue;
    for (const o of r.offers) {
      const before = await rt.store.findListingByUrl(source.id, o.url);
      await observeOffer(rt.store, pack, source, o, {
        sessionId: null,
        discoveredVia: "ucp",
        persist: true,
        resolve: true,
      });
      if (!before) out.newListings++;
      out.enriched++;
    }
  }
  await rt.recorder.flush();
  return out;
}

/** Every source discovery may run on, one after another (each store stays polite). */
export async function discoverAll(
  rt: EngineRuntime,
  pack: CategoryPack,
  opts: { maxFetches?: number; signal?: AbortSignal } = {},
): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  for (const s of await rt.sources()) {
    if (opts.signal?.aborted) break;
    if (s.status !== "active" || !s.enabled) continue;
    results.push(await discoverSource(rt, pack, s.id, opts));
  }
  return results;
}

/**
 * Optional Tavily discovery (flag discovery.tavily, default OFF): when the
 * index knows nothing for a query, ask Tavily for pages on registry stores
 * we may verify, and index their URLs. Prices in Tavily's text are ignored:
 * the session verifies each listing itself. Costs at most 1 credit, under
 * the existing monthly cap.
 */
export async function discoverViaTavily(
  rt: EngineRuntime,
  pack: CategoryPack,
  q: ParsedQuery,
): Promise<number> {
  if (!flagOn(await rt.flags(), "discovery.tavily")) return 0;
  const { tavilyConfigured, tavilySearch } = await import("@/lib/tavily");
  if (!tavilyConfigured()) return 0;
  const routeCtx = { flags: await rt.flags(), config: rt.config };
  const verifiable = (await rt.sources()).filter((s) =>
    checkRoutes(s, routeCtx).some(
      (c) =>
        c.usable &&
        !c.route.crossCheckOnly &&
        (c.route.adapter === "shopify_product_json" ||
          c.route.adapter === "html_structured" ||
          c.route.adapter === "shopify_ucp"),
    ),
  );
  const domains = [...new Set(verifiable.flatMap((s) => s.allowedDomains))];
  if (domains.length === 0) return 0;
  let added = 0;
  try {
    const res = await tavilySearch({
      query: `${q.raw} luggage`,
      maxResults: 10,
      includeDomains: domains,
      includeDomainsMode: "restrict",
      searchDepth: "basic",
      includeRawContent: false,
    });
    for (const r of res.results) {
      const source = sourceForUrl(r.url);
      if (!source || !verifiable.some((v) => v.id === source.id)) continue;
      let url: string;
      try {
        url = canonicalUrl(r.url);
        if (!isProductUrl(url) && !/\/p\/|\.html$/.test(new URL(url).pathname)) continue;
      } catch {
        continue;
      }
      const title = r.title.replace(/\s*[|–-]\s*[^|–-]+$/, "").trim() || titleFromHandle(url);
      const existing = await rt.store.findListingByUrl(source.id, url);
      if (existing) continue;
      await rt.store.upsertListing({
        sourceId: source.id,
        url,
        externalId: null,
        title,
        brand: pack.brandOf(title) ?? source.identityQuality.houseBrand ?? null,
        sizeClass: pack.sizeClassOf(title),
        colour: pack.colourOf(title),
        identifiers: [],
        imageUrl: null,
        discoveredVia: "tavily",
        lastmod: null,
        active: true,
      });
      added++;
    }
  } catch {
    /* discovery is best-effort; the session continues without it */
  }
  return added;
}
