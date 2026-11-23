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
import { adviseReview, hardVeto, identityKey, nearMatch, type NearMatch } from "./match";

export { identityKey };

export type Resolution = {
  productId: string | null;
  variantId: string | null;
  method: "gtin" | "sku" | "model" | "name" | "new" | "review" | "unresolved";
  reasons: string[];
};

const ids = (list: Identifier[], kind: Identifier["kind"]) =>
  list.filter((i) => i.kind === kind).map((i) => i.value);

/** Numbers in a line ("Omni 3.0", "Maxlite 5", "Alpha 3") must agree exactly. */
function versionsAgree(a: string[], b: string[]): boolean {
  const na = a
    .filter((w) => /\d/.test(w))
    .sort()
    .join(" ");
  const nb = b
    .filter((w) => /\d/.test(w))
    .sort()
    .join(" ");
  return na === nb;
}

function sizeCompatible(product: CatalogProduct, sizeClass: string | null): boolean {
  return product.sizeClass === null || sizeClass === null || product.sizeClass === sizeClass;
}

async function attach(
  store: EngineStore,
  listing: ListingRecord,
  product: CatalogProduct,
  colourCode: string | null,
): Promise<string | null> {
  const variant = await store.findOrCreateVariant(
    product.id,
    listing.colour,
    colourCode,
    listing.title,
    listing.imageUrl,
  );
  await store.linkListing(listing.id, product.id, variant.id);
  // Record what this listing taught us (GTIN on the variant, model on the product, SKU per store).
  for (const i of listing.identifiers) {
    const r = await store.addIdentifier(
      product.id,
      i.kind === "gtin" || i.kind === "mpn" ? variant.id : null,
      i.kind,
      i.value,
      i.kind === "store_sku" ? listing.sourceId : undefined,
    );
    // The same barcode/model on two products means one of the links is wrong: a human decides.
    if (r === "conflict" && i.kind !== "store_sku") {
      await store.enqueueReview(listing.id, product.id, 0.4, [
        `${i.kind} ${i.value} is already recorded on another product`,
      ]);
    }
  }
  return variant.id;
}

function colourCodeOf(listing: ListingRecord): string | null {
  const mpn = ids(listing.identifiers, "mpn")[0];
  return mpn?.split("-").pop() ?? null;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** "/fr/products/…" → "fr": a store's pages in another language are the same products. */
const langOf = (url: string) =>
  pathOf(url)
    .match(/^\/([a-z]{2})(?:-[a-z]{2})?\//i)?.[1]
    ?.toLowerCase() ?? "";

/**
 * Does the listing's own store already sell the candidate as a page of its own
 * (another store product id, else another page)? Then the store itself tells
 * the two apart (A5.3). Variant pages of one product share its id.
 */
async function storeListsApart(
  store: EngineStore,
  listing: ListingRecord,
  productId: string,
): Promise<boolean> {
  const samePage = (l: ListingRecord) =>
    l.externalId && listing.externalId
      ? l.externalId === listing.externalId
      : pathOf(l.url) === pathOf(listing.url);
  return (await store.listingsForProduct(productId)).some(
    (l) =>
      l.sourceId === listing.sourceId &&
      l.id !== listing.id &&
      langOf(l.url) === langOf(listing.url) &&
      !samePage(l),
  );
}

/**
 * Is this candidate product a real near match for the listing (A5.3)? Hard
 * vetoes first, then the product-word rule: names at most one word apart, or,
 * when the store lists the candidate as another of its own pages, only the
 * colour part may differ. Shared by resolution and the queue re-check.
 */
export async function judgeCandidate(
  store: EngineStore,
  pack: CategoryPack,
  listing: ListingRecord,
  product: CatalogProduct,
): Promise<NearMatch> {
  const veto = hardVeto(pack, product.name, listing.title);
  if (veto) return { near: false, score: 0, why: veto };
  const brand = listing.brand ?? pack.brandOf(listing.title);
  const a = { title: product.name, brand: product.brand };
  const b = { title: listing.title, brand };
  const loose = nearMatch(pack, a, b, false);
  if (!loose.near) return loose;
  return (await storeListsApart(store, listing, product.id)) ? nearMatch(pack, a, b, true) : loose;
}

export async function resolveListing(
  store: EngineStore,
  pack: CategoryPack,
  listing: ListingRecord,
): Promise<Resolution> {
  if (listing.productId)
    return {
      productId: listing.productId,
      variantId: listing.variantId,
      method: "unresolved",
      reasons: ["already linked"],
    };
  const sizeClass = listing.sizeClass ?? pack.sizeClassOf(listing.title);
  const brand = listing.brand ?? pack.brandOf(listing.title);
  const line = pack.lineOf(listing.title, brand);
  const inches = pack.inchesOf(listing.title);
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
        await store.enqueueReview(listing.id, p.id, 0.5, [
          `GTIN ${gtin} matches a ${p.sizeClass} product but this listing reads as ${sizeClass}`,
        ]);
        return {
          productId: null,
          variantId: null,
          method: "review",
          reasons: ["GTIN matches a product of another size"],
        };
      }
    }
    if (hits.length > 1) reasons.push(`GTIN ${gtin} is on ${hits.length} products`);
  }

  /* 1b. the same SKU at the same store is the same product (v4 A5.1) */
  for (const sku of ids(listing.identifiers, "store_sku")) {
    const hits = await store.findProductsByIdentifier("store_sku", sku, listing.sourceId);
    const products = (await Promise.all(hits.map((h) => store.getProduct(h)))).filter(
      (p): p is CatalogProduct => !!p && sizeCompatible(p, sizeClass),
    );
    if (products.length === 1) {
      const variantId = await attach(store, listing, products[0], colourCode);
      return {
        productId: products[0].id,
        variantId,
        method: "sku",
        reasons: [`${listing.sourceId} SKU ${sku}`],
      };
    }
  }

  /* 2. manufacturer model number, same size class */
  for (const model of ids(listing.identifiers, "model")) {
    const hits = await store.findProductsByIdentifier("model", model);
    const products = (await Promise.all(hits.map((h) => store.getProduct(h)))).filter(
      (p): p is CatalogProduct => !!p && sizeCompatible(p, sizeClass),
    );
    if (products.length === 1) {
      const variantId = await attach(store, listing, products[0], colourCode);
      return { productId: products[0].id, variantId, method: "model", reasons: [`model ${model}`] };
    }
    if (products.length > 1) reasons.push(`model ${model} on ${products.length} products`);
  }

  /* 3. brand + line + size class */
  const key = identityKey(brand, line, sizeClass, inches);
  if (key) {
    const exact = await store.findProductByIdentityKey(key);
    if (exact) {
      // v4 A5.1: one store selling two products under one name in the same
      // colour (Ventra "Large" Carry-On vs Carry-On before the A3.0 fix):
      // different store products never merge on the name alone.
      const clash = listing.externalId
        ? (await store.listingsForProduct(exact.id)).find(
            (l) =>
              l.sourceId === listing.sourceId &&
              l.id !== listing.id &&
              !!l.externalId &&
              l.externalId !== listing.externalId &&
              (l.colour ?? "").toLowerCase() === (listing.colour ?? "").toLowerCase(),
          )
        : undefined;
      if (clash) {
        const own = await createFor(store, listing, brand, line, sizeClass, null);
        await store.enqueueReview(listing.id, exact.id, 0.9, [
          `${listing.sourceId} also sells "${clash.title}" under this name`,
          ...reasons,
        ]);
        // Same request shape as the review row rebuilds (identity/advice.ts).
        await adviseReview({
          a: listing.title,
          b: exact.name,
          storeA: listing.sourceId,
          storeB: "our catalogue",
        });
        return {
          productId: own,
          variantId: null,
          method: "review",
          reasons: ["same name as another product at this store: queued for review"],
        };
      }
      const variantId = await attach(store, listing, exact, colourCode);
      return {
        productId: exact.id,
        variantId,
        method: "name",
        reasons: [`same brand, line and size (${key})`],
      };
    }
    const candidates = await store.candidateProducts(brand!, sizeClass);
    const close: { p: CatalogProduct; score: number }[] = [];
    for (const p of candidates) {
      const pLine = (p.line ?? "").split(" ").filter(Boolean);
      if (!versionsAgree(pLine, line)) continue;
      // Both state a size and they differ (Nexis Large 28 vs 31): not the same bag.
      const pInches = Number(p.identityKey?.match(/\|(\d+)in$/)?.[1]) || pack.inchesOf(p.name);
      if (inches && pInches && inches !== pInches) continue;
      // v4 A5.2: an edition, a Large/Compact carry-on, International/Lite/… on one side.
      if (hardVeto(pack, p.name, listing.title)) continue;
      // v4 A5.3: names more than one product word apart are never near matches.
      const loose = nearMatch(
        pack,
        { title: p.name, brand: p.brand },
        { title: listing.title, brand },
        false,
      );
      if (loose.near) close.push({ p, score: loose.score });
    }
    // Best first; a candidate the store lists as another of its own pages must
    // differ only in the colour part (owner 2026-10-30: only real near matches).
    close.sort((x, y) => y.score - x.score);
    let best: { p: CatalogProduct; score: number; why: string } | null = null;
    for (const c of close) {
      const j = await judgeCandidate(store, pack, listing, c.p);
      if (j.near) {
        best = { p: c.p, score: j.score, why: j.why };
        break;
      }
    }
    if (best) {
      // Close but not provably the same (e.g. "outline pro" vs "outline pro signature",
      // or a store's colour page): a human decides.
      // The new product keeps its own key so its other colours join it instead of
      // each opening another review; approving a merge moves them all.
      const listingProduct = await createFor(store, listing, brand, line, sizeClass, key);
      await store.enqueueReview(listing.id, best.p.id, best.score, [
        `similar line: "${best.p.line}" vs "${line.join(" ")}"`,
        best.why,
        ...reasons,
      ]);
      await adviseReview({
        a: listing.title,
        b: best.p.name,
        storeA: listing.sourceId,
        storeB: "our catalogue",
      });
      return {
        productId: listingProduct,
        variantId: null,
        method: "review",
        reasons: [`near match (${best.score.toFixed(2)}) queued for review`],
      };
    }
  }

  /* 4. a new product of its own */
  if (!sizeClass || !brand) {
    // Without a size class or brand we can't match it safely: it gets a product of
    // its own. No review either (owner 2026-10-30: the queue holds only real near
    // matches); with no candidate there is nothing for a person to join it to.
    const productId = await createFor(store, listing, brand, line, sizeClass, null);
    return {
      productId,
      variantId: null,
      method: "new",
      reasons: [...reasons, `${!brand ? "brand" : "size class"} unknown: kept on its own`],
    };
  }
  const productId = await createFor(store, listing, brand, line, sizeClass, key);
  return {
    productId,
    variantId: (await store.getListing(listing.id))?.variantId ?? null,
    method: "new",
    reasons,
  };
}

async function createFor(
  store: EngineStore,
  listing: ListingRecord,
  brand: string | null,
  line: string[],
  sizeClass: string | null,
  key: string | null,
): Promise<string> {
  const p = await store.createProduct({
    category: "luggage",
    brand,
    line: line.join(" ") || null,
    name: listing.title.replace(/\s+-\s+[^-]{2,30}$/, ""),
    sizeClass,
    identityKey: key,
  });
  const colourCode = colourCodeOf(listing);
  await attach(store, listing, p, colourCode);
  return p.id;
}
