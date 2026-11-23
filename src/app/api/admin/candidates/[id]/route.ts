import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { candidateView, decideCandidate, probeCandidate } from "@/lib/engine/discovery/candidates";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";
// A probe is robots.txt plus up to three terms pages, spaced by the store's crawl delay.
export const maxDuration = 60;

/** POST /api/admin/candidates/<id> { action: "probe" | "approve" | "reject" } (v4 A6) */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireAdmin(req);
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { action?: unknown };
    const rt = getEngine().rt;
    const r =
      body.action === "probe"
        ? await probeCandidate(rt, id, { signal: req.signal })
        : body.action === "approve"
          ? await decideCandidate(rt, id, "approved_crawl", userId)
          : body.action === "reject"
            ? await decideCandidate(rt, id, "rejected", userId)
            : null;
    if (!r) return badRequest('Choose "probe", "approve" or "reject".');
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ candidate: candidateView(r.source) });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/candidates/[id]");
  }
}
