/* ------------------------------------------------------------------ */
/*  Structured product data in HTML                                   */
/*                                                                     */
/*  JSON-LD (Product / ProductGroup / Offer, @graph, hasVariant,        */
/*  priceSpecification), then microdata (itemprop=price — SFCC stores  */
/*  render prices this way), then OpenGraph / product: meta tags, which */
/*  carry the price the customer is shown. Pure functions, no network.  */
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
  /** List / strikethrough / MSRP price from priceSpecification or AggregateOffer.highPrice. */
  listPrice: number | null;
  itemCondition: string | null;
};

export type StructuredProduct = {
  type: string;
  name: string | null;
  brand: string | null;
  sku: string | null;
  gtin: string | null;
  color: string | null;
  size: string | null;
  url: string | null;
  image: string | null;
  productGroupId: string | null;
  offers: StructuredOffer[];
  variants: StructuredProduct[];
};

export type StructuredResult = {
  jsonLdBlocks: number;
  jsonLdParseErrors: number;
  products: StructuredProduct[];
  meta: Record<string, string>;
  microdata: { price: number | null; currency: string | null; availability: string | null };
};

const LD_RE = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_RE =
  /<meta\s+[^>]*?(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*>/gi;
const META_RE_REV =
  /<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name|itemprop)\s*=\s*["']([^"']+)["'][^>]*>/gi;

const META_KEYS = new Set([
  "og:type",
  "og:title",
  "og:url",
  "og:image",
  "og:price:amount",
  "og:price:currency",
  "product:price:amount",
  "product:price:currency",
  "product:availability",
  "product:sale_price:amount",
  "product:original_price:amount",
  "product:retailer_item_id",
  "product:brand",
]);

export function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  reg: "®",
  trade: "™",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  acirc: "â",
  ccedil: "ç",
  icirc: "î",
  iuml: "ï",
  ocirc: "ô",
  ucirc: "û",
};

/**
 * Plain text (titles, meta values) → characters, in one pass so "&amp;lt;"
 * stays "&lt;". Named French accents and numeric entities included: Delsey's
 * sitemap says "ALU&apos;R". Not for JSON text (see decodeEntities).
 */
export function decodeHtmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (e === "amp") return "&";
    return NAMED_ENTITIES[e] ?? m;
  });
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return str(v[0]);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("name" in o) return str(o.name);
    if ("url" in o) return str(o.url);
  }
  return null;
}

/** Price text → number. Handles "1,030.00", "1 030,00", "C$ 224.95". */
export function parsePrice(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  let t = v.replace(/[^\d.,]/g, "");
  if (!t) return null;
  if (/,\d{2}$/.test(t) && !/\.\d{2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function types(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string");
}

function gtinOf(node: Record<string, unknown>): string | null {
  for (const k of ["gtin14", "gtin13", "gtin12", "gtin8", "gtin"]) {
    const v = str(node[k]);
    if (v) {
      const digits = v.replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 14) return digits;
    }
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
      if (node.offers) out.push(...toOffers(node.offers));
      else
        out.push({
          price: parsePrice(node.lowPrice ?? node.price),
          priceCurrency: str(node.priceCurrency),
          availability: str(node.availability),
          priceValidUntil: str(node.priceValidUntil),
          sku: null,
          gtin: null,
          url: str(node.url),
          seller: str(node.seller),
          listPrice: parsePrice(node.highPrice),
          itemCondition: str(node.itemCondition),
        });
      continue;
    }
    const specs = Array.isArray(node.priceSpecification)
      ? node.priceSpecification
      : node.priceSpecification
        ? [node.priceSpecification]
        : [];
    let price = parsePrice(node.price);
    let listPrice: number | null = null;
    let currency = str(node.priceCurrency);
    for (const s of specs) {
      if (!s || typeof s !== "object") continue;
      const ps = s as Record<string, unknown>;
      const p = parsePrice(ps.price);
      if (/ListPrice|StrikethroughPrice|MSRP/i.test(str(ps.priceType) ?? "")) listPrice = p;
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
      itemCondition: str(node.itemCondition),
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
    gtin: gtinOf(node),
    color: str(node.color),
    size: str(node.size),
    url: str(node.url),
    image: str(node.image),
    productGroupId: str(node.productGroupID),
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
    return;
  }
  for (const k of ["mainEntity", "itemListElement", "item"]) if (node[k]) walk(node[k], found);
}

function microdata(html: string): StructuredResult["microdata"] {
  const attr = (prop: string) =>
    html.match(
      new RegExp(`itemprop\\s*=\\s*["']${prop}["'][^>]*?content\\s*=\\s*["']([^"']+)["']`, "i"),
    )?.[1] ??
    html.match(
      new RegExp(`content\\s*=\\s*["']([^"']+)["'][^>]*?itemprop\\s*=\\s*["']${prop}["']`, "i"),
    )?.[1] ??
    null;
  return {
    price: parsePrice(attr("price")),
    currency: attr("priceCurrency"),
    availability: attr("availability"),
  };
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
        walk(JSON.parse(decodeEntities(raw)), nodes);
      } catch {
        errors++;
      }
    }
  }
  const meta: Record<string, string> = {};
  for (const m of html.matchAll(META_RE)) {
    const k = m[1].toLowerCase();
    if (META_KEYS.has(k) && !(k in meta)) meta[k] = decodeHtmlText(m[2]);
  }
  for (const m of html.matchAll(META_RE_REV)) {
    const k = m[2].toLowerCase();
    if (META_KEYS.has(k) && !(k in meta)) meta[k] = decodeHtmlText(m[1]);
  }
  return {
    jsonLdBlocks: blocks,
    jsonLdParseErrors: errors,
    products: nodes.map(toProduct),
    meta,
    microdata: microdata(html),
  };
}

/** The price the customer is shown, from meta tags (falls back to microdata). */
export function displayedPrice(s: StructuredResult): {
  price: number | null;
  currency: string | null;
} {
  const price =
    parsePrice(
      s.meta["product:sale_price:amount"] ??
        s.meta["og:price:amount"] ??
        s.meta["product:price:amount"] ??
        "",
    ) ?? s.microdata.price;
  const currency =
    s.meta["og:price:currency"] ?? s.meta["product:price:currency"] ?? s.microdata.currency ?? null;
  return { price, currency };
}

export function schemaAvailability(
  v: string | null,
): "in_stock" | "out_of_stock" | "preorder" | "backorder" | "unknown" {
  if (!v) return "unknown";
  const t = v.toLowerCase();
  if (/instock|in stock|in_stock|limitedavailability|onlineonly/.test(t)) return "in_stock";
  if (/outofstock|out of stock|out_of_stock|soldout|sold out|discontinued/.test(t))
    return "out_of_stock";
  if (/preorder|presale/.test(t)) return "preorder";
  if (/backorder/.test(t)) return "backorder";
  return "unknown";
}
