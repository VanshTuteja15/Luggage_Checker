/* ------------------------------------------------------------------ */
/*  Product persistence and reads                                     */
/*                                                                     */
/*  Every function takes a SupabaseClient so it works both for a       */
/*  user-scoped client (RLS applies) and the service-role client used  */
/*  by cron jobs.                                                      */
/* ------------------------------------------------------------------ */

import type { SupabaseClient } from "@supabase/supabase-js";
import { slugify } from "@/lib/search/cluster";
import type { SearchProduct } from "@/lib/search/types";
import type { PricePoint, TrackedOffer, TrackedProduct } from "@/lib/types";

type ProductRow = {
  id: string;
  slug: string;
  name: string;
  brand: string;
  model: string;
  color: string | null;
  upc: string | null;
  image_url: string | null;
  product_type: string | null;
  last_checked_at: string | null;
};

type OfferRow = {
  product_id: string;
  retailer: string;
  price: number | string;
  in_stock: boolean;
  url: string | null;
  title: string | null;
  last_checked_at: string | null;
};

type HistoryRow = {
  product_id: string;
  retailer: string;
  price: number | string;
  date: string;
};

type TrackedRow = {
  product_id: string;
  target_price: number | string | null;
  alert_enabled: boolean | null;
  created_at: string;
};

const num = (v: number | string | null | undefined): number =>
  typeof v === "number" ? v : Number(v ?? 0);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  Writes                                                            */
/* ------------------------------------------------------------------ */

/**
 * Create or update a product and all of its offers, and record today's
 * prices in history.
 *
 * Matching order: UPC when we have one (the only truly reliable key),
 * otherwise the brand+model slug. Returns the product row id.
 */
export async function upsertProductWithOffers(
  supabase: SupabaseClient,
  product: SearchProduct,
): Promise<string> {
  const slug = product.key || slugify(`${product.brand} ${product.model}`) || slugify(product.name);
  const now = new Date().toISOString();

  // ── Find an existing product ────────────────────────────────
  let existing: { id: string; image_url: string | null } | null = null;

  if (product.upc) {
    const { data } = await supabase
      .from("products")
      .select("id, image_url")
      .eq("upc", product.upc)
      .maybeSingle();
    existing = data ?? null;
  }

  if (!existing) {
    const { data } = await supabase
      .from("products")
      .select("id, image_url")
      .eq("slug", slug)
      .maybeSingle();
    existing = data ?? null;
  }

  let productId: string;

  if (existing) {
    productId = existing.id;
    await supabase
      .from("products")
      .update({
        name: product.name,
        brand: product.brand,
        model: product.model,
        color: product.color ?? "",
        product_type: product.productType,
        // Don't clobber an existing image with a null.
        ...(product.imageUrl ? { image_url: product.imageUrl } : {}),
        ...(product.upc ? { upc: product.upc } : {}),
        last_checked_at: now,
      })
      .eq("id", productId);
  } else {
    const { data, error } = await supabase
      .from("products")
      .insert({
        slug,
        name: product.name,
        brand: product.brand,
        model: product.model,
        color: product.color ?? "",
        upc: product.upc,
        image_url: product.imageUrl,
        product_type: product.productType,
        source_url: product.offers[0]?.url ?? null,
        last_checked_at: now,
      })
      .select("id")
      .single();

    if (error) {
      // A concurrent insert can win the race on the unique slug — re-read.
      const { data: retry } = await supabase
        .from("products")
        .select("id")
        .eq("slug", slug)
        .maybeSingle();
      if (!retry) throw error;
      productId = retry.id;
      return finishOffers(supabase, productId, product);
    }
    productId = data.id;
  }

  return finishOffers(supabase, productId, product);
}

async function finishOffers(
  supabase: SupabaseClient,
  productId: string,
  product: SearchProduct,
): Promise<string> {
  const now = new Date().toISOString();
  const date = today();

  if (product.offers.length === 0) return productId;

  const offerRows = product.offers.map((o) => ({
    product_id: productId,
    retailer: o.retailer,
    price: o.price,
    currency: "CAD",
    in_stock: o.inStock,
    url: o.url,
    title: o.title,
    last_checked_at: now,
  }));

  const { error: offerErr } = await supabase
    .from("retailer_offers")
    .upsert(offerRows, { onConflict: "product_id,retailer" });
  if (offerErr) throw offerErr;

  const historyRows = product.offers.map((o) => ({
    product_id: productId,
    retailer: o.retailer,
    price: o.price,
    currency: "CAD",
    date,
  }));

  // Requires the price_history_unique_day constraint from migration 002.
  const { error: histErr } = await supabase
    .from("price_history")
    .upsert(historyRows, { onConflict: "product_id,retailer,date" });
  if (histErr) throw histErr;

  return productId;
}

/* ------------------------------------------------------------------ */
/*  Reads                                                             */
/* ------------------------------------------------------------------ */

/**
 * Load every product the given user tracks, with current offers and the
 * last `days` of price history assembled for charting.
 */
export async function getTrackedProducts(
  supabase: SupabaseClient,
  userId: string,
  opts: { days?: number; productId?: string } = {},
): Promise<TrackedProduct[]> {
  const days = opts.days ?? 30;

  let trackedQuery = supabase
    .from("tracked_products")
    .select("product_id, target_price, alert_enabled, created_at")
    .eq("user_id", userId);

  if (opts.productId) trackedQuery = trackedQuery.eq("product_id", opts.productId);

  const { data: trackedRaw, error: trackedErr } = await trackedQuery;
  if (trackedErr) throw trackedErr;

  const tracked = (trackedRaw ?? []) as TrackedRow[];
  if (tracked.length === 0) return [];

  const productIds = tracked.map((t) => t.product_id);

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const [productsRes, offersRes, historyRes] = await Promise.all([
    supabase.from("products").select("*").in("id", productIds),
    supabase.from("retailer_offers").select("*").in("product_id", productIds),
    supabase
      .from("price_history")
      .select("product_id, retailer, price, date")
      .in("product_id", productIds)
      .gte("date", since)
      .order("date", { ascending: true }),
  ]);

  if (productsRes.error) throw productsRes.error;
  if (offersRes.error) throw offersRes.error;
  if (historyRes.error) throw historyRes.error;

  const products = (productsRes.data ?? []) as ProductRow[];
  const offers = (offersRes.data ?? []) as OfferRow[];
  const history = (historyRes.data ?? []) as HistoryRow[];

  const trackedById = new Map(tracked.map((t) => [t.product_id, t]));

  return products
    .map((p) => buildTrackedProduct(p, offers, history, trackedById.get(p.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildTrackedProduct(
  p: ProductRow,
  allOffers: OfferRow[],
  allHistory: HistoryRow[],
  tracked: TrackedRow | undefined,
): TrackedProduct {
  const rows = allOffers.filter((o) => o.product_id === p.id);

  const offers: TrackedOffer[] = rows
    .map((o) => ({
      retailer: o.retailer,
      price: num(o.price),
      inStock: o.in_stock !== false,
      url: o.url,
      title: o.title,
      lastCheckedAt: o.last_checked_at,
    }))
    .sort((a, b) => a.price - b.price);

  const inStockOffers = offers.filter((o) => o.inStock);
  const best = inStockOffers[0] ?? offers[0] ?? null;

  // ── History: lowest price per day, and a series per retailer ──
  const productHistory = allHistory.filter((h) => h.product_id === p.id);

  const lowestByDate = new Map<string, number>();
  const byRetailer: Record<string, PricePoint[]> = {};

  for (const h of productHistory) {
    const price = num(h.price);
    const current = lowestByDate.get(h.date);
    if (current === undefined || price < current) lowestByDate.set(h.date, price);
    (byRetailer[h.retailer] ??= []).push({ date: h.date, price });
  }

  for (const series of Object.values(byRetailer)) {
    series.sort((a, b) => a.date.localeCompare(b.date));
  }

  const historySeries: PricePoint[] = [...lowestByDate.entries()]
    .map(([date, price]) => ({ date, price }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lowestPrice = best?.price ?? null;

  // "Previous" is the most recent day before the latest one we have.
  const previousLowest =
    historySeries.length >= 2 ? historySeries[historySeries.length - 2].price : null;

  const change =
    lowestPrice !== null && previousLowest !== null
      ? Math.round((lowestPrice - previousLowest) * 100) / 100
      : 0;

  const prices = offers.map((o) => o.price);
  const spread =
    prices.length > 1 ? Math.round((Math.max(...prices) - Math.min(...prices)) * 100) / 100 : 0;

  const lastCheckedAt =
    offers.map((o) => o.lastCheckedAt).filter((d): d is string => !!d).sort().pop() ??
    p.last_checked_at;

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    model: p.model,
    color: p.color ?? "",
    upc: p.upc,
    imageUrl: p.image_url,
    productType: p.product_type,
    offers,
    history: historySeries,
    historyByRetailer: byRetailer,
    lowestPrice,
    lowestRetailer: best?.retailer ?? null,
    previousLowest,
    change,
    retailerCount: offers.length,
    spread,
    inStock: inStockOffers.length > 0,
    targetPrice: tracked?.target_price != null ? num(tracked.target_price) : null,
    alertEnabled: tracked?.alert_enabled !== false,
    lastCheckedAt,
    trackedAt: tracked?.created_at ?? new Date().toISOString(),
  };
}
