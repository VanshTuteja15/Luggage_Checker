import type { NextRequest } from "next/server";
import { params, parseParams, promotionsV1 } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/promotions?store=&limit= : promotions stores state now, newest first. */
export async function GET(req: NextRequest) {
  return priceApi(req, "GET /api/v1/promotions", (d, q) =>
    promotionsV1(d, parseParams(params.promotions, q)),
  );
}
