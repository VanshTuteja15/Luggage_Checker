import { NextRequest, NextResponse } from "next/server";
import { settingsFor } from "@/lib/digest/run";
import { NO_DATABASE, digestDeps, emailRouteError } from "@/lib/digest/server";
import { bannerFor, logRows, recipientStatus } from "@/lib/digest/status";
import { mailerStatus } from "@/lib/mailer";
import { requireUser } from "@/lib/supabase/server";
import { CANADIAN_TIME_ZONES, addDays, localDate } from "@/lib/time/local";

export const dynamic = "force-dynamic";

/**
 * GET /api/email: everything the Morning Email page shows. Settings
 * (created on first visit with the old report address, R1.14), whether
 * sending is set up, the tracked products with their choice, the last 30
 * days of sends, and today's banner if the email had a problem.
 */
export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const deps = digestDeps({ req, mailer: null });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });

    const settings = await settingsFor(deps.store, userId);
    const today = localDate(deps.now(), settings.timeZone);
    const [tracked, runs] = await Promise.all([
      deps.store.listTracked(userId),
      deps.store.listRuns(userId, addDays(today, -30)),
    ]);
    const status = mailerStatus();
    const sentLast24h = await deps.store.emailsSentSince(
      new Date(deps.now().getTime() - 24 * 3_600_000).toISOString(),
    );

    return NextResponse.json({
      settings: {
        enabled: settings.enabled,
        sendTime: settings.sendTime,
        timeZone: settings.timeZone,
        recipients: recipientStatus(runs, settings.recipients),
      },
      provider: {
        configured: status.configured,
        // The sender address only: never a key.
        from: status.from ? (/<([^>]+)>/.exec(status.from)?.[1] ?? status.from) : null,
        warning: status.warning,
        missing: status.missing,
        dailyLimit: status.dailyLimit,
        sentLast24h,
      },
      products: tracked.map((t) => ({
        productId: t.productId,
        name: t.name,
        brand: t.brand,
        color: t.color,
        imageUrl: t.imageUrl,
        targetPrice: t.targetPrice,
        chosen: t.chosen,
        position: t.position,
      })),
      log: logRows(runs),
      banner: bannerFor(runs.find((r) => r.kind === "daily" && r.localDate === today) ?? null, settings),
      timeZones: CANADIAN_TIME_ZONES,
    });
  } catch (err) {
    return emailRouteError(err, "GET /api/email", "The morning email settings couldn't be loaded. Try again.");
  }
}
