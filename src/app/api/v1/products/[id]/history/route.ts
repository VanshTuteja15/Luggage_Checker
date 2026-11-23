import type { NextRequest } from "next/server";
import { historyV1, params, parseParams } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/products/{id}/history?days= : every stored reading of the product's pages. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return priceApi(req, "GET /api/v1/products/[id]/history", (d, q) =>
    historyV1(d, parseParams(params.history, { ...q, id })),
  );
}
