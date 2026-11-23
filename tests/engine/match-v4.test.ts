/* ------------------------------------------------------------------ */
/*  Matching v2 (v4 A5): U-MATCH-3…8 and the stricter near-match rule   */
/*  of 2026-10-30 (the owner: the review queue gets only real near      */
/*  matches). Real CLD / Delsey titles unless a line says "constructed". */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { matchJudgeTask } from "@/lib/engine/ai";
import {
  hardVeto,
  matchVerdict,
  nearMatch,
  productName,
  setReviewAdvisor,
  type JudgeRequest,
} from "@/lib/engine/identity/match";
import { resolveListing } from "@/lib/engine/identity/resolve";
import { decideReviews, recheckReviews, wordsApart } from "@/lib/engine/identity/review";
import { luggagePack as pack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import type { Identifier, ListingInput } from "@/lib/engine/types";

const domainOf = (sourceId: string) =>
  SOURCE_SEED.find((s) => s.id === sourceId)!.allowedDomains[0];

function input(
  sourceId: string,
  title: string,
  identifiers: Identifier[] = [],
  over: Partial<ListingInput> = {},
): ListingInput {
  return {
    sourceId,
    url: `https://${domainOf(sourceId)}/products/${randomUUID().slice(0, 8)}`,
    externalId: null,
    title,
    brand: pack.brandOf(title),
    sizeClass: pack.sizeClassOf(title),
    colour: pack.colourOf(title),
    identifiers,
    imageUrl: null,
    discoveredVia: "catalog",
    lastmod: null,
    active: true,
    ...over,
  };
}

async function resolveNew(store: MemoryEngineStore, li: ListingInput) {
  const listing = await store.upsertListing(li);
  const r = await resolveListing(store, pack, listing);
  return { r, listing: (await store.getListing(listing.id))! };
}

const cld = (title: string, externalId: string) =>
  input("canadaluggagedepot", title, [], { externalId });

describe("hard vetoes (U-MATCH-3, A5.2)", () => {
  it("the known traps are never the same product", () => {
    const apart: [string, string][] = [
      ["Samsonite Nexis Spinner Large Luggage (28)", "Samsonite Nexis Spinner Large Luggage (31)"],
      [
        "Samsonite Paralux Hardside Expandable Spinner Medium Luggage",
        "Samsonite Paralux Hardside Expandable Spinner Large Luggage",
      ],
      [
        "SKY MAX 2.0 | 31-Inch Expandable Check-In Suitcase, Green",
        "SKY MAX 3.0 | 31-Inch Check-In Suitcase, Teal blue",
      ],
      [
        "CHATELET AIR 2.0 | 23-Inch Carry-On Suitcase, Brown",
        "CHATELET AIR 2.0 | 23-Inch Expandable Carry-On Suitcase - 80th Anniversary Edition, Burgundy",
      ],
    ];
    for (const [a, b] of apart)
      expect(matchVerdict(pack, { title: a }, { title: b }).verdict, `${a} vs ${b}`).toBe(
        "different",
      );
    // International vs International Expandable: two products of one store.
    expect(
      matchVerdict(
        pack,
        {
          title: "Tumi 19 Degree Aluminum International Carry-On Luggage",
          sourceId: "canadaluggagedepot",
          externalId: "1",
        },
        {
          title: "Tumi 19 Degree Aluminum International Expandable Carry-On Luggage - Silver",
          sourceId: "canadaluggagedepot",
          externalId: "2",
        },
      ).verdict,
    ).toBe("different");
  });

  it("2026-10-30 vetoes: stated sizes, any inch figure, any edition, spinner vs upright", () => {
    const veto = (a: string, b: string) => hardVeto(pack, a, b);
    expect(
      veto(
        "The North Face Base Camp Duffel—S - New Taupe Green/TNF Black-NPF",
        "The North Face Base Camp Duffel—L - New Taupe Green/TNF Black-NPF",
      ),
    ).toMatch(/sizes differ/);
    expect(
      veto(
        "The North Face Pack Rain Cover - L - TNF Black-NPF",
        "The North Face Pack Rain Cover - XL - TNF Black-NPF",
      ),
    ).toMatch(/sizes differ/);
    expect(
      veto('Tumi Alpha Large 15" Laptop Cover - Black', 'Tumi Alpha Medium 13" Laptop Cover'),
    ).toMatch(/inches differ/);
    expect(veto('Eagle Creek ORV 30" Trunk - Black', 'Eagle Creek ORV 36" Trunk')).toMatch(
      /inches differ/,
    );
    expect(
      veto(
        "TURENNE SOFT | 14-Inch Laptop Backpack, Night blue",
        "TURENNE SOFT | 14-Inch Laptop Backpack - Roland Garros Edition, Navy blue",
      ),
    ).toMatch(/edition differs/);
    expect(
      veto(
        "Samsonite Urbify Expandable Spinner Carry-On Luggage - Black",
        'Samsonite Urbify Expandable Upright Carry-On 20" Luggage',
      ),
    ).toMatch(/wheels differ/);
    // Litres, possessives and one size written two ways are not vetoes.
    expect(
      veto(
        "The North Face Base Camp Voyager Duffel—62L - New Taupe Green/TNF Black",
        "The North Face Base Camp Voyager Duffel—62L",
      ),
    ).toBeNull();
    expect(
      veto(
        "The North Face Women's Surge Backpack - TNF Black/TNF Black/NPF",
        "The North Face Women's Surge Backpack",
      ),
    ).toBeNull();
    expect(
      veto("Samsonite Omni PC Extra Large Spinner", "Samsonite Omni PC XL Spinner"),
    ).toBeNull();
  });
});

describe("near matches (A5.3, stricter since 2026-10-30)", () => {
  it("a product's name leaves out the colour part, however long", () => {
    expect(
      productName(
        "The North Face Base Camp Duffel Shoulder Bag - Deep Burgundy/TNF Black/Burgundy Crush",
      ),
    ).toBe("The North Face Base Camp Duffel Shoulder Bag");
    expect(
      productName(
        "Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage - Textured Finish - Grey Textured",
      ),
    ).toBe("Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage");
    expect(productName("CHATELET AIR 2.0 | 14-Inch Laptop Backpack, Navy blue")).toBe(
      "CHATELET AIR 2.0 | 14-Inch Laptop Backpack",
    );
  });

  it("listed apart by one store: only the colour part may differ", () => {
    const tumi = (title: string) => ({ title, brand: "TUMI" });
    expect(
      nearMatch(
        pack,
        tumi("Tumi Alpha Bravo Navigation Leather Backpack - Black"),
        tumi("Tumi Alpha Bravo Navigation Backpack"),
        true,
      ).near,
    ).toBe(false);
    expect(
      nearMatch(
        pack,
        tumi(
          "Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage - Textured Finish - Grey Textured",
        ),
        tumi("Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage"),
        true,
      ).near,
    ).toBe(true);
  });

  it("two stores: at most one product word apart", () => {
    const sam = (title: string) => ({ title, brand: "Samsonite" });
    // Stores drop "Expandable" (CLD vs Amazon.ca, labelled pair p56): a person decides.
    expect(
      nearMatch(
        pack,
        sam("Samsonite Outline Pro Large Expandable Spinner Luggage"),
        sam("Samsonite Outline Pro Spinner Large"),
        false,
      ).near,
    ).toBe(true);
    // Constructed: two words swapped. Overlap 0.6 made this a review before; now it isn't.
    const swap = nearMatch(
      pack,
      sam("Samsonite Pro Elite Hybrid Alpha Medium Spinner"),
      sam("Samsonite Pro Elite Hybrid Omega Medium Spinner"),
      false,
    );
    expect(swap.score).toBeGreaterThanOrEqual(0.6);
    expect(swap.near).toBe(false);
  });

  it("resolution: another product of the same store is no review; its colour page is", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const nav = await resolveNew(store, cld("Tumi Alpha Bravo Navigation Backpack", "101"));
    const leather = await resolveNew(
      store,
      cld("Tumi Alpha Bravo Navigation Leather Backpack - Black", "102"),
    );
    expect(leather.r.method).toBe("new");
    expect(leather.listing.productId).not.toBe(nav.listing.productId);
    const intl = await resolveNew(
      store,
      cld("Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage", "201"),
    );
    const textured = await resolveNew(
      store,
      cld(
        "Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage - Textured Finish - Grey Textured",
        "202",
      ),
    );
    expect(textured.r.method).toBe("review");
    const pending = await store.listReviews("pending", 10);
    expect(pending.map((p) => [p.listingId, p.candidateProductId])).toEqual([
      [textured.listing.id, intl.listing.productId],
    ]);
  });

  it("a suitcase without a size class keeps a product of its own, with no review", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const r = await resolveNew(
      store,
      input("canadaluggagedepot", "Briggs & Riley Baseline Deluxe Wardrobe Spinner - Black"),
    );
    expect(r.r.method).toBe("new");
    expect(r.listing.productId).not.toBeNull();
    expect(await store.listReviews("pending", 10)).toHaveLength(0);
  });
});

describe("store SKU first (U-MATCH-4, U-MATCH-5, A5.1)", () => {
  const sku = (value: string): Identifier => ({ kind: "store_sku", value, sourceId: "delsey-ca" });

  it("the same Delsey code is the same product under another name (COSMIQUE page vs Alexandra FR slug)", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const en = await resolveNew(
      store,
      input("delsey-ca", "COSMIQUE | 32-Inch Expandable Check-In Suitcase, Dark teal", [
        sku("40392683023"),
      ]),
    );
    const fr = await resolveNew(
      store,
      input(
        "delsey-ca",
        "40392683023 Alexandra 32 Inch Expandable Check In Suitcase Dark Teal",
        [sku("40392683023")],
        { url: `https://${domainOf("delsey-ca")}/fr/products/40392683023-alexandra` },
      ),
    );
    expect(fr.r.method).toBe("sku");
    expect(fr.listing.productId).toBe(en.listing.productId);
    expect(
      matchVerdict(
        pack,
        {
          title: "COSMIQUE | 32-Inch Expandable Check-In Suitcase, Dark teal",
          sourceId: "delsey-ca",
          storeSku: "40392683023",
        },
        {
          title: "40392683023 Alexandra 32 Inch Expandable Check In Suitcase Dark Teal",
          sourceId: "delsey-ca",
          storeSku: "40392683023",
        },
      ).verdict,
    ).toBe("same");
  });

  it("three Delsey sets with one name and colour stay three products", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const title = "CHATELET AIR 2.0 | 2-Piece Luggage Set, Brown";
    const sets = [];
    for (const [id, code] of [
      ["8001", "40167697506"],
      ["8002", "40167697606"],
      ["8003", "40167698506"],
    ])
      sets.push(
        await resolveNew(
          store,
          input("delsey-ca", title, [sku(code)], { externalId: id, brand: "Delsey" }),
        ),
      );
    expect(new Set(sets.map((s) => s.listing.productId)).size).toBe(3);
    expect(sets.slice(1).map((s) => s.r.method)).toEqual(["review", "review"]);
    expect(
      matchVerdict(
        pack,
        { title, sourceId: "delsey-ca", storeSku: "40167697506" },
        { title, sourceId: "delsey-ca", storeSku: "40167697606" },
      ).verdict,
    ).toBe("review");
  });
});

describe("the AI judge only advises (U-MATCH-6, U-MATCH-7)", () => {
  afterEach(() => setReviewAdvisor(null));

  it("a near match asks for advice once; matches and other sizes don't; nothing merges", async () => {
    const asked: JudgeRequest[] = [];
    setReviewAdvisor(async (r) => {
      asked.push(r);
    });
    const store = new MemoryEngineStore(SOURCE_SEED);
    const base = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Outline Pro Medium Spinner"),
    );
    expect(
      (await resolveNew(store, input("delsey-ca", "Samsonite Outline Pro Medium Spinner, Black"))).r
        .method,
    ).toBe("name");
    expect(
      (await resolveNew(store, input("delsey-ca", "Samsonite Outline Pro Large Spinner"))).r.method,
    ).toBe("new");
    const near = await resolveNew(
      store,
      input("unluggage", "Samsonite Outline Pro Signature Medium Spinner"),
    );
    expect(near.r.method).toBe("review");
    expect(near.listing.productId).not.toBe(base.listing.productId);
    expect(asked).toEqual([
      {
        a: "Samsonite Outline Pro Signature Medium Spinner",
        b: "Samsonite Outline Pro Medium Spinner",
        storeA: "unluggage",
        storeB: "our catalogue",
      },
    ]);
  });

  it("an advisor that fails never blocks resolution", async () => {
    setReviewAdvisor(async () => {
      throw new Error("queue down");
    });
    const store = new MemoryEngineStore(SOURCE_SEED);
    await resolveNew(store, input("canadaluggagedepot", "Samsonite Outline Pro Medium Spinner"));
    const near = await resolveNew(
      store,
      input("unluggage", "Samsonite Outline Pro Signature Medium Spinner"),
    );
    expect(near.r.method).toBe("review");
  });

  it("hard vetoes beat a judge's 'same' (new vetoes included)", () => {
    const out = matchJudgeTask.evidence(
      {
        a: "The North Face Base Camp Duffel—S - New Taupe Green/TNF Black-NPF",
        b: "The North Face Base Camp Duffel—L - New Taupe Green/TNF Black-NPF",
        storeA: "canadaluggagedepot",
        storeB: "canadaluggagedepot",
      },
      { verdict: "same", reason: "same duffel" },
    );
    expect(out.value.verdict).toBe("different");
    expect(out.dropped[0].reason).toMatch(/hard rule: sizes differ/);
  });
});

describe("the labelled pairs (U-MATCH-8)", () => {
  it("no pair labelled different is ever same or variant", () => {
    const set = (
      JSON.parse(readFileSync("scripts/bench/sets/pairs.json", "utf8")) as {
        items: { id: string; a: string; b: string; expected: string; stores: string[] }[];
      }
    ).items;
    const side = (title: string, sourceId: string) => ({
      title,
      sourceId,
      brand:
        pack.brandOf(title) ??
        SOURCE_SEED.find((s) => s.id === sourceId)?.identityQuality.houseBrand ??
        null,
    });
    const wrong = set.filter((it) => {
      const v = matchVerdict(pack, side(it.a, it.stores[0]), side(it.b, it.stores[1]));
      return it.expected === "different" && (v.verdict === "same" || v.verdict === "variant");
    });
    expect(set.length).toBe(80);
    expect(wrong.map((w) => w.id)).toEqual([]);
  });
});

describe("re-checking the queue (A5.3)", () => {
  it("supersedes what the rules no longer send to a person; keeps real near matches and conflicts", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const nav = await resolveNew(store, cld("Tumi Alpha Bravo Navigation Backpack", "101"));
    const leather = await resolveNew(
      store,
      cld("Tumi Alpha Bravo Navigation Leather Backpack - Black", "102"),
    );
    const intl = await resolveNew(
      store,
      cld("Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage", "201"),
    );
    const textured = await resolveNew(
      store,
      cld(
        "Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage - Textured Finish - Grey Textured",
        "202",
      ),
    );
    // What the old rules queued: a near match by overlap, and a suitcase without a size.
    await store.enqueueReview(leather.listing.id, nav.listing.productId, 0.8, [
      'similar line: "alpha bravo navigation backpack" vs "alpha bravo navigation leather backpack"',
    ]);
    const trolley = await resolveNew(
      store,
      input("canadaluggagedepot", "Rolser Jet LN Joy 2 Wheel Shopping Trolley - Red"),
    );
    await store.enqueueReview(trolley.listing.id, null, 0, ["size class unknown"]);
    // Identifier conflicts are not near matches and stay for a person.
    await store.enqueueReview(leather.listing.id, intl.listing.productId, 0.4, [
      "gtin 00000000000017 is already recorded on another product",
    ]);

    const dry = await recheckReviews(store, pack, { apply: false });
    expect(dry).toMatchObject({ checked: 4, kept: 2, superseded: 2 });
    expect(await store.listReviews("pending", 10)).toHaveLength(4);

    expect((await recheckReviews(store, pack, { apply: true })).superseded).toBe(2);
    const pending = await store.listReviews("pending", 10);
    expect(pending.map((p) => p.listingId).sort()).toEqual(
      [textured.listing.id, leather.listing.id].sort(),
    );
    const superseded = await store.listReviews("superseded", 10);
    expect(superseded).toHaveLength(2);
    for (const s of superseded) expect(s.reasons.at(-1)).toMatch(/^not a real near match/);
    expect((await recheckReviews(store, pack, { apply: true })).superseded).toBe(0);
  });
});

describe("the batch review screen's backend (T-501)", () => {
  it("decides several items like single clicks; a decided or unknown id fails alone", async () => {
    const store = new MemoryEngineStore(SOURCE_SEED);
    const base = await resolveNew(
      store,
      input("canadaluggagedepot", "Samsonite Outline Pro Medium Spinner"),
    );
    const near = await resolveNew(
      store,
      input("unluggage", "Samsonite Outline Pro Signature Medium Spinner"),
    );
    const intl = await resolveNew(
      store,
      cld("Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage", "201"),
    );
    const textured = await resolveNew(
      store,
      cld(
        "Tumi 19 Degree International Expandable 4 Wheeled Carry-On Luggage - Textured Finish - Grey Textured",
        "202",
      ),
    );
    const ids = (await store.listReviews("pending", 10)).map((r) => r.id);
    expect(ids).toHaveLength(2);
    const results = await decideReviews(
      store,
      [...ids, ids[0], "00000000-0000-0000-0000-000000000000"],
      "approved",
      null,
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect((await store.getListing(near.listing.id))!.productId).toBe(base.listing.productId);
    expect((await store.getListing(textured.listing.id))!.productId).toBe(intl.listing.productId);
    expect(await store.listReviews("pending", 10)).toHaveLength(0);
  });

  it("names the words only one side has", () => {
    expect(
      wordsApart(pack, {
        listingTitle: "Samsonite Outline Pro Signature Medium Spinner",
        candidateName: "Samsonite Outline Pro Medium Spinner",
      }),
    ).toEqual({ onlyListing: ["signature"], onlyCandidate: [] });
    expect(
      wordsApart(pack, {
        listingTitle: "Rolser Jet LN Joy 2 Wheel Shopping Trolley",
        candidateName: null,
      }),
    ).toEqual({ onlyListing: [], onlyCandidate: [] });
  });
});
