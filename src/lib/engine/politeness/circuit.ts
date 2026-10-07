/* ------------------------------------------------------------------ */
/*  Circuit breaker and visit windows                                 */
/*                                                                     */
/*  After repeated blocks a store's circuit opens: we stop knocking for  */
/*  a cool-down instead of hammering a door that's closed to us. After   */
/*  the cool-down one trial request is allowed (half-open); success     */
/*  closes the circuit, another block re-opens it.                      */
/* ------------------------------------------------------------------ */

import type { FetchOutcome, SourceHealth, VisitWindow } from "../types";
import { isBlockOutcome } from "../types";

export const CIRCUIT_THRESHOLD = 3;
export const CIRCUIT_COOLDOWN_MS = 30 * 60_000;

export function closedHealth(sourceId: string): SourceHealth {
  return { sourceId, circuit: "closed", circuitOpenedAt: null, circuitReason: null, consecutiveFailures: 0 };
}

/** May we send a request to this source right now? */
export function circuitAllows(h: SourceHealth, now: number): { allowed: boolean; trial: boolean } {
  if (h.circuit === "closed") return { allowed: true, trial: false };
  const opened = h.circuitOpenedAt ? Date.parse(h.circuitOpenedAt) : 0;
  if (now - opened >= CIRCUIT_COOLDOWN_MS) return { allowed: true, trial: true };
  return { allowed: false, trial: false };
}

/** New health after a request finished with `outcome`. */
export function recordOutcome(h: SourceHealth, outcome: FetchOutcome, now: number): SourceHealth {
  if (outcome === "ok" || outcome === "not_found") {
    return h.circuit === "closed" && h.consecutiveFailures === 0 ? h : closedHealth(h.sourceId);
  }
  // Only refusals count toward the breaker; our own timeouts/parse errors don't.
  if (!isBlockOutcome(outcome)) return h;
  const failures = h.consecutiveFailures + 1;
  if (h.circuit === "half_open" || h.circuit === "open" || failures >= CIRCUIT_THRESHOLD) {
    return {
      sourceId: h.sourceId,
      circuit: "open",
      circuitOpenedAt: new Date(now).toISOString(),
      circuitReason: `${failures} consecutive ${outcome} responses`,
      consecutiveFailures: failures,
    };
  }
  return { ...h, consecutiveFailures: failures };
}

/** Is `now` inside the store's stated visit window (robots.txt Visit-time)? */
export function inVisitWindow(w: VisitWindow | null, now: Date): boolean {
  if (!w) return true;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: w.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const minutes = hh * 60 + mm;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const start = toMin(w.start);
  const end = toMin(w.end);
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}
