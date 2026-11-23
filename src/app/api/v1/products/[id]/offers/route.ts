import type { NextRequest } from "next/server";
import { offersV1, params, parseParams } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/products/{id}/offers : each store's latest price for the product, cheapest first. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return priceApi(req, "GET /api/v1/products/[id]/offers", (d, q) =>
    offersV1(d, parseParams(params.product, { ...q, id })),
  );
}
