"use client";

/* ------------------------------------------------------------------ */
/*  Verified price research in the browser                            */
/*                                                                     */
/*  POST /api/research returns a session id at once. The page then      */
/*  follows the session's events: through Supabase Realtime when the    */
/*  engine's events live in Supabase, and always through the NDJSON     */
/*  stream as the fallback (events are de-duplicated by sequence, so    */
/*  both can run). Reconnects resume from the last sequence seen.       */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, apiStreamGet, ApiRequestError } from "@/lib/api-client";
import type {
  AnswerOffer,
  AnswerProduct,
  ResearchAnswer,
  SessionEvent,
  StoreStatusRow,
} from "@/lib/engine/types";
import { getSupabaseBrowser } from "@/lib/supabase/client";

export type ResearchStatus = "idle" | "starting" | "running" | "done" | "cancelled" | "error";

export type ResearchView = {
  status: ResearchStatus;
  sessionId: string | null;
  query: string;
  rows: Record<string, StoreStatusRow>;
  /** Offers in arrival order (fast stores first). */
  offers: AnswerOffer[];
  answer: ResearchAnswer | null;
  error: string | null;
  lastSeq: number;
  startedAt: number | null;
  /** Web estimates are still being looked for (R3). */
  estimating: boolean;
};

type Action =
  | { type: "start"; query: string }
  | { type: "session"; sessionId: string; query: string }
  | { type: "event"; event: SessionEvent }
  | { type: "error"; error: string }
  | { type: "reset" };

const initial: ResearchView = {
  status: "idle",
  sessionId: null,
  query: "",
  rows: {},
  offers: [],
  answer: null,
  error: null,
  lastSeq: 0,
  startedAt: null,
  estimating: false,
};

function reduce(state: ResearchView, action: Action): ResearchView {
  switch (action.type) {
    case "reset":
      return initial;
    case "start":
      return { ...initial, status: "starting", query: action.query, startedAt: Date.now() };
    case "session":
      return { ...state, status: "running", sessionId: action.sessionId, query: action.query };
    case "error":
      return { ...state, status: "error", error: action.error };
    case "event": {
      const e = action.event;
      if (e.sessionId !== state.sessionId || e.seq <= state.lastSeq) return state;
      const next = { ...state, lastSeq: e.seq };
      const p = e.payload as Record<string, unknown>;
      switch (e.type) {
        case "plan": {
          const rows: Record<string, StoreStatusRow> = {};
          for (const r of (p.stores as StoreStatusRow[]) ?? []) rows[r.sourceId] = r;
          return { ...next, rows };
        }
        case "store_started":
          return e.sourceId && next.rows[e.sourceId]
            ? {
                ...next,
                rows: {
                  ...next.rows,
                  [e.sourceId]: { ...next.rows[e.sourceId], state: "running", message: "checking" },
                },
              }
            : next;
        case "store_offers":
          return { ...next, offers: [...next.offers, ...((p.offers as AnswerOffer[]) ?? [])] };
        case "store_done": {
          const row = p.row as StoreStatusRow | undefined;
          return row ? { ...next, rows: { ...next.rows, [row.sourceId]: row } } : next;
        }
        case "estimates_started":
          return { ...next, estimating: true };
        case "estimates_done":
          return { ...next, estimating: false };
        case "session_done": {
          const answer = p.answer as ResearchAnswer;
          const rows: Record<string, StoreStatusRow> = {};
          for (const r of answer.stores) rows[r.sourceId] = r;
          return { ...next, status: "done", answer, rows, estimating: false };
        }
        case "session_cancelled":
          return { ...next, status: "cancelled" };
        case "session_failed":
          // The technical reason stays in the session record (Store status → Technical details).
          return { ...next, status: "error", error: "The live price check stopped early." };
        default:
          return next;
      }
    }
  }
}

type RealtimeRow = {
  session_id: string;
  seq: number;
  type: SessionEvent["type"];
  source_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
};

export function useResearch() {
  const [state, dispatch] = useReducer(reduce, initial);
  const run = useRef<{ abort: AbortController; cleanup: (() => void)[] } | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const stop = useCallback(() => {
    if (!run.current) return;
    run.current.abort.abort();
    run.current.cleanup.forEach((f) => f());
    run.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const follow = useCallback(
    async (
      sessionId: string,
      realtime: boolean,
      abort: AbortController,
      cleanup: (() => void)[],
    ) => {
      const apply = (event: SessionEvent) => dispatch({ type: "event", event });

      if (realtime) {
        const sb = getSupabaseBrowser();
        if (sb) {
          const channel = sb
            .channel(`research:${sessionId}`)
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "session_events",
                filter: `session_id=eq.${sessionId}`,
              },
              (msg) => {
                const r = msg.new as RealtimeRow;
                apply({
                  sessionId: r.session_id,
                  seq: r.seq,
                  type: r.type,
                  sourceId: r.source_id,
                  payload: r.payload ?? {},
                  createdAt: r.created_at,
                });
              },
            )
            .subscribe();
          cleanup.push(() => void sb.removeChannel(channel));
        }
      }

      // NDJSON: the fallback, and the catch-up for anything Realtime missed.
      for (let attempt = 0; attempt < 6 && !abort.signal.aborted; attempt++) {
        try {
          await apiStreamGet(
            `/api/research/${sessionId}/stream?after=${stateRef.current.lastSeq}`,
            (line) => {
              const l = line as { type?: string; event?: SessionEvent };
              if (l.type === "event" && l.event) apply(l.event);
            },
            abort.signal,
          );
        } catch (err) {
          if (abort.signal.aborted) return;
          if (err instanceof ApiRequestError && err.status < 500) {
            dispatch({ type: "error", error: err.message });
            return;
          }
        }
        const s = stateRef.current.status;
        if (s === "done" || s === "cancelled" || s === "error") return;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    },
    [],
  );

  const start = useCallback(
    async (body: { query: string; reverifyOf?: string }) => {
      stop();
      const abort = new AbortController();
      const cleanup: (() => void)[] = [];
      run.current = { abort, cleanup };
      dispatch({ type: "start", query: body.query });
      try {
        const res = await apiFetch<{ sessionId: string; query: string; realtime: boolean }>(
          "/api/research",
          { method: "POST", json: body, signal: abort.signal },
        );
        if (abort.signal.aborted) return;
        dispatch({ type: "session", sessionId: res.sessionId, query: res.query });
        await follow(res.sessionId, res.realtime, abort, cleanup);
      } catch (err) {
        if (abort.signal.aborted) return;
        // Server messages are written for people; anything else (network) gets a plain sentence.
        dispatch({
          type: "error",
          error:
            err instanceof ApiRequestError
              ? err.message
              : "We couldn't reach the price check. Check your connection and try again.",
        });
      }
    },
    [follow, stop],
  );

  const search = useCallback((query: string) => start({ query }), [start]);

  /** Fresh verification of the listings the current answer shows. */
  const reverify = useCallback(() => {
    const { sessionId, query } = stateRef.current;
    if (sessionId) void start({ query, reverifyOf: sessionId });
  }, [start]);

  const cancel = useCallback(async () => {
    const id = stateRef.current.sessionId;
    if (!id) return;
    await apiFetch(`/api/research/${id}/cancel`, { method: "POST" }).catch(() => undefined);
  }, []);

  return { state, search, reverify, cancel, reset: () => dispatch({ type: "reset" }) };
}

/** Saved prices for a search, each with its own date (used when a live check can't run). */
export function useLastKnown(query: string, enabled: boolean) {
  return useQuery({
    queryKey: ["last-known", query],
    enabled: enabled && query.trim().length > 0,
    staleTime: 60_000,
    retry: 1,
    queryFn: () =>
      apiFetch<{ products: AnswerProduct[]; from: "engine" | "tracked" | "none" }>(
        `/api/research/last-known?q=${encodeURIComponent(query.trim())}`,
      ),
  });
}

export type ResearchInfo = {
  available: boolean;
  defaultEngine: boolean;
  worker: boolean;
  store: string;
  realtime: boolean;
  deadlineMs: number;
};

export function useResearchInfo(enabled = true) {
  return useQuery({
    queryKey: ["research-info"],
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => apiFetch<ResearchInfo>("/api/research"),
  });
}
