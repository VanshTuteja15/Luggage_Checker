import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { addCandidate, candidateView, listCandidates } from "@/lib/engine/discovery/candidates";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

const FOUND_VIA = ["staff", "brand_locator", "link", "common_crawl"] as const;

/** GET /api/admin/candidates: stores found but not reviewed yet (v4 A6), newest first. */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const candidates = await listCandidates(getEngine().rt);
    return NextResponse.json({ candidates: candidates.map(candidateView) });
  } catch (err) {
    return errorResponse(err, "GET /api/admin/candidates");
  }
}

/** POST /api/admin/candidates { url, name?, foundVia, note? }: record a store. Nothing is fetched. */
export async function POST(req: NextRequest) {
  try {
    await requireAdmin(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof body.url !== "string" || body.url.length > 300)
      return badRequest("Give the store's web address.");
    const foundVia = FOUND_VIA.find((f) => f === body.foundVia);
    if (!foundVia)
      return badRequest("Say how it was found: staff, brand_locator, link or common_crawl.");
    const r = await addCandidate(getEngine().rt, {
      url: body.url,
      name: typeof body.name === "string" ? body.name : null,
      foundVia,
      note: typeof body.note === "string" ? body.note : null,
    });
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
    return NextResponse.json({ candidate: candidateView(r.source) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/candidates");
  }
}
