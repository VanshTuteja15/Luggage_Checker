/* ------------------------------------------------------------------ */
/*  Price Data API v1: the HTTP shell around core.ts (v4 A7)            */
/*                                                                     */
/*  503 until keys are set (PRICE_API_KEYS), 401 without a valid key,   */
/*  429 over the key's rate (PRICE_API_RATE_PER_MIN, default 60 a       */
/*  minute), 400 / 404 with a plain sentence, never a stack trace.      */
/* ------------------------------------------------------------------ */

import { NextResponse, type NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { luggagePack } from "../packs/luggage";
import { getEngine } from "../server";
import {
  ApiInputError,
  ApiNotFound,
  RateLimiter,
  apiKeys,
  keyName,
  ratePerMinute,
  type ApiDeps,
} from "./core";

let limiter: RateLimiter | null = null;

/** Tests only: start the per-key counts again (and re-read the rate). */
export function resetPriceApiLimiter(): void {
  limiter = null;
}

export async function priceApi(
  req: NextRequest,
  context: string,
  run: (deps: ApiDeps, query: Record<string, string>) => Promise<unknown>,
): Promise<NextResponse> {
  try {
    const keys = apiKeys();
    if (keys.length === 0)
      return NextResponse.json(
        { error: "The price API isn't switched on here: no API keys are set." },
        { status: 503 },
      );
    const name = keyName(req.headers, keys);
    if (!name)
      return NextResponse.json(
        { error: "This needs a valid API key, sent as Authorization: Bearer <key>." },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    limiter ??= new RateLimiter(ratePerMinute());
    const rate = limiter.take(name, Date.now());
    if (!rate.ok)
      return NextResponse.json(
        { error: `Too many requests for this key; try again in ${rate.retryAfterSec} seconds.` },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } },
      );
    const { rt } = getEngine();
    const deps: ApiDeps = { store: rt.store, pack: luggagePack, sources: await rt.sources() };
    const data = await run(deps, Object.fromEntries(req.nextUrl.searchParams));
    return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ApiInputError) return NextResponse.json({ error: err.message }, { status: 400 });
    if (err instanceof ApiNotFound) return NextResponse.json({ error: err.message }, { status: 404 });
    return errorResponse(err, context);
  }
}
