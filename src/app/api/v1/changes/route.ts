import type { NextRequest } from "next/server";
import { changesV1, params, parseParams } from "@/lib/engine/api-v1/core";
import { priceApi } from "@/lib/engine/api-v1/http";

export const dynamic = "force-dynamic";

/** GET /api/v1/changes?since=&limit= : price or stock changes since a time, newest first. */
export async function GET(req: NextRequest) {
  return priceApi(req, "GET /api/v1/changes", (d, q) => changesV1(d, parseParams(params.changes, q)));
}
