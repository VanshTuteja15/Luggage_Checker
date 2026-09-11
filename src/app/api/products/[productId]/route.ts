import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { getTrackedProducts } from "@/lib/db/products";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ productId: string }> };

/** GET /api/products/:id — one tracked product with offers and history. */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { supabase, userId } = await requireUser(req);
    const { productId } = await params;

    const daysParam = Number(req.nextUrl.searchParams.get("days") ?? 30);
    const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 365) : 30;

    const [product] = await getTrackedProducts(supabase, userId, { productId, days });

    if (!product) {
      return NextResponse.json({ error: "Product not found in your tracked list." }, { status: 404 });
    }

    return NextResponse.json({ product });
  } catch (err) {
    return errorResponse(err, "GET /api/products/[productId]");
  }
}

/** DELETE /api/products/:id — stop tracking it. */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { supabase, userId } = await requireUser(req);
    const { productId } = await params;

    const { error } = await supabase
      .from("tracked_products")
      .delete()
      .eq("user_id", userId)
      .eq("product_id", productId);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    return errorResponse(err, "DELETE /api/products/[productId]");
  }
}
