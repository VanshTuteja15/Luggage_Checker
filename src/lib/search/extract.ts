/* ------------------------------------------------------------------ */
/*  Reading prices and specs out of retailer pages                    */
/*                                                                     */
/*  Web research returns pages, not prices. A product page shows its   */
/*  price — but also a list price, a "save $70", "$20/mo with Affirm", */
/*  "free shipping on orders over $75", and a row of other products'   */
/*  prices under "Customers also viewed". Picking the wrong one is     */
/*  worse than picking none: a wrong price on a price-tracking tool    */
/*  is a fake result.                                                 */
/*                                                                     */
/*  So this is deliberately conservative:                             */
/*    • a price must appear literally in the page text, and the exact  */
/*      words around it are kept as evidence                           */
/*    • amounts in "was / list / save / per month / orders over / USD" */
/*      contexts are rejected outright                                */
/*    • candidates after "related products" style sections are ignored */
/*    • search and category pages (many prices, no product) are skipped */
/*    • when nothing clears the bar, the answer is "no price", never a  */
/*      guess                                                         */
/*                                                                     */
/*  No LLM is involved. Every function here is pure and deterministic. */
/* ------------------------------------------------------------------ */

import {
  RETAILER_INFO,
  hostOf,
  isCanadianStorefront,
  isMerchantUrl,
  matchRetailer,
} from "@/lib/retailers";
import type { LuggageDetails, Offer } from "./types";

/** Plausible single-item luggage prices in CAD. Outside this, we don't believe it. */
export const MIN_PLAUSIBLE_PRICE = 15;
export const MAX_PLAUSIBLE_PRICE = 6_000;

/** How much page text we'll examine. Past this it's footers and recommendations. */
const MAX_TEXT = 60_000;

/* ------------------------------------------------------------------ */
/*  Titles                                                            */
/* ------------------------------------------------------------------ */

/**
 * Split a page title into the product name and the site name.
 *   "Samsonite Winfield 2 28" Spinner | Walmart Canada"
 *     → { name: "Samsonite Winfield 2 28" Spinner", site: "Walmart Canada" }
 *   "Samsonite Freeform … : Amazon.ca: Luggage & Bags"
 *     → { name: "Samsonite Freeform …", site: "Amazon.ca" }
 */
export function cleanPageTitle(title: string): { name: string; site: string | null } {
  const raw = (title ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { name: "", site: null };

  const parts = raw
    .split(/\s+[|–—]\s+|\s+-\s+|\s+:\s+|:\s+(?=Amazon)/)
    .map((p) => p.trim())
    .filter(Boolean);

  let name = parts[0] ?? raw;
  if (name.length < 8 && parts[1]) name = parts[1];

  // Amazon: "Amazon.ca: Samsonite Freeform …" puts the site first.
  const amazonFirst = name.match(/^Amazon\.(?:ca|com)\s*:\s*(.+)$/i);
  if (amazonFirst) name = amazonFirst[1];

  // Store names come last ("… | Walmart Canada", "… - Bagages Mira").
  let site: string | null = null;
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/[a-z]/i.test(last) && last.length <= 40) site = last;
  }

  // Search engines cut long titles: "… with Double ..." — drop the ellipsis.
  name = name.replace(/\s*(?:\.{3,}|…)\s*$/, "");
  return { name: name.replace(/\s{2,}/g, " ").trim(), site };
}

/* ------------------------------------------------------------------ */
/*  Page type                                                         */
/* ------------------------------------------------------------------ */

const PRODUCT_URL =
  /\/dp\/|\/gp\/product\/|\/ip\/|\/products?\/|\/pdp\/|\/p\/|\.product\.|\/item\/|\/itm\/|\/sku\/|-p-\d|\/\d{6,}(?:[/?#.]|$)|\.html(?:[?#]|$)/i;

const LISTING_URL =
  /\/b\/|\/sch\/|\/search\b|[?&](?:q|query|k|keyword|keywords|text|searchterm)=|\/s\?|\/browse\/|\/category\/|\/categories\/|\/c\/[^/]+\/?$|\/collections\/[^/]+\/?(?:[?#]|$)|\/brands?\/[^/]*\/?$|\/blog\/|\/reviews?\/|\/compare\/|\/deals\/?$|\/sale\/?$/i;

/** True when the URL shape says "one product". */
export function looksLikeProductUrl(url: string): boolean {
  return PRODUCT_URL.test(url) && !LISTING_URL.test(url);
}

/** True when the URL shape says "search results, a category, a blog…". */
export function looksLikeListingUrl(url: string): boolean {
  return LISTING_URL.test(url) && !/\/products?\/[^/]+/i.test(url);
}

/** A site's home page (samsonite.ca, samsonite.ca/en/) — never one product. */
export function isHomePage(url: string): boolean {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    return path === "" || /^\/(?:en|fr|en-ca|fr-ca|ca)$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Page titles that announce a list rather than a product: "… Collection",
 * "… for sale", "Best … 2023", "Luggage Sets", "Shop all …".
 */
const LISTING_TITLE =
  /\bcollection\b|\bfor sale\b|\bbest\b[^|]*\b20\d\d\b|\bsets\s*(?:$|\|)|\bshop all\b|\bcategory\b|\bdeals? on\b/i;

export function looksLikeListingTitle(title: string): boolean {
  return LISTING_TITLE.test(title);
}

/* ------------------------------------------------------------------ */
/*  Prices                                                            */
/* ------------------------------------------------------------------ */

type Candidate = {
  value: number;
  index: number;
  end: number;
  usd: boolean;
};

/** Leading-symbol amounts: $229.99, CA$ 229.99, CAD $1,129.00, US$99. */
const LEADING = /(CA\$|C\$|CAD\s?\$?|US\$|USD\s?\$?|\$)\s?((?:\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.\d{1,2})?)(?![\d])/g;
/** Trailing-code amounts: 229.99 CAD, 1,129.00 USD. */
const TRAILING = /((?:\d{1,3}(?:,\d{3})+|\d{1,6})\.\d{2})\s?(CAD|USD)\b/g;
/** French-Canadian amounts: 129,99 $ and 1 299,99 $. */
const FRENCH = /((?:\d{1,3}(?:[   ]\d{3})+|\d{1,6}),(\d{2}))\s?\$/g;

function toNumber(s: string): number {
  return Number.parseFloat(s.replace(/,/g, ""));
}

/** Every money amount in the text, left to right, overlaps removed. */
export function findPriceCandidates(text: string): Candidate[] {
  const found: Candidate[] = [];

  for (const m of text.matchAll(LEADING)) {
    const symbol = m[1].toUpperCase();
    found.push({
      value: toNumber(m[2]),
      index: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      usd: symbol.startsWith("US"),
    });
  }
  for (const m of text.matchAll(TRAILING)) {
    found.push({
      value: toNumber(m[1]),
      index: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      usd: m[2].toUpperCase() === "USD",
    });
  }
  for (const m of text.matchAll(FRENCH)) {
    const whole = m[1].replace(/[   ]/g, "").replace(",", ".");
    found.push({
      value: Number.parseFloat(whole),
      index: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      usd: false,
    });
  }

  found.sort((a, b) => a.index - b.index);

  // Drop matches that overlap an earlier one (e.g. "CA$229.99" also
  // matching as "$229.99").
  const result: Candidate[] = [];
  for (const c of found) {
    const prev = result[result.length - 1];
    if (prev && c.index < prev.end) continue;
    result.push(c);
  }
  return result.filter((c) => Number.isFinite(c.value));
}

/** Words right before an amount that mean "this isn't the selling price". */
const NEGATIVE_BEFORE =
  /(?:\bto|\d\s*[-–—]|save|you save|savings|off|reg\.?|regular(?: price)?|was|compare at|compared at|list price|list|original price|msrp|orders?(?: of| over)?|spend|over|shipping|delivery|gift card|coupon|rebate|reward|points|deposit|as low as|up to|payments? of|installments? of|valued at|value|économisez|prix courant|prix régulier|avant)\s*[:\-–]?\s*$/i;

/** Words right after an amount that mean the same. */
const NEGATIVE_AFTER =
  /^\s*(?:(?:to|[-–—])\s*(?:CA\$|C\$|CAD|\$)\s?\d|\/\s*(?:mo|month|wk|week|yr)\b|per\s+(?:mo|month|week|year)\b|a\s+month\b|monthly\b|x\s*\d|×\s*\d|off\b|savings?\b|discount\b|or more\b|and up\b|\+|\/mois\b|par mois\b|de rabais\b)/i;

/** Words right before an amount that mean "this IS the selling price". */
const POSITIVE_BEFORE =
  /(?:price|sale|sale price|now|our price|your price|current price|special|today|deal|prix|prix de vente|maintenant|solde)\s*[:\-–]?\s*$/i;

/** Mildly negative: "from $199" is often a variant range floor. */
const WEAK_BEFORE = /(?:from|starting at|starts at|à partir de)\s*[:\-–]?\s*$/i;

/** Headings after which a page lists OTHER products. */
const RELATED_SECTION =
  /customers (?:also|who)|frequently bought|related products|you may also like|similar (?:items|products)|recently viewed|sponsored|more from|people also|complete the (?:set|look)|you might also|products related|compare with similar|shop similar|vous aimerez aussi|produits similaires|articles similaires/i;

/** Filler words that don't help find the product on its own page. */
const ANCHOR_STOPWORDS = new Set([
  "luggage", "suitcase", "spinner", "carry", "carry-on", "checked", "check", "hardside",
  "softside", "expandable", "wheeled", "travel", "with", "from", "size", "inch", "large",
  "medium", "small", "piece", "black", "blue", "grey", "gray", "navy", "silver", "price",
  "canada", "shop", "online", "free", "shipping",
]);

function anchorTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length >= 4 && !ANCHOR_STOPWORDS.has(t) && !/^\d+$/.test(t)),
    ),
  ].slice(0, 6);
}

/**
 * Where the product itself starts on the page: the first spot where two
 * distinctive title words appear within 120 characters. -1 if not found.
 */
export function findAnchor(text: string, title: string): number {
  const tokens = anchorTokens(title);
  if (tokens.length === 0) return -1;
  if (tokens.length === 1) return text.toLowerCase().indexOf(tokens[0]);

  const lower = text.toLowerCase();
  const positions: { token: string; index: number }[] = [];
  for (const token of tokens) {
    let from = 0;
    for (let n = 0; n < 50; n++) {
      const i = lower.indexOf(token, from);
      if (i < 0) break;
      positions.push({ token, index: i });
      from = i + token.length;
    }
  }
  positions.sort((a, b) => a.index - b.index);

  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length && positions[j].index - positions[i].index <= 120; j++) {
      if (positions[j].token !== positions[i].token) return positions[i].index;
    }
  }
  return -1;
}

export type PricePick = {
  price: number;
  /** The words around the amount, exactly as on the page. */
  evidence: string;
  /** Higher is surer. Negative scores are never returned. */
  score: number;
};

function evidenceAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 70);
  const to = Math.min(text.length, end + 40);
  return `${from > 0 ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

/** A gap in a search snippet: text on either side isn't adjacent on the page. */
const SNIPPET_GAP = /\.\.\.|…|\[\s*\.\.\.\s*\]/;

/**
 * Words that sit right next to a product's OWN price on its page (the
 * variant picker, the buy button, stock status) — as opposed to a carousel
 * of other items.
 */
const OWN_PRICE_CUE =
  /\bselected\b|add to (?:cart|bag|basket)|\bin stock\b|\bcolou?r\s*:|\bqty\b|\bquantity\b|\bsold by\b|\bships?\b|\bpickup\b|\bajouter au panier\b|\ben stock\b/i;

export type PriceOptions = {
  /**
   * The text is a short search-engine excerpt, not the page. Excerpts
   * stitch fragments together ("… Spinner Large … C$ 35.00 … RFID
   * Passport"), so a price only counts when it's contiguous with the
   * product's name — or, on a product URL with no name in the excerpt, when
   * it's the first amount and sits beside the page's own buy/variant UI.
   */
  snippet?: boolean;
  /** The URL looks like a single product's page. */
  productUrl?: boolean;
};

/**
 * The page's selling price, or null when it can't be told apart from the
 * other amounts on the page.
 */
export function pickListingPrice(
  rawText: string,
  title: string,
  opts: PriceOptions = {},
): PricePick | null {
  const text = (rawText ?? "").slice(0, MAX_TEXT);
  if (!text) return null;

  const anchor = findAnchor(text, title);

  // Excerpt from a page that isn't recognisably a product page, and the
  // product isn't even named in it: nothing ties any amount to the product.
  if (opts.snippet && anchor < 0 && !opts.productUrl) return null;

  // Everything after a "customers also viewed" heading belongs to other
  // products. Only look for that heading after the product's own anchor.
  const tail = text.slice(Math.max(0, anchor));
  const related = tail.search(RELATED_SECTION);
  const cutoff = related >= 0 ? Math.max(0, anchor) + related : text.length;

  const scored: (Candidate & { score: number })[] = [];
  let firstPlausible = true;

  for (const c of findPriceCandidates(text)) {
    if (c.index >= cutoff) continue;
    if (c.usd) continue;
    if (c.value < MIN_PLAUSIBLE_PRICE || c.value > MAX_PLAUSIBLE_PRICE) continue;

    const isFirst = firstPlausible;
    firstPlausible = false;

    if (opts.snippet) {
      if (anchor >= 0) {
        // The excerpt jumps between the product's name and this amount —
        // it belongs to something else on the page.
        if (c.index < anchor || SNIPPET_GAP.test(text.slice(anchor, c.index))) continue;
      } else {
        // Product URL, product not named in the excerpt: accept only the
        // first amount, and only beside the page's own buy/variant controls.
        if (!isFirst) continue;
        const around = text.slice(Math.max(0, c.index - 80), Math.min(text.length, c.end + 80));
        if (!OWN_PRICE_CUE.test(around)) continue;
        if (SNIPPET_GAP.test(text.slice(0, c.index))) continue;
      }
    }

    const before = text.slice(Math.max(0, c.index - 40), c.index);
    const after = text.slice(c.end, c.end + 30);

    if (NEGATIVE_BEFORE.test(before)) continue;
    if (NEGATIVE_AFTER.test(after)) continue;
    if (/\bUSD\b|\bUS\s?\$/i.test(text.slice(Math.max(0, c.index - 12), c.end + 12))) continue;

    let score = 0;
    if (POSITIVE_BEFORE.test(before)) score += 3;
    if (WEAK_BEFORE.test(before)) score -= 1;

    if (anchor >= 0) {
      if (c.index >= anchor && c.index - anchor <= 2_500) score += 2;
      else if (c.index < anchor) score -= 2;
    }

    scored.push({ ...c, score });
  }

  if (scored.length === 0) return null;

  // First surviving amount gets a small nudge: on product pages the
  // selling price is almost always the first real price shown.
  scored[0].score += 1;

  let best = scored[0];
  for (const c of scored) if (c.score > best.score) best = c;

  if (best.score < 0) return null;

  // Ambiguity guard: another amount just as plausible, at a clearly
  // different value, and nothing on the page says which is the price.
  if (!POSITIVE_BEFORE.test(text.slice(Math.max(0, best.index - 40), best.index))) {
    const rival = scored.find(
      (c) =>
        c !== best &&
        c.score >= best.score &&
        Math.abs(c.value - best.value) / best.value > 0.03,
    );
    if (rival) return null;
  }

  return {
    price: Math.round(best.value * 100) / 100,
    evidence: evidenceAround(text, best.index, best.end),
    score: best.score,
  };
}

/**
 * Search and category pages list many products, each with a price. Reading
 * one of those as "the" price would pair the wrong number with the title.
 */
export function isListingPage(url: string, text: string, title = ""): boolean {
  if (isHomePage(url)) return true;
  if (looksLikeListingUrl(url)) return true;
  if (title && looksLikeListingTitle(title)) return true;
  if (looksLikeProductUrl(url)) return false;

  const distinct = new Set(
    findPriceCandidates(text.slice(0, 12_000))
      .filter((c) => c.value >= MIN_PLAUSIBLE_PRICE && c.value <= MAX_PLAUSIBLE_PRICE)
      .map((c) => c.value),
  );
  return distinct.size >= 8;
}

/* ------------------------------------------------------------------ */
/*  Availability                                                      */
/* ------------------------------------------------------------------ */

const OUT_OF_STOCK =
  /\b(?:out of stock|sold out|currently unavailable|no longer available|discontinued|not available online|rupture de stock|épuisé|non disponible)\b/i;

/** False when the product's own section says it's unavailable. */
export function detectInStock(text: string, title: string): boolean {
  const anchor = Math.max(0, findAnchor(text, title));
  const window = text.slice(anchor, anchor + 3_000);
  return !OUT_OF_STOCK.test(window);
}

/* ------------------------------------------------------------------ */
/*  Specs                                                             */
/* ------------------------------------------------------------------ */

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Specs the page states outright. A field is only set when the page says
 * it; nothing is inferred.
 */
export function extractDetails(rawText: string, title: string): LuggageDetails | undefined {
  const full = (rawText ?? "").slice(0, MAX_TEXT);
  const anchor = Math.max(0, findAnchor(full, title));
  const tail = full.slice(anchor);
  const related = tail.search(RELATED_SECTION);
  const text = `${title}\n${related >= 0 ? tail.slice(0, related) : tail}`.slice(0, 25_000);

  const d: LuggageDetails = {};

  const dims = text.match(
    /(\d{1,3}(?:\.\d+)?)\s*(?:"|''|in(?:ches|\.)?)?\s*[x×]\s*(\d{1,3}(?:\.\d+)?)\s*(?:"|''|in(?:ches|\.)?)?\s*[x×]\s*(\d{1,3}(?:\.\d+)?)\s*("|''|in(?:ches|\.)?|cm|centimet(?:er|re)s?)(?![a-z])/i,
  );
  if (dims) {
    const unit = /cm|centim/i.test(dims[4]) ? "cm" : "in";
    d.dimensions = `${dims[1]} x ${dims[2]} x ${dims[3]} ${unit}`;
  }

  const weight = text.match(
    /(?:\b(?:item |product |bag |luggage )?weight\b(?!\s*(?:limit|allowance|capacity|restriction))|\bweighs\b|\bpoids\b)[^0-9]{0,25}(\d{1,2}(?:\.\d{1,2})?)\s*(lbs?|pounds?|kg|kilograms?)\b/i,
  );
  if (weight) {
    const unit = /^k/i.test(weight[2]) ? "kg" : "lb";
    d.weight = `${weight[1]} ${unit}`;
  }

  const capacity = text.match(/\b(\d{2,3}(?:\.\d)?)\s*(?:L|litres?|liters?)\b(?![a-z])/);
  if (capacity) d.capacity = `${capacity[1]} L`;

  const material = text.match(
    /\b(polycarbonate|polypropylene|ABS|aluminum|aluminium|ballistic nylon|nylon|polyester|curv|leather|canvas)\b/i,
  );
  if (material) d.material = material[1].toUpperCase() === "ABS" ? "ABS" : titleCase(material[1]);

  if (/\b(?:8|eight)[- ]?(?:double[- ])?(?:spinner[- ])?wheels?\b|\bdouble[- ]spinner\b/i.test(text)) {
    d.wheels = "8 wheels (double spinner)";
  } else if (/\b(?:4|four)[- ]?(?:spinner[- ])?wheels?\b|\bspinner\b/i.test(text)) {
    d.wheels = "Spinner (4 wheels)";
  } else if (/\b(?:2|two)[- ]?wheel(?:s|ed)?\b|\bupright\b/i.test(text)) {
    d.wheels = "2 wheels";
  }

  if (/\bexpandable\b|\bexpansion\b|\bextensible\b/i.test(text)) d.expandable = true;
  if (/\bTSA\b/.test(text)) d.tsaLock = true;

  const warranty = text.match(/\b(\d{1,2})[- ]year\b[^.\n]{0,25}warrant(?:y|ie)|\b(limited lifetime|lifetime)\s+warrant(?:y|ie)/i);
  if (warranty) d.warranty = warranty[1] ? `${warranty[1]}-year` : titleCase(warranty[2]);

  return Object.keys(d).length > 0 ? d : undefined;
}

/* ------------------------------------------------------------------ */
/*  One page → one offer (or a reason it isn't one)                   */
/* ------------------------------------------------------------------ */

export type PageInput = {
  url: string;
  title: string;
  /** Short, query-relevant excerpt(s). */
  content: string;
  /** Full page text, when available. */
  rawContent: string | null;
};

export type PageAnalysis = {
  url: string;
  host: string;
  retailer: string;
  offer: Offer | null;
  /** Why no offer was made — for diagnostics. */
  reason: string | null;
};

/** Human-friendly retailer label for a site we don't have in the registry. */
function prettyHost(host: string): string {
  const base = host.replace(/^www\./, "");
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * Turn one research result into an offer, or explain why it can't be one.
 * The same function feeds the app and the live diagnostic, so what the
 * diagnostic reports is exactly what the app will show.
 */
export function analyzePage(page: PageInput, fetchedAt = new Date().toISOString()): PageAnalysis {
  const url = page.url;
  const host = hostOf(url);
  const cleaned = cleanPageTitle(page.title);
  const site = cleaned.site;
  let name = cleaned.name;

  // On the open web the DOMAIN is the retailer. A page title can end in the
  // brand instead ("… - Samsonite | Luggage Depot"), so the title is only
  // used to name a store we don't recognise — never to identify one.
  const retailerKey = matchRetailer("", url);
  const retailer =
    retailerKey ??
    (site && site.length <= 30 && !/amazon|walmart|samsonite/i.test(site) ? site : prettyHost(host));

  const base = { url, host, retailer };

  if (!isMerchantUrl(url)) return { ...base, offer: null, reason: "not a retailer page" };
  if (!name) return { ...base, offer: null, reason: "page has no title" };

  // Brand stores title their pages without the brand ("Freeform Carry-On
  // Spinner" on samsonite.ca). Put it back, so the product is named properly
  // and groups with the same bag at other retailers.
  const info = retailerKey ? RETAILER_INFO[retailerKey] : undefined;
  if (info?.category === "specialty") {
    const brand = retailerKey!.replace(/\.(?:ca|com)$/i, "");
    if (!name.toLowerCase().includes(brand.toLowerCase())) name = `${brand} ${name}`;
  }

  const raw = page.rawContent ?? "";
  const pageText = `${page.content}\n${raw}`;

  if (!isCanadianStorefront(url, pageText)) {
    return { ...base, offer: null, reason: "not a Canadian storefront (prices likely USD)" };
  }

  if (isHomePage(url)) {
    return { ...base, offer: null, reason: "home page, not a single product" };
  }
  if (isListingPage(url, raw || page.content, page.title)) {
    return { ...base, offer: null, reason: "search or category page, not a single product" };
  }

  // Read the price from the full page and from Tavily's excerpt, and keep
  // the surer reading. Full-page reads are anchored to the product and cut
  // off before "related products", so they win ties. Excerpts get the
  // stricter snippet rules: they stitch fragments of the page together.
  const productUrl = looksLikeProductUrl(url);
  const fromRaw = raw ? pickListingPrice(raw, name, { productUrl }) : null;
  const fromExcerpt = page.content
    ? pickListingPrice(page.content, name, { snippet: true, productUrl })
    : null;
  const pick =
    fromRaw && fromExcerpt
      ? fromExcerpt.score > fromRaw.score
        ? fromExcerpt
        : fromRaw
      : (fromRaw ?? fromExcerpt);

  if (!pick) return { ...base, offer: null, reason: "no clear price on the page" };

  const detailSource = raw || page.content;

  return {
    ...base,
    offer: {
      retailer,
      retailerKey,
      price: pick.price,
      currency: "CAD",
      inStock: detectInStock(detailSource, name),
      url,
      title: name,
      fetchedAt,
      evidence: pick.evidence,
      details: extractDetails(detailSource, name),
    },
    reason: null,
  };
}
