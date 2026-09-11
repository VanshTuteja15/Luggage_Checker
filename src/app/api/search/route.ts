import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import {
  activeProvider,
  configuredProviders,
  getAllBudgets,
  providerLabel,
  search,
} from "@/lib/search";
import { requireUser } from "@/lib/supabase/server";

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

    const result = await search(query, {
      allowedRetailers,
      limit,
      db: supabase,
      bypassCache: body.refresh === true,
      mode,
    });

    const budgets = await getAllBudgets(supabase, configuredProviders());

    return NextResponse.json({
      ...result,
      providerLabel: providerLabel(result.provider),
      budgets,
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
