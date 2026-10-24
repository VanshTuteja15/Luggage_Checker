import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { getTrackedProducts } from "@/lib/db/products";
import { sendPriceAlert } from "@/lib/email";
import { PgTrackedBridge } from "@/lib/engine/bridge/tracked";
import { verifyTracked } from "@/lib/engine/jobs/verify-tracked";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { getEngine } from "@/lib/engine/server";
import { pgPoolOf } from "@/lib/engine/store/pg";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A whole list at once would outlive the request; the stalest go first. */
const MAX_PRODUCTS_PER_REQUEST = 8;

const body = z.object({ productId: z.string().uuid().optional() }).strict();

/**
 * POST /api/refresh — re-check prices now. Body: { productId } for one
 * product, or {} for the tracked list (capped, most stale first).
 *
 * Prices are re-read by the price engine from the stores' own pages or
 * official channels (MASTER_PROMPT_V2 §4) and written to the tracking
 * tables through the engine's bridge. Web-search prices are never written.
 */
export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    const parsed = body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return badRequest("That product can't be refreshed.");
    const single = parsed.data.productId ?? null;

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

    const { rt } = getEngine();
    const pool = pgPoolOf(rt.store);
    if (!pool) {
      return NextResponse.json(
        { error: "Live price checks aren't set up on this server yet." },
        { status: 503 },
      );
    }

    // Stalest first, so a capped run still makes progress across the list.
    const queue = [...tracked]
      .sort((a, b) => (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? ""))
      .slice(0, single ? 1 : MAX_PRODUCTS_PER_REQUEST);
    const before = new Map(queue.map((p) => [p.id, p.lowestPrice]));

    const { stats, verifiedProductIds } = await verifyTracked(
      rt,
      luggagePack,
      new PgTrackedBridge(pool),
      {
        productIds: queue.map((p) => p.id),
        maxProducts: queue.length,
        sendAlert: sendPriceAlert,
        signal: AbortSignal.timeout(50_000),
        trigger: "manual",
      },
    );

    const after = await getTrackedProducts(supabase, userId, {
      ...(single ? { productId: single } : {}),
      days: 2,
    });
    const drops = after.filter((p) => {
      const was = before.get(p.id);
      return (
        verifiedProductIds.includes(p.id) &&
        was != null &&
        p.lowestPrice != null &&
        p.lowestPrice < was
      );
    }).length;

    return NextResponse.json({
      checked: queue.length,
      updated: stats.verified,
      drops,
      remaining: Math.max(0, tracked.length - queue.length),
    });
  } catch (err) {
    return errorResponse(err, "POST /api/refresh");
  }
}
