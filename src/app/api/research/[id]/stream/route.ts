import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/respond";
import { ownedSession } from "@/lib/engine/research/api";
import { followSession } from "@/lib/engine/research/follow";
import { getEngine } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/research/<id>/stream?after=<seq> — newline-delimited JSON.
 *
 * The fallback (and, without Supabase Realtime, the only) way the page
 * follows a session: one {"type":"event"} line per session event after
 * `after`, a {"type":"ping"} every few seconds, and the stream ends after the
 * session's last event. Safe to reconnect with the last seq seen.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await requireUser(req);
    const { id } = await params;
    const engine = getEngine();
    const session = await ownedSession(engine.rt.store, id, userId);
    if (!session) return NextResponse.json({ error: "Search not found." }, { status: 404 });
    const after = Math.max(0, Number.parseInt(req.nextUrl.searchParams.get("after") ?? "0", 10) || 0);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (line: unknown) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
          } catch {
            /* client went away */
          }
        };
        try {
          await followSession(engine, id, after, (event) => send({ type: "event", event }), {
            signal: req.signal,
            onIdle: () => send({ type: "ping" }),
          });
        } catch (err) {
          send({ type: "error", error: err instanceof Error ? err.message : "stream failed" });
        } finally {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/research/[id]/stream");
  }
}
