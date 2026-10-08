/* ------------------------------------------------------------------ */
/*  Shopify public product data                                       */
/*                                                                     */
/*  /products/<handle>.json — decimal prices with an explicit           */
/*  price_currency, barcode, SKU, inventory (when the store tracks it).  */
/*  /products/<handle>.js   — prices in cents and the storefront's own   */
/*  `available` flag per variant, but no currency.                      */
/*  The adapter reads .json first and adds .js only when availability   */
/*  can't be told from .json (P0: Delsey has no inventory field).       */
/* ------------------------------------------------------------------ */

export type ShopifyVariant = {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAt: number | null;
  currency: string | null;
  available: boolean | null;
  options: string[];
};

export type ShopifyProduct = {
  id: string;
  handle: string | null;
  title: string;
  vendor: string | null;
  productType: string | null;
  imageUrl: string | null;
  variants: ShopifyVariant[];
  source: ".json" | ".js" | "merged";
};

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const cents = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n) / 100;
};
const absUrl = (u: string | null): string | null => (u ? (u.startsWith("//") ? `https:${u}` : u) : null);

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Availability from .json: inventory tracked by Shopify and not "continue selling". */
function availabilityFromJson(v: Record<string, unknown>): boolean | null {
  if (typeof v.available === "boolean") return v.available;
  const qty = num(v.inventory_quantity);
  if (qty === null || v.inventory_management !== "shopify") return null;
  if (v.inventory_policy === "continue") return true;
  return qty > 0;
}

export function parseShopifyJson(text: string): ShopifyProduct | null {
  const p = (parse(text) as { product?: Record<string, unknown> } | null)?.product;
  if (!p || !Array.isArray(p.variants) || !str(p.title)) return null;
  const image = (p.image as { src?: unknown } | null)?.src;
  return {
    id: String(p.id ?? ""),
    handle: str(p.handle),
    title: str(p.title) ?? "",
    vendor: str(p.vendor),
    productType: str(p.product_type),
    imageUrl: absUrl(str(image)),
    source: ".json",
    variants: (p.variants as Record<string, unknown>[]).map((v) => ({
      id: String(v.id ?? ""),
      title: str(v.title),
      sku: str(v.sku),
      barcode: str(v.barcode),
      price: num(v.price),
      compareAt: num(v.compare_at_price),
      currency: str(v.price_currency),
      available: availabilityFromJson(v),
      options: [v.option1, v.option2, v.option3].map(str).filter((x): x is string => !!x && x !== "Default Title"),
    })),
  };
}

export function parseShopifyJs(text: string): ShopifyProduct | null {
  const p = parse(text) as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.variants) || !str(p.title)) return null;
  return {
    id: String(p.id ?? ""),
    handle: str(p.handle),
    title: str(p.title) ?? "",
    vendor: str(p.vendor),
    productType: str(p.type),
    imageUrl: absUrl(str(p.featured_image)),
    source: ".js",
    variants: (p.variants as Record<string, unknown>[]).map((v) => ({
      id: String(v.id ?? ""),
      title: str(v.title),
      sku: str(v.sku),
      barcode: str(v.barcode),
      price: cents(v.price),
      compareAt: cents(v.compare_at_price),
      currency: null,
      available: typeof v.available === "boolean" ? v.available : null,
      options: Array.isArray(v.options) ? (v.options as unknown[]).map(str).filter((x): x is string => !!x && x !== "Default Title") : [],
    })),
  };
}

/**
 * .json is authoritative for price and currency; .js only fills in
 * availability. If the two disagree on a price, the .json price stands and
 * the disagreement is reported so validation can flag it.
 */
export function mergeShopify(json: ShopifyProduct, js: ShopifyProduct | null): { product: ShopifyProduct; priceDisagreements: string[] } {
  if (!js) return { product: json, priceDisagreements: [] };
  const byId = new Map(js.variants.map((v) => [v.id, v]));
  const disagreements: string[] = [];
  const variants = json.variants.map((v) => {
    const other = byId.get(v.id);
    if (!other) return v;
    if (v.price !== null && other.price !== null && Math.abs(v.price - other.price) > 0.005) {
      disagreements.push(`variant ${v.id}: .json ${v.price} vs .js ${other.price}`);
    }
    return { ...v, available: v.available ?? other.available };
  });
  return { product: { ...json, imageUrl: json.imageUrl ?? js.imageUrl, variants, source: "merged" }, priceDisagreements: disagreements };
}
