/* ------------------------------------------------------------------ */
/*  Store status: what the page shows (R5.2), safe for the browser     */
/*                                                                     */
/*  The rows are built on the server (src/lib/engine/store-status.ts); */
/*  this file holds their shape and the Usage lines, with no imports,  */
/*  so the page doesn't pull the store registry into the browser.      */
/* ------------------------------------------------------------------ */

export type StoreCapability = "Verified live" | "Web estimate" | "Dealer list" | "Link only";

export type StoreStatusRow = {
  sourceId: string;
  name: string;
  gets: StoreCapability[];
  lastOkAt: string | null;
  /** One plain sentence, or null when nothing is wrong. */
  problem: string | null;
};

export type UsageSummary = {
  estimates: { configured: boolean; left: number; cap: number };
  /** null when the price database (which keeps the email log) isn't connected. */
  emails: { last24h: number; dailyLimit: number; thisMonth: number; monthlyLimit: number } | null;
};

const num = (x: number) => x.toLocaleString("en-CA");

/** The Usage tab's lines, exactly as shown. */
export function usageLines(u: UsageSummary): string[] {
  const lines = [
    u.estimates.configured
      ? `Web estimates left this month: ${num(Math.max(0, u.estimates.left))}`
      : "Web estimates are off, so none are used.",
  ];
  if (u.emails)
    lines.push(
      `Emails sent in the last 24 hours: ${num(u.emails.last24h)} of ${num(u.emails.dailyLimit)}`,
      `Emails sent this month: ${num(u.emails.thisMonth)} of ${num(u.emails.monthlyLimit)}`,
    );
  else lines.push("Email counts appear once the price database is connected.");
  return lines;
}
