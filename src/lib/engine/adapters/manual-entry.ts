/* ------------------------------------------------------------------ */
/*  manual_entry: a price an admin checked by hand                    */
/*                                                                     */
/*  For stores no automated route reaches (Costco, in-store-only       */
/*  Luggage Warehouse Vancouver, blocked brand stores). Always shown   */
/*  as "Manually checked <date>", never as live.                        */
/* ------------------------------------------------------------------ */

import type { CategoryPack, RawOffer, SourceRecord } from "../types";
import { buildIdentifiers, result, type Adapter, type AdapterResult } from "./base";

export type ManualInput = {
  title: string;
  price: number;
  /** ISO date or date-time the price was seen. */
  checkedAt: string;
  url?: string | null;
  sku?: string | null;
  gtin?: string | null;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  note?: string | null;
  enteredBy: string;
};

export type ManualCheck = { ok: true; offer: RawOffer } | { ok: false; reason: string };

export function manualOffer(
  source: SourceRecord,
  pack: CategoryPack,
  input: ManualInput,
  now = Date.now(),
): ManualCheck {
  const title = input.title.trim().slice(0, 300);
  // People read these on Store status → Data entry: plain sentences (R5.5).
  if (!title) return { ok: false, reason: "Enter the product's name." };
  if (!Number.isFinite(input.price) || input.price <= 0 || input.price > 100_000)
    return { ok: false, reason: "Enter the price in dollars, for example 349.99." };
  const checked = Date.parse(input.checkedAt);
  if (!Number.isFinite(checked))
    return { ok: false, reason: "Pick the date you checked the price." };
  if (checked > now + 60_000)
    return { ok: false, reason: "The date you checked the price can't be in the future." };

  let url = `manual:${source.id}:${(input.sku ?? input.gtin ?? title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 80)}`;
  if (input.url) {
    try {
      const u = new URL(input.url);
      if (u.protocol !== "https:" || !source.allowedDomains.includes(u.hostname.toLowerCase())) {
        return {
          ok: false,
          reason: `The link must be a page on ${source.allowedDomains.join(" or ") || "the store's own site"}.`,
        };
      }
      u.hash = "";
      url = u.toString();
    } catch {
      return { ok: false, reason: "That link isn't a web address. Copy it from the store's page." };
    }
  }
  const brand = pack.brandOf(title);
  return {
    ok: true,
    offer: {
      sourceId: source.id,
      adapter: "manual_entry",
      url,
      externalId: input.sku ?? null,
      variantExternalId: null,
      title,
      brand,
      identifiers: buildIdentifiers(pack, source.id, {
        brand,
        sku: input.sku ?? null,
        barcode: input.gtin ?? null,
        title,
      }),
      colour: pack.colourOf(title),
      options: [],
      price: Math.round(input.price * 100) / 100,
      listPrice: null,
      currency: "CAD",
      availability: input.availability ?? "unknown",
      seller: null,
      condition: null,
      imageUrl: null,
      displayedPrice: null,
      pageType: "manual",
      evidence: { enteredBy: input.enteredBy, note: input.note?.slice(0, 500) ?? null },
      fetchedAt: new Date(now).toISOString(),
      cacheAgeSec: null,
      asOf: new Date(checked).toISOString(),
    },
  };
}

export const manualEntry: Adapter = {
  id: "manual_entry",
  live: false,
  async verify(): Promise<AdapterResult> {
    return result("not_configured", [], "manual prices are entered by an admin, not fetched");
  },
};
