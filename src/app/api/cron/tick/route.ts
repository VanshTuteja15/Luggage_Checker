import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { NO_DATABASE, tickDeps } from "@/lib/digest/server";
import { runTick } from "@/lib/digest/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/cron/tick: the one scheduler entry point (R1.15).
 *
 * Supabase pg_cron calls it every 15 minutes (supabase/scheduler/
 * schedule.sql); the worker and Vercel Cron are fallbacks. Each call
 * decides what is due for each account and does it once: the daily engine
 * jobs and retention, the morning email's prepare run at send − 60 min,
 * the send, and "missed" after noon. Idempotent, so extra calls are safe.
 *
 * Auth: `x-cron-secret: CRON_SECRET`, compared in constant time. POST only.
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const deps = tickDeps(req);
  if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
  try {
    return NextResponse.json(await runTick(deps));
  } catch (err) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`tick [${ref}]:`, err);
    return NextResponse.json({ error: `The scheduled run didn't finish (ref ${ref}).` }, { status: 500 });
  }
}
