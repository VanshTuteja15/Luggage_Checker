import { after, NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { engineConfig } from "@/lib/engine/config";
import { flagOn } from "@/lib/engine/flags";
import { checkRateLimit, createSession, parseResearchInput } from "@/lib/engine/research/api";
import { dispatchSession, getEngine, realtimeAvailable } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/research — start a price-verification session.
 *
 * Returns 202 with the session id immediately. The session runs on the
 * worker (signed dispatch) or, when none is configured, inline in this
 * server. The page follows it via Supabase Realtime or the NDJSON stream at
 * /api/research/<id>/stream, and can resume it by id at any time.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireUser(req);
    const parsed = parseResearchInput(await req.json().catch(() => null));
    if (!parsed.ok) return badRequest(parsed.error);

    const cfg = engineConfig();
    const { rt } = getEngine();
    if (!flagOn(await rt.flags(), "engine.enabled")) {
      return NextResponse.json({ error: "Verified price checks are switched off right now.", code: "engine_disabled" }, { status: 503 });
    }

    const rate = await checkRateLimit(rt.store, userId, cfg);
    if (!rate.ok) {
      return NextResponse.json({ error: rate.reason, code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    }

    const created = await createSession(rt.store, userId, parsed.value, cfg, cfg.worker ? "worker" : "inline");
    if (!created.ok) return NextResponse.json({ error: created.error }, { status: created.status });

    const { mode, run } = await dispatchSession(created.session.id);
    // Inline mode: keep this invocation alive until the session has finished.
    if (run) after(() => run);

    return NextResponse.json(
      { sessionId: created.session.id, query: created.session.query, mode, realtime: realtimeAvailable(), deadlineMs: created.session.deadlineMs },
      { status: 202 },
    );
  } catch (err) {
    return errorResponse(err, "POST /api/research");
  }
}

/** GET /api/research — is the engine on, and is it the default search? */
export async function GET(req: NextRequest) {
  try {
    await requireUser(req);
    const cfg = engineConfig();
    const { rt } = getEngine();
    const flags = await rt.flags();
    return NextResponse.json({
      available: flagOn(flags, "engine.enabled"),
      defaultEngine: flagOn(flags, "engine.default_search"),
      worker: !!cfg.worker,
      store: rt.store.kind,
      realtime: realtimeAvailable(),
      deadlineMs: cfg.sessionDeadlineMs,
    });
  } catch (err) {
    return errorResponse(err, "GET /api/research");
  }
}
