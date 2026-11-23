import type { NextRequest } from "next/server";
import { params, parseParams, storesV1 } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/stores : the stores in our registry and how we read them. */
export async function GET(req: NextRequest) {
  return priceApi(req, "GET /api/v1/stores", (d, q) => {
    parseParams(params.stores, q);
    return storesV1(d);
  });
}
