import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { getTrackedProducts } from "@/lib/db/products";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/products?days=30
 *
 * Every product the signed-in user tracks, with current offers and price
 * history. RLS scopes this to the caller — there is no userId parameter to
 * tamper with.
 */
export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);

    const daysParam = Number(req.nextUrl.searchParams.get("days") ?? 30);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 365) : 30;

    const products = await getTrackedProducts(supabase, userId, { days });

    return NextResponse.json({ products, count: products.length });
  } catch (err) {
    return errorResponse(err, "GET /api/products");
  }
}
