/* ------------------------------------------------------------------ */
/*  feed_import: dealer price lists and affiliate feeds               */
/*                                                                     */
/*  CSV or JSON, uploaded by an admin (Samsonite dealer list, Rakuten  */
/*  / Impact affiliate feeds once approved). Nothing is fetched: a     */
/*  feed price is shown as "Feed as of <date>", never as live.         */
/*                                                                     */
/*  Columns (case-insensitive, extra columns ignored):                 */
/*    title*  price*  sku  gtin|upc|ean|barcode  mpn|model  brand       */
/*    list_price|msrp  currency  availability|stock  url  as_of         */
/* ------------------------------------------------------------------ */

import type { Availability, CategoryPack, RawOffer, SourceRecord } from "../types";
import { buildIdentifiers, result, type Adapter, type AdapterResult } from "./base";
import { parsePrice } from "../extract/structured";

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

const COLUMN: Record<string, string> = {
  title: "title", name: "title", product: "title", "product name": "title",
  price: "price", "sale price": "price", "dealer price": "price",
  sku: "sku", "item number": "sku", "item #": "sku",
  gtin: "gtin", upc: "gtin", ean: "gtin", barcode: "gtin",
  mpn: "mpn", model: "mpn", "model number": "mpn",
  brand: "brand", vendor: "brand",
  list_price: "list_price", "list price": "list_price", msrp: "list_price", "regular price": "list_price",
  currency: "currency",
  availability: "availability", stock: "availability", "in stock": "availability",
  url: "url", link: "url", "product url": "url",
  as_of: "as_of", "as of": "as_of", date: "as_of",
};

function availability(v: string | undefined): Availability {
  const t = (v ?? "").trim().toLowerCase();
  if (!t) return "unknown";
  if (/^(y|yes|true|1|in stock|in_stock|available)$/.test(t) || /^\d+$/.test(t) && Number(t) > 0) return "in_stock";
  if (/^(n|no|false|0|out of stock|out_of_stock|sold out|discontinued)$/.test(t)) return "out_of_stock";
  if (/backorder/.test(t)) return "backorder";
  if (/pre-?order/.test(t)) return "preorder";
  return "unknown";
}

export type FeedRow = Record<string, string>;

export type ParsedFeed = { offers: RawOffer[]; errors: { row: number; reason: string }[] };

export function feedRows(text: string, format: "csv" | "json"): FeedRow[] {
  if (format === "json") {
    const data = JSON.parse(text) as unknown;
    const list = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : [];
    return list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((o) => {
        const row: FeedRow = {};
        for (const [k, v] of Object.entries(o)) {
          const col = COLUMN[k.trim().toLowerCase()];
          if (col && v !== null && v !== undefined) row[col] = String(v);
        }
        return row;
      });
  }
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => COLUMN[h.trim().toLowerCase()] ?? null);
  return body.map((r) => {
    const row: FeedRow = {};
    cols.forEach((c, i) => {
      if (c && r[i] !== undefined && r[i].trim() !== "") row[c] = r[i].trim();
    });
    return row;
  });
}

/**
 * Turn feed rows into RawOffers for `source`. Rows without a title or a
 * price are reported, not guessed. Listing URLs must be on the store's own
 * domains; otherwise the row gets a stable feed: key and the UI links to the
 * store's search page.
 */
export function parseFeed(
  text: string,
  format: "csv" | "json",
  source: SourceRecord,
  pack: CategoryPack,
  defaultAsOf: string,
  feedName: string,
  now = Date.now(),
): ParsedFeed {
  const out: ParsedFeed = { offers: [], errors: [] };
  let rows: FeedRow[];
  try {
    rows = feedRows(text, format);
  } catch {
    out.errors.push({ row: 0, reason: `not valid ${format.toUpperCase()}` });
    return out;
  }
  rows.forEach((r, i) => {
    const line = i + 2;
    if (!r.title) return out.errors.push({ row: line, reason: "no title" });
    const price = parsePrice(r.price);
    if (price === null || price <= 0) return out.errors.push({ row: line, reason: "no usable price" });
    const asOf = r.as_of && /^\d{4}-\d{2}-\d{2}/.test(r.as_of) ? r.as_of.slice(0, 10) : defaultAsOf;
    const brand = pack.brandOf(r.brand ?? "") ?? pack.brandOf(r.title) ?? r.brand ?? null;
    let url = `feed:${source.id}:${(r.sku ?? r.gtin ?? r.mpn ?? r.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80)}`;
    if (r.url) {
      try {
        const u = new URL(r.url);
        if (u.protocol === "https:" && source.allowedDomains.includes(u.hostname.toLowerCase())) url = u.toString();
      } catch {
        /* keep the feed: key */
      }
    }
    const listPrice = parsePrice(r.list_price);
    out.offers.push({
      sourceId: source.id,
      adapter: "feed_import",
      url,
      externalId: r.sku ?? null,
      variantExternalId: null,
      title: r.title.slice(0, 300),
      brand,
      identifiers: buildIdentifiers(pack, source.id, { brand, sku: r.mpn ?? r.sku ?? null, barcode: r.gtin ?? null, title: r.title }),
      colour: pack.colourOf(r.title),
      options: [],
      price,
      listPrice: listPrice !== null && listPrice > price ? listPrice : null,
      currency: (r.currency ?? "CAD").toUpperCase(),
      availability: availability(r.availability),
      seller: null,
      condition: null,
      imageUrl: null,
      displayedPrice: null,
      pageType: "feed",
      evidence: { feed: feedName, row: line },
      fetchedAt: new Date(now).toISOString(),
      cacheAgeSec: null,
      asOf: `${asOf}T00:00:00.000Z`,
    });
  });
  return out;
}

/** Feeds are imported, not fetched: the research session reads stored feed observations. */
export const feedImport: Adapter = {
  id: "feed_import",
  live: false,
  async verify(): Promise<AdapterResult> {
    return result("not_configured", [], "feed prices are imported, not fetched");
  },
};
