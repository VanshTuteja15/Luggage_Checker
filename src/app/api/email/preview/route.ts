import { NextRequest, NextResponse } from "next/server";
import { composeDigest } from "@/lib/digest/run";
import { NO_DATABASE, digestDeps, emailRouteError } from "@/lib/digest/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/email/preview: the exact email that would be sent now (R1.1),
 * from real prices. Nothing is sent and nothing is fetched from a store.
 */
export async function GET(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const deps = digestDeps({ req, mailer: null });
    if (!deps) return NextResponse.json({ error: NO_DATABASE }, { status: 503 });
    const c = await composeDigest(deps, userId);
    return NextResponse.json({
      subject: c.view.subject,
      html: c.html,
      text: c.text,
      productCount: c.productCount,
    });
  } catch (err) {
    return emailRouteError(
      err,
      "GET /api/email/preview",
      "The preview couldn't be made. Try again.",
    );
  }
}
