import { describe, expect, it } from "vitest";
import { luggagePack } from "@/lib/engine/packs/luggage";
import type { RawOffer } from "@/lib/engine/types";
import { crossCheck, validateOffer, type ValidationContext } from "@/lib/engine/validate";
import { source } from "./helpers";

const NOW = Date.parse("2026-10-07T21:30:00Z");
const cld = source("canadaluggagedepot");

function offer(over: Partial<RawOffer> = {}): RawOffer {
  return {
    sourceId: "canadaluggagedepot",
    adapter: "shopify_product_json",
    url: "https://www.canadaluggagedepot.ca/products/samsonite-omni-3-0-large-spinner-expandable-luggage?variant=42742339010736",
    externalId: "1",
    variantExternalId: "42742339010736",
    title: "Samsonite Omni 3.0 Large Spinner Expandable Luggage - Blue",
    brand: "Samsonite",
    identifiers: [
      { kind: "gtin", value: "00043202917998" },
      { kind: "model", value: "samsonite:135955" },
    ],
    colour: "Blue",
    options: ["Blue"],
    price: 279.99,
    listPrice: 440,
    currency: "CAD",
    availability: "in_stock",
    seller: null,
    condition: null,
    imageUrl: null,
    displayedPrice: null,
    pageType: "api",
    evidence: {},
    fetchedAt: new Date(NOW).toISOString(),
    cacheAgeSec: null,
    asOf: null,
    ...over,
  };
}

const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({ source: cld, pack: luggagePack, now: NOW, ...over });
const expected = { gtin: "00043202917998", model: "samsonite:135955", sizeClass: "large", brand: "Samsonite", colour: "Blue" };

describe("validateOffer", () => {
  it("accepts a clean reading with high confidence", () => {
    const v = validateOffer(offer(), ctx({ expected }));
    expect(v.outcome).toBe("accepted");
    expect(v.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("currency: CAD only, never converted", () => {
    expect(validateOffer(offer({ currency: "USD" }), ctx()).outcome).toBe("rejected");
    expect(validateOffer(offer({ currency: null, adapter: "shopify_ucp", url: "https://www.canadaluggagedepot.ca/products/x" }), ctx()).outcome).toBe("rejected");
    const implied = validateOffer(offer({ currency: null, adapter: "html_structured", url: "https://www.canadaluggagedepot.ca/products/x" }), ctx());
    expect(implied.outcome).toBe("accepted");
    expect(implied.reasons.join()).toMatch(/implied by the Canadian storefront/);
  });

  it("rejects links off the store's own domains", () => {
    const v = validateOffer(offer({ url: "https://us.delsey.com/products/x" }), ctx());
    expect(v.outcome).toBe("rejected");
    expect(v.reasons[0]).toMatch(/us\.delsey\.com/);
  });

  it("identity: GTIN, model, size class and brand must agree; colour is a caveat", () => {
    expect(validateOffer(offer({ identifiers: [{ kind: "gtin", value: "00099999999999" }] }), ctx({ expected })).outcome).toBe("rejected");
    expect(validateOffer(offer({ identifiers: [{ kind: "model", value: "samsonite:137394" }] }), ctx({ expected })).outcome).toBe("rejected");
    expect(validateOffer(offer({ title: "Samsonite Omni 3.0 Carry-On Spinner", identifiers: [] }), ctx({ expected })).outcome).toBe("rejected");
    expect(validateOffer(offer({ brand: "American Tourister" }), ctx({ expected })).outcome).toBe("rejected");
    const colour = validateOffer(offer({ colour: "Black" }), ctx({ expected }));
    expect(colour.outcome).toBe("accepted");
    expect(colour.reasons.join()).toMatch(/colour is Black/);
    expect(validateOffer(offer({ title: "Samsonite Omni 3.0 Luggage Cover, Large", identifiers: [] }), ctx({ expected })).outcome).toBe("rejected");
  });

  it("price sanity: band, list price, history and other stores", () => {
    expect(validateOffer(offer({ price: 4.99 }), ctx()).outcome).toBe("rejected");
    expect(validateOffer(offer({ price: 9_999 }), ctx()).outcome).toBe("rejected");
    expect(validateOffer(offer({ price: 0 }), ctx()).outcome).toBe("rejected");
    expect(validateOffer(offer({ price: null }), ctx()).outcome).toBe("rejected");
    expect(validateOffer(offer({ price: 279.99 }), ctx({ history: [899.99, 879.99, 899.99] })).outcome).toBe("low_confidence");
    expect(validateOffer(offer({ price: 89.99, listPrice: null }), ctx({ peers: [279.99, 289.99, 299.99] })).outcome).toBe("low_confidence");
    expect(validateOffer(offer({ price: 279.99 }), ctx({ peers: [279.99, 289.99, 299.99], history: [279.99, 299.99] })).outcome).toBe("accepted");
  });

  it("displayed vs data price disagreement is low-confidence, with the evidence", () => {
    const v = validateOffer(offer({ adapter: "html_structured", price: 179.99, displayedPrice: 125.99, listPrice: null }), ctx());
    expect(v.outcome).toBe("low_confidence");
    expect(v.reasons.join()).toMatch(/page shows 125\.99, data says 179\.99/);
  });

  it("marketplaces: new condition required; a missing seller is a caveat", () => {
    const ebay = source("ebay-ca");
    const base = offer({ sourceId: "ebay-ca", adapter: "ebay_browse_api", url: "https://www.ebay.ca/itm/1", seller: "shop" });
    expect(validateOffer({ ...base, condition: "New" }, ctx({ source: ebay })).outcome).toBe("accepted");
    expect(validateOffer({ ...base, condition: "Used" }, ctx({ source: ebay })).outcome).toBe("rejected");
    expect(validateOffer({ ...base, condition: "Open box" }, ctx({ source: ebay })).outcome).toBe("rejected");
    expect(validateOffer({ ...base, condition: "New", seller: null }, ctx({ source: ebay })).reasons.join()).toMatch(/seller/);
  });

  it("page type and age", () => {
    expect(validateOffer(offer({ pageType: "listing" }), ctx()).outcome).toBe("rejected");
    expect(validateOffer(offer({ cacheAgeSec: 3 * 86_400 }), ctx()).reasons.join()).toMatch(/cache/);
    const feed = (days: number) => offer({ adapter: "feed_import", url: "feed:canadaluggagedepot:x", pageType: "feed", asOf: new Date(NOW - days * 86_400_000).toISOString() });
    expect(validateOffer(feed(3), ctx()).outcome).toBe("accepted");
    expect(validateOffer(feed(20), ctx()).reasons.join()).toMatch(/feed dated 20 days ago/);
    expect(validateOffer(feed(120), ctx()).outcome).toBe("rejected");
  });

  it("never changes the price", () => {
    const o = offer({ price: 279.99 });
    validateOffer(o, ctx({ expected, history: [100], peers: [1, 2, 3] }));
    expect(o.price).toBe(279.99);
  });
});

describe("crossCheck (displayed vs data route)", () => {
  it("flags the Bentley render-time discount", () => {
    const data = offer({ sourceId: "bentley", price: 179.99, identifiers: [{ kind: "gtin", value: "00770005864180" }] });
    const page = offer({ sourceId: "bentley", adapter: "html_structured", price: 179.99, displayedPrice: 125.99, identifiers: [{ kind: "gtin", value: "00770005864180" }] });
    const flagged = crossCheck([data], [page]);
    expect(flagged.get(data)).toMatch(/shows 125\.99/);
    expect(crossCheck([data], [{ ...page, displayedPrice: 179.99 }]).size).toBe(0);
  });
});
