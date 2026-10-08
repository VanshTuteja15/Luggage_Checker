/* ------------------------------------------------------------------ */
/*  Identity resolution: which product is this listing?               */
/*                                                                     */
/*  Order (deterministic first, MASTER_PROMPT §2B):                     */
/*    1. GTIN / UPC           — the same barcode is the same item       */
/*    2. model number (+ colour code), within one size class            */
/*    3. brand + product line + size class (+ colour for the variant)   */
/*    4. anything uncertain → admin review queue (an AI tie-break may   */
/*       rank candidates later; it never invents a match)               */
/*  Size classes are a hard wall: a carry-on, a medium and a large of   */
/*  the same line never resolve to one product, whatever else matches.  */
/* ------------------------------------------------------------------ */

import type { CatalogProduct, EngineStore } from "../store/port";
import type { CategoryPack, Identifier, ListingRecord } from "../types";

export type Resolution = {
  productId: string | null;
  variantId: string | null;
  method: "gtin" | "model" | "name" | "new" | "review" | "unresolved";
  reasons: string[];
};

const ids = (list: Identifier[], kind: Identifier["kind"]) => list.filter((i) => i.kind === kind).map((i) => i.value);

/** brand|line words (sorted)|size: the name-level identity of a product. */
export function identityKey(brand: string | null, line: string[], sizeClass: string | null): string | null {
  if (!brand || line.length === 0 || !sizeClass) return null;
  return `${brand.toLowerCase()}|${[...line].sort().join(" ")}|${sizeClass}`;
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Numbers in a line ("Omni 3.0", "Maxlite 5", "Alpha 3") must agree exactly. */
function versionsAgree(a: string[], b: string[]): boolean {
  const na = a.filter((w) => /\d/.test(w)).sort().join(" ");
  const nb = b.filter((w) => /\d/.test(w)).sort().join(" ");
  return na === nb;
}

function sizeCompatible(product: CatalogProduct, sizeClass: string | null): boolean {
  return product.sizeClass === null || sizeClass === null || product.sizeClass === sizeClass;
}

async function attach(store: EngineStore, listing: ListingRecord, product: CatalogProduct, colourCode: string | null): Promise<string | null> {
  const variant = await store.findOrCreateVariant(product.id, listing.colour, colourCode, listing.title, listing.imageUrl);
  await store.linkListing(listing.id, product.id, variant.id);
  // Record what this listing taught us (GTIN on the variant, model on the product, SKU per store).
  for (const i of listing.identifiers) {
    const r = await store.addIdentifier(product.id, i.kind === "gtin" || i.kind === "mpn" ? variant.id : null, i.kind, i.value, i.kind === "store_sku" ? listing.sourceId : undefined);
    // The same barcode/model on two products means one of the links is wrong: a human decides.
    if (r === "conflict" && i.kind !== "store_sku") {
      await store.enqueueReview(listing.id, product.id, 0.4, [`${i.kind} ${i.value} is already recorded on another product`]);
    }
  }
  return variant.id;
}

function colourCodeOf(listing: ListingRecord): string | null {
  const mpn = ids(listing.identifiers, "mpn")[0];
  return mpn?.split("-").pop() ?? null;
}

export async function resolveListing(store: EngineStore, pack: CategoryPack, listing: ListingRecord): Promise<Resolution> {
  if (listing.productId) return { productId: listing.productId, variantId: listing.variantId, method: "unresolved", reasons: ["already linked"] };
  const sizeClass = listing.sizeClass ?? pack.sizeClassOf(listing.title);
  const brand = listing.brand ?? pack.brandOf(listing.title);
  const line = pack.lineOf(listing.title, brand);
  const colourCode = colourCodeOf(listing);
  const reasons: string[] = [];

  /* 1. GTIN */
  for (const gtin of ids(listing.identifiers, "gtin")) {
    const hits = await store.findProductsByIdentifier("gtin", gtin);
    if (hits.length === 1) {
      const p = await store.getProduct(hits[0]);
      if (p && sizeCompatible(p, sizeClass)) {
        const variantId = await attach(store, listing, p, colourCode);
        return { productId: p.id, variantId, method: "gtin", reasons: [`GTIN ${gtin}`] };
      }
      if (p) {
        await store.enqueueReview(listing.id, p.id, 0.5, [`GTIN ${gtin} matches a ${p.sizeClass} product but this listing reads as ${sizeClass}`]);
        return { productId: null, variantId: null, method: "review", reasons: ["GTIN matches a product of another size"] };
      }
    }
    if (hits.length > 1) reasons.push(`GTIN ${gtin} is on ${hits.length} products`);
  }

  /* 2. manufacturer model number, same size class */
  for (const model of ids(listing.identifiers, "model")) {
    const hits = await store.findProductsByIdentifier("model", model);
    const products = (await Promise.all(hits.map((h) => store.getProduct(h)))).filter((p): p is CatalogProduct => !!p && sizeCompatible(p, sizeClass));
    if (products.length === 1) {
      const variantId = await attach(store, listing, products[0], colourCode);
      return { productId: products[0].id, variantId, method: "model", reasons: [`model ${model}`] };
    }
    if (products.length > 1) reasons.push(`model ${model} on ${products.length} products`);
  }

  /* 3. brand + line + size class */
  const key = identityKey(brand, line, sizeClass);
  if (key) {
    const exact = await store.findProductByIdentityKey(key);
    if (exact) {
      const variantId = await attach(store, listing, exact, colourCode);
      return { productId: exact.id, variantId, method: "name", reasons: [`same brand, line and size (${key})`] };
    }
    const candidates = await store.candidateProducts(brand!, sizeClass);
    let best: { p: CatalogProduct; score: number } | null = null;
    for (const p of candidates) {
      const pLine = (p.line ?? "").split(" ").filter(Boolean);
      if (!versionsAgree(pLine, line)) continue;
      const score = jaccard(pLine, line);
      if (!best || score > best.score) best = { p, score };
    }
    if (best && best.score >= 0.6) {
      // Close but not identical (e.g. "outline pro" vs "outline pro hardside"): a human decides.
      const listingProduct = await createFor(store, listing, brand, line, sizeClass, null);
      await store.enqueueReview(listing.id, best.p.id, best.score, [`similar line: "${best.p.line}" vs "${line.join(" ")}"`, ...reasons]);
      return { productId: listingProduct, variantId: null, method: "review", reasons: [`near match (${best.score.toFixed(2)}) queued for review`] };
    }
  }

  /* 4. a new product of its own */
  if (!sizeClass || !brand) {
    // Without a size class or brand we can't be sure what it is: own product, flagged.
    const productId = await createFor(store, listing, brand, line, sizeClass, null);
    await store.enqueueReview(listing.id, null, 0, [!brand ? "brand unknown" : "size class unknown", ...reasons]);
    return { productId, variantId: null, method: "review", reasons: ["created, flagged for review"] };
  }
  const productId = await createFor(store, listing, brand, line, sizeClass, key);
  return { productId, variantId: (await store.getListing(listing.id))?.variantId ?? null, method: "new", reasons };
}

async function createFor(store: EngineStore, listing: ListingRecord, brand: string | null, line: string[], sizeClass: string | null, key: string | null): Promise<string> {
  const p = await store.createProduct({ category: "luggage", brand, line: line.join(" ") || null, name: listing.title.replace(/\s+-\s+[^-]{2,30}$/, ""), sizeClass, identityKey: key });
  const colourCode = colourCodeOf(listing);
  await attach(store, listing, p, colourCode);
  return p.id;
}
