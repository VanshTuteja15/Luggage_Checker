/* ------------------------------------------------------------------ */
/*  Web estimates: the rules a search result must pass (R3.2)          */
/*                                                                     */
/*  An estimate is a price read from a web search result (title and    */
/*  snippet) for a store's own product page. We never open that page.  */
/*  E1 (a $150 Paralux "Large" that was really the Medium's page) and   */
/*  E2 (domino sets and pigeon rings for "Aluminum Carry-On") proved    */
/*  raw results unsafe, so every rule below must hold:                 */
/*                                                                     */
/*   a. the URL is a PRODUCT page on the store's own registry domain;  */
/*   b. identity: brand, product line, size class, stated inches and    */
/*      version agree; a barcode in the snippet must equal ours;        */
/*   c. one clear selling price with "$"/CAD (not "from", a range, a   */
/*      monthly payment, "save $X" or a model number);                  */
/*   d. plausible next to verified prices (0.6×–1.5×), else next to    */
/*      ≥ 2 other estimates, else inside the category band and marked   */
/*      "single source";                                                 */
/*   e. not an accessory when the search is for a bag.                  */
/*                                                                     */
/*  One exception to a: a brand's own store (Samsonite.ca for a         */
/*  Samsonite) often shows up only as a collection page. Its snippet    */
/*  counts when one tile names exactly our product with its own "$"     */
/*  price right after the name (readListingTile).                       */
/*                                                                     */
/*  Pure: no network, no database. Category knowledge comes from the   */
/*  pack; store knowledge from the registry record.                    */
/* ------------------------------------------------------------------ */

import {
  cleanPageTitle,
  extractListingTiles,
  findPriceCandidates,
  isAccessoryTitle,
  isHomePage,
  looksLikeListingTitle,
  looksLikeListingUrl,
  looksLikeProductUrl,
  NEGATIVE_AFTER,
  NEGATIVE_BEFORE,
  WEAK_BEFORE,
} from "@/lib/search/extract";
import { normaliseGtin } from "../adapters/base";
import { normaliseHost } from "../registry";
import type { CategoryPack, ParsedQuery, SourceRecord } from "../types";

export const ESTIMATE_VALIDATOR_VERSION = "estimate-validate/1";

/** Ratio band around a reference price (R3.2 d). */
export const RATIO_MIN = 0.6;
export const RATIO_MAX = 1.5;

export type EstimateCandidate = {
  sourceId: string;
  url: string;
  title: string;
  snippet: string;
  /** The search that found it. */
  query: string;
  foundAt: string;
};

/** What the estimate must be: from a search query or a tracked product. */
export type ExpectedProduct = {
  brand: string | null;
  line: string[];
  sizeClass: string | null;
  inches: number | null;
  gtin: string | null;
};

/** A price we stand behind for the same brand + line (any size), for rule d. */
export type ReferencePrice = { price: number; sizeClass: string | null; inches: number | null };

export type EstimateVerdict = {
  outcome: "accepted" | "rejected";
  price: number | null;
  /** Plain reasons; for an accepted estimate, notes such as "single source". */
  reasons: string[];
  singleSource: boolean;
  /** The snippet text around the price (≤ 300 chars), kept as evidence. */
  excerpt: string;
  /** The tile's name when the price was read from a brand store's listing page. */
  tile: string | null;
};

const SIZE_ORDER: Record<string, number> = {
  carry_on: 1,
  medium: 2,
  large: 3,
  extra_large: 4,
};

const VERSION = /^\d+(?:\.\d+)?$/;

export function expectedFromQuery(q: ParsedQuery): ExpectedProduct {
  return {
    brand: q.brand,
    line: q.line,
    sizeClass: q.sizeClass,
    inches: q.inches,
    gtin: q.gtin ? normaliseGtin(q.gtin) : null,
  };
}

export function expectedFromTracked(
  item: { name: string; brand: string; model?: string; upc: string | null },
  pack: CategoryPack,
): ExpectedProduct {
  const text = `${item.brand} ${item.name}`;
  const brand = pack.brandOf(text) ?? (item.brand || null);
  return {
    brand,
    line: pack.lineOf(item.name, brand),
    sizeClass: pack.sizeClassOf(item.name),
    inches: pack.inchesOf(item.name),
    gtin: item.upc ? normaliseGtin(item.upc) : null,
  };
}

/** The title without a trailing "| Store Name" or " - Store" part. */
function productTitle(title: string): string {
  return cleanPageTitle(title).name || title;
}

/* ── a. the store's own product page ──────────────────────────────── */

/** Store-specific product-page shapes, for stores whose URLs are well known. */
const PRODUCT_PAGE: Record<string, RegExp> = {
  "amazon-ca": /\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:[/?#]|$)/,
  "walmart-ca": /\/ip\//,
  "bestbuy-ca": /\/product\//,
  "costco-ca": /\.product\.\d+\.html/,
  canadiantire: /\/pdp\//,
  "ebay-ca": /\/itm\//,
};

/** A secure page on the store's own registry domain, other than its home page. */
export function onStoreSite(source: SourceRecord, url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a web address";
  }
  if (u.protocol !== "https:") return "not a secure store page";
  const host = normaliseHost(u.hostname);
  if (!source.allowedDomains.some((d) => normaliseHost(d) === host))
    return "not on the store's own website";
  if (isHomePage(url)) return "the store's home page, not a product";
  return null;
}

export function isProductPage(source: SourceRecord, url: string): string | null {
  const site = onStoreSite(source, url);
  if (site) return site;
  const u = new URL(url);
  const specific = PRODUCT_PAGE[source.id];
  if (specific) return specific.test(url) ? null : "not a product page";
  if (/shopify/i.test(source.platform) && !/\/products\/[^/?#]+/.test(u.pathname))
    return "not a product page";
  if (looksLikeListingUrl(url) || !looksLikeProductUrl(url))
    return "a search, category or listing page";
  return null;
}

/* ── b + e. identity ──────────────────────────────────────────────── */

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9.']+/)
      .map((t) => t.replace(/^\.+|\.+$/g, ""))
      .filter(Boolean),
  );
}

const GTIN_IN_TEXT = /\b(\d{12,14})\b/g;

export function identityReasons(
  cand: EstimateCandidate,
  source: SourceRecord,
  expected: ExpectedProduct,
  pack: CategoryPack,
): string[] {
  const reasons: string[] = [];
  const title = productTitle(cand.title);
  const wantsBag = expected.sizeClass !== "accessory";

  // e. A cover, tag or lock is never the bag.
  if (wantsBag && (isAccessoryTitle(title) || pack.isAccessory(title)))
    reasons.push("an accessory, not the bag");
  if (looksLikeListingTitle(title)) reasons.push("a list of products, not one product");

  // Brand: named in the title, or the store's own brand (brand-direct stores).
  const brand = pack.brandOf(title) ?? source.identityQuality.houseBrand ?? null;
  if (expected.brand) {
    if (!brand) reasons.push("brand not named");
    else if (brand.toLowerCase() !== expected.brand.toLowerCase())
      reasons.push("a different brand");
  }

  // Product line: every word of ours must be there (optional words aside).
  const have = words(`${title} ${pack.lineOf(title, brand).join(" ")}`);
  const missing = expected.line.filter(
    (w) => !pack.optionalLineWords.has(w) && !have.has(w.toLowerCase()),
  );
  if (missing.length) reasons.push(`different product line (no "${missing.join(" ")}")`);

  // Versions must agree: Omni 2 is not Omni 3.0.
  const ourVersions = expected.line.filter((w) => VERSION.test(w));
  const theirVersions = pack.lineOf(title, brand).filter((w) => VERSION.test(w));
  if (
    ourVersions.length + theirVersions.length > 0 &&
    (ourVersions.some((v) => !theirVersions.includes(v)) ||
      theirVersions.some((v) => !ourVersions.includes(v)))
  )
    reasons.push("a different version");

  // Size class: stated and the same. The snippet must not describe another size only.
  const size = pack.sizeClassOf(title);
  if (expected.sizeClass) {
    if (!size) reasons.push("size not stated");
    else if (size !== expected.sizeClass) reasons.push("a different size");
    else {
      const snippetSize = pack.sizeClassOf(cand.snippet);
      const snippetHasOurs = words(cand.snippet).has(
        expected.sizeClass.replace("_", "-").split("-")[0],
      );
      if (snippetSize && snippetSize !== size && !snippetHasOurs)
        reasons.push("size mismatch: the text describes another size");
    }
  }

  // Stated inches: 28" and 31" are different bags.
  const inches = pack.inchesOf(title);
  if (expected.inches && inches && inches !== expected.inches)
    reasons.push("a different stated size");

  // A barcode in the result must be ours.
  const ours = expected.gtin ? normaliseGtin(expected.gtin) : null;
  if (ours) {
    const codes = [...`${cand.title} ${cand.snippet}`.matchAll(GTIN_IN_TEXT)].map((m) =>
      normaliseGtin(m[1]),
    );
    if (codes.length && !codes.includes(ours)) reasons.push("a different barcode");
  }
  return reasons;
}

/* ── a brand store's listing page ─────────────────────────────────── */

/** The store is the brand's own (Samsonite.ca for Samsonite). */
export function isHouseBrandStore(source: SourceRecord, brand: string | null): boolean {
  const house = source.identityQuality.houseBrand;
  return !!brand && !!house && house.toLowerCase() === brand.toLowerCase();
}

/** The brand's own store among these, if there is one. */
export function houseBrandStore(
  brand: string | null,
  sources: SourceRecord[],
): SourceRecord | null {
  return sources.find((s) => isHouseBrandStore(s, brand)) ?? null;
}

/** Another amount right after a tile's price ("C$ 529.95 C$ 449.95"): which one is it? */
const SECOND_AMOUNT =
  /^\s*(?:CAD\b)?[\s.,·•|:–—-]*(?:(?:sale|now|special)\s*(?:price)?\s*[:\-–]?\s*)?(?:CA\$|C\$|CAD\s?\$?|\$)\s?\d/i;

function lineSet(words: string[], pack: CategoryPack): Set<string> {
  return new Set(words.map((w) => w.toLowerCase()).filter((w) => !pack.optionalLineWords.has(w)));
}

export type TileRead = { name: string; price: number; excerpt: string } | { reason: string };

/**
 * Our product's price from a listing page's snippet. Only a tile whose
 * name is exactly our product counts: brand (or the store's own), the same
 * line words and no others (Outline is not Outline Pro), the same size
 * class and stated inches if any, with a "$" amount right after the name.
 * Two such tiles at different prices, or a second amount right after the
 * price, are refused: we can't tell which one is the bag.
 */
export function readListingTile(
  cand: EstimateCandidate,
  source: SourceRecord,
  expected: ExpectedProduct,
  pack: CategoryPack,
): TileRead {
  const ours = lineSet(expected.line, pack);
  if (!expected.brand || !expected.sizeClass || ours.size === 0)
    return { reason: "the search doesn't name one exact product" };
  const exact: { name: string; price: number; excerpt: string }[] = [];
  let doubled = false;
  for (const t of extractListingTiles(cand.snippet, [...ours].join(" "))) {
    if (!t.amount.includes("$") || WEAK_BEFORE.test(t.name)) continue;
    const tileCand = { ...cand, title: t.name, snippet: `${t.name} ${t.amount}` };
    if (identityReasons(tileCand, source, expected, pack).length) continue;
    const brand = pack.brandOf(t.name) ?? source.identityQuality.houseBrand ?? null;
    const theirs = lineSet(pack.lineOf(t.name, brand), pack);
    if (theirs.size !== ours.size || [...ours].some((w) => !theirs.has(w))) continue;
    if (SECOND_AMOUNT.test(cand.snippet.slice(t.end, t.end + 40))) doubled = true;
    exact.push({ name: t.name, price: t.price, excerpt: t.evidence.slice(0, 300) });
  }
  if (exact.length === 0) return { reason: "no tile for this exact product with its own price" };
  if (doubled || new Set(exact.map((t) => t.price)).size > 1)
    return { reason: "more than one price for this product on the listing page" };
  return exact[0];
}

/* ── c. one clear selling price ───────────────────────────────────── */

export type PriceRead = { price: number; excerpt: string } | { reason: string };

/**
 * The selling price written in the result, or why there isn't one we can
 * trust. Needs "$", "C$" or "CAD"; skips "from", "save", "was", ranges and
 * monthly payments; refuses a result that shows more than one price.
 */
export function readEstimatePrice(title: string, snippet: string): PriceRead {
  const text = `${title}\n${snippet}`.replace(/\s+/g, " ");
  const kept: { value: number; index: number; end: number }[] = [];
  for (const c of findPriceCandidates(text)) {
    if (c.usd) continue;
    const before = text.slice(Math.max(0, c.index - 40), c.index);
    const after = text.slice(c.end, c.end + 30);
    if (NEGATIVE_BEFORE.test(before) || WEAK_BEFORE.test(before) || NEGATIVE_AFTER.test(after))
      continue;
    kept.push(c);
  }
  const values = [...new Set(kept.map((c) => Math.round(c.value * 100) / 100))];
  if (values.length === 0) return { reason: "no clear price in the search result" };
  if (values.length > 1) return { reason: "more than one price in the search result" };
  const c = kept[0];
  const from = Math.max(0, c.index - 150);
  const to = Math.min(text.length, c.end + 140);
  return { price: values[0], excerpt: text.slice(from, to).trim().slice(0, 300) };
}

/* ── d. plausibility ──────────────────────────────────────────────── */

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function sameSize(r: ReferencePrice, e: ExpectedProduct): boolean {
  if (!e.sizeClass || r.sizeClass !== e.sizeClass) return false;
  return !e.inches || !r.inches || r.inches === e.inches;
}

/**
 * Rule d. `references` are prices we stand behind for the same brand and
 * line (verified, staff-checked or dealer list); `peers` are the other
 * candidate estimates for the same product from other stores.
 */
export function plausibility(
  price: number,
  expected: ExpectedProduct,
  references: ReferencePrice[],
  peers: number[],
  pack: CategoryPack,
): { reason: string | null; singleSource: boolean } {
  const same = references.filter((r) => sameSize(r, expected)).map((r) => r.price);
  if (same.length) {
    const m = median(same);
    if (price < RATIO_MIN * m || price > RATIO_MAX * m)
      return { reason: `too far from the verified price ($${m.toFixed(2)})`, singleSource: false };
    return { reason: null, singleSource: false };
  }
  // A bigger size can't cost much less than a smaller size of the same bag (E1).
  const ours = expected.sizeClass ? SIZE_ORDER[expected.sizeClass] : undefined;
  if (ours) {
    for (const r of references) {
      const theirs = r.sizeClass ? SIZE_ORDER[r.sizeClass] : undefined;
      if (!theirs || theirs === ours) continue;
      if (theirs < ours && price < RATIO_MIN * r.price)
        return {
          reason: `cheaper than the smaller size's verified price ($${r.price.toFixed(2)})`,
          singleSource: false,
        };
      if (theirs > ours && price > RATIO_MAX * r.price)
        return {
          reason: `dearer than the larger size's verified price ($${r.price.toFixed(2)})`,
          singleSource: false,
        };
    }
  }
  const all = [price, ...peers];
  if (all.length >= 2) {
    const m = median(all);
    if (price < RATIO_MIN * m || price > RATIO_MAX * m)
      return { reason: "too far from the other stores' estimates", singleSource: false };
    return { reason: null, singleSource: false };
  }
  if (price < pack.priceBand.min || price > pack.priceBand.max)
    return { reason: "outside the usual price range for luggage", singleSource: true };
  return { reason: null, singleSource: true };
}

/* ── all rules ────────────────────────────────────────────────────── */

export type ScreenedEstimate = {
  price: number | null;
  excerpt: string;
  reasons: string[];
  /** Set when the price came from a tile on the brand store's listing page. */
  tile: string | null;
};

/** Rules a, b, c, e for one result; rule d needs the other results too. */
export function screenEstimate(
  cand: EstimateCandidate,
  source: SourceRecord,
  expected: ExpectedProduct,
  pack: CategoryPack,
): ScreenedEstimate {
  const reasons: string[] = [];
  const page = isProductPage(source, cand.url);
  // The brand's own store, on a listing page: its exact tile or nothing.
  if (page && !onStoreSite(source, cand.url) && isHouseBrandStore(source, expected.brand)) {
    const tile = readListingTile(cand, source, expected, pack);
    if ("reason" in tile)
      return {
        price: null,
        excerpt: cand.snippet.slice(0, 300),
        reasons: [page, tile.reason],
        tile: null,
      };
    return { price: tile.price, excerpt: tile.excerpt, reasons: [], tile: tile.name };
  }
  if (page) reasons.push(page);
  reasons.push(...identityReasons(cand, source, expected, pack));
  const read = readEstimatePrice(productTitle(cand.title), cand.snippet);
  if ("reason" in read) {
    reasons.push(read.reason);
    return { price: null, excerpt: cand.snippet.slice(0, 300), reasons, tile: null };
  }
  return { price: read.price, excerpt: read.excerpt, reasons, tile: null };
}

/** Passes every rule that doesn't need the other results (all but d). */
export function passesScreen(
  cand: EstimateCandidate,
  source: SourceRecord,
  expected: ExpectedProduct,
  pack: CategoryPack,
): boolean {
  const s = screenEstimate(cand, source, expected, pack);
  return s.reasons.length === 0 && s.price !== null;
}

/**
 * Validate a batch of results for one product: screen each, then judge the
 * survivors' prices against the references and against each other (one
 * estimate per store; the store's own result list may repeat).
 */
export function validateEstimates(
  candidates: EstimateCandidate[],
  sources: Map<string, SourceRecord>,
  expected: ExpectedProduct,
  references: ReferencePrice[],
  pack: CategoryPack,
): { candidate: EstimateCandidate; verdict: EstimateVerdict }[] {
  const screened = candidates.map((candidate) => {
    const source = sources.get(candidate.sourceId);
    const s: ScreenedEstimate = source
      ? screenEstimate(candidate, source, expected, pack)
      : { price: null, excerpt: "", reasons: ["not a store we know"], tile: null };
    return { candidate, ...s };
  });
  const survivors = screened.filter((s) => s.reasons.length === 0 && s.price !== null);

  return screened.map((s) => {
    if (s.reasons.length || s.price === null) {
      return {
        candidate: s.candidate,
        verdict: {
          outcome: "rejected" as const,
          price: s.price,
          reasons: s.reasons,
          singleSource: false,
          excerpt: s.excerpt,
          tile: s.tile,
        },
      };
    }
    // Peers: other stores' surviving prices (one per store).
    const peerByStore = new Map<string, number>();
    for (const o of survivors)
      if (o.candidate.sourceId !== s.candidate.sourceId && !peerByStore.has(o.candidate.sourceId))
        peerByStore.set(o.candidate.sourceId, o.price as number);
    const p = plausibility(s.price, expected, references, [...peerByStore.values()], pack);
    return {
      candidate: s.candidate,
      verdict: p.reason
        ? {
            outcome: "rejected" as const,
            price: s.price,
            reasons: [p.reason],
            singleSource: false,
            excerpt: s.excerpt,
            tile: s.tile,
          }
        : {
            outcome: "accepted" as const,
            price: s.price,
            reasons: [
              ...(p.singleSource ? ["single source"] : []),
              ...(s.tile ? ["read from the store's listing page"] : []),
            ],
            singleSource: p.singleSource,
            excerpt: s.excerpt,
            tile: s.tile,
          },
    };
  });
}
