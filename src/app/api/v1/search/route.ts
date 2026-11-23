import type { NextRequest } from "next/server";
import { params, parseParams, searchV1 } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/search?q=&limit= : products in our index with their latest prices (docs/openapi-v1.yaml). */
export async function GET(req: NextRequest) {
  return priceApi(req, "GET /api/v1/search", (d, q) => searchV1(d, parseParams(params.search, q)));
}
