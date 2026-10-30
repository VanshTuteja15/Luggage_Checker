import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { factsForUrls, MAX_FACT_URLS } from "@/lib/engine/facts";
import { engineStoreReady, getEngine } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const urls = z
  .array(z.string().trim().url().startsWith("https://").max(2_000))
  .min(1)
  .max(MAX_FACT_URLS);

/**
 * GET /api/engine/offer-facts?url=…&url=… — for store pages on screen:
 * the promotions each store states now and the product attributes on
 * file, every value with its store, method, evidence and date (v4 A4).
 * Reads the index only and never fetches a store. A promotion's sale and
 * was figures are what the store stated beside a verified reading; the
 * price shown on screen still comes from the offer itself.
 */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const parsed = urls.safeParse(req.nextUrl.searchParams.getAll("url"));
    if (!parsed.success) return badRequest(`Give 1–${MAX_FACT_URLS} store page links (https).`);
    if (!engineStoreReady()) return NextResponse.json({ facts: [] });
    const { rt } = getEngine();
    const facts = await factsForUrls(rt.store, await rt.sources(), parsed.data);
    return NextResponse.json({ facts });
  } catch (err) {
    return errorResponse(err, "GET /api/engine/offer-facts");
  }
}
