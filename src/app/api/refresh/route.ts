import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { getTrackedProducts } from "@/lib/db/products";
import { refreshProducts } from "@/lib/db/refresh";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Refreshing everything at once would blow a shopping-API quota. */
const MAX_PRODUCTS_PER_REQUEST = 8;

/**
 * POST /api/refresh
 *
 * Re-checks prices on demand. Body: { productId } for one product, or
 * {} to refresh the whole tracked list (capped, most stale first).
 *
 * This is the "I don't believe that price" button the app was missing —
 * previously the only way to update a price was to wait up to six hours
 * for the cron job.
 */
export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as { productId?: unknown };

    const { data: settings } = await supabase
      .from("user_settings")
      .select("retailers")
      .eq("user_id", userId)
      .maybeSingle();

    const allowedRetailers = Array.isArray(settings?.retailers)
      ? (settings.retailers as string[])
      : [];

    const single = typeof body.productId === "string" ? body.productId : null;

    const tracked = await getTrackedProducts(supabase, userId, {
      ...(single ? { productId: single } : {}),
      days: 2,
    });

    if (tracked.length === 0) {
      return NextResponse.json(
        { error: single ? "That product isn't in your tracked list." : "Nothing tracked yet." },
        { status: 404 },
      );
    }

    // Stalest first, so a capped run still makes progress across the list.
    const queue = [...tracked]
      .sort((a, b) => (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? ""))
      .slice(0, single ? 1 : MAX_PRODUCTS_PER_REQUEST);

    const results = await refreshProducts(supabase, queue, { allowedRetailers });

    const updated = results.filter((r) => r.offersFound > 0);
    const drops = updated.filter(
      (r) => r.previousLowest !== null && r.newLowest !== null && r.newLowest < r.previousLowest,
    );

    const products = await getTrackedProducts(supabase, userId, {
      ...(single ? { productId: single } : {}),
    });

    return NextResponse.json({
      checked: results.length,
      updated: updated.length,
      drops: drops.length,
      remaining: Math.max(0, tracked.length - queue.length),
      results,
      products,
    });
  } catch (err) {
    return errorResponse(err, "POST /api/refresh");
  }
}
