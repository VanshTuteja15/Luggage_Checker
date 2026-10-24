import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { NO_DATABASE, tickDeps } from "@/lib/digest/server";
import { runTick } from "@/lib/digest/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The old daily report, kept for one release (R1.14). It now delegates to
 * the morning email for the same accounts: the first call moves an old
 * report address into the email's recipients, then the email goes out
 * (once a day at most; it is the same run the scheduler would make).
 *
 * Vercel Cron calls this with GET at 16:00 UTC (10:00 MDT / 9:00 MST, inside
 * the catch-up window all year) as the last-resort trigger. The primary
 * trigger is POST /api/cron/tick every 15 minutes from Supabase pg_cron.
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const deps = tickDeps(req);
  if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
  try {
    const result = await runTick(deps, { emailOnly: true });
    return NextResponse.json({ message: "Delegated to the morning email", ...result });
  } catch (err) {
    const ref = crypto.randomUUID().slice(0, 8);
    console.error(`daily-report [${ref}]:`, err);
    return NextResponse.json(
      { error: `The morning email run didn't finish (ref ${ref}).` },
      { status: 500 },
    );
  }
}

/** Vercel Cron issues GET requests. */
export async function GET(req: NextRequest) {
  return POST(req);
}
