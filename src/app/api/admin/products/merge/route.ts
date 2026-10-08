import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** POST /api/admin/products/merge { fromId, intoId } — correct a split identity. Never across sizes. */
export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as { fromId?: unknown; intoId?: unknown };
    if (typeof body.fromId !== "string" || typeof body.intoId !== "string" || !UUID.test(body.fromId) || !UUID.test(body.intoId)) {
      return badRequest("fromId and intoId must be product ids");
    }
    try {
      await getEngine().rt.store.mergeProducts(body.fromId, body.intoId);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "merge refused" }, { status: 409 });
    }
    return NextResponse.json({ merged: true });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/products/merge");
  }
}
