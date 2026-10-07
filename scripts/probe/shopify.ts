/* ------------------------------------------------------------------ */
/*  Shopify public product data: /products/<handle>.json and .js      */
/* ------------------------------------------------------------------ */

export type NormVariant = {
  id: string;
  title: string | null;
  sku: string | null;
  barcode: string | null;
  price: number | null;
  compareAt: number | null;
  currency: string | null;
  available: boolean | null;
  inventory: number | null;
  options: string[];
};

export type NormProduct = {
  source: string;
  id: string | null;
  title: string | null;
  vendor: string | null;
  type: string | null;
  updatedAt: string | null;
  variants: NormVariant[];
  /** Field names actually present in the payload (schema discovery). */
  fieldsSeen: string[];
};

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const toStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

/** /products/<handle>.json — prices are decimal strings. */
export function parseProductJson(text: string): NormProduct | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const p = (data as { product?: Record<string, unknown> })?.product;
  if (!p) return null;
  const variants = Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : [];
  const fields = new Set<string>(Object.keys(p).map((k) => `product.${k}`));
  for (const v of variants) for (const k of Object.keys(v)) fields.add(`variant.${k}`);
  return {
    source: "product.json",
    id: toStr(p.id),
    title: toStr(p.title),
    vendor: toStr(p.vendor),
    type: toStr(p.product_type),
    updatedAt: toStr(p.updated_at),
    variants: variants.map((v) => ({
      id: String(v.id ?? ""),
      title: toStr(v.title),
      sku: toStr(v.sku),
      barcode: toStr(v.barcode),
      price: toNum(v.price),
      compareAt: toNum(v.compare_at_price),
      currency: toStr(v.price_currency) ?? null,
      available: typeof v.available === "boolean" ? v.available : null,
      inventory: toNum(v.inventory_quantity),
      options: [v.option1, v.option2, v.option3].map(toStr).filter((x): x is string => !!x),
    })),
    fieldsSeen: [...fields].sort(),
  };
}

/** /products/<handle>.js — prices are integers in cents, `available` per variant. */
export function parseProductJs(text: string): NormProduct | null {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!p || !Array.isArray(p.variants)) return null;
  const variants = p.variants as Record<string, unknown>[];
  const fields = new Set<string>(Object.keys(p).map((k) => `product.${k}`));
  for (const v of variants) for (const k of Object.keys(v)) fields.add(`variant.${k}`);
  const cents = (v: unknown) => {
    const n = toNum(v);
    return n === null ? null : n / 100;
  };
  return {
    source: "product.js",
    id: toStr(p.id),
    title: toStr(p.title),
    vendor: toStr(p.vendor),
    type: toStr(p.type),
    updatedAt: null,
    variants: variants.map((v) => ({
      id: String(v.id ?? ""),
      title: toStr(v.title),
      sku: toStr(v.sku),
      barcode: toStr(v.barcode),
      price: cents(v.price),
      compareAt: cents(v.compare_at_price),
      currency: null,
      available: typeof v.available === "boolean" ? v.available : null,
      inventory: toNum(v.inventory_quantity),
      options: Array.isArray(v.options) ? (v.options as unknown[]).map(toStr).filter((x): x is string => !!x) : [],
    })),
    fieldsSeen: [...fields].sort(),
  };
}
