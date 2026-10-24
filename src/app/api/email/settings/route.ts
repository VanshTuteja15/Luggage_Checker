import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { NO_DATABASE, digestDeps, emailRouteError } from "@/lib/digest/server";
import { requireUser } from "@/lib/supabase/server";
import { isValidTimeZone, parseClock } from "@/lib/time/local";

export const dynamic = "force-dynamic";

const Body = z
  .object({
    enabled: z.boolean().optional(),
    sendTime: z
      .string()
      .refine((v) => /^\d{2}:\d{2}$/.test(v) && parseClock(v) !== null, "Pick a send time like 09:00.")
      .optional(),
    timeZone: z.string().refine(isValidTimeZone, "Pick a time zone from the list.").optional(),
    recipients: z
      .array(z.string().trim().toLowerCase().email("One of the addresses isn't a valid email address."))
      .max(10, "You can add up to 10 addresses.")
      .refine((list) => new Set(list).size === list.length, "Each address can be on the list once.")
      .optional(),
  })
  .strict();

/** PUT /api/email/settings: on/off, send time, time zone and recipients (R1.1). */
export async function PUT(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Those settings couldn't be saved." },
        { status: 400 },
      );
    const deps = digestDeps({ req, mailer: null });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
    const s = await deps.store.updateSettings(userId, parsed.data);
    return NextResponse.json({
      settings: { enabled: s.enabled, sendTime: s.sendTime, timeZone: s.timeZone, recipients: s.recipients },
    });
  } catch (err) {
    return emailRouteError(err, "PUT /api/email/settings", "The settings couldn't be saved. Try again.");
  }
}
