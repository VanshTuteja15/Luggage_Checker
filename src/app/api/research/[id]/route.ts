import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { ownedSession } from "@/lib/engine/research/api";
import { getEngine } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** GET /api/research/<id> — resume a session: its state and every event so far. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireUser(req);
    const { id } = await params;
    const { rt } = getEngine();
    const session = await ownedSession(rt.store, id, userId);
    if (!session) return NextResponse.json({ error: "Search not found." }, { status: 404 });
    const events = await rt.store.listEvents(id, 0);
    const { userId: _owner, ...publicSession } = session;
    void _owner;
    return NextResponse.json({ session: publicSession, events });
  } catch (err) {
    return errorResponse(err, "GET /api/research/[id]");
  }
}
