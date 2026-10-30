/* ------------------------------------------------------------------ */
/*  Promotions from offer text (rules; v4 A4.2)                        */
/*                                                                     */
/*  A promotion is only what the store states: a sale price below its  */
/*  own regular/was/original price, an explicit % or $ off, a free-     */
/*  shipping offer or a free gift. Not promotions (real traps in our    */
/*  labelled set): a "Sale price" equal to the regular price, "Best     */
/*  Offer", a "Comparable value" (someone else's price), in-store-only  */
/*  discounts and merchandising tags. Every number keeps its text.      */
/* ------------------------------------------------------------------ */

import type { PromotionInput } from "../store/port";
import type { RawOffer } from "../types";

export type PromotionKind =
  | "percent_off"
  | "amount_off"
  | "sale_price"
  | "free_shipping"
  | "gift"
  | "code"
  | "in_store"
  | "reference_price";

export type Promotion = {
  isPromotion: boolean;
  kinds: PromotionKind[];
  percentOff: number | null;
  upTo: boolean;
  amountOff: number | null;
  salePrice: number | null;
  wasPrice: number | null;
  threshold: number | null;
  code: string | null;
  /** The exact text each value came from. */
  evidence: string[];
};

const MONEY = String.raw`(\d+(?:\.\d{1,2})?)`;

export function extractPromotion(text: string): Promotion {
  const t = text.replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/\s+/g, " ");
  const evidence: string[] = [];
  const take = (m: RegExpMatchArray | null) => {
    if (m) evidence.push(m[0].trim());
    return m;
  };
  // Merchandising tags ("tags: CLEARANCE, BLACKFRIDAY, free-gift1") say nothing about today's offer.
  if (/^\s*tags:/i.test(t))
    return {
      isPromotion: false,
      kinds: [],
      percentOff: null,
      upTo: false,
      amountOff: null,
      salePrice: null,
      wasPrice: null,
      threshold: null,
      code: null,
      evidence: [],
    };

  const pct = take(t.match(/\b(up to\s+)?(\d{1,2})\s?%\s?off\b/i));
  const was = take(
    t.match(new RegExp(`\\bwas\\s*C?\\$\\s?${MONEY}`, "i")) ??
      t.match(new RegExp(`\\bRegular price\\s*\\$?\\s?${MONEY}`, "i")) ??
      t.match(new RegExp(`\\bOriginal price:?\\s*\\$\\s?${MONEY}`, "i")) ??
      t.match(new RegExp(`\\bPrice:\\s*\\$${MONEY}:\\s*Price:\\s*\\$\\d`, "i")),
  );
  const sale = take(
    t.match(new RegExp(`\\bNow\\s*C?\\$\\s?${MONEY}`, "i")) ??
      t.match(new RegExp(`\\bSale price:?\\s*\\$?\\s?${MONEY}`, "i")) ??
      t.match(new RegExp(`\\bPrice:\\s*\\$\\d+(?:\\.\\d+)?:\\s*Price:\\s*\\$${MONEY}`, "i")) ??
      t.match(new RegExp(`\\bspecially priced at\\s*\\$\\s?${MONEY}`, "i")),
  );
  const save = take(t.match(new RegExp(`\\bYou save:?\\s*\\$\\s?${MONEY}`, "i")));
  const ship = take(
    t.match(/free shipping\s*(?:over|on orders over)?\s*\$\s?(\d+)|free shipping\s*\$(\d+)\+/i),
  );
  const anyShip = /\bfree shipping\b/i.test(t);
  const gift = /\bfree gift\b/i.test(t);
  const code = take(t.match(/\b(?:use|with|promo|discount) code:?\s*([A-Z0-9]{3,20})\b/));

  const salePrice = sale ? Number(sale[1]) : null;
  const wasPrice = was ? Number(was[1]) : null;
  const discounted = salePrice !== null && wasPrice !== null && salePrice < wasPrice;
  const special = !!sale && /specially priced/i.test(sale[0]);

  const kinds: PromotionKind[] = [];
  if (pct) kinds.push("percent_off");
  if (save) kinds.push("amount_off");
  if ((discounted || special) && !pct) kinds.push("sale_price");
  if (anyShip) kinds.push("free_shipping");
  if (gift) kinds.push("gift");
  if (code) kinds.push("code");
  if (/in[- ]store discount|discount in store/i.test(t)) kinds.push("in_store");
  if (/comparable value/i.test(t)) kinds.push("reference_price");

  return {
    isPromotion: !!pct || !!save || discounted || special || anyShip || gift || !!code,
    kinds,
    percentOff: pct ? Number(pct[2]) : null,
    upTo: !!pct?.[1],
    amountOff: save ? Number(save[1]) : null,
    salePrice: discounted || pct || special ? salePrice : null,
    // A was-price only when it sits beside a real discount on the same offer.
    wasPrice:
      discounted || (pct && wasPrice !== null && salePrice !== null && salePrice < wasPrice)
        ? wasPrice
        : null,
    threshold: ship ? Number(ship[1] ?? ship[2]) : null,
    code: code ? code[1] : null,
    evidence,
  };
}

/* ── Storage (v4 A4.2): what one shown reading states ──────────────── */

/** A "was" price over 5× the sale price is a data error, not a deal. */
const MAX_OFF = 0.8;

/** Same promotion, same row: everything the store stated, nothing we computed. */
export function promotionFingerprint(p: PromotionInput): string {
  return [
    p.kind,
    p.method,
    p.percentOff,
    p.upTo,
    p.amountOff,
    p.salePrice,
    p.wasPrice,
    p.threshold,
    p.code,
    p.endsText,
  ].join("|");
}

/**
 * The store's end date ("2026-12-31", or a full timestamp) as an instant.
 * A bare date is read as the end of that day in UTC: approximate, which is
 * why the verbatim text is always kept beside it. Unreadable → null.
 */
export function approximateEnd(text: string | null): string | null {
  if (!text) return null;
  const t = text.trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(t) ? Date.parse(`${t}T23:59:59Z`) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Promotions one reading states: a Shopify compare-at above the price, a
 * JSON-LD ListPrice/StrikethroughPrice above the price (with its
 * priceValidUntil as the end date), and offer text an adapter kept as
 * `evidence.offerText`. An AggregateOffer highPrice is the dearest variant,
 * never a "was" price. Text discounts must name this offer's own price.
 */
export function promotionsFromOffer(o: RawOffer): PromotionInput[] {
  const out: PromotionInput[] = [];
  const ev = o.evidence ?? {};
  const price = o.price;
  const blank = {
    percentOff: null,
    upTo: false,
    amountOff: null,
    salePrice: null,
    wasPrice: null,
    threshold: null,
    code: null,
    endsText: null,
    endsAt: null,
  };
  if (
    price !== null &&
    price > 0 &&
    o.listPrice !== null &&
    o.listPrice > price &&
    price >= o.listPrice * (1 - MAX_OFF)
  ) {
    const method =
      o.adapter === "shopify_product_json"
        ? "compare_at"
        : o.adapter === "html_structured" &&
            ev.from === "json-ld" &&
            ev.listPriceFrom === "price_specification"
          ? "jsonld"
          : null;
    if (method) {
      const endsText =
        method === "jsonld" && typeof ev.priceValidUntil === "string"
          ? ev.priceValidUntil.trim().slice(0, 200) || null
          : null;
      out.push({
        ...blank,
        kind: "sale_price",
        method,
        salePrice: price,
        wasPrice: o.listPrice,
        endsText,
        endsAt: approximateEnd(endsText),
        evidence:
          method === "compare_at"
            ? [`compare_at_price ${String(ev.rawCompareAt ?? o.listPrice)}`, `price ${price}`]
            : [
                `priceSpecification list price ${o.listPrice}`,
                `price ${price}`,
                ...(endsText ? [`priceValidUntil ${endsText}`] : []),
              ],
      });
    }
  }

  if (typeof ev.offerText === "string" && ev.offerText.trim()) {
    const p = extractPromotion(ev.offerText.slice(0, 2_000));
    if (p.isPromotion) {
      const base = { ...blank, method: "page_text" as const, evidence: p.evidence };
      const priceKind = (["percent_off", "amount_off", "sale_price"] as const).find((k) =>
        p.kinds.includes(k),
      );
      const ownPrice =
        p.salePrice !== null && price !== null && Math.abs(p.salePrice - price) <= 0.01;
      const consistent =
        p.percentOff === null ||
        p.upTo ||
        p.wasPrice === null ||
        p.salePrice === null ||
        Math.abs((1 - p.salePrice / p.wasPrice) * 100 - p.percentOff) <= 2;
      if (priceKind && ownPrice && consistent && out.length === 0)
        out.push({
          ...base,
          kind: priceKind,
          percentOff: p.percentOff !== null && p.percentOff > 0 ? p.percentOff : null,
          upTo: p.upTo,
          amountOff: p.amountOff,
          salePrice: p.salePrice,
          wasPrice: p.wasPrice,
        });
      if (p.kinds.includes("free_shipping"))
        out.push({ ...base, kind: "free_shipping", threshold: p.threshold });
      if (p.kinds.includes("gift")) out.push({ ...base, kind: "gift" });
      if (p.kinds.includes("code") && p.code) out.push({ ...base, kind: "code", code: p.code });
    }
  }
  return out;
}
