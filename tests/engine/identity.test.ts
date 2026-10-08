/* ------------------------------------------------------------------ */
/*  Identity resolution (P5 checks): one product per UPC across stores, */
/*  and size classes never merge.                                       */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { resolveListing } from "@/lib/engine/identity/resolve";
import { decideReview } from "@/lib/engine/identity/review";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import type { Identifier, ListingInput } from "@/lib/engine/types";

function input(
  sourceId: string,
  title: string,
  identifiers: Identifier[] = [],
  over: Partial<ListingInput> = {},
): ListingInput {
  return {
    sourceId,
    url: `https://${SOURCE_SEED.find((s) => s.id === sourceId)!.allowedDomains[0]}/products/${randomUUID().slice(0, 8)}`,
    externalId: null,
    title,
    brand: luggagePack.brandOf(title),
    sizeClass: luggagePack.sizeClassOf(title),
    colour: luggagePack.colourOf(title),
    identifiers,
    imageUrl: null,
    discoveredVia: "sitemap",
    lastmod: null,
    active: true,
    ...over,
  };
}

async function resolveNew(store: MemoryEngineStore, li: ListingInput) {
  const listing = await store.upsertListing(li);
  const r = await resolveListing(store, luggagePack, listing);
  return { r, listing: (await store.getListing(listing.id))! };
}

const OMNI_BLUE = "00043202917998";

describe("identity resolution", () => {
  it("the same UPC at three stores resolves to one product", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const a = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Omni 3.0 Large Spinner Expandable Luggage - Blue", [
        { kind: "gtin", value: OMNI_BLUE },
        { kind: "store_sku", value: "135955-1247", sourceId: "canadaluggagedepot" },
        { kind: "model", value: "samsonite:135955" },
        { kind: "mpn", value: "samsonite:135955-1247" },
      ]),
    );
    expect(a.r.method).toBe("new");
    const b = await resolveNew(
      store,
      input("unluggage", 'Samsonite Omni 3.0 Hardside Spinner 28" Blue', [
        { kind: "gtin", value: OMNI_BLUE },
      ]),
    );
    const c = await resolveNew(
      store,
      input(
        "ebay-ca",
        "NEW Samsonite Omni 3.0 Large 28 inch Spinner BLUE",
        [{ kind: "gtin", value: OMNI_BLUE }],
        { url: "https://www.ebay.ca/itm/123" },
      ),
    );
    expect(b.r.method).toBe("gtin");
    expect(c.r.method).toBe("gtin");
    expect(new Set([a.listing.productId, b.listing.productId, c.listing.productId]).size).toBe(1);
    // The colour variant is shared too (same GTIN → same variant).
    expect(b.listing.variantId).toBe(a.listing.variantId);
  });

  it("Carry-On, Medium and Large of one line are three products, never merged", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const sizes = [
      "Samsonite Outline Pro Spinner Carry-On",
      "Samsonite Outline Pro Medium Spinner",
      "Samsonite Outline Pro Large Spinner",
    ];
    const resolved = [];
    for (const t of sizes) resolved.push(await resolveNew(store, input("canadaluggagedepot", t)));
    expect(new Set(resolved.map((x) => x.listing.productId)).size).toBe(3);
    // Another store's medium joins the medium, not the others.
    const med = await resolveNew(
      store,
      input("delsey-ca", "Samsonite Outline Pro Medium Spinner, Black"),
    );
    expect(med.r.method).toBe("name");
    expect(med.listing.productId).toBe(resolved[1].listing.productId);
    // An admin can't merge across sizes either.
    await expect(
      store.mergeProducts(resolved[0].listing.productId!, resolved[2].listing.productId!),
    ).rejects.toThrow(/size/);
  });

  it("a model number matches within its size class only", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const medium = await resolveNew(
      store,
      input("unluggage", "Samsonite Outline Pro Medium Spinner - Black", [
        { kind: "model", value: "samsonite:137394" },
      ]),
    );
    const sameModel = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite 137394 Outline Pro 25 inch", [
        { kind: "model", value: "samsonite:137394" },
      ]),
    );
    expect(sameModel.r.method).toBe("model");
    expect(sameModel.listing.productId).toBe(medium.listing.productId);
    const wrongSize = await resolveNew(
      store,
      input("delsey-ca", "Samsonite Outline Pro Carry-On", [
        { kind: "model", value: "samsonite:137394" },
      ]),
    );
    expect(wrongSize.listing.productId).not.toBe(medium.listing.productId);
  });

  it("a near-match goes to review, and approving it merges the listing in", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const base = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Outline Pro Medium Spinner"),
    );
    // One extra line word ("signature"): similar, but not provably the same product.
    const near = await resolveNew(
      store,
      input("delsey-ca", "Samsonite Outline Pro Signature Medium Spinner"),
    );
    expect(near.r.method).toBe("review");
    expect(near.listing.productId).not.toBe(base.listing.productId);
    // Its other colour joins it rather than opening a second review.
    const sibling = await resolveNew(
      store,
      input("delsey-ca", "Samsonite Outline Pro Signature Medium Spinner - Black"),
    );
    expect(sibling.listing.productId).toBe(near.listing.productId);
    expect(await store.listReviews("pending", 10)).toHaveLength(1);
    const [item] = await store.listReviews("pending", 10);
    expect(item.candidateProductId).toBe(base.listing.productId);
    const decided = await decideReview(store, item.id, "approved", null);
    expect(decided.ok).toBe(true);
    expect((await store.getListing(near.listing.id))!.productId).toBe(base.listing.productId);
    expect((await store.getListing(sibling.listing.id))!.productId).toBe(base.listing.productId);
  });

  it("different version numbers never match (Omni 2 vs Omni 3.0)", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const v3 = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Omni 3.0 Large Spinner"),
    );
    const v2 = await resolveNew(store, input("delsey-ca", "Samsonite Omni 2 Large Spinner"));
    expect(v2.listing.productId).not.toBe(v3.listing.productId);
    expect(v2.r.method).toBe("new");
  });

  it("International, International Expandable and Domestic carry-ons stay apart (real CLD titles)", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const intl = await resolveNew(
      store,
      input(
        "canadaluggagedepot",
        "Tumi 19 Degree Aluminum International Carry-On Luggage - Silver",
      ),
    );
    const sameIntl = await resolveNew(
      store,
      input(
        "canadaluggagedepot",
        "Tumi 19 Degree Aluminum International Carry-On Luggage - Matte Black",
      ),
    );
    const expandable = await resolveNew(
      store,
      input(
        "canadaluggagedepot",
        "Tumi 19 Degree Aluminum International Expandable Carry-On Luggage - Silver",
      ),
    );
    const domestic = await resolveNew(
      store,
      input("canadaluggagedepot", "Tumi 19 Degree Aluminum Domestic Carry-On Luggage - Silver"),
    );
    expect(sameIntl.listing.productId).toBe(intl.listing.productId);
    expect(expandable.listing.productId).not.toBe(intl.listing.productId);
    expect(domestic.listing.productId).not.toBe(intl.listing.productId);
    expect(domestic.listing.productId).not.toBe(expandable.listing.productId);
  });

  it("two stated sizes in one size class are two products, with no review (Nexis Large 28 vs 31)", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const l28 = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Nexis Spinner Large Luggage (28)"),
    );
    const l31 = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Nexis Spinner Large Luggage (31)"),
    );
    expect(l31.listing.productId).not.toBe(l28.listing.productId);
    expect(l31.r.method).toBe("new");
    expect(await store.listReviews("pending", 10)).toHaveLength(0);
  });

  it("an unknown size is kept apart and flagged; a GTIN conflict is flagged", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const noSize = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Omni 3.0 Spinner"),
    );
    expect(noSize.r.method).toBe("review");
    const pending = await store.listReviews("pending", 10);
    expect(pending.some((p) => p.reasons.includes("size class unknown"))).toBe(true);

    const p1 = await resolveNew(
      store,
      input("canadaluggagedepot", 'Heys Xtrak 26"', [{ kind: "gtin", value: "00000000000017" }]),
    );
    const other = await store.createProduct({
      category: "luggage",
      brand: "Heys",
      line: "core",
      name: "Heys Core 21",
      sizeClass: "carry_on",
      identityKey: null,
    });
    expect(await store.addIdentifier(other.id, null, "gtin", "00000000000017")).toBe("conflict");
    expect(p1.listing.productId).not.toBe(other.id);
  });

  it("split gives a wrongly linked listing a product of its own", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const a = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Outline Pro Medium Spinner"),
    );
    const b = await resolveNew(store, input("delsey-ca", "Samsonite Outline Pro Medium Spinner"));
    expect(b.listing.productId).toBe(a.listing.productId);
    const own = await store.splitListing(b.listing.id);
    expect((await store.getListing(b.listing.id))!.productId).toBe(own.id);
    expect(own.id).not.toBe(a.listing.productId);
  });
});
