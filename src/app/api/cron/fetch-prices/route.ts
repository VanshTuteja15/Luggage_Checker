import { NextRequest, NextResponse } from "next/server";
import { getTrackedProducts } from "@/lib/db/products";
import { refreshProducts } from "@/lib/db/refresh";
import { activeProvider, getBudget } from "@/lib/search";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Scheduled price check.
 *
 * Called by Vercel Cron (or the GitHub Actions workflow) every 6 hours.
 * Runs the same live-search pipeline the app uses, per user, so each user's
 * retailer settings are respected.
 *
 * Protected by CRON_SECRET. Uses the service-role client because there is no
 * signed-in user in a cron context — this is the only place that's allowed.
 */
function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";

  return header === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();

    // Which users track anything, and what are their retailer preferences?
    const { data: trackedRows, error: trackedErr } = await supabase
      .from("tracked_products")
      .select("user_id, product_id");
    if (trackedErr) throw trackedErr;

    const byUser = new Map<string, string[]>();
    for (const row of trackedRows ?? []) {
      const list = byUser.get(row.user_id) ?? [];
      list.push(row.product_id);
      byUser.set(row.user_id, list);
    }

    if (byUser.size === 0) {
      return NextResponse.json({ message: "No tracked products", checked: 0 });
    }

    // ── Spend only what the free allowance has left ──────────────
    // A scheduled job that burns a month's quota in one run is worse than
    // one that checks fewer products. Leave a small reserve so manual
    // refreshes and searches still work between runs.
    const provider = activeProvider();
    if (!provider) {
      return NextResponse.json(
        { error: "No price source configured", checked: 0 },
        { status: 503 },
      );
    }

    const budget = await getBudget(supabase, provider);
    const RESERVE = 20;
    const spendable = budget ? Math.max(0, budget.remaining - RESERVE) : Number.MAX_SAFE_INTEGER;

    if (spendable === 0) {
      return NextResponse.json({
        message: "Skipped — provider allowance exhausted",
        provider,
        budget,
        checked: 0,
      });
    }

    let callsLeft = spendable;

    const { data: allSettings } = await supabase
      .from("user_settings")
      .select("user_id, retailers");

    const retailersByUser = new Map<string, string[]>(
      (allSettings ?? []).map((s) => [
        s.user_id as string,
        Array.isArray(s.retailers) ? (s.retailers as string[]) : [],
      ]),
    );

    // A product tracked by several users only needs checking once.
    const seen = new Set<string>();
    const totalDistinctProducts = new Set(
      [...byUser.values()].flat(),
    ).size;
    const summary: { userId: string; checked: number; updated: number; failed: number }[] = [];

    for (const [userId, productIds] of byUser) {
      if (callsLeft <= 0) break;

      const fresh = productIds.filter((id) => !seen.has(id));
      if (fresh.length === 0) continue;

      const products = await getTrackedProducts(supabase, userId, { days: 2 });

      // Stalest first, so a budget-capped run still makes progress across
      // the whole list rather than re-checking the same few products.
      const queue = products
        .filter((p) => fresh.includes(p.id))
        .sort((a, b) => (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? ""))
        .slice(0, callsLeft);

      queue.forEach((p) => seen.add(p.id));
      callsLeft -= queue.length;

      const results = await refreshProducts(supabase, queue, {
        allowedRetailers: retailersByUser.get(userId) ?? [],
        // Shopping APIs are quota-metered; pace the requests.
        delayMs: 1500,
      });

      summary.push({
        userId,
        checked: results.length,
        updated: results.filter((r) => r.offersFound > 0).length,
        failed: results.filter((r) => r.error).length,
      });
    }

    const finalBudget = await getBudget(supabase, provider);

    return NextResponse.json({
      message: "Price check complete",
      provider,
      budget: finalBudget,
      skippedForBudget: Math.max(0, totalDistinctProducts - seen.size),
      users: summary.length,
      checked: summary.reduce((n, s) => n + s.checked, 0),
      updated: summary.reduce((n, s) => n + s.updated, 0),
      failed: summary.reduce((n, s) => n + s.failed, 0),
      summary,
    });
  } catch (err) {
    console.error("Cron fetch-prices error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

/** Vercel Cron issues GET requests. */
export async function GET(req: NextRequest) {
  return POST(req);
}
