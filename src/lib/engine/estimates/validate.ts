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
import type { Availability, CategoryPack, ParsedQuery, SourceRecord } from "../types";

export const ESTIMATE_VALIDATOR_VERSION = "estimate-validate/2";

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
  /** "out_of_stock" when the result itself says so; otherwise unknown (a snippet can't prove stock). */
  availability: Availability;
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

/** A title the search engine shortened ("… Spinner ..." / "… Spinner …"). */
const TRUNCATED = /(?:\.{3}|…)\s*$/;

/** Size words a text names, each mapped to its class ("21-Inch" → carry-on). */
const SIZE_WORDS: [RegExp, string][] = [
  [/\bcarry[-\s]?on\b|\bcarryon\b|\bcabin\b/i, "carry_on"],
  [/\bextra[-\s]?large\b|\bx-?large\b/i, "extra_large"],
  [/\b(?<!extra[-\s]?)(?<!x-?)large\b/i, "large"],
  [/\bmedium\b/i, "medium"],
];

/** The one size class a text names, or null when it names none or several. */
function onlySize(text: string, pack: CategoryPack): string | null {
  const found = new Set<string>();
  for (const [re, cls] of SIZE_WORDS) if (re.test(text)) found.add(cls);
  const inches = pack.inchesOf(text);
  if (inches) {
    const byInches = pack.sizeClassOf(`${inches}-inch`);
    if (byInches) found.add(byInches);
  }
  return found.size === 1 ? [...found][0] : null;
}

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
  // Cleaning a title like "TUMI - 19 Degree Lite …" can take the brand for a site
  // name, so the result's full title counts too.
  const brand =
    pack.brandOf(title) ?? pack.brandOf(cand.title) ?? source.identityQuality.houseBrand ?? null;
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
  // A search engine cuts long titles ("Travelpro Platinum Elite … Spinner ..."): then
  // the size may come from the snippet, but only when it names exactly one size.
  const size = pack.sizeClassOf(title) ?? (TRUNCATED.test(cand.title) ? onlySize(cand.snippet, pack) : null);
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

  // Stated inches: 28" and 31" are different bags (a shortened title's snippet counts).
  const inches =
    pack.inchesOf(title) ?? (TRUNCATED.test(cand.title) ? pack.inchesOf(cand.snippet) : null);
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

/* ── condition and stock, as the result states them ───────────────── */

/** A used, renewed or open-box item is not the new bag a customer compares (Amazon Renewed, eBay Pre-Owned). */
const NOT_NEW =
  /\b(?:pre[- ]?owned|refurbished|renewed|reconditioned|open[- ]box|second[- ]hand|used\s*[-–:]\s*(?:like new|very good|good|acceptable)|condition\s*:\s*used)\b|\(used\)/i;
/** A title that starts with "Used" ("Used Samsonite …"); in a snippet that's just a word. */
const USED_TITLE = /^\s*used\b/i;

/** The store no longer sells it: its old price is not a price anyone can pay. */
const DISCONTINUED = /\b(?:discontinued|no longer (?:available|sold|carried|offered))\b/i;

/** The result says it can't be bought right now (kept, shown as out of stock). */
const OUT_OF_STOCK =
  /\b(?:out of stock|sold out|currently unavailable|temporarily unavailable|not available online|épuisé|en rupture de stock)\b/i;

/** Reasons the item itself isn't the new, on-sale product, from its title and snippet. */
export function conditionReasons(title: string, snippet: string): string[] {
  const reasons: string[] = [];
  if (NOT_NEW.test(title) || USED_TITLE.test(title) || NOT_NEW.test(snippet))
    reasons.push("a used or refurbished item");
  if (DISCONTINUED.test(title) || DISCONTINUED.test(snippet))
    reasons.push("the store no longer sells it");
  return reasons;
}

/** Stock as the result states it: only "out of stock" can be read from a snippet. */
export function availabilityFromResult(title: string, snippet: string): Availability {
  return OUT_OF_STOCK.test(`${title} ${snippet}`) ? "out_of_stock" : "unknown";
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

/** An instalment written after its amount ("$166.50 every month for 6"). */
// (no \b after the period: snippets run words together, "every monthfor 6")
const INSTALMENT_AFTER = /^\s*(?:every\s+(?:month|week|two weeks|2 weeks|other week)|bi-?weekly)/i;
/** Another currency before the amount ("US $518.75", "EUR 32.36", "£40"). */
const FOREIGN_BEFORE = /(?:\b(?:US|USD|EUR|GBP|AUD|AU|HK|NZ)\s*|[€£¥]\s*)$/i;
/** A converted amount ("Approx. C $743.21"): the seller's price is in another currency. */
const CONVERTED_BEFORE = /\bapprox(?:\.|imately)?\s*(?:C\s*|CA\s*)?$/i;
/** "Regular price" on its own: the price, when the result shows no sale at all (Shopify). */
const REGULAR_BEFORE = /\bregular price\s*[:\-–]?\s*$/i;
const SALE_WORDS = /\b(?:sale|now|special|clearance|save|was|compare at)\b/i;

/**
 * The selling price written in the result, or why there isn't one we can
 * trust. Needs "$", "C$" or "CAD"; skips "from", "save", "was", ranges,
 * monthly payments and instalments, other currencies and converted amounts;
 * refuses a result that shows more than one price. A lone "Regular price $X"
 * is the price when nothing in the result speaks of a sale.
 */
export function readEstimatePrice(title: string, snippet: string): PriceRead {
  // "C $895.44" (eBay) is "C$895.44": joined, so the word before it ("Was") is seen.
  const text = `${title}\n${snippet}`
    .replace(/\s+/g, " ")
    .replace(/\b(CA?)\s+\$/g, (_m, c: string) => `${c}$`);
  const kept: { value: number; index: number; end: number }[] = [];
  const regular: { value: number; index: number; end: number }[] = [];
  for (const c of findPriceCandidates(text)) {
    if (c.usd) continue;
    const before = text.slice(Math.max(0, c.index - 40), c.index);
    const after = text.slice(c.end, c.end + 30);
    if (FOREIGN_BEFORE.test(before) || CONVERTED_BEFORE.test(before)) continue;
    if (NEGATIVE_AFTER.test(after) || INSTALMENT_AFTER.test(after)) continue;
    if (REGULAR_BEFORE.test(before)) {
      regular.push(c);
      continue;
    }
    if (NEGATIVE_BEFORE.test(before) || WEAK_BEFORE.test(before)) continue;
    kept.push(c);
  }
  if (kept.length === 0 && regular.length > 0 && !SALE_WORDS.test(text)) kept.push(...regular);
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
    // Only the tile's own name speaks for it: the snippet also describes other tiles.
    return {
      price: tile.price,
      excerpt: tile.excerpt,
      reasons: conditionReasons(tile.name, ""),
      tile: tile.name,
    };
  }
  if (page) reasons.push(page);
  reasons.push(...identityReasons(cand, source, expected, pack));
  reasons.push(...conditionReasons(productTitle(cand.title), cand.snippet));
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
    // A tile's stock can't be told from a snippet that lists several products.
    const availability = s.tile
      ? ("unknown" as const)
      : availabilityFromResult(s.candidate.title, s.candidate.snippet);
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
          availability,
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
            availability,
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
            availability,
          },
    };
  });
}
