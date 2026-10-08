import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "rejected", "superseded"] as const;

/** GET /api/admin/review?status=pending — the identity review queue. */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const raw = req.nextUrl.searchParams.get("status") ?? "pending";
    const status = (STATUSES as readonly string[]).includes(raw) ? (raw as (typeof STATUSES)[number]) : "pending";
    const items = await getEngine().rt.store.listReviews(status, 200);
    return NextResponse.json({ items });
  } catch (err) {
    return errorResponse(err, "GET /api/admin/review");
  }
}
