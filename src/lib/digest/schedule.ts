/* ------------------------------------------------------------------ */
/*  Morning email: what is due at a given instant (R1.4, R1.5)         */
/*                                                                     */
/*  Pure. All local-time questions go through src/lib/time/local.ts    */
/*  (Intl with the account's time zone), so the DST days (2026-11-01,   */
/*  2027-03-14 in Calgary) need no special case: 9:00 is 9:00.         */
/*                                                                     */
/*    send − 60 min … send        prepare (fresh prices)               */
/*    send … send + 15 min        send (the normal window)             */
/*    send + 15 min … noon        send late (catch-up)                 */
/*    from noon                   missed: logged, never sent late      */
/* ------------------------------------------------------------------ */

import { localParts, parseClock, zonedTimeToUtc, formatClock } from "@/lib/time/local";

export type Phase = "early" | "prepare" | "send" | "after";

export type SchedulePlan = {
  localDate: string;
  /** Minutes since local midnight now. */
  minutes: number;
  sendMinutes: number;
  prepareFrom: number;
  /** The end of the catch-up window: noon, or 15 minutes after a later send time. */
  cutoff: number;
  phase: Phase;
  /** No tick arrived by send + 30 min (R1.7 "late scheduler"). */
  late: boolean;
  /** When the prepare window opened today (prices re-checked since then count as fresh). */
  prepareStart: Date;
};

export const NOON = 12 * 60;
export const SEND_WINDOW_MIN = 15;
export const LATE_AFTER_MIN = 30;
export const PREPARE_LEAD_MIN = 60;

export function planFor(now: Date, sendTime: string, timeZone: string): SchedulePlan {
  const local = localParts(now, timeZone);
  const sendMinutes = parseClock(sendTime) ?? 9 * 60;
  const prepareFrom = Math.max(0, sendMinutes - PREPARE_LEAD_MIN);
  const cutoff = Math.max(NOON, sendMinutes + SEND_WINDOW_MIN);
  const m = local.minutes;
  const phase: Phase =
    m < prepareFrom ? "early" : m < sendMinutes ? "prepare" : m < cutoff ? "send" : "after";
  return {
    localDate: local.date,
    minutes: m,
    sendMinutes,
    prepareFrom,
    cutoff,
    phase,
    late: phase === "send" && m >= sendMinutes + LATE_AFTER_MIN,
    prepareStart: zonedTimeToUtc(local.date, formatClock(prepareFrom), timeZone),
  };
}
