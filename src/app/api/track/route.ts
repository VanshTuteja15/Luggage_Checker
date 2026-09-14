import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { getTrackedProducts, upsertProductWithOffers } from "@/lib/db/products";
import type { Offer, SearchProduct } from "@/lib/search/types";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/*                                                                     */
/*  The payload comes from the browser, so it is not trusted. An offer */
/*  without a real URL and a positive price is discarded rather than   */
/*  stored — a bad price in the history table poisons every future     */
/*  comparison and alert.                                             */
/* ------------------------------------------------------------------ */

function parseOffer(raw: unknown): Offer | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const url = typeof o.url === "string" ? o.url.trim() : "";
  const price = typeof o.price === "number" ? o.price : Number(o.price);
  const retailer = typeof o.retailer === "string" ? o.retailer.trim() : "";

  if (!url.startsWith("http")) return null;
  if (!Number.isFinite(price) || price <= 0 || price > 100_000) return null;
  if (!retailer) return null;

  return {
    retailer,
    retailerKey: typeof o.retailerKey === "string" ? o.retailerKey : null,
    price: Math.round(price * 100) / 100,
    currency: "CAD",
    url,
    inStock: o.inStock !== false,
    title: typeof o.title === "string" ? o.title.slice(0, 300) : retailer,
    thumbnail: typeof o.thumbnail === "string" ? o.thumbnail : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

function parseProduct(raw: unknown): SearchProduct | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;

  const name = typeof p.name === "string" ? p.name.trim().slice(0, 200) : "";
  if (!name) return null;

  const offers = (Array.isArray(p.offers) ? p.offers : [])
    .map(parseOffer)
    .filter((o): o is Offer => o !== null)
    .sort((a, b) => a.price - b.price);

  if (offers.length === 0) return null;

  const prices = offers.map((o) => o.price);
  const upcRaw = typeof p.upc === "string" ? p.upc.replace(/\D/g, "") : "";

  return {
    key: typeof p.key === "string" ? p.key : "",
    name,
    brand: typeof p.brand === "string" ? p.brand.trim().slice(0, 100) : "Unknown",
    model: typeof p.model === "string" ? p.model.trim().slice(0, 120) : "",
    color: typeof p.color === "string" ? p.color.trim().slice(0, 60) : "",
    size: typeof p.size === "string" ? p.size.trim().slice(0, 60) : "",
    upc: upcRaw.length >= 12 && upcRaw.length <= 14 ? upcRaw : null,
    productType: typeof p.productType === "string" ? p.productType.slice(0, 60) : null,
    imageUrl: typeof p.imageUrl === "string" ? p.imageUrl : null,
    offers,
    lowestPrice: Math.min(...prices),
    highestPrice: Math.max(...prices),
    retailerCount: offers.length,
    spread: Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100,
    hasMajorRetailer: p.hasMajorRetailer === true,
  };
}

/* ------------------------------------------------------------------ */
/*  POST /api/track — start tracking a product from a search result   */
/* ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Two shapes: track a brand-new product from search, or track a product
    // that already exists in the database by id.
    if (typeof body.productId === "string" && body.productId) {
      const { error } = await supabase.from("tracked_products").upsert(
        {
          user_id: userId,
          product_id: body.productId,
          target_price: typeof body.targetPrice === "number" ? body.targetPrice : null,
        },
        { onConflict: "user_id,product_id" },
      );
      if (error) throw error;

      const [product] = await getTrackedProducts(supabase, userId, {
        productId: body.productId,
      });
      return NextResponse.json({ product }, { status: 201 });
    }

    const product = parseProduct(body.product);
    if (!product) {
      return badRequest(
        "That result can't be tracked — it has no usable retailer listing with a price.",
      );
    }

    const productId = await upsertProductWithOffers(supabase, product);

    const { error } = await supabase.from("tracked_products").upsert(
      {
        user_id: userId,
        product_id: productId,
        target_price: typeof body.targetPrice === "number" ? body.targetPrice : null,
      },
      { onConflict: "user_id,product_id" },
    );
    if (error) throw error;

    const [saved] = await getTrackedProducts(supabase, userId, { productId });
    return NextResponse.json({ product: saved }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/track");
  }
}

/* ------------------------------------------------------------------ */
/*  DELETE /api/track — stop tracking one or more products            */
/* ------------------------------------------------------------------ */

export async function DELETE(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      productId?: unknown;
      productIds?: unknown;
    };

    const ids = Array.isArray(body.productIds)
      ? body.productIds.filter((v): v is string => typeof v === "string")
      : typeof body.productId === "string"
        ? [body.productId]
        : [];

    if (ids.length === 0) return badRequest("No product specified.");

    const { error } = await supabase
      .from("tracked_products")
      .delete()
      .eq("user_id", userId)
      .in("product_id", ids);

    if (error) throw error;

    return NextResponse.json({ removed: ids.length });
  } catch (err) {
    return errorResponse(err, "DELETE /api/track");
  }
}

/* ------------------------------------------------------------------ */
/*  PATCH /api/track — update the alert threshold for a product       */
/* ------------------------------------------------------------------ */

export async function PATCH(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as {
      productId?: unknown;
      targetPrice?: unknown;
      alertEnabled?: unknown;
    };

    if (typeof body.productId !== "string" || !body.productId) {
      return badRequest("No product specified.");
    }

    const patch: Record<string, unknown> = {};

    if ("targetPrice" in body) {
      const t = body.targetPrice;
      if (t === null) patch.target_price = null;
      else {
        const n = typeof t === "number" ? t : Number(t);
        if (!Number.isFinite(n) || n <= 0) return badRequest("Target price must be a positive number.");
        patch.target_price = Math.round(n * 100) / 100;
      }
    }

    if (typeof body.alertEnabled === "boolean") patch.alert_enabled = body.alertEnabled;

    if (Object.keys(patch).length === 0) return badRequest("Nothing to update.");

    const { error } = await supabase
      .from("tracked_products")
      .update(patch)
      .eq("user_id", userId)
      .eq("product_id", body.productId);

    if (error) throw error;

    const [product] = await getTrackedProducts(supabase, userId, {
      productId: body.productId,
    });
    return NextResponse.json({ product });
  } catch (err) {
    return errorResponse(err, "PATCH /api/track");
  }
}
