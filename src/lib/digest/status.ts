/* ------------------------------------------------------------------ */
/*  Morning email status for people (R1.1 log, R1.7 banner)            */
/*                                                                     */
/*  Pure: from the run log to "last delivered" per address, the log    */
/*  rows the page shows, and the red banner text when today's email   */
/*  didn't reach everyone.                                             */
/* ------------------------------------------------------------------ */

import { formatTime } from "@/lib/time/local";
import { clockText } from "./build";
import type { DigestRun, DigestSettings } from "./store";

export type RecipientStatus = {
  address: string;
  lastDeliveredAt: string | null;
  /** The latest failure, only when it came after the last delivery. */
  lastError: string | null;
  lastErrorAt: string | null;
};

export function recipientStatus(runs: DigestRun[], addresses: string[]): RecipientStatus[] {
  return addresses.map((address) => {
    let delivered: string | null = null;
    let failed: { at: string; error: string } | null = null;
    for (const run of runs)
      for (const r of run.recipients) {
        if (r.address !== address) continue;
        if (r.status === "sent" && (!delivered || r.at > delivered)) delivered = r.at;
        if (r.status === "failed" && (!failed || r.at > failed.at))
          failed = { at: r.at, error: r.error ?? "The email couldn't be sent." };
      }
    const errorNewer = failed && (!delivered || failed.at > delivered);
    return {
      address,
      lastDeliveredAt: delivered,
      lastError: errorNewer ? failed!.error : null,
      lastErrorAt: errorNewer ? failed!.at : null,
    };
  });
}

export type LogRow = {
  id: string;
  localDate: string;
  kind: "daily" | "test";
  status: DigestRun["status"];
  /** "Sent", "Didn't reach 1 of 3", "Missed", … */
  statusText: string;
  sentAt: string | null;
  products: number;
  delivered: number;
  failed: number;
  /** Plain sentences: errors and notes. */
  details: string[];
};

const STATUS_TEXT: Record<DigestRun["status"], string> = {
  claimed: "Starting",
  preparing: "Getting fresh prices",
  sending: "Sending",
  sent: "Sent",
  partial: "Partly sent",
  failed: "Not sent",
  missed: "Missed",
  skipped: "Skipped",
};

export function logRows(runs: DigestRun[]): LogRow[] {
  return runs.map((run) => {
    const delivered = run.recipients.filter((r) => r.status === "sent").length;
    const failed = run.recipients.filter((r) => r.status === "failed").length;
    const details = [
      ...(run.error ? [run.error] : []),
      ...run.recipients
        .filter((r) => r.status === "failed" && r.error && r.error !== run.error)
        .map((r) => r.error!),
      ...run.notes,
    ];
    return {
      id: run.id,
      localDate: run.localDate,
      kind: run.kind,
      status: run.status,
      statusText:
        run.status === "partial"
          ? `Didn't reach ${failed} of ${run.recipients.length}`
          : STATUS_TEXT[run.status],
      sentAt: run.sentAt,
      products: run.productCount,
      delivered,
      failed,
      details: [...new Set(details)],
    };
  });
}

/**
 * The red banner (R1.7) for today's daily email, or null when all is well.
 * "Today's 9:00 a.m. email didn't reach 1 of 3 people: <reason>"
 */
export function bannerFor(today: DigestRun | null, settings: DigestSettings): string | null {
  if (!today || today.kind !== "daily") return null;
  const at = clockText(settings.sendTime);
  const failed = today.recipients.filter((r) => r.status === "failed");
  const reason = today.error ?? failed.find((r) => r.error)?.error ?? null;
  if (today.status === "partial")
    return `Today's ${at} email didn't reach ${failed.length} of ${today.recipients.length} people${reason ? `: ${reason}` : "."}`;
  if (today.status === "failed")
    return `Today's ${at} email wasn't sent${reason ? `: ${reason}` : "."}`;
  if (today.status === "missed")
    return `Today's ${at} email was missed because the app wasn't running in time. It won't be sent late; tomorrow's will go out as usual.`;
  return null;
}

/** "Sent 9:01 a.m. to 3 people" for the Dashboard (R7.5). */
export function sentLine(today: DigestRun | null, tz: string): string | null {
  if (!today || today.status !== "sent" || !today.sentAt) return null;
  const n = today.recipients.filter((r) => r.status === "sent").length;
  return `Sent ${formatTime(today.sentAt, tz)} to ${n} ${n === 1 ? "person" : "people"}`;
}
