import { NextRequest, NextResponse } from "next/server";
import { fetchPrices } from "@/lib/serpapi";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * POST /api/search
 * Search for luggage prices across Canadian retailers via SerpAPI.
 * Body: { query: string }
 *
 * If Supabase is configured, also checks local DB for existing products.
 */
export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "query string is required" },
        { status: 400 },
      );
    }

    // Search local DB first (if configured)
    let dbProducts: unknown[] = [];
    try {
      const supabase = getSupabaseAdmin();
      const { data } = await supabase
        .from("products")
        .select("*, retailer_offers(*)")
        .or(
          `name.ilike.%${query}%,brand.ilike.%${query}%,upc.eq.${query}`,
        )
        .limit(10);
      dbProducts = data ?? [];
    } catch {
      // Supabase not configured — skip DB search
    }

    // Search SerpAPI for live prices
    let liveResults: Awaited<ReturnType<typeof fetchPrices>> = [];
    try {
      liveResults = await fetchPrices(`${query} luggage Canada`);
    } catch (err) {
      console.warn("SerpAPI search failed:", err);
      // Continue with DB results only
    }

    return NextResponse.json({
      dbProducts,
      liveResults,
      query,
    });
  } catch (err) {
    console.error("POST /api/search error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
