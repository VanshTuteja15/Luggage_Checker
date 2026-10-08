/* ------------------------------------------------------------------ */
/*  amazon_creators_api                                               */
/*                                                                     */
/*  Amazon's sanctioned route for Associates: product data through the */
/*  official API, never the storefront (the registry gives the fetcher  */
/*  only the API host). INACTIVE until an Associates account qualifies  */
/*  AND the flag adapter.amazon_creators_api is on AND credentials are  */
/*  set. The transport follows Amazon's documented PA-API 5 GetItems /   */
/*  SearchItems contract (SigV4-signed JSON); when the account is        */
/*  approved, confirm the endpoint in Amazon's console (HUMAN_ACTIONS). */
/* ------------------------------------------------------------------ */

import { createHash, createHmac } from "node:crypto";
import type { Availability, ParsedQuery, RawOffer } from "../types";
import { blankOffer, buildIdentifiers, result, statusFromOutcome, type Adapter, type AdapterContext, type AdapterResult, type ListingRef } from "./base";

const HOST = "webservices.amazon.ca";
const REGION = "us-east-1";
const SERVICE = "ProductAdvertisingAPI";
const RESOURCES = [
  "ItemInfo.Title",
  "ItemInfo.ByLineInfo",
  "ItemInfo.ExternalIds",
  "Offers.Listings.Price",
  "Offers.Listings.SavingBasis",
  "Offers.Listings.Availability.Type",
  "Offers.Listings.Condition",
  "Offers.Listings.MerchantInfo",
  "Images.Primary.Medium",
];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: Buffer | string, s: string) => createHmac("sha256", key).update(s).digest();

/** AWS Signature Version 4 headers for a PA-API request. Exported for tests. */
export function signPaapi(op: "GetItems" | "SearchItems", body: string, accessKey: string, secretKey: string, now: Date): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const target = `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${op}`;
  const path = `/paapi5/${op.toLowerCase()}`;
  const signed = {
    "content-encoding": "amz-1.0",
    "content-type": "application/json; charset=utf-8",
    host: HOST,
    "x-amz-date": amzDate,
    "x-amz-target": target,
  };
  const names = Object.keys(signed).sort();
  const canonical = ["POST", path, "", ...names.map((n) => `${n}:${signed[n as keyof typeof signed]}`), "", names.join(";"), sha256(body)].join("\n");
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), REGION), SERVICE), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  const { host: _host, ...sent } = signed;
  void _host;
  return { ...sent, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

type PaItem = {
  ASIN?: string;
  DetailPageURL?: string;
  ItemInfo?: {
    Title?: { DisplayValue?: string };
    ByLineInfo?: { Brand?: { DisplayValue?: string } };
    ExternalIds?: { EANs?: { DisplayValues?: string[] }; UPCs?: { DisplayValues?: string[] } };
  };
  Offers?: {
    Listings?: {
      Price?: { Amount?: number; Currency?: string };
      SavingBasis?: { Amount?: number };
      Availability?: { Type?: string };
      Condition?: { Value?: string };
      MerchantInfo?: { Name?: string };
    }[];
  };
  Images?: { Primary?: { Medium?: { URL?: string } } };
};

function availability(t: string | undefined): Availability {
  if (!t) return "unknown";
  if (/^Now$/i.test(t)) return "in_stock";
  if (/Backorder/i.test(t)) return "backorder";
  if (/Preorder/i.test(t)) return "preorder";
  return "unknown";
}

function toOffer(ctx: AdapterContext, it: PaItem, evidence: Record<string, unknown>): RawOffer | null {
  const title = it.ItemInfo?.Title?.DisplayValue;
  if (!it.DetailPageURL || !title) return null;
  const l = it.Offers?.Listings?.[0];
  const brandRaw = it.ItemInfo?.ByLineInfo?.Brand?.DisplayValue ?? null;
  const brand = ctx.pack.brandOf(brandRaw ?? "") ?? ctx.pack.brandOf(title) ?? brandRaw;
  const barcode = it.ItemInfo?.ExternalIds?.UPCs?.DisplayValues?.[0] ?? it.ItemInfo?.ExternalIds?.EANs?.DisplayValues?.[0] ?? null;
  return blankOffer(ctx, "amazon_creators_api", {
    url: it.DetailPageURL,
    externalId: it.ASIN ?? null,
    title,
    brand,
    identifiers: buildIdentifiers(ctx.pack, ctx.source.id, { brand, sku: it.ASIN ?? null, barcode, title }),
    colour: ctx.pack.colourOf(title),
    price: l?.Price?.Amount ?? null,
    listPrice: l?.SavingBasis?.Amount ?? null,
    currency: l?.Price?.Currency ?? null,
    availability: availability(l?.Availability?.Type),
    seller: l?.MerchantInfo?.Name ?? null,
    condition: l?.Condition?.Value ?? null,
    imageUrl: it.Images?.Primary?.Medium?.URL ?? null,
    pageType: "api",
    evidence: { ...evidence, asin: it.ASIN },
  });
}

async function call(ctx: AdapterContext, op: "GetItems" | "SearchItems", payload: Record<string, unknown>): Promise<{ items: PaItem[] } | { error: AdapterResult }> {
  const a = ctx.config.amazon!;
  const body = JSON.stringify({ ...payload, PartnerTag: a.partnerTag, PartnerType: "Associates", Marketplace: "www.amazon.ca", Resources: RESOURCES });
  const res = await ctx.fetcher.fetch({
    source: ctx.source,
    url: `https://${HOST}/paapi5/${op.toLowerCase()}`,
    adapter: "amazon_creators_api",
    method: "POST",
    respectRobots: false,
    headers: signPaapi(op, body, a.credentialId, a.credentialSecret, new Date(ctx.now())),
    body,
    signal: ctx.signal,
    deadlineAt: ctx.deadlineAt,
    sessionId: ctx.sessionId ?? null,
  });
  if (res.outcome !== "ok") return { error: result(res.status === 401 || res.status === 403 ? "not_configured" : statusFromOutcome(res.outcome), [], res.error) };
  try {
    const j = JSON.parse(res.body) as { ItemsResult?: { Items?: PaItem[] }; SearchResult?: { Items?: PaItem[] } };
    return { items: j.ItemsResult?.Items ?? j.SearchResult?.Items ?? [] };
  } catch {
    return { error: result("garbage", [], "Amazon response was not JSON") };
  }
}

export const amazonCreators: Adapter = {
  id: "amazon_creators_api",
  live: true,

  async search(ctx: AdapterContext, q: ParsedQuery, limit: number): Promise<AdapterResult> {
    if (!ctx.config.amazon) return result("not_configured", [], "Amazon Creators API not configured");
    const r = await call(ctx, "SearchItems", { Keywords: q.raw.slice(0, 100), SearchIndex: "Luggage", ItemCount: Math.min(limit, 10) });
    if ("error" in r) return r.error;
    const offers = r.items.map((it, i) => toOffer(ctx, it, { op: "SearchItems", field: `SearchResult.Items[${i}].Offers.Listings[0].Price` })).filter((o): o is RawOffer => o !== null);
    return result(offers.length ? "ok" : "not_found", offers);
  },

  async verify(ctx: AdapterContext, listing: ListingRef): Promise<AdapterResult> {
    if (!ctx.config.amazon) return result("not_configured", [], "Amazon Creators API not configured");
    if (!listing.externalId) return result("not_found", [], "no ASIN for this listing");
    const r = await call(ctx, "GetItems", { ItemIds: [listing.externalId] });
    if ("error" in r) return r.error;
    const offer = r.items[0] ? toOffer(ctx, r.items[0], { op: "GetItems", field: "ItemsResult.Items[0].Offers.Listings[0].Price" }) : null;
    return offer ? result("ok", [offer]) : result("not_found", [], "ASIN not returned");
  },
};
