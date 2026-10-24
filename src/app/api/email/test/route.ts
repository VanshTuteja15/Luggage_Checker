import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { sendTest } from "@/lib/digest/run";
import { NO_DATABASE, digestDeps, emailRouteError } from "@/lib/digest/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ to: z.string().trim().toLowerCase().email() }).strict();

/**
 * POST /api/email/test: send the email now to one address already on the
 * list (R1.1). A real send that doesn't count as the daily one; at most
 * five an hour (§6). No open relay: any other address is refused.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success)
      return NextResponse.json({ error: "Choose an address from the list." }, { status: 400 });
    const deps = digestDeps({ req });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
    const { run } = await sendTest(deps, userId, parsed.data.to);
    const r = run.recipients[0];
    if (run.status !== "sent")
      return NextResponse.json(
        { error: r?.error ?? "The test email couldn't be sent.", status: run.status },
        { status: 502 },
      );
    return NextResponse.json({ status: run.status, providerId: r?.providerId ?? null });
  } catch (err) {
    return emailRouteError(
      err,
      "POST /api/email/test",
      "The test email couldn't be sent. Try again.",
    );
  }
}
