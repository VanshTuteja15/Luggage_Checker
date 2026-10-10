import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { getTrackedProducts } from "@/lib/db/products";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { lastKnownFromEngine, lastKnownFromTracked } from "@/lib/engine/research/last-known";
import { engineStoreReady, getEngine } from "@/lib/engine/server";
import type { AnswerProduct } from "@/lib/engine/types";
import { chosenStoreIdsFor } from "@/lib/stores";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 20;

const query = z.string().trim().min(1).max(200);

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

/**
 * GET /api/research/last-known?q=… — saved prices for a search, each with
 * its own date, for when a live check can't run (R2.5). Engine records
 * first; the tracked products as a second source. Never fetches a store.
 */
export async function GET(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    const q = query.safeParse(req.nextUrl.searchParams.get("q") ?? "");
    if (!q.success) return badRequest("A search is required.");
    const storeIds = await chosenStoreIdsFor(supabase, userId);

    let products: AnswerProduct[] = [];
    let from: "engine" | "tracked" | "none" = "none";
    try {
      if (engineStoreReady()) {
        const { rt } = getEngine();
        products = await withTimeout(
          rt.sources().then((sources) =>
            lastKnownFromEngine(rt.store, luggagePack, sources, q.data, { storeIds }),
          ),
          6_000,
        );
        if (products.length) from = "engine";
      }
    } catch (err) {
      console.error("GET /api/research/last-known (engine):", err);
    }
    if (products.length === 0) {
      try {
        const tracked = await getTrackedProducts(supabase, userId, { days: 30 });
        products = lastKnownFromTracked(tracked, q.data, luggagePack, SOURCE_SEED).filter(
          (p) => !storeIds || p.offers.some((o) => storeIds.includes(o.sourceId)),
        );
        if (products.length) from = "tracked";
      } catch (err) {
        console.error("GET /api/research/last-known (tracked):", err);
      }
    }
    return NextResponse.json({ products, from });
  } catch (err) {
    return errorResponse(err, "GET /api/research/last-known");
  }
}
