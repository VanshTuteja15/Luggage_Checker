import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { decideReview } from "@/lib/engine/identity/review";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

/** POST /api/admin/review/<id> { decision: "approved" | "rejected" } */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireAdmin(req);
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { decision?: unknown };
    if (body.decision !== "approved" && body.decision !== "rejected") return badRequest('decision must be "approved" or "rejected"');
    const r = await decideReview(getEngine().rt.store, id, body.decision, userId);
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ item: r.item });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/review/[id]");
  }
}
