import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import {
  activeProvider,
  configuredProviders,
  getAllBudgets,
  providerLabel,
  search,
} from "@/lib/search";
import { brandStoreFor } from "@/lib/retailers";
import { requireUser } from "@/lib/supabase/server";
import type { SearchResponse } from "@/lib/search/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/search
 *
 * Natural-language luggage search across Canadian retailers.
 *
 * Every price returned came from a real listing that a price provider
 * fetched, and carries the URL it came from. The LLM interprets the query
 * and groups listings into products; it never supplies a price.
 *
 * Results are cached, so a repeated search costs no provider quota.
 *
 * With `stream: true` the answer is newline-delimited JSON: a "partial"
 * line as soon as the searches return (while store pages are still being
 * read), then a "final" line — so results appear in a few seconds instead
 * of waiting for everything. An "error" line replaces "final" on failure.
 */
export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);

    const body = (await req.json().catch(() => ({}))) as {
      query?: unknown;
      limit?: unknown;
      allRetailers?: unknown;
      refresh?: unknown;
      mode?: unknown;
      stream?: unknown;
    };

    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) return badRequest("A search query is required.");
    if (query.length > 200) return badRequest("That search query is too long.");

    const mode = body.mode === "catalog" ? "catalog" : "compare";

    const limit =
      typeof body.limit === "number" && body.limit > 0 && body.limit <= 25
        ? Math.floor(body.limit)
        : mode === "catalog"
          ? 20
          : 10;

    // Catalog lookups need the full retailer set so variants aren't hidden.
    // Compare still respects Settings, then unions in Amazon/Walmart/Samsonite.
    let allowedRetailers: string[] = [];
    if (body.allRetailers !== true && mode !== "catalog") {
      const { data } = await supabase
        .from("user_settings")
        .select("retailers")
        .eq("user_id", userId)
        .maybeSingle();
      if (Array.isArray(data?.retailers)) allowedRetailers = data.retailers as string[];
    }
    // The client always wants Amazon, Walmart and Samsonite — and the
    // searched brand's own store — whatever the Settings filter says.
    if (allowedRetailers.length > 0) {
      const always = ["Amazon.ca", "Walmart.ca", "Samsonite.ca", brandStoreFor(query)];
      allowedRetailers = [...new Set([...allowedRetailers, ...always.filter((r): r is string => !!r)])];
    }

    const searchOpts = {
      allowedRetailers,
      limit,
      db: supabase,
      bypassCache: body.refresh === true,
      mode,
    } as const;

    const withLabel = (r: SearchResponse, budgets: unknown[] = []) => ({
      ...r,
      providerLabel: providerLabel(r.provider),
      budgets,
    });

    if (body.stream !== true) {
      const result = await search(query, searchOpts);
      const budgets = await getAllBudgets(supabase, configuredProviders());
      return NextResponse.json(withLabel(result, budgets));
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            /* client went away */
          }
        };
        try {
          const result = await search(query, {
            ...searchOpts,
            onPartial: (partial) => send({ type: "partial", data: withLabel(partial) }),
          });
          const budgets = await getAllBudgets(supabase, configuredProviders());
          send({ type: "final", data: withLabel(result, budgets) });
        } catch (err) {
          const res = errorResponse(err, "POST /api/search (stream)");
          const payload = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
          send({ type: "error", status: res.status, error: payload.error ?? "Search failed", code: payload.code });
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    return errorResponse(err, "POST /api/search");
  }
}

/** GET /api/search — which price source is configured, and what's left of it. */
export async function GET(req: NextRequest) {
  try {
    const { supabase } = await requireUser(req);

    const provider = activeProvider();
    const providers = configuredProviders();
    const budgets = await getAllBudgets(supabase, providers);

    return NextResponse.json({
      provider,
      providerLabel: provider ? providerLabel(provider) : null,
      configured: provider !== null,
      providers,
      budgets,
    });
  } catch (err) {
    return errorResponse(err, "GET /api/search");
  }
}
