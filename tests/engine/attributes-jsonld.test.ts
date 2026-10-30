/* ------------------------------------------------------------------ */
/*  Attributes from JSON-LD and their storage rules (v4 A4.1, U-ATTR). */
/*  Inputs are schema.org shapes (QuantitativeValue, PropertyValue);   */
/*  no recorded store page states them yet (checked 2026-10-30).        */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  attributesFromJsonLd,
  extractAttributes,
  mergeAttributes,
  toStoredAttributes,
} from "@/lib/engine/extract/attributes";

describe("JSON-LD attributes (U-ATTR)", () => {
  it("reads weight and H × W × D with units, converting to kg and cm", () => {
    const r = attributesFromJsonLd({
      "@type": "Product",
      weight: { "@type": "QuantitativeValue", value: 7.3, unitCode: "LBR" },
      height: { "@type": "QuantitativeValue", value: 22, unitCode: "INH" },
      width: { "@type": "QuantitativeValue", value: 14, unitCode: "INH" },
      depth: { "@type": "QuantitativeValue", value: 9, unitCode: "INH" },
    })!;
    expect(r.fields).toMatchObject({ weightKg: 3.31, dimsCm: [55.88, 35.56, 22.86] });
    expect(r.provenance.weightKg).toMatchObject({ method: "jsonld", evidence: "weight: 7.3 LBR" });
    expect(r.provenance.dimsCm?.evidence).toBe("height: 22 INH, width: 14 INH, depth: 9 INH");
  });

  it("reads additionalProperty capacity, dimensions, wheels and expandable as stated", () => {
    const r = attributesFromJsonLd({
      additionalProperty: [
        { "@type": "PropertyValue", name: "Capacity", value: "40 L" },
        { "@type": "PropertyValue", name: "Dimensions", value: "55 x 40 x 20 cm" },
        { "@type": "PropertyValue", name: "Wheels", value: "4 spinner wheels" },
        { "@type": "PropertyValue", name: "Expandable", value: "Yes" },
      ],
    })!;
    expect(r.fields).toEqual({
      dimsCm: [55, 40, 20],
      capacityL: 40,
      weightKg: null,
      wheels: 4,
      expandable: true,
    });
    expect(r.provenance.capacityL?.evidence).toBe("Capacity: 40 L");
  });

  it("guesses nothing: a number without a unit, 'No', or an empty node gives no value", () => {
    expect(
      attributesFromJsonLd({
        weight: 3.2,
        height: { value: 55 },
        additionalProperty: [
          { name: "Expandable", value: "No" },
          { name: "Capacity", value: "40" },
        ],
      }),
    ).toBeNull();
    expect(attributesFromJsonLd({})).toBeNull();
  });
});

describe("stored attributes (U-ATTR storage)", () => {
  const read = extractAttributes(
    "Samsonite Omni 3.0 Carry-On Spinner",
    "Dimensions: 55 x 40 x 20 cm. Weight: 2.9 kg. 4 spinner wheels.",
  );

  it("keeps every value with its method, evidence, store, page and first read time", () => {
    const s = toStoredAttributes(
      read,
      "canadaluggagedepot",
      "https://x.test/p",
      "2026-10-30T10:00:00.000Z",
    );
    expect(Object.keys(s).sort()).toEqual(["dimsCm", "weightKg", "wheels"]);
    expect(s.weightKg).toMatchObject({
      value: 2.9,
      method: "rules",
      sourceId: "canadaluggagedepot",
      url: "https://x.test/p",
      firstReadAt: "2026-10-30T10:00:00.000Z",
    });
    expect(s.weightKg.evidence).toMatch(/2\.9 ?kg/i);
  });

  it("writes nothing when the value, method and evidence are unchanged", () => {
    const first = toStoredAttributes(
      read,
      "canadaluggagedepot",
      "https://x.test/p",
      "2026-10-30T10:00:00.000Z",
    );
    const later = toStoredAttributes(
      read,
      "canadaluggagedepot",
      "https://x.test/p",
      "2026-10-30T16:00:00.000Z",
    );
    expect(mergeAttributes({}, first)).toEqual(first);
    expect(mergeAttributes(first, later)).toBeNull();
  });
});
