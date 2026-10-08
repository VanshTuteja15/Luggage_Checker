/* ------------------------------------------------------------------ */
/*  Validation: confidence-scored, never price-changing                */
/*                                                                     */
/*  Every reading is judged on identity, currency, the store's own      */
/*  domain, price sanity (category band, list price, history, other     */
/*  stores), marketplace seller/condition, availability, page type and  */
/*  data age. The result is accepted, low-confidence (shown, labelled)  */
/*  or rejected (kept as evidence, never shown). Validation cannot      */
/*  alter a price: it only decides whether the source's own number may  */
/*  be shown, and how loudly to caveat it.                              */
/* ------------------------------------------------------------------ */

import { normaliseHost } from "../registry";
import type { AdapterId, CategoryPack, Identifier, RawOffer, SourceRecord, ValidationResult } from "../types";

export type ExpectedIdentity = {
  gtin?: string | null;
  /** brandkey:model, e.g. "samsonite:137394". */
  model?: string | null;
  sizeClass?: string | null;
  brand?: string | null;
  colour?: string | null;
};

export type ValidationContext = {
  source: SourceRecord;
  pack: CategoryPack;
  expected?: ExpectedIdentity | null;
  /** Recent accepted prices for this listing (any order). */
  history?: number[];
  /** Same-identity prices at other stores this session. */
  peers?: number[];
  now: number;
};

const BASE: Record<AdapterId, number> = {
  shopify_ucp: 0.97,
  shopify_product_json: 0.95,
  amazon_creators_api: 0.92,
  ebay_browse_api: 0.9,
  html_structured: 0.9,
  feed_import: 0.85,
  manual_entry: 0.8,
};

export const LOW_CONFIDENCE_BELOW = 0.7;

function median(xs: number[]): number | null {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const ident = (ids: Identifier[], kind: Identifier["kind"]) => ids.filter((i) => i.kind === kind).map((i) => i.value);

export function validateOffer(o: RawOffer, ctx: ValidationContext): ValidationResult {
  const reject: string[] = [];
  const caveats: string[] = [];
  let confidence = BASE[o.adapter] ?? 0.8;
  const knock = (amount: number, reason: string) => {
    confidence -= amount;
    caveats.push(reason);
  };

  /* price present and plausible */
  if (o.price === null || !Number.isFinite(o.price) || o.price <= 0) reject.push("no price on the source");
  else if (o.price < ctx.pack.priceBand.min || o.price > ctx.pack.priceBand.max) {
    reject.push(`price ${o.price} outside the plausible ${ctx.pack.priceBand.min}–${ctx.pack.priceBand.max} CAD band`);
  }

  /* currency: CAD only, never converted */
  const cur = o.currency?.toUpperCase() ?? null;
  if (cur && cur !== "CAD") reject.push(`priced in ${cur}, not CAD (geo/foreign currency)`);
  else if (!cur) {
    const host = (() => {
      try {
        return normaliseHost(new URL(o.url).hostname);
      } catch {
        return "";
      }
    })();
    const canadianStorefront = !!ctx.source.marketHost && host === normaliseHost(ctx.source.marketHost) && (o.adapter === "html_structured" || o.adapter === "shopify_product_json");
    if (canadianStorefront) knock(0.1, "currency not stated; implied by the Canadian storefront");
    else if (o.adapter !== "feed_import" && o.adapter !== "manual_entry") reject.push("currency not stated");
  }

  /* the link must be the store's own (no look-alike or other-market domains) */
  if (/^https:/.test(o.url)) {
    try {
      const h = normaliseHost(new URL(o.url).hostname);
      if (!ctx.source.allowedDomains.some((d) => normaliseHost(d) === h)) reject.push(`link points to ${h}, not ${ctx.source.retailerLabel}'s own site`);
    } catch {
      reject.push("listing URL is not valid");
    }
  } else if (!/^(feed|manual):/.test(o.url)) reject.push("listing URL is not https");

  /* page type */
  if (o.pageType === "listing") reject.push("read from a category/search page, not a product page");

  /* identity */
  const exp = ctx.expected;
  if (exp) {
    const gtins = ident(o.identifiers, "gtin");
    if (exp.gtin && gtins.length && !gtins.includes(exp.gtin)) reject.push("barcode (GTIN) differs from the product");
    const models = ident(o.identifiers, "model");
    if (exp.model && models.length && !models.includes(exp.model)) reject.push("manufacturer model number differs");
    const size = ctx.pack.sizeClassOf([o.title, ...o.options].join(" "));
    if (exp.sizeClass && size && size !== exp.sizeClass) reject.push(`size differs (${size} vs ${exp.sizeClass})`);
    const brand = o.brand ?? ctx.pack.brandOf(o.title);
    if (exp.brand && brand && brand !== exp.brand) reject.push(`brand differs (${brand} vs ${exp.brand})`);
    if (exp.colour && o.colour && o.colour.toLowerCase() !== exp.colour.toLowerCase()) knock(0.05, `colour is ${o.colour}`);
    if (!exp.gtin && !exp.model && !gtins.length && !models.length) knock(0.05, "matched by name, no shared identifier");
  }
  if (exp?.sizeClass && exp.sizeClass !== "accessory" && ctx.pack.isAccessory(o.title)) reject.push("an accessory, not the item");

  /* price sanity against list price, history and other stores */
  if (o.price !== null && o.price > 0) {
    if (o.listPrice !== null && o.price > o.listPrice * 1.05) knock(0.2, `price above the store's own list price ${o.listPrice}`);
    if (o.displayedPrice !== null && Math.abs(o.displayedPrice - o.price) > Math.max(0.01, o.price * 0.005)) {
      knock(0.3, `page shows ${o.displayedPrice}, data says ${o.price}`);
    }
    const hist = median(ctx.history ?? []);
    if (hist !== null) {
      const move = (o.price - hist) / hist;
      if (move < -0.6 || move > 1.5) knock(0.3, `price moved ${Math.round(move * 100)}% vs this listing's history`);
    }
    const peer = (ctx.peers ?? []).length >= 2 ? median(ctx.peers ?? []) : null;
    if (peer !== null) {
      if (o.price < peer * 0.45) knock(0.3, "far below other stores for the same item");
      else if (o.price > peer * 2.5) knock(0.2, "far above other stores for the same item");
    }
  }

  /* marketplaces: new condition, a named seller */
  if (ctx.source.category === "marketplace") {
    if (o.condition && !/^new$|brand new|^1000$/i.test(o.condition.trim())) reject.push(`condition "${o.condition}", not new`);
    if (!o.seller) knock(0.1, "seller not stated");
  }

  /* availability and age */
  if (o.availability === "unknown") knock(0.03, "stock not stated");
  if (o.cacheAgeSec !== null && o.cacheAgeSec > 86_400) knock(0.2, `served from a cache ${Math.round(o.cacheAgeSec / 3600)} h old`);
  if (o.asOf) {
    const ageDays = (ctx.now - Date.parse(o.asOf)) / 86_400_000;
    if (ageDays > 90) reject.push(`${o.adapter === "manual_entry" ? "checked" : "feed dated"} over 90 days ago`);
    else if (ageDays > 14) knock(0.15, `${o.adapter === "manual_entry" ? "checked" : "feed dated"} ${Math.round(ageDays)} days ago`);
  }

  confidence = Math.max(0, Math.min(1, Math.round(confidence * 1000) / 1000));
  if (reject.length) return { outcome: "rejected", confidence: Math.min(confidence, 0.2), reasons: [...reject, ...caveats] };
  return { outcome: confidence < LOW_CONFIDENCE_BELOW ? "low_confidence" : "accepted", confidence, reasons: caveats };
}

/**
 * Cross-route check (the Bentley case): a storefront page's displayed price
 * against the data route's price for the same variant. Returns a reason per
 * disagreement; the caller marks the data observation low-confidence.
 */
export function crossCheck(primary: RawOffer[], shown: RawOffer[]): Map<RawOffer, string> {
  const out = new Map<RawOffer, string>();
  const key = (o: RawOffer) => ident(o.identifiers, "gtin")[0] ?? ident(o.identifiers, "store_sku")[0] ?? null;
  for (const p of primary) {
    const k = key(p);
    const s = shown.find((x) => (k && key(x) === k) || x.url === p.url);
    const seen = s?.displayedPrice ?? s?.price ?? null;
    if (p.price !== null && seen !== null && Math.abs(seen - p.price) > Math.max(0.01, p.price * 0.005)) {
      out.set(p, `the product page shows ${seen}, the data route says ${p.price}`);
    }
  }
  return out;
}
