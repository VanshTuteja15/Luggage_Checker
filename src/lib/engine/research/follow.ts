/* ------------------------------------------------------------------ */
/*  Follow a session's events (the NDJSON stream behind the page)      */
/*                                                                     */
/*  Reads persisted events after a sequence number, then keeps          */
/*  polling the store (the worker may be writing them) and wakes early  */
/*  when this process is running the session itself. Ends after the     */
/*  terminal event, on abort, or after `maxMs`.                         */
/* ------------------------------------------------------------------ */

import type { EngineRuntime } from "../recorder";
import type { SessionEvent } from "../types";
import type { ResearchManager } from "./manager";

const TERMINAL = new Set(["session_done", "session_failed", "session_cancelled"]);

export async function followSession(
  engine: { rt: EngineRuntime; manager: ResearchManager },
  sessionId: string,
  afterSeq: number,
  onEvent: (e: SessionEvent) => void,
  opts: {
    signal?: AbortSignal;
    maxMs?: number;
    pollMs?: number;
    idleMs?: number;
    onIdle?: () => void;
  } = {},
): Promise<"done" | "aborted" | "timeout"> {
  const maxMs = opts.maxMs ?? 45_000;
  const pollMs = opts.pollMs ?? 250;
  const idleMs = opts.idleMs ?? 5_000;
  const started = Date.now();
  let last = afterSeq;
  let lastSent = Date.now();
  let wake: (() => void) | null = null;
  const unsubscribe = engine.manager.subscribe(sessionId, () => wake?.());

  try {
    for (;;) {
      if (opts.signal?.aborted) return "aborted";
      const events = await engine.rt.store.listEvents(sessionId, last);
      for (const e of events) {
        onEvent(e);
        last = e.seq;
        lastSent = Date.now();
        if (TERMINAL.has(e.type)) return "done";
      }
      if (events.length === 0) {
        // A session that ended without a terminal event (process died) shouldn't hang the stream.
        const s = await engine.rt.store.getSession(sessionId);
        if (
          s &&
          (s.status === "done" || s.status === "failed" || s.status === "cancelled") &&
          (await engine.rt.store.listEvents(sessionId, last)).length === 0
        )
          return "done";
      }
      if (Date.now() - started > maxMs) return "timeout";
      if (Date.now() - lastSent > idleMs) {
        opts.onIdle?.();
        lastSent = Date.now();
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    unsubscribe();
  }
}
