/* ------------------------------------------------------------------ */
/*  Identity keys that must never collide (v4 A3.0, review P2-04)      */
/*  Real titles from the CLD and Delsey catalogues.                     */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { identityKey } from "@/lib/engine/identity/resolve";
import { luggagePack as pack } from "@/lib/engine/packs/luggage";

const key = (title: string, houseBrand: string | null = null) => {
  const brand = pack.brandOf(title) ?? houseBrand;
  return identityKey(
    brand,
    pack.lineOf(title, brand),
    pack.sizeClassOf(title),
    pack.inchesOf(title),
  );
};

describe("identity keys (U-MATCH-1, U-MATCH-2)", () => {
  it("TUMI Ventra Large Carry-On is not the Ventra Carry-On (the live bug)", () => {
    const large = key("Tumi Ventra Large Expandable Carry-On Luggage");
    const regular = key("Tumi Ventra Expandable Carry-On Luggage");
    expect(large).not.toBeNull();
    expect(large).not.toBe(regular);
    // "Large" still means the large size when there is no carry-on word.
    expect(pack.sizeClassOf("Tumi Ventra Large Expandable Checked Luggage")).toBe("large");
    expect(pack.lineOf("Tumi Ventra Large Expandable Checked Luggage", "TUMI")).not.toContain(
      "large",
    );
  });

  it("Briggs & Riley Baseline Global is not the Domestic carry-on, but a query without the word still matches", () => {
    expect(key("Briggs & Riley Baseline Global Carry-On Spinner Luggage")).not.toBe(
      key("Briggs & Riley Baseline Domestic Carry-On Expandable Spinner"),
    );
    expect(pack.parseQuery("briggs riley baseline carry-on").line).toEqual(["baseline"]);
  });

  it("Delsey's Carefree Carry keeps its line word; 'carry-on' stays a size word", () => {
    expect(pack.lineOf("CAREFREE CARRY | 17-Inch Laptop Backpack, Sage green", "Delsey")).toContain(
      "carry",
    );
    expect(pack.lineOf("Samsonite Outline Pro Carry-On Spinner Luggage", "Samsonite")).toEqual([
      "outline",
      "pro",
    ]);
    expect(pack.lineOf("Samsonite Outline Pro Carry On Spinner", "Samsonite")).toEqual([
      "outline",
      "pro",
    ]);
  });

  it("the known traps stay apart", () => {
    const apart: [string, string][] = [
      ["Samsonite Nexis Spinner Large Luggage (28)", "Samsonite Nexis Spinner Large Luggage (31)"],
      [
        "Samsonite Paralux Hardside Expandable Spinner Medium Luggage",
        "Samsonite Paralux Hardside Expandable Spinner Large Luggage",
      ],
      [
        "Tumi 19 Degree Aluminum International Carry-On Luggage",
        "Tumi 19 Degree Aluminum International Expandable Carry-On Luggage - Silver",
      ],
      [
        "Travelpro Maxlite 5 International Carry-On Spinner Luggage",
        "Travelpro Maxlite Air V2 International Carry-On Hardside Spinner",
      ],
    ];
    for (const [a, b] of apart) expect(key(a), `${a} vs ${b}`).not.toBe(key(b));
    expect(key("SKY MAX 2.0 | 31-Inch Expandable Check-In Suitcase, Green", "Delsey")).not.toBe(
      key("SKY MAX 3.0 | 31-Inch Check-In Suitcase, Teal blue", "Delsey"),
    );
  });
});
