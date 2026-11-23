/* ------------------------------------------------------------------ */
/*  v5 F2.1–F2.2: the query parser, size table, vocabulary and typos   */
/* ------------------------------------------------------------------ */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classFromInches, luggagePack as P } from "@/lib/engine/packs/luggage";
import {
  correctWord,
  editDistance,
  EMPTY_VOCABULARY,
  setVocabulary,
  vocabularyFromRows,
} from "@/lib/engine/query";
import { ensureVocabulary } from "@/lib/engine/query/load";
import { suggestFor } from "@/lib/engine/query/suggest";
import { markVocabularyStale } from "@/lib/engine/query/vocabulary";
import { BASE_VOCABULARY } from "@/lib/engine/query/vocabulary-base";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { matchScore, requiredTerms, sizeFilterOf } from "@/lib/engine/store/terms";

beforeEach(() => setVocabulary(BASE_VOCABULARY));
afterEach(() => setVocabulary(EMPTY_VOCABULARY));

describe("F2.1 inches → size class (the owner's table)", () => {
  it("carry-on ≤ 22, medium 23–26, large 27–30, extra large ≥ 31", () => {
    const table: [number, string][] = [
      [18, "carry_on"],
      [22, "carry_on"],
      [23, "medium"],
      [26, "medium"],
      [27, "large"],
      [30, "large"],
      [31, "extra_large"],
      [34, "extra_large"],
    ];
    for (const [n, cls] of table) expect(classFromInches(n), `${n}"`).toBe(cls);
    expect(classFromInches(16)).toBe("underseat");
    expect(classFromInches(40)).toBeNull();
  });

  it("a store's own size word always wins over its inches", () => {
    expect(P.sizeClassOf("CHATELET AIR 2.0 | 23-Inch Carry-On Suitcase, Brown")).toBe("carry_on");
    expect(P.sizeClassOf('Eagle Creek Expanse 2-Wheel 30" Luggage')).toBe("large");
  });

  it("a query's inches read the way the brand's own titles name that size", () => {
    expect(P.parseQuery("Delsey Chatelet Air 2.0 23 inch")).toMatchObject({
      sizeClass: "carry_on",
      inches: 23,
      sizeByMeasure: true,
    });
    expect(P.parseQuery("samsonite nexis 31 inch spinner").sizeClass).toBe("large");
    // No override: the table.
    expect(P.parseQuery("Travelpro Maxlite 5 23 inch").sizeClass).toBe("medium");
    // A size word in the query wins, even with inches.
    expect(P.parseQuery("Delsey Cosmique 23-inch carry on")).toMatchObject({
      sizeClass: "carry_on",
      sizeByMeasure: false,
    });
  });

  it('"Delsey 23 inch" matches Delsey\'s 23" bags whatever size word their titles use', () => {
    const q = P.parseQuery("Delsey Chatelet Air 2.0 23 inch");
    expect(sizeFilterOf(q)).toBeNull(); // matched on the inches, not a class
    const haystack = new Set(["delsey", "chatelet", "air", "2.0", "23", "inch", "carry", "on"]);
    expect(matchScore(q, haystack, "carry_on")).toBeGreaterThan(0);
    expect(matchScore(q, haystack, "medium")).toBeGreaterThan(0);
    // With a size word, the class still filters.
    const worded = P.parseQuery("Delsey Chatelet Air 2.0 medium");
    expect(matchScore(worded, haystack, "carry_on")).toBe(0);
  });
});

describe("F2.2 the parser", () => {
  it("bare inches right after the bag's words; a number before a line word is part of the line", () => {
    expect(P.parseQuery("Travelpro Platinum Elite 21")).toMatchObject({
      inches: 21,
      sizeClass: "carry_on",
      line: ["platinum", "elite"],
    });
    expect(P.parseQuery("Nexis Large 28")).toMatchObject({ inches: 28, sizeClass: "large" });
    expect(P.parseQuery("TUMI 19 Degree International Expandable carry-on")).toMatchObject({
      inches: null,
      line: ["19", "degree", "international", "expandable"],
      optionalLine: ["international", "expandable"],
    });
  });

  it("price limits, in stock, cheapest and a named store", () => {
    expect(P.parseQuery("medium spinner between 200 and 300")).toMatchObject({
      minPrice: 200,
      maxPrice: 300,
      type: "spinner",
      line: [],
    });
    expect(P.parseQuery("samsonite under $250").maxPrice).toBe(250);
    expect(P.parseQuery("carry-on over $150").minPrice).toBe(150);
    expect(P.parseQuery("luggage over 26 inches").minPrice).toBeNull(); // a size, not a price
    expect(P.parseQuery("cheapest Travelpro carry-on in stock")).toMatchObject({
      sort: "price",
      inStock: true,
      brand: "Travelpro",
    });
    expect(P.parseQuery("Samsonite Paralux medium at Amazon")).toMatchObject({
      storeIds: ["amazon-ca"],
      brand: "Samsonite",
      line: ["paralux"],
    });
    // "carry-on" is never the store preposition "on".
    expect(P.parseQuery("carry on samsonite").storeIds).toEqual([]);
    // A brand's own store implies the brand.
    expect(P.parseQuery("carry-on at Samsonite")).toMatchObject({
      storeIds: ["samsonite-ca"],
      brand: "Samsonite",
    });
  });

  it("synonyms and French", () => {
    for (const q of ["hand luggage", "cabin bag samsonite", "bagage à main 55 cm", "valise cabine"])
      expect(P.parseQuery(q).sizeClass, q).toBe("carry_on");
    expect(P.parseQuery("grande valise rigide samsonite")).toMatchObject({
      sizeClass: "large",
      shell: "hard",
      line: [],
    });
    expect(P.parseQuery("sac à dos herschel")).toMatchObject({
      type: "backpack",
      brand: "Herschel",
    });
    expect(P.parseQuery("herschel hard shell large")).toMatchObject({ shell: "hard", line: [] });
  });

  it("type, shell, material and colour, but not a colour inside a line's name", () => {
    expect(P.parseQuery("Samsonite Andante 2 wheeled duffel 28").type).toBe("duffel");
    expect(P.parseQuery("aluminum carry-on")).toMatchObject({
      material: "aluminium",
      line: [],
    });
    expect(P.parseQuery("Delsey ALU'R 28").material).toBeNull();
    expect(P.parseQuery("samsonite black label c-lite 28")).toMatchObject({
      colour: null,
      line: ["black", "label", "c", "lite"],
    });
    expect(P.parseQuery("Samsonite Evoa Z medium black").colour).toBe("Black");
  });

  it("noise words never become a product line", () => {
    expect(P.parseQuery("carry on for getting away this weekend").line).toEqual([]);
    expect(P.parseQuery("cheap kids suitcase").line).toEqual([]);
    expect(P.parseQuery("Samsonite Sky Max 3.0 spinner medium").line).toEqual(["sky", "max", "3.0"]);
  });

  it("brands our catalogue sells that the pack doesn't list", () => {
    expect(P.parseQuery("Dakine split roller 85L")).toMatchObject({
      brand: "Dakine",
      line: ["split", "roller"],
      litres: 85,
    });
    expect(P.parseQuery("Peak Design packing cube").brand).toBe("Peak Design");
    setVocabulary(EMPTY_VOCABULARY);
    expect(P.parseQuery("Dakine split roller 85L").brand).toBeNull();
  });
});

describe("F2.2 typos and Did you mean", () => {
  it("edit distance counts a swap of two neighbours as one edit", () => {
    expect(editDistance("alpah", "alpha")).toBe(1);
    expect(editDistance("samsonte", "samsonite")).toBe(1);
    expect(editDistance("abc", "xyz", 2)).toBe(3);
  });

  it("corrects brand and line typos, and says what was typed", () => {
    const q = P.parseQuery("samsonte paralx medium");
    expect(q).toMatchObject({
      brand: "Samsonite",
      line: ["paralux"],
      correctedFrom: "samsonte paralx medium",
    });
    expect(P.parseQuery("tumi alpah bravo backpack").line).toEqual(["alpha", "bravo"]);
    expect(P.parseQuery("travlepro platinum elite carry-on").brand).toBe("Travelpro");
  });

  it("leaves real words alone: no correction without a brand nearby, and short words never", () => {
    expect(P.parseQuery("Samsonite Paralux medium").correctedFrom).toBeNull();
    expect(P.parseQuery("away the bigger carry-on").line).toEqual(["bigger"]);
    expect(correctWord("bag", new Map([["bags", 10]]))).toBeNull();
    // Two equally close, equally common words: nothing is guessed.
    expect(
      correctWord(
        "mantra",
        new Map([
          ["mantry", 5],
          ["mantre", 5],
        ]),
      ),
    ).toBeNull();
  });
});

describe("F2.2 the vocabulary comes from our catalogue", () => {
  it("brands with too few listings and everyday words never become brands", () => {
    const v = vocabularyFromRows(
      [
        { brand: "Dakine", line: "split roller", listings: 12 },
        { brand: "Canada", line: null, listings: 40 },
        { brand: "Tinybrand", line: "x", listings: 1 },
        { brand: "Dakine", line: "a very long line name here", listings: 3 },
      ],
      "2026-11-23T00:00:00.000Z",
    );
    expect(v.brands.map((b) => b.name)).toEqual(["Dakine"]);
    expect(v.lines.map((l) => l.phrase)).toEqual(["split roller"]);
  });

  it("the server loads it from the store and rebuilds it after discovery", async () => {
    setVocabulary(EMPTY_VOCABULARY);
    const store = new MemoryEngineStore(SOURCE_SEED);
    for (let i = 0; i < 3; i++)
      await store.upsertListing({
        sourceId: "canadaluggagedepot",
        url: `https://www.canadaluggagedepot.ca/products/nomatic-${i}`,
        externalId: null,
        title: `Nomatic Travel Pack ${i}`,
        brand: "Nomatic",
        sizeClass: "backpack",
        colour: null,
        identifiers: [],
        imageUrl: null,
        discoveredVia: "catalog",
        lastmod: null,
        active: true,
      });
    markVocabularyStale();
    await ensureVocabulary(store, Date.now() + 3_600_000);
    expect(P.parseQuery("nomatic travel pack").brand).toBe("Nomatic");
  });

  it("autocomplete: brands, a brand's lines, a mistyped brand, popular searches; nothing under 2 letters", () => {
    expect(suggestFor("s")).toEqual([]);
    expect(suggestFor("samso").map((s) => s.text)).toContain("Samsonite");
    const lines = suggestFor("samsonite para").map((s) => s.text);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((t) => t.startsWith("Samsonite Para"))).toBe(true);
    // One wrong letter in the part typed so far.
    expect(suggestFor("samdon").map((s) => s.text)).toContain("Samsonite");
    const withPopular = suggestFor("dels", [{ query: "delsey chatelet air 2.0 medium", count: 4 }]);
    expect(withPopular.map((s) => s.kind)).toContain("search");
    expect(suggestFor("zzzz")).toEqual([]);
  });

  it("optional words rank but are never required", () => {
    const q = P.parseQuery("briggs and riley baseline global carry on");
    expect(q.line).toEqual(["baseline", "global"]);
    expect(requiredTerms(q)).toEqual(["briggs", "riley", "baseline"]);
  });
});
