import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { flagOn } from "@/lib/engine/flags";
import { getEngine } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** GET /api/features — which optional parts of the app are switched on. */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const flags = await getEngine().rt.flags();
    return NextResponse.json({ chat: flagOn(flags, "chat.enabled") });
  } catch (err) {
    return errorResponse(err, "GET /api/features");
  }
}
