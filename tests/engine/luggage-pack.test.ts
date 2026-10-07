import { describe, expect, it } from "vitest";
import { luggagePack as P } from "@/lib/engine/packs/luggage";

describe("size classes (identity boundary)", () => {
  const cases: [string, string | null][] = [
    // Real titles from the 7 Oct probe
    ["Samsonite Outline Pro Medium Spinner", "medium"],
    ["Samsonite Omni 3.0 Large Spinner Expandable Luggage", "large"],
    ["WAGRAM | 23-Inch Expandable Carry-On Suitcase, Black", "carry_on"],
    ['Air Canada Logan 20" Hardside Spinner', "carry_on"],
    ["Air Canada Logan Carry-on", "carry_on"],
    // Common shapes
    ["Samsonite Outline Pro Spinner Carry-On™", "carry_on"],
    ["Freeform Spinner 75", "large"],
    ["Freeform Spinner 55", "carry_on"],
    ['Travelpro Maxlite 5 29" Expandable Check-In Spinner', "large"],
    ['Heys Xtrak 26"', "medium"],
    ["Hardside Spinner 28 inch with TSA lock", "large"],
    ["Samsonite Outline Pro 3-Piece Set", "set"],
    ["Samsonite Outline Pro Luggage Cover, Large", "accessory"],
    ["Samsonite Underseater with USB", "underseat"],
    ["Briggs & Riley Baseline Essential Carry-On Expandable Spinner", "carry_on"],
    ["TUMI Alpha 3 Expandable 4 Wheeled Packing Case", null],
  ];
  for (const [title, want] of cases) {
    it(`${title} → ${want}`, () => expect(P.sizeClassOf(title)).toBe(want));
  }

  it("never puts carry-on, medium and large in one class", () => {
    const classes = ["Outline Pro Spinner Carry-On", "Outline Pro Medium Spinner", "Outline Pro Large Spinner"].map(P.sizeClassOf);
    expect(new Set(classes).size).toBe(3);
  });
});

describe("manufacturer model numbers", () => {
  it("Samsonite model + colour code (Canada Luggage Depot SKU)", () => {
    expect(P.modelOf("135955-1247", "Samsonite")).toEqual({ model: "135955", colourCode: "1247" });
  });
  it("Samsonite model + colour name (U.N. Luggage SKU)", () => {
    expect(P.modelOf("137394-Black", "Samsonite")).toEqual({ model: "137394", colourCode: null });
    expect(P.modelOf("137394-Stone Grey", "Samsonite")).toEqual({ model: "137394", colourCode: null });
  });
  it("SFCC concatenated SKU and master id", () => {
    expect(P.modelOf("1373941041", "Samsonite")).toEqual({ model: "137394", colourCode: "1041" });
    expect(P.modelOf("137394XXXX", "Samsonite")).toEqual({ model: "137394", colourCode: null });
  });
  it("TUMI style + colour", () => {
    expect(P.modelOf("expandable-carry-on-01396831041", "TUMI")).toEqual({ model: "0139683", colourCode: "1041" });
  });
  it("Delsey 9-digit model + 2-digit colour", () => {
    expect(P.modelOf("40119980500US", "Delsey")).toEqual({ model: "401199805", colourCode: "00" });
    expect(P.modelOf("40119980502US", "Delsey")).toEqual({ model: "401199805", colourCode: "02" });
  });
  it("doesn't invent a model from an unrelated number", () => {
    expect(P.modelOf("128201001", "Air Canada")).toBeNull();
  });
});

describe("brands and product lines", () => {
  it("normalises brand spellings", () => {
    expect(P.brandOf("DELSEY PARIS")).toBe("Delsey");
    expect(P.brandOf("Briggs & Riley Baseline")).toBe("Briggs & Riley");
    expect(P.brandOf("briggs-riley essential")).toBe("Briggs & Riley");
    expect(P.brandOf("American Tourister Moonlight")).toBe("American Tourister");
  });
  it("doesn't read ordinary words as ambiguous brands", () => {
    expect(P.brandOf("carry-on for a weekend away")).toBeNull();
    expect(P.brandOf("Away The Carry-On")).toBe("Away");
  });
  it("keeps line and version words, drops size, colour and filler", () => {
    expect(P.lineOf("Samsonite Outline Pro Medium Spinner", "Samsonite")).toEqual(["outline", "pro"]);
    expect(P.lineOf("Samsonite Omni 3.0 Large Spinner Expandable Luggage", "Samsonite")).toEqual(["omni", "3.0"]);
    expect(P.lineOf('Travelpro Maxlite 5 21" Expandable Carry-On Spinner', "Travelpro")).toEqual(["maxlite", "5"]);
    expect(P.lineOf("TUMI Alpha 3 International Expandable 4 Wheeled Carry-On", "TUMI")).toEqual(["alpha", "3"]);
    expect(P.lineOf("Outline Pro Spinner Medium, Stone Grey", "Samsonite")).toEqual(["outline", "pro"]);
  });
});

describe("query parsing", () => {
  it("reads brand, line, size, colour and a price cap", () => {
    const q = P.parseQuery("Samsonite Outline Pro carry-on black under $400");
    expect(q.brand).toBe("Samsonite");
    expect(q.line).toEqual(["outline", "pro"]);
    expect(q.sizeClass).toBe("carry_on");
    expect(q.colour).toBe("Black");
    expect(q.maxPrice).toBe(400);
  });
  it("reads a UPC as a GTIN-14", () => {
    expect(P.parseQuery("043202927614").gtin).toBe("00043202927614");
  });
  it("reads a Samsonite model number", () => {
    expect(P.parseQuery("Samsonite 137394-1041").model).toBe("137394");
  });
  it("plain line queries", () => {
    const q = P.parseQuery("Travelpro Maxlite 5");
    expect(q.brand).toBe("Travelpro");
    expect(q.line).toEqual(["maxlite", "5"]);
    expect(q.sizeClass).toBeNull();
  });
});
