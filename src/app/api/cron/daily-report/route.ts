import { NextRequest, NextResponse } from "next/server";
import { getTrackedProducts } from "@/lib/db/products";
import {
  emailConfigured,
  sendDailyReport,
  type PriceChangeItem,
  type ReportData,
  type TargetAlertItem,
} from "@/lib/email";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  return header === secret;
}

type SettingsRow = {
  user_id: string;
  daily_report: boolean | null;
  report_email: string | null;
  admin_email: string | null;
  include_drops: boolean | null;
  include_increases: boolean | null;
  include_oos: boolean | null;
  include_summary: boolean | null;
};

/**
 * Daily report.
 *
 * Compares each tracked product's latest recorded price against the previous
 * day's, and — new — flags anything that reached the user's target price.
 * Each user gets their own email honouring their own settings.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabaseAdmin();
    const today = new Date().toISOString().slice(0, 10);

    const { data: trackedRows, error: trackedErr } = await supabase
      .from("tracked_products")
      .select("user_id");
    if (trackedErr) throw trackedErr;

    const userIds = [...new Set((trackedRows ?? []).map((r) => r.user_id as string))];
    if (userIds.length === 0) {
      return NextResponse.json({ message: "No tracked products", sent: 0 });
    }

    const { data: settingsRows } = await supabase
      .from("user_settings")
      .select("user_id, daily_report, report_email, admin_email, include_drops, include_increases, include_oos, include_summary")
      .in("user_id", userIds);

    const settingsByUser = new Map<string, SettingsRow>(
      ((settingsRows ?? []) as SettingsRow[]).map((s) => [s.user_id, s]),
    );

    const results: { userId: string; sent: boolean; reason?: string }[] = [];

    for (const userId of userIds) {
      const settings = settingsByUser.get(userId);

      if (settings?.daily_report === false) {
        results.push({ userId, sent: false, reason: "daily report disabled" });
        continue;
      }

      const to = settings?.report_email || settings?.admin_email || process.env.REPORT_TO_EMAIL || "";
      if (!to) {
        results.push({ userId, sent: false, reason: "no report email" });
        continue;
      }

      const products = await getTrackedProducts(supabase, userId, { days: 3 });
      if (products.length === 0) {
        results.push({ userId, sent: false, reason: "nothing tracked" });
        continue;
      }

      const drops: PriceChangeItem[] = [];
      const increases: PriceChangeItem[] = [];
      const outOfStock: { productName: string; retailer: string }[] = [];
      const lowestFinds: ReportData["lowestFinds"] = [];
      const targetAlerts: TargetAlertItem[] = [];

      for (const p of products) {
        const best = p.offers.find((o) => o.inStock) ?? p.offers[0];

        if (p.lowestPrice !== null && p.previousLowest !== null && p.change !== 0) {
          const item: PriceChangeItem = {
            productName: p.name,
            brand: p.brand,
            retailer: p.lowestRetailer ?? "",
            oldPrice: p.previousLowest,
            newPrice: p.lowestPrice,
            url: best?.url ?? "",
          };
          if (p.change < 0) drops.push(item);
          else increases.push(item);
        }

        for (const offer of p.offers) {
          if (!offer.inStock) outOfStock.push({ productName: p.name, retailer: offer.retailer });
        }

        if (best && p.lowestPrice !== null) {
          lowestFinds.push({
            productName: p.name,
            retailer: best.retailer,
            price: p.lowestPrice,
            url: best.url ?? "",
          });
        }

        // The reason someone sets up a price tracker in the first place.
        if (
          p.alertEnabled &&
          p.targetPrice !== null &&
          p.lowestPrice !== null &&
          p.lowestPrice <= p.targetPrice
        ) {
          targetAlerts.push({
            productName: p.name,
            brand: p.brand,
            retailer: p.lowestRetailer ?? "",
            price: p.lowestPrice,
            targetPrice: p.targetPrice,
            url: best?.url ?? "",
          });
        }
      }

      drops.sort((a, b) => a.newPrice - a.oldPrice - (b.newPrice - b.oldPrice));
      lowestFinds.sort((a, b) => a.price - b.price);

      const reportData: ReportData = {
        date: today,
        totalTracked: products.length,
        drops,
        increases,
        outOfStock,
        lowestFinds: lowestFinds.slice(0, 5),
        targetAlerts,
      };

      if (!emailConfigured()) {
        results.push({ userId, sent: false, reason: "RESEND_API_KEY not configured" });
        continue;
      }

      try {
        await sendDailyReport(reportData, {
          to,
          include: {
            drops: settings?.include_drops !== false,
            increases: settings?.include_increases !== false,
            oos: settings?.include_oos !== false,
            summary: settings?.include_summary !== false,
          },
        });
        results.push({ userId, sent: true });
      } catch (err) {
        results.push({
          userId,
          sent: false,
          reason: err instanceof Error ? err.message : "send failed",
        });
      }
    }

    return NextResponse.json({
      message: "Daily report complete",
      users: results.length,
      sent: results.filter((r) => r.sent).length,
      results,
    });
  } catch (err) {
    console.error("Daily report error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return POST(req);
}
