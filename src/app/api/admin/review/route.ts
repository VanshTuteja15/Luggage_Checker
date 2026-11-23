import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { aiAllowed, matchJudgeTask, PgAiCache } from "@/lib/engine/ai";
import { reviewAdvice, type ReviewAdvice } from "@/lib/engine/identity/advice";
import { wordsApart } from "@/lib/engine/identity/review";
import { luggagePack } from "@/lib/engine/packs/luggage";
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
    const n = Number(req.nextUrl.searchParams.get("limit") ?? 200);
    const limit = Number.isInteger(n) && n >= 1 && n <= 1000 ? n : 200;
    const items = await rt.store.listReviews(status, limit);
    // v4 A5.3: the judge's cached opinion beside each pending pair (advice only).
    let advice: Record<string, ReviewAdvice | null> = {};
    if (status === "pending" && aiAllowed(await rt.flags(), matchJudgeTask)) {
      const cache = rt.store instanceof PgEngineStore ? new PgAiCache(rt.store.pool) : null;
      if (cache) advice = await reviewAdvice(cache, rt.config.ai.model, items);
    }
    // The words only one side's product name has, for the batch screen to highlight (T-501).
    const words = Object.fromEntries(items.map((r) => [r.id, wordsApart(luggagePack, r)]));
    return NextResponse.json({ items, advice, words });
  } catch (err) {
    return errorResponse(err, "GET /api/admin/review");
  }
}
