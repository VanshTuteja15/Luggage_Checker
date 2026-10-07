/* ------------------------------------------------------------------ */
/*  eBay Browse API (EBAY_CA) — official API only, never HTML          */
/* ------------------------------------------------------------------ */

import { probeFetch, type FetchRecord } from "./http";

export type EbayResult = {
  configured: boolean;
  token: { ok: boolean; record?: FetchRecord; error?: string };
  searches: {
    label: string;
    record: FetchRecord;
    total: number | null;
    items: {
      itemId: string;
      title: string;
      price: string | null;
      currency: string | null;
      condition: string | null;
      seller: string | null;
      itemLocationCountry: string | null;
      buyingOptions: string[];
    }[];
    error?: string;
  }[];
  item?: {
    record: FetchRecord;
    gtin: string | null;
    mpn: string | null;
    brand: string | null;
    price: string | null;
    currency: string | null;
    availability: unknown;
    itemEndDate: string | null;
    fieldsSeen: string[];
  };
};

const API = "https://api.ebay.com";

export async function probeEbay(query: string, gtin: string | null): Promise<EbayResult> {
  const id = process.env.EBAY_CLIENT_ID?.trim();
  const secret = process.env.EBAY_CLIENT_SECRET?.trim();
  const out: EbayResult = { configured: !!(id && secret), token: { ok: false }, searches: [] };
  if (!id || !secret) {
    out.token.error = "EBAY_CLIENT_ID / EBAY_CLIENT_SECRET not set (free at developer.ebay.com)";
    return out;
  }

  const tok = await probeFetch(`${API}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
    skipPacing: true,
  });
  out.token.record = tok.record;
  let token: string | null = null;
  try {
    token = (JSON.parse(tok.body) as { access_token?: string }).access_token ?? null;
  } catch {
    /* handled below */
  }
  if (!token) {
    out.token.error = tok.body.slice(0, 300) || tok.record.outcome;
    return out;
  }
  out.token.ok = true;

  const headers = {
    Authorization: `Bearer ${token}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_CA",
    "X-EBAY-C-ENDUSERCTX": "contextualLocation=country=CA",
    Accept: "application/json",
  };

  const searches: [string, string][] = [
    ["keywords, new condition", `${API}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=20&filter=${encodeURIComponent("conditionIds:{1000}")}`],
  ];
  if (gtin) searches.push(["by GTIN", `${API}/buy/browse/v1/item_summary/search?gtin=${encodeURIComponent(gtin)}&limit=20`]);

  let firstItem: string | null = null;
  for (const [label, url] of searches) {
    const { record, body } = await probeFetch(url, { headers });
    try {
      const data = JSON.parse(body) as {
        total?: number;
        itemSummaries?: Record<string, unknown>[];
        errors?: { message?: string }[];
      };
      const items = (data.itemSummaries ?? []).map((s) => {
        const price = (s.price ?? {}) as { value?: string; currency?: string };
        return {
          itemId: String(s.itemId ?? ""),
          title: String(s.title ?? "").slice(0, 120),
          price: price.value ?? null,
          currency: price.currency ?? null,
          condition: (s.condition as string) ?? null,
          seller: ((s.seller as { username?: string })?.username as string) ?? null,
          itemLocationCountry: ((s.itemLocation as { country?: string })?.country as string) ?? null,
          buyingOptions: Array.isArray(s.buyingOptions) ? (s.buyingOptions as string[]) : [],
        };
      });
      if (!firstItem && items[0]) firstItem = items[0].itemId;
      out.searches.push({ label, record, total: data.total ?? null, items, error: data.errors?.[0]?.message });
    } catch {
      out.searches.push({ label, record, total: null, items: [], error: body.slice(0, 300) });
    }
  }

  if (firstItem) {
    const { record, body } = await probeFetch(`${API}/buy/browse/v1/item/${encodeURIComponent(firstItem)}`, { headers });
    try {
      const it = JSON.parse(body) as Record<string, unknown>;
      const price = (it.price ?? {}) as { value?: string; currency?: string };
      out.item = {
        record,
        gtin: (it.gtin as string) ?? null,
        mpn: (it.mpn as string) ?? null,
        brand: (it.brand as string) ?? null,
        price: price.value ?? null,
        currency: price.currency ?? null,
        availability: it.estimatedAvailabilities ?? null,
        itemEndDate: (it.itemEndDate as string) ?? null,
        fieldsSeen: Object.keys(it).sort(),
      };
    } catch {
      /* leave undefined */
    }
  }
  return out;
}
