/* ------------------------------------------------------------------ */
/*  Structured product data in HTML                                   */
/*                                                                     */
/*  JSON-LD (schema.org Product / ProductGroup / Offer), then the      */
/*  OpenGraph / product: meta tags. Pure functions — no network.       */
/* ------------------------------------------------------------------ */

export type StructuredOffer = {
  price: number | null;
  priceCurrency: string | null;
  availability: string | null;
  priceValidUntil: string | null;
  sku: string | null;
  gtin: string | null;
  url: string | null;
  seller: string | null;
  /** schema.org priceSpecification list/strikethrough price, when given. */
  listPrice: number | null;
};

export type StructuredProduct = {
  type: string;
  name: string | null;
  brand: string | null;
  sku: string | null;
  mpn: string | null;
  gtin: string | null;
  color: string | null;
  size: string | null;
  offers: StructuredOffer[];
  variants: StructuredProduct[];
};

export type StructuredResult = {
  jsonLdBlocks: number;
  jsonLdParseErrors: number;
  products: StructuredProduct[];
  meta: Record<string, string>;
};

const LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_RE = /<meta\s+[^>]*?(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/gi;
const META_RE_REV = /<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*>/gi;

const META_KEYS = new Set([
  "og:type", "og:title", "og:price:amount", "og:price:currency", "product:price:amount",
  "product:price:currency", "product:availability", "product:sale_price:amount",
  "product:original_price:amount", "product:retailer_item_id", "product:brand", "price", "pricecurrency",
]);

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && "name" in v) return str((v as { name: unknown }).name);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && v.trim() !== "" ? n : null;
  }
  return null;
}

function types(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

function gtinOf(node: Record<string, unknown>): string | null {
  for (const k of ["gtin", "gtin13", "gtin12", "gtin14", "gtin8", "isbn"]) {
    const v = str(node[k]);
    if (v) return v.replace(/\D/g, "") || v;
  }
  return null;
}

function toOffers(raw: unknown): StructuredOffer[] {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: StructuredOffer[] = [];
  for (const o of list) {
    if (!o || typeof o !== "object") continue;
    const node = o as Record<string, unknown>;
    if (types(node).includes("AggregateOffer")) {
      out.push({
        price: num(node.lowPrice ?? node.price),
        priceCurrency: str(node.priceCurrency),
        availability: str(node.availability),
        priceValidUntil: str(node.priceValidUntil),
        sku: null,
        gtin: null,
        url: str(node.url),
        seller: str(node.seller),
        listPrice: num(node.highPrice),
      });
      if (node.offers) out.push(...toOffers(node.offers));
      continue;
    }
    const spec = node.priceSpecification;
    const specs = Array.isArray(spec) ? spec : spec ? [spec] : [];
    let price = num(node.price);
    let listPrice: number | null = null;
    let currency = str(node.priceCurrency);
    for (const s of specs) {
      if (!s || typeof s !== "object") continue;
      const ps = s as Record<string, unknown>;
      const p = num(ps.price);
      const priceType = str(ps.priceType) ?? "";
      if (/ListPrice|StrikethroughPrice|MSRP/i.test(priceType)) listPrice = p;
      else if (price === null) price = p;
      currency = currency ?? str(ps.priceCurrency);
    }
    out.push({
      price,
      priceCurrency: currency,
      availability: str(node.availability),
      priceValidUntil: str(node.priceValidUntil),
      sku: str(node.sku),
      gtin: gtinOf(node),
      url: str(node.url),
      seller: str(node.seller),
      listPrice,
    });
  }
  return out;
}

function toProduct(node: Record<string, unknown>): StructuredProduct {
  const variants = Array.isArray(node.hasVariant)
    ? (node.hasVariant as unknown[])
        .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
        .map(toProduct)
    : [];
  return {
    type: types(node).join(","),
    name: str(node.name),
    brand: str(node.brand),
    sku: str(node.sku),
    mpn: str(node.mpn),
    gtin: gtinOf(node),
    color: str(node.color),
    size: str(node.size),
    offers: toOffers(node.offers),
    variants,
  };
}

function walk(value: unknown, found: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, found);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  if (node["@graph"]) walk(node["@graph"], found);
  const t = types(node);
  if (t.includes("Product") || t.includes("ProductGroup") || t.includes("IndividualProduct")) {
    found.push(node);
    return; // variants are read from hasVariant, not walked twice
  }
  // Products are sometimes nested (e.g. inside an ItemPage's mainEntity).
  for (const k of ["mainEntity", "itemListElement", "item"]) if (node[k]) walk(node[k], found);
}

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export function extractStructured(html: string): StructuredResult {
  let blocks = 0;
  let errors = 0;
  const nodes: Record<string, unknown>[] = [];
  for (const m of html.matchAll(LD_RE)) {
    blocks++;
    const raw = m[1].trim().replace(/^<!--|-->$/g, "");
    try {
      walk(JSON.parse(raw), nodes);
    } catch {
      try {
        // Some themes HTML-escape the JSON.
        walk(JSON.parse(decodeEntities(raw)), nodes);
      } catch {
        errors++;
      }
    }
  }

  const meta: Record<string, string> = {};
  for (const m of html.matchAll(META_RE)) {
    const k = m[1].toLowerCase();
    if (META_KEYS.has(k) && !(k in meta)) meta[k] = decodeEntities(m[2]);
  }
  for (const m of html.matchAll(META_RE_REV)) {
    const k = m[2].toLowerCase();
    if (META_KEYS.has(k) && !(k in meta)) meta[k] = decodeEntities(m[1]);
  }

  return { jsonLdBlocks: blocks, jsonLdParseErrors: errors, products: nodes.map(toProduct), meta };
}

/** Does the HTML look like a page that needs JavaScript to show its product? */
export function looksJsOnly(html: string): boolean {
  return /javascript is required|enable javascript|<noscript>[^<]*javascript/i.test(html.slice(0, 50_000)) &&
    !/application\/ld\+json/i.test(html);
}
