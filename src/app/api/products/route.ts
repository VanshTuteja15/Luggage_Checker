import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * GET /api/products
 * List all products with current offers.
 */
export async function GET() {
  try {
    const supabase = getSupabaseAdmin();

    const { data: products, error } = await supabase
      .from("products")
      .select(`
        *,
        retailer_offers (*)
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return NextResponse.json(products ?? []);
  } catch (err) {
    console.error("GET /api/products error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/products
 * Add a product to the database.
 * Body: { name, brand, model, color, upc?, slug? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, brand, model, color, upc, slug: rawSlug } = body;

    if (!name || !brand || !model) {
      return NextResponse.json(
        { error: "name, brand, and model are required" },
        { status: 400 },
      );
    }

    const slug =
      rawSlug ||
      `${brand}-${model}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

    const supabase = getSupabaseAdmin();

    // Check if product already exists by slug or UPC
    const { data: existing } = await supabase
      .from("products")
      .select("id, slug")
      .or(`slug.eq.${slug}${upc ? `,upc.eq.${upc}` : ""}`)
      .maybeSingle();

    if (existing) {
      return NextResponse.json(existing);
    }

    const { data: product, error } = await supabase
      .from("products")
      .insert({ name, brand, model, color: color ?? "", upc, slug })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json(product, { status: 201 });
  } catch (err) {
    console.error("POST /api/products error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
