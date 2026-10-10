import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { runScheduledEngine } from "@/lib/engine/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled price check: the price engine re-verifies tracked products
 * (on the worker, or here within a time limit) and applies retention.
 *
 * The engine is the only source of current prices (MASTER_PROMPT_V2 §4).
 * The old web-research refresh that wrote search-result prices into the
 * tracking tables no longer runs: those prices could be wrong (E1/E2), and
 * web estimates now go through the R3 checks and stay labelled instead.
 *
 * Protected by CRON_SECRET (constant-time compare). /api/cron/tick runs the
 * same job on the morning-email schedule; this route stays for Vercel Cron.
 */
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const engine = await runScheduledEngine({ timeLimitMs: 120_000 });
    return NextResponse.json({ message: "Price check complete (verified engine)", engine });
  } catch (err) {
    console.error("Cron fetch-prices error:", err);
    return NextResponse.json({ error: "The daily price check couldn't run." }, { status: 500 });
  }
}

/** Vercel Cron issues GET requests. */
export async function GET(req: NextRequest) {
  return POST(req);
}
