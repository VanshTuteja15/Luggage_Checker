import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { PgDigestStore } from "@/lib/digest/store";
import { requireAdmin } from "@/lib/engine/admin";
import { adminOverview } from "@/lib/engine/admin-actions";
import { estimateStoreFor, tavilyUsage } from "@/lib/engine/estimates/deps";
import { getEngine } from "@/lib/engine/server";
import { pgPoolOf } from "@/lib/engine/store/pg";
import type { UsageSummary } from "@/lib/store-status-view";
import { emailDailyLimit, emailMonthlyLimit, monthStartUtc } from "@/lib/mailer";

export const dynamic = "force-dynamic";

/** Web estimates and emails used against their free limits (Store status → Usage). */
async function usage(now: Date): Promise<UsageSummary> {
  const { rt } = getEngine();
  const credits = await tavilyUsage().catch(() => null);
  const pool = pgPoolOf(rt.store);
  let emails: UsageSummary["emails"] = null;
  if (pool) {
    const store = new PgDigestStore(pool);
    const [last24h, thisMonth] = await Promise.all([
      store.emailsSentSince(new Date(now.getTime() - 24 * 3_600_000).toISOString()),
      store.emailsSentSince(monthStartUtc(now)),
    ]).catch(() => [null, null]);
    if (last24h !== null && thisMonth !== null)
      emails = {
        last24h,
        thisMonth,
        dailyLimit: emailDailyLimit(),
        monthlyLimit: emailMonthlyLimit(),
      };
  }
  return {
    estimates: credits
      ? { configured: true, left: Math.max(0, credits.cap - credits.used), cap: credits.cap }
      : { configured: false, left: 0, cap: 0 },
    emails,
  };
}

/**
 * GET /api/admin/overview — Store status: plain store rows and usage first,
 * then the technical detail (source health, failures, review queue, session
 * timings, flags, rejected web estimates).
 */
export async function GET(req: NextRequest) {
  try {
    await requireAdmin(req);
    const { rt } = getEngine();
    const [overview, used, estimateRejections] = await Promise.all([
      adminOverview(rt),
      usage(new Date()),
      estimateStoreFor(rt)
        .recentRejections(60)
        .catch(() => []),
    ]);
    return NextResponse.json({ ...overview, usage: used, estimateRejections });
  } catch (err) {
    return errorResponse(err, "GET /api/admin/overview");
  }
}
