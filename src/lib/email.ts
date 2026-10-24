/* ------------------------------------------------------------------ */
/*  Target-price alert email, and the HTML escape every email uses     */
/*                                                                     */
/*  The old daily report lived here; the morning email replaced it     */
/*  (src/lib/digest, R1.14). Sending goes through src/lib/mailer.ts,   */
/*  so alerts work with either free provider (Resend or SMTP).         */
/* ------------------------------------------------------------------ */

import { getMailer, maskEmail } from "@/lib/mailer";
import { DEFAULT_TIME_ZONE, formatTime, formatWeekdayDate } from "@/lib/time/local";

const BRAND = "#5B6B4A";
const SUCCESS = "#047857";

function cad(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** HTML-escape text and attribute values (attributes are always double-quoted). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type PriceAlert = {
  to: string;
  productName: string;
  retailer: string;
  price: number;
  target: number;
  url: string;
  checkedAt: string;
};

/**
 * Target-price alert, sent when a tracked bag's verified price reaches the
 * user's target. The scheduler sends at most one per user, product and day.
 * Returns null when email isn't set up (not an error: the check still ran).
 */
export async function sendPriceAlert(a: PriceAlert): Promise<{ id: string } | null> {
  const mailer = getMailer();
  if (!mailer || !a.to) return null;
  const when = `${formatWeekdayDate(a.checkedAt, DEFAULT_TIME_ZONE)} at ${formatTime(a.checkedAt, DEFAULT_TIME_ZONE)}`;
  const link = /^https:\/\//.test(a.url)
    ? `<p><a href="${esc(a.url)}" style="background:${BRAND};color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:14px">Open ${esc(a.retailer)}</a></p>`
    : "";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h1 style="font-size:18px;margin:0 0 12px">Price alert: ${esc(a.productName)}</h1>
      <p style="font-size:15px;margin:0 0 8px"><strong style="color:${SUCCESS}">${cad(a.price)}</strong> at ${esc(a.retailer)}. Your target was ${cad(a.target)}.</p>
      <p style="font-size:13px;color:#555;margin:0 0 16px">Verified live ${esc(when)} (Calgary time) from the store's own data.</p>
      ${link}
    </div>`;
  const text = `Price alert: ${a.productName}\n${cad(a.price)} at ${a.retailer}. Your target was ${cad(a.target)}.\nVerified live ${when} (Calgary time).\n${/^https:\/\//.test(a.url) ? a.url : ""}`;
  try {
    const { id } = await mailer.send({
      to: a.to,
      subject: `Price alert: ${a.productName} is ${cad(a.price)} at ${a.retailer}`,
      html,
      text,
    });
    return id ? { id } : null;
  } catch (err) {
    console.error(`price alert to ${maskEmail(a.to)} failed`);
    throw err;
  }
}
