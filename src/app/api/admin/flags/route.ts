import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { setFlagAdmin } from "@/lib/engine/admin-actions";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

/** POST /api/admin/flags { key, enabled } — flip a known feature flag. */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as { key?: unknown; enabled?: unknown };
    if (typeof body.key !== "string" || typeof body.enabled !== "boolean")
      return badRequest("key (string) and enabled (boolean) are required");
    const r = await setFlagAdmin(getEngine().rt, body.key, body.enabled, userId);
    if (!r.ok) return badRequest(r.error ?? "invalid flag");
    return NextResponse.json({ key: body.key, enabled: body.enabled });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/flags");
  }
}
