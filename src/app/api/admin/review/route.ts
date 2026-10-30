import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { aiAllowed, matchJudgeTask, PgAiCache } from "@/lib/engine/ai";
import { reviewAdvice, type ReviewAdvice } from "@/lib/engine/identity/advice";
import { getEngine } from "@/lib/engine/server";
import { PgEngineStore } from "@/lib/engine/store/pg";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "rejected", "superseded"] as const;

/** GET /api/admin/review?status=pending — the identity review queue. */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const raw = req.nextUrl.searchParams.get("status") ?? "pending";
    const status = (STATUSES as readonly string[]).includes(raw)
      ? (raw as (typeof STATUSES)[number])
      : "pending";
    const { rt } = getEngine();
    const items = await rt.store.listReviews(status, 200);
    // v4 A5.3: the judge's cached opinion beside each pending pair (advice only).
    let advice: Record<string, ReviewAdvice | null> = {};
    if (status === "pending" && aiAllowed(await rt.flags(), matchJudgeTask)) {
      const cache = rt.store instanceof PgEngineStore ? new PgAiCache(rt.store.pool) : null;
      if (cache) advice = await reviewAdvice(cache, rt.config.ai.model, items);
    }
    return NextResponse.json({ items, advice });
  } catch (err) {
    return errorResponse(err, "GET /api/admin/review");
  }
}
