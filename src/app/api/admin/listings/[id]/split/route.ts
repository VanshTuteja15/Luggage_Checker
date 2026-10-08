import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";

/** POST /api/admin/listings/<id>/split — this listing is not that product: give it its own. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    const store = getEngine().rt.store;
    if (!(await store.getListing(id)))
      return NextResponse.json({ error: "Listing not found." }, { status: 404 });
    const product = await store.splitListing(id);
    return NextResponse.json({ productId: product.id });
  } catch (err) {
    return errorResponse(err, "POST /api/admin/listings/[id]/split");
  }
}
