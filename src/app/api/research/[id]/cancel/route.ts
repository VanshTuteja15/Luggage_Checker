import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { ownedSession } from "@/lib/engine/research/api";
import { getEngine } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/research/<id>/cancel — stop a running session.
 *
 * Marks the session cancelled (the worker sees it within half a second)
 * and aborts it directly when it runs in this process.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireUser(req);
    const { id } = await params;
    const { rt, manager } = getEngine();
    const session = await ownedSession(rt.store, id, userId);
    if (!session) return NextResponse.json({ error: "Search not found." }, { status: 404 });
    if (session.status !== "queued" && session.status !== "running") {
      return NextResponse.json({ cancelled: false, status: session.status });
    }
    await rt.store.updateSession(id, { status: "cancelled", finishedAt: new Date().toISOString() });
    manager.cancel(id);
    return NextResponse.json({ cancelled: true, status: "cancelled" });
  } catch (err) {
    return errorResponse(err, "POST /api/research/[id]/cancel");
  }
}
