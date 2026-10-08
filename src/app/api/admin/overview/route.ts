import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { adminOverview } from "@/lib/engine/admin-actions";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

/** GET /api/admin/overview — source health, failures, review queue, session timings, flags. */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    return NextResponse.json(await adminOverview(getEngine().rt));
  } catch (err) {
    return errorResponse(err, "GET /api/admin/overview");
  }
}
