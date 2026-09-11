import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { RETAILER_NAMES } from "@/lib/retailers";
import { requireUser } from "@/lib/supabase/server";
import type { UserSettings } from "@/lib/types";

export const dynamic = "force-dynamic";

type SettingsRow = {
  admin_email: string | null;
  timezone: string | null;
  daily_report: boolean | null;
  report_email: string | null;
  include_drops: boolean | null;
  include_increases: boolean | null;
  include_oos: boolean | null;
  include_summary: boolean | null;
  retailers: string[] | null;
};

function toSettings(row: SettingsRow | null, fallbackEmail: string | null): UserSettings {
  return {
    adminEmail: row?.admin_email ?? fallbackEmail ?? "",
    timezone: row?.timezone ?? "America/Edmonton",
    dailyReport: row?.daily_report ?? true,
    reportEmail: row?.report_email ?? fallbackEmail ?? "",
    include: {
      drops: row?.include_drops ?? true,
      increases: row?.include_increases ?? true,
      oos: row?.include_oos ?? true,
      summary: row?.include_summary ?? true,
    },
    retailers: row?.retailers ?? [...RETAILER_NAMES],
  };
}

/** GET /api/settings — the signed-in user's settings. */
export async function GET(req: NextRequest) {
  try {
    const { supabase, userId, email } = await requireUser(req);

    const { data, error } = await supabase
      .from("user_settings")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;

    return NextResponse.json({ settings: toSettings(data as SettingsRow | null, email) });
  } catch (err) {
    return errorResponse(err, "GET /api/settings");
  }
}

/**
 * PUT /api/settings
 *
 * Accepts a partial update. There is no userId in the body — the row is
 * chosen by the authenticated session, and RLS enforces it.
 */
export async function PUT(req: NextRequest) {
  try {
    const { supabase, userId, email } = await requireUser(req);
    const body = (await req.json().catch(() => ({}))) as Partial<UserSettings>;

    const patch: Record<string, unknown> = { user_id: userId };

    if (typeof body.adminEmail === "string") patch.admin_email = body.adminEmail.trim();
    if (typeof body.timezone === "string") patch.timezone = body.timezone;
    if (typeof body.dailyReport === "boolean") patch.daily_report = body.dailyReport;

    if (typeof body.reportEmail === "string") {
      const value = body.reportEmail.trim();
      if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return badRequest("That doesn't look like a valid email address.");
      }
      patch.report_email = value;
    }

    if (body.include && typeof body.include === "object") {
      const inc = body.include;
      if (typeof inc.drops === "boolean") patch.include_drops = inc.drops;
      if (typeof inc.increases === "boolean") patch.include_increases = inc.increases;
      if (typeof inc.oos === "boolean") patch.include_oos = inc.oos;
      if (typeof inc.summary === "boolean") patch.include_summary = inc.summary;
    }

    if (Array.isArray(body.retailers)) {
      const valid = body.retailers.filter(
        (r): r is string => typeof r === "string" && RETAILER_NAMES.includes(r),
      );
      if (valid.length === 0) {
        return badRequest("Keep at least one retailer enabled, or searches will return nothing.");
      }
      patch.retailers = valid;
    }

    const { data, error } = await supabase
      .from("user_settings")
      .upsert(patch, { onConflict: "user_id" })
      .select("*")
      .single();

    if (error) throw error;

    return NextResponse.json({ settings: toSettings(data as SettingsRow, email) });
  } catch (err) {
    return errorResponse(err, "PUT /api/settings");
  }
}
