import type { NextRequest } from "next/server";
import { params, parseParams, productV1 } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/products/{id} : the product, its variants and their attributes. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return priceApi(req, "GET /api/v1/products/[id]", (d, q) =>
    productV1(d, parseParams(params.product, { ...q, id })),
  );
}
