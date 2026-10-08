/* ------------------------------------------------------------------ */
/*  shopify_ucp: the store-published agent channel                    */
/*                                                                     */
/*  Shopify's UCP Catalog MCP (POST <store>/api/ucp/mcp, JSON-RPC 2.0  */
/*  tools/call): search_catalog, get_product. Every call carries our   */
/*  public agent profile URL. Catalog tools only — never cart or        */
/*  checkout. Prices arrive in minor units (cents) and are converted;   */
/*  the request always states a Canadian context, and the validator     */
/*  rejects anything not priced in CAD (Delsey and Away share shops     */
/*  with other markets).                                                */
/* ------------------------------------------------------------------ */

import type { Availability, ParsedQuery, RawOffer } from "../types";
import {
  blankOffer,
  buildIdentifiers,
  canonicalUrl,
  result,
  statusFromOutcome,
  withVariant,
  type Adapter,
  type AdapterContext,
  type AdapterResult,
  type ListingRef,
} from "./base";

const CONTEXT = { address_country: "CA", currency: "CAD", language: "en" };

/* ── MCP plumbing ─────────────────────────────────────────────────── */

/** Body of an MCP response: plain JSON, or the last JSON-RPC message in an SSE stream. */
export function parseMcpBody(body: string, contentType: string | null): unknown {
  const text = body.trim();
  if ((contentType ?? "").includes("text/event-stream") || text.startsWith("event:") || text.startsWith("data:")) {
    const datas = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    for (let i = datas.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(datas[i]);
      } catch {
        /* try the previous message */
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function toolResult(rpc: unknown): { ok: boolean; error: string | null; result: unknown } {
  const r = rpc as { error?: { message?: string; code?: number }; result?: Record<string, unknown> } | null;
  if (!r || typeof r !== "object") return { ok: false, error: "unparseable response", result: null };
  if (r.error) return { ok: false, error: `${r.error.code ?? ""} ${r.error.message ?? "error"}`.trim(), result: null };
  const res = r.result ?? {};
  if (res.isError) {
    const msg = Array.isArray(res.content) ? (res.content as { text?: string }[]).map((c) => c.text).join(" ") : "tool error";
    return { ok: false, error: msg.slice(0, 400), result: null };
  }
  if (res.structuredContent) return { ok: true, error: null, result: res.structuredContent };
  if (Array.isArray(res.content)) {
    for (const c of res.content as { type?: string; text?: string }[]) {
      if (c.type === "text" && c.text) {
        try {
          return { ok: true, error: null, result: JSON.parse(c.text) };
        } catch {
          return { ok: true, error: null, result: c.text };
        }
      }
    }
  }
  return { ok: true, error: null, result: res };
}

/** Every object in a payload whose id is a Shopify Product GID. */
export function findProducts(payload: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && /^gid:\/\/shopify\/Product\/\d+$/.test(o.id)) {
      out.push(o);
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(payload);
  return out;
}

function money(m: unknown): { amount: number | null; currency: string | null } {
  if (!m || typeof m !== "object") return { amount: null, currency: null };
  const o = m as { amount?: unknown; currency?: unknown; currency_code?: unknown };
  const a = typeof o.amount === "number" ? o.amount : Number(o.amount);
  return {
    // UCP money is in minor units.
    amount: Number.isFinite(a) ? Math.round(a) / 100 : null,
    currency: typeof o.currency === "string" ? o.currency : typeof o.currency_code === "string" ? o.currency_code : null,
  };
}

function barcodeOf(v: Record<string, unknown>): string | null {
  const b = v.barcodes ?? v.barcode ?? v.gtin;
  if (typeof b === "string") return b;
  if (Array.isArray(b)) {
    for (const x of b) {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const val = (x as { value?: unknown }).value ?? (x as { code?: unknown }).code;
        if (typeof val === "string") return val;
      }
    }
  }
  return null;
}

function availabilityOf(v: Record<string, unknown>): Availability {
  const a = v.availability;
  const flag =
    typeof a === "boolean"
      ? a
      : a && typeof a === "object"
        ? typeof (a as { available?: unknown }).available === "boolean"
          ? ((a as { available: boolean }).available)
          : typeof (a as { status?: unknown }).status === "string"
            ? /in_?stock|available/i.test((a as { status: string }).status)
            : null
        : null;
  return flag === true ? "in_stock" : flag === false ? "out_of_stock" : "unknown";
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** The customer-facing product page for a UCP product. */
function productUrl(ctx: AdapterContext, p: Record<string, unknown>): string | null {
  const direct = str(p.url) ?? str(p.online_store_url) ?? str(p.onlineStoreUrl);
  if (direct) return direct;
  const handle = str(p.handle);
  if (!handle || !ctx.source.marketHost) return null;
  return `https://${ctx.source.marketHost}${ctx.source.marketPathPrefix ?? ""}/products/${handle}`;
}

export function offersFromUcpProduct(ctx: AdapterContext, p: Record<string, unknown>, evidence: Record<string, unknown>): RawOffer[] {
  const url = productUrl(ctx, p);
  if (!url) return [];
  const title = str(p.title) ?? "";
  const vendor = str(p.vendor) ?? str(p.brand);
  const brand = ctx.pack.brandOf(vendor ?? "") ?? ctx.pack.brandOf(title) ?? vendor;
  const variants = Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : [];
  const gid = String(p.id);
  return variants.map((v, i) => {
    const price = money(v.price);
    const list = money(v.list_price ?? v.compare_at_price);
    const options = Array.isArray(v.options)
      ? (v.options as { label?: unknown; value?: unknown }[]).map((o) => String(o.label ?? o.value ?? "")).filter((x) => x && x !== "Default Title")
      : [];
    const variantId = String(v.id ?? "").match(/(\d+)$/)?.[1] ?? null;
    const sku = str(v.sku);
    return blankOffer(ctx, "shopify_ucp", {
      url: withVariant(canonicalUrl(url), variants.length > 1 ? variantId : null),
      externalId: gid,
      variantExternalId: variantId,
      title: str(v.title) && str(v.title) !== "Default Title" && !title.includes(String(v.title)) ? `${title} - ${v.title}` : title,
      brand,
      identifiers: buildIdentifiers(ctx.pack, ctx.source.id, { brand, sku, barcode: barcodeOf(v), title }),
      colour: ctx.pack.colourOf(options.join(" ")) ?? ctx.pack.colourOf(title),
      options,
      price: price.amount,
      listPrice: list.amount !== null && price.amount !== null && list.amount > price.amount ? list.amount : null,
      currency: price.currency,
      availability: availabilityOf(v),
      imageUrl: str((p.media as { url?: unknown }[] | undefined)?.[0]?.url) ?? str((p.images as { url?: unknown }[] | undefined)?.[0]?.url),
      pageType: "api",
      evidence: { ...evidence, field: `variants[${i}].price.amount`, minorUnits: (v.price as { amount?: unknown } | undefined)?.amount ?? null },
    });
  });
}

async function callTool(ctx: AdapterContext, tool: "search_catalog" | "get_product", catalog: Record<string, unknown>) {
  const profile = ctx.config.ucpAgentProfileUrl!;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method: "tools/call",
    id: 1,
    params: { name: tool, arguments: { meta: { "ucp-agent": { profile } }, catalog } },
  });
  const res = await ctx.fetcher.fetch({
    source: ctx.source,
    url: ctx.source.ucpEndpoint!,
    adapter: "shopify_ucp",
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "UCP-Agent": `profile="${profile}"` },
    signal: ctx.signal,
    deadlineAt: ctx.deadlineAt,
    sessionId: ctx.sessionId ?? null,
  });
  if (res.outcome !== "ok") return { res, rpc: null as ReturnType<typeof toolResult> | null };
  return { res, rpc: toolResult(parseMcpBody(res.body, res.headers["content-type"] ?? null)) };
}

function notConfigured(ctx: AdapterContext): AdapterResult | null {
  if (!ctx.source.ucpEndpoint) return result("not_configured", [], "no UCP endpoint on record");
  if (!ctx.config.ucpAgentProfileUrl) return result("not_configured", [], "UCP agent profile not published yet (UCP_AGENT_PROFILE_URL)");
  return null;
}

export const shopifyUcp: Adapter = {
  id: "shopify_ucp",
  live: true,

  async search(ctx: AdapterContext, q: ParsedQuery, limit: number): Promise<AdapterResult> {
    const nc = notConfigured(ctx);
    if (nc) return nc;
    const { res, rpc } = await callTool(ctx, "search_catalog", { query: q.raw, context: CONTEXT, pagination: { limit: Math.min(limit, 20) } });
    if (!rpc) return result(statusFromOutcome(res.outcome), [], res.error);
    if (!rpc.ok) return result(/profile|agent/i.test(rpc.error ?? "") ? "not_configured" : "error", [], rpc.error);
    const products = findProducts(rpc.result).slice(0, limit);
    const offers = products.flatMap((p) => offersFromUcpProduct(ctx, p, { tool: "search_catalog", endpoint: ctx.source.ucpEndpoint }));
    return result(offers.length ? "ok" : "not_found", offers, offers.length ? null : "no products for this query");
  },

  async verify(ctx: AdapterContext, listing: ListingRef): Promise<AdapterResult> {
    const nc = notConfigured(ctx);
    if (nc) return nc;
    const id = listing.externalId && /^\d+$/.test(listing.externalId) ? `gid://shopify/Product/${listing.externalId}` : listing.externalId;
    if (!id || !/^gid:\/\/shopify\/Product\/\d+$/.test(id)) return result("not_found", [], "no Shopify product id for this listing");
    const { res, rpc } = await callTool(ctx, "get_product", { id, context: CONTEXT });
    if (!rpc) return result(statusFromOutcome(res.outcome), [], res.error);
    if (!rpc.ok) return result(/not found/i.test(rpc.error ?? "") ? "not_found" : "error", [], rpc.error);
    const product = findProducts(rpc.result)[0] ?? ((rpc.result as { product?: Record<string, unknown> } | null)?.product ?? null);
    if (!product) return result("garbage", [], "get_product returned no product");
    const offers = offersFromUcpProduct(ctx, product, { tool: "get_product", endpoint: ctx.source.ucpEndpoint, id });
    return offers.length ? result("ok", offers) : result("garbage", [], "product has no linkable variants");
  },
};
