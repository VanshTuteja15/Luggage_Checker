import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { decideReviews, MAX_BATCH_DECISIONS } from "@/lib/engine/identity/review";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

const ID_RE = /^[0-9a-f-]{8,64}$/i;

/**
 * POST /api/admin/review/batch { ids: string[], decision: "approved" | "rejected" }
 * The same decision on up to 100 review items (v4 A5.3, the batch review
 * screen). Each id gets its own result; one failure doesn't stop the rest.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as { ids?: unknown; decision?: unknown };
    if (body.decision !== "approved" && body.decision !== "rejected")
      return badRequest('Choose "Same product" or "Different product".');
    const ids = body.ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_BATCH_DECISIONS ||
      !ids.every((id) => typeof id === "string" && ID_RE.test(id))
    )
      return badRequest(`Pick between 1 and ${MAX_BATCH_DECISIONS} items.`);
    const results = await decideReviews(
      getEngine().rt.store,
      ids as string[],
      body.decision,
      userId,
    );
    return NextResponse.json({ results });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/review/batch");
  }
}
