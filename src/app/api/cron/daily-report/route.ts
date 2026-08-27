import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sendDailyReport, type PriceChangeItem, type ReportData } from "@/lib/email";

/**
 * POST /api/cron/daily-report
 *
 * Called daily at 9 AM MT by Vercel Cron (or GitHub Actions).
 * Compares today's prices with yesterday's and sends an email report.
 */
export async function POST(req: NextRequest) {
  // Verify cron secret
  const secret =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Get all tracked products
    const { data: tracked } = await supabase
      .from("tracked_products")
      .select("product_id");

    const productIds = [...new Set(tracked?.map((t) => t.product_id) ?? [])];
    if (productIds.length === 0) {
      return NextResponse.json({ message: "No tracked products", sent: false });
    }

    // Get product details
    const { data: products } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);

    // Get today's and yesterday's prices
    const { data: todayPrices } = await supabase
      .from("price_history")
      .select("*")
      .in("product_id", productIds)
      .eq("date", today);

    const { data: yesterdayPrices } = await supabase
      .from("price_history")
      .select("*")
      .in("product_id", productIds)
      .eq("date", yesterday);

    // Get current offers for OOS check
    const { data: offers } = await supabase
      .from("retailer_offers")
      .select("*")
      .in("product_id", productIds);

    // Build report data
    const drops: PriceChangeItem[] = [];
    const increases: PriceChangeItem[] = [];
    const outOfStock: { productName: string; retailer: string }[] = [];
    const lowestFinds: { productName: string; retailer: string; price: number; url: string }[] = [];

    for (const product of products ?? []) {
      const todayP = todayPrices?.filter((p) => p.product_id === product.id) ?? [];
      const yesterdayP = yesterdayPrices?.filter((p) => p.product_id === product.id) ?? [];
      const productOffers = offers?.filter((o) => o.product_id === product.id) ?? [];

      // Find price changes per retailer
      for (const tp of todayP) {
        const yp = yesterdayP.find((y) => y.retailer === tp.retailer);
        if (!yp) continue;

        const oldPrice = Number(yp.price);
        const newPrice = Number(tp.price);
        if (oldPrice === newPrice) continue;

        const offer = productOffers.find((o) => o.retailer === tp.retailer);
        const item: PriceChangeItem = {
          productName: product.name,
          brand: product.brand,
          retailer: tp.retailer,
          oldPrice,
          newPrice,
          url: offer?.url ?? "",
        };

        if (newPrice < oldPrice) drops.push(item);
        else increases.push(item);
      }

      // OOS alerts
      for (const o of productOffers) {
        if (!o.in_stock) {
          outOfStock.push({ productName: product.name, retailer: o.retailer });
        }
      }

      // Best deal per product
      const inStock = productOffers.filter((o) => o.in_stock);
      if (inStock.length > 0) {
        const best = inStock.reduce((a, b) => (Number(a.price) < Number(b.price) ? a : b));
        lowestFinds.push({
          productName: product.name,
          retailer: best.retailer,
          price: Number(best.price),
          url: best.url ?? "",
        });
      }
    }

    // Sort: biggest drops first, lowest prices first
    drops.sort((a, b) => (a.newPrice - a.oldPrice) - (b.newPrice - b.oldPrice));
    lowestFinds.sort((a, b) => a.price - b.price);

    const reportData: ReportData = {
      date: today,
      totalTracked: productIds.length,
      drops,
      increases,
      outOfStock,
      lowestFinds: lowestFinds.slice(0, 5),
    };

    // Send the email
    const result = await sendDailyReport(reportData);

    return NextResponse.json({
      message: "Report sent",
      drops: drops.length,
      increases: increases.length,
      outOfStock: outOfStock.length,
      emailId: result?.id,
    });
  } catch (err) {
    console.error("Daily report error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
