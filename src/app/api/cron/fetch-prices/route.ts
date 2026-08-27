import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchPrices, buildSearchQuery } from "@/lib/serpapi";

/**
 * POST /api/cron/fetch-prices
 *
 * Called by Vercel Cron (or GitHub Actions) every 6 hours.
 * Fetches current prices for all tracked products via SerpAPI
 * and updates the database.
 *
 * Protected by CRON_SECRET header.
 */
export async function POST(req: NextRequest) {
  // Verify cron secret
  const secret = req.headers.get("x-cron-secret") ?? req.headers.get("authorization")?.replace("Bearer ", "");
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();

    // Get all tracked product IDs (distinct)
    const { data: tracked, error: trackedErr } = await supabase
      .from("tracked_products")
      .select("product_id");

    if (trackedErr) throw trackedErr;

    const productIds = [...new Set(tracked?.map((t) => t.product_id) ?? [])];
    if (productIds.length === 0) {
      return NextResponse.json({ message: "No tracked products", updated: 0 });
    }

    // Fetch product details
    const { data: products, error: productsErr } = await supabase
      .from("products")
      .select("*")
      .in("id", productIds);

    if (productsErr) throw productsErr;

    const results: { slug: string; offers: number; error?: string }[] = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const product of products ?? []) {
      try {
        const query = buildSearchQuery(product);
        const prices = await fetchPrices(query);

        if (prices.length === 0) {
          results.push({ slug: product.slug, offers: 0 });
          continue;
        }

        // Upsert offers (one per retailer)
        for (const p of prices) {
          await supabase
            .from("retailer_offers")
            .upsert(
              {
                product_id: product.id,
                retailer: p.retailer,
                price: p.price,
                in_stock: p.inStock,
                url: p.url,
                last_checked_at: new Date().toISOString(),
              },
              { onConflict: "product_id,retailer" },
            );

          // Record price in history (one entry per product+retailer+date)
          const { data: existing } = await supabase
            .from("price_history")
            .select("id")
            .eq("product_id", product.id)
            .eq("retailer", p.retailer)
            .eq("date", today)
            .maybeSingle();

          if (existing) {
            await supabase
              .from("price_history")
              .update({ price: p.price })
              .eq("id", existing.id);
          } else {
            await supabase
              .from("price_history")
              .insert({
                product_id: product.id,
                retailer: p.retailer,
                price: p.price,
                date: today,
              });
          }
        }

        // Update product image if we got a thumbnail and don't have one
        if (!product.image_url && prices[0]?.thumbnail) {
          await supabase
            .from("products")
            .update({ image_url: prices[0].thumbnail })
            .eq("id", product.id);
        }

        results.push({ slug: product.slug, offers: prices.length });
      } catch (err) {
        results.push({
          slug: product.slug,
          offers: 0,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }

      // Rate limit: SerpAPI free tier = 100 searches/month.
      // Wait 2s between products to be polite.
      await new Promise((r) => setTimeout(r, 2000));
    }

    return NextResponse.json({
      message: "Price fetch complete",
      updated: results.filter((r) => r.offers > 0).length,
      total: results.length,
      results,
    });
  } catch (err) {
    console.error("Cron fetch-prices error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

/** Vercel Cron also calls GET. Support both. */
export async function GET(req: NextRequest) {
  return POST(req);
}
