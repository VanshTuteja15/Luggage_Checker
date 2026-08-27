import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * POST /api/track
 * Track a product. Body: { productId, userId }
 */
export async function POST(req: NextRequest) {
  try {
    const { productId, userId } = await req.json();

    if (!productId || !userId) {
      return NextResponse.json(
        { error: "productId and userId are required" },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();

    const { data, error } = await supabase
      .from("tracked_products")
      .upsert(
        { user_id: userId, product_id: productId },
        { onConflict: "user_id,product_id" },
      )
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(data, { status: 201 });
  } catch (err) {
    console.error("POST /api/track error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/track
 * Untrack a product. Body: { productId, userId }
 */
export async function DELETE(req: NextRequest) {
  try {
    const { productId, userId } = await req.json();

    if (!productId || !userId) {
      return NextResponse.json(
        { error: "productId and userId are required" },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();

    const { error } = await supabase
      .from("tracked_products")
      .delete()
      .eq("user_id", userId)
      .eq("product_id", productId);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("DELETE /api/track error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
