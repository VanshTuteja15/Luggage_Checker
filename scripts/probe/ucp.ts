/* ------------------------------------------------------------------ */
/*  Shopify UCP Catalog MCP — read-only client                        */
/*                                                                     */
/*  POST https://<store>/api/ucp/mcp, JSON-RPC 2.0 "tools/call".       */
/*  Every call carries our agent profile URL (meta.ucp-agent.profile   */
/*  and the UCP-Agent header). Catalog tools only — no cart/checkout.  */
/* ------------------------------------------------------------------ */

import { probeFetch, type FetchRecord } from "./http";
import type { NormProduct, NormVariant } from "./shopify";

export type McpCall = {
  tool: string;
  record: FetchRecord;
  ok: boolean;
  error: string | null;
  /** Parsed JSON result (structuredContent, or JSON inside the text content). */
  result: unknown;
  rawSample: string;
};

/** Find the MCP endpoint in a /.well-known/ucp document. */
export function findMcpEndpoint(doc: unknown, host: string): string {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string" && /^https:\/\/.+\/api\/ucp\/mcp\b/.test(v)) found.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return found[0] ?? `https://${host}/api/ucp/mcp`;
}

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
        /* try previous */
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

/** Pull the tool result out of a JSON-RPC response. */
export function toolResult(rpc: unknown): { ok: boolean; error: string | null; result: unknown } {
  const r = rpc as { error?: { message?: string; code?: number }; result?: Record<string, unknown> } | null;
  if (!r) return { ok: false, error: "unparseable response", result: null };
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

export async function callTool(
  endpoint: string,
  profileUrl: string,
  tool: string,
  catalog: Record<string, unknown>,
  id: number,
): Promise<McpCall> {
  const body = {
    jsonrpc: "2.0",
    method: "tools/call",
    id,
    params: { name: tool, arguments: { meta: { "ucp-agent": { profile: profileUrl } }, catalog } },
  };
  const { record, body: text } = await probeFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "UCP-Agent": `profile="${profileUrl}"`,
    },
    body: JSON.stringify(body),
  });
  const parsed = parseMcpBody(text, record.contentType);
  const { ok, error, result } = record.outcome === "ok" ? toolResult(parsed) : { ok: false, error: `HTTP ${record.status} ${record.outcome}`, result: null };
  return { tool, record, ok, error, result, rawSample: text.slice(0, 6000) };
}

/** Every object in a payload whose id is a Shopify Product GID. */
export function findProducts(payload: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.id === "string" && /gid:\/\/shopify\/Product\/\d+/.test(o.id)) {
      out.push(o);
      return;
    }
    Object.values(o).forEach(walk);
  };
  walk(payload);
  return out;
}

const money = (m: unknown): { amount: number | null; currency: string | null } => {
  if (!m || typeof m !== "object") return { amount: null, currency: null };
  const o = m as { amount?: unknown; currency?: unknown; currency_code?: unknown };
  const a = typeof o.amount === "number" ? o.amount : Number(o.amount);
  return {
    amount: Number.isFinite(a) ? a / 100 : null,
    currency: typeof o.currency === "string" ? o.currency : typeof o.currency_code === "string" ? o.currency_code : null,
  };
};

function barcodeOf(v: Record<string, unknown>): string | null {
  const b = v.barcodes ?? v.barcode ?? v.gtin;
  if (typeof b === "string") return b;
  if (Array.isArray(b)) {
    for (const x of b) {
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        const val = (x as { value?: unknown; code?: unknown }).value ?? (x as { code?: unknown }).code;
        if (typeof val === "string") return val;
      }
    }
  }
  return null;
}

function availabilityOf(v: Record<string, unknown>): boolean | null {
  const a = v.availability;
  if (typeof a === "boolean") return a;
  if (a && typeof a === "object") {
    const o = a as { available?: unknown; status?: unknown };
    if (typeof o.available === "boolean") return o.available;
    if (typeof o.status === "string") return /in_?stock|available/i.test(o.status);
  }
  return null;
}

/** Normalise a UCP product (search hit or get_product result). */
export function normaliseUcpProduct(p: Record<string, unknown>): NormProduct {
  const variants = Array.isArray(p.variants) ? (p.variants as Record<string, unknown>[]) : [];
  const fields = new Set<string>(Object.keys(p).map((k) => `product.${k}`));
  for (const v of variants) for (const k of Object.keys(v)) fields.add(`variant.${k}`);
  return {
    source: "ucp",
    id: typeof p.id === "string" ? p.id : null,
    title: typeof p.title === "string" ? p.title : null,
    vendor: typeof p.vendor === "string" ? p.vendor : typeof p.brand === "string" ? p.brand : null,
    type: null,
    updatedAt: typeof p.updated_at === "string" ? p.updated_at : null,
    variants: variants.map((v): NormVariant => {
      const price = money(v.price);
      const list = money(v.list_price ?? v.compare_at_price);
      const opts = Array.isArray(v.options)
        ? (v.options as { label?: unknown; value?: unknown }[]).map((o) => String(o.label ?? o.value ?? "")).filter(Boolean)
        : [];
      return {
        id: String(v.id ?? ""),
        title: typeof v.title === "string" ? v.title : null,
        sku: typeof v.sku === "string" ? v.sku : null,
        barcode: barcodeOf(v),
        price: price.amount,
        compareAt: list.amount,
        currency: price.currency,
        available: availabilityOf(v),
        inventory: null,
        options: opts,
      };
    }),
    fieldsSeen: [...fields].sort(),
  };
}
