import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * GET /api/products/[productId]
 * Get a single product with offers and 30-day price history.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ productId: string }> },
) {
  try {
    const { productId } = await params;
    const supabase = getSupabaseAdmin();

    // Fetch product + offers
    const { data: product, error } = await supabase
      .from("products")
      .select(`
        *,
        retailer_offers (*)
      `)
      .eq("slug", productId)
      .maybeSingle();

    if (error) throw error;
    if (!product) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Fetch 30-day price history
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data: history, error: historyErr } = await supabase
      .from("price_history")
      .select("retailer, price, date")
      .eq("product_id", product.id)
      .gte("date", thirtyDaysAgo.toISOString().slice(0, 10))
      .order("date", { ascending: true });

    if (historyErr) throw historyErr;

    // Group history by retailer
    const historyByRetailer: Record<string, { date: string; price: number }[]> = {};
    for (const h of history ?? []) {
      if (!historyByRetailer[h.retailer]) historyByRetailer[h.retailer] = [];
      historyByRetailer[h.retailer].push({ date: h.date, price: Number(h.price) });
    }

    return NextResponse.json({
      ...product,
      history: historyByRetailer,
    });
  } catch (err) {
    console.error("GET /api/products/[id] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
