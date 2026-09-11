/* ------------------------------------------------------------------ */
/*  Resend email — daily price report                                 */
/* ------------------------------------------------------------------ */

import { Resend } from "resend";

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

function client(): Resend {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not configured");
  return new Resend(key);
}

export type PriceChangeItem = {
  productName: string;
  brand: string;
  retailer: string;
  oldPrice: number;
  newPrice: number;
  url: string;
};

export type TargetAlertItem = {
  productName: string;
  brand: string;
  retailer: string;
  price: number;
  targetPrice: number;
  url: string;
};

export type ReportData = {
  date: string;
  totalTracked: number;
  drops: PriceChangeItem[];
  increases: PriceChangeItem[];
  outOfStock: { productName: string; retailer: string }[];
  lowestFinds: { productName: string; retailer: string; price: number; url: string }[];
  /** Products that reached the user's target price. The headline of the email. */
  targetAlerts: TargetAlertItem[];
};

export type ReportOptions = {
  to: string;
  include?: { drops: boolean; increases: boolean; oos: boolean; summary: boolean };
  appUrl?: string;
};

const BRAND = "#5B6B4A";
const SUCCESS = "#10B981";
const DANGER = "#EF4444";

function cad(n: number): string {
  return `$${n.toFixed(2)}`;
}

function changeLabel(oldP: number, newP: number): string {
  const diff = newP - oldP;
  const pct = oldP === 0 ? 0 : (diff / oldP) * 100;
  const arrow = diff < 0 ? "&darr;" : "&uarr;";
  return `${arrow} ${cad(Math.abs(diff))} (${Math.abs(pct).toFixed(1)}%)`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const td = "padding:8px 12px;border-bottom:1px solid #e5e5e5;font-size:14px";

function section(title: string, body: string): string {
  if (!body) return "";
  return `
    <h2 style="margin:28px 0 10px;font-size:16px;font-weight:600;color:#111">${title}</h2>
    ${body}`;
}

function table(headers: string[], rows: string): string {
  if (!rows) return "";
  return `
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#fafafa">
          ${headers.map((h) => `<th style="${td};text-align:left;color:#6b7280;font-weight:600">${h}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ------------------------------------------------------------------ */

function buildReportHtml(data: ReportData, opts: ReportOptions): string {
  const include = opts.include ?? { drops: true, increases: true, oos: true, summary: true };
  const appUrl = opts.appUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

  const alertRows = data.targetAlerts
    .map(
      (a) => `
      <tr>
        <td style="${td}"><strong>${esc(a.productName)}</strong><br/><span style="color:#6b7280;font-size:13px">${esc(a.brand)}</span></td>
        <td style="${td};color:${SUCCESS};font-weight:700">${cad(a.price)}</td>
        <td style="${td};color:#6b7280">target ${cad(a.targetPrice)}</td>
        <td style="${td}">${esc(a.retailer)}</td>
        <td style="${td}">${a.url ? `<a href="${esc(a.url)}" style="color:${BRAND}">Buy</a>` : ""}</td>
      </tr>`,
    )
    .join("");

  const dropRows = include.drops
    ? data.drops
        .map(
          (d) => `
      <tr>
        <td style="${td}"><strong>${esc(d.productName)}</strong><br/><span style="color:#6b7280;font-size:13px">${esc(d.brand)}</span></td>
        <td style="${td};text-decoration:line-through;color:#9ca3af">${cad(d.oldPrice)}</td>
        <td style="${td};color:${SUCCESS};font-weight:600">${cad(d.newPrice)}</td>
        <td style="${td};color:${SUCCESS}">${changeLabel(d.oldPrice, d.newPrice)}</td>
        <td style="${td}">${esc(d.retailer)}</td>
        <td style="${td}">${d.url ? `<a href="${esc(d.url)}" style="color:${BRAND}">View</a>` : ""}</td>
      </tr>`,
        )
        .join("")
    : "";

  const increaseRows = include.increases
    ? data.increases
        .map(
          (d) => `
      <tr>
        <td style="${td}"><strong>${esc(d.productName)}</strong><br/><span style="color:#6b7280;font-size:13px">${esc(d.brand)}</span></td>
        <td style="${td};text-decoration:line-through;color:#9ca3af">${cad(d.oldPrice)}</td>
        <td style="${td};color:${DANGER};font-weight:600">${cad(d.newPrice)}</td>
        <td style="${td};color:${DANGER}">${changeLabel(d.oldPrice, d.newPrice)}</td>
        <td style="${td}">${esc(d.retailer)}</td>
        <td style="${td}">${d.url ? `<a href="${esc(d.url)}" style="color:${BRAND}">View</a>` : ""}</td>
      </tr>`,
        )
        .join("")
    : "";

  const oosRows = include.oos
    ? data.outOfStock
        .map(
          (o) => `
      <tr>
        <td style="${td}"><strong>${esc(o.productName)}</strong></td>
        <td style="${td};color:${DANGER}">Out of stock at ${esc(o.retailer)}</td>
      </tr>`,
        )
        .join("")
    : "";

  const bestRows = include.summary
    ? data.lowestFinds
        .map(
          (b) => `
      <tr>
        <td style="${td}"><strong>${esc(b.productName)}</strong></td>
        <td style="${td};font-weight:600">${cad(b.price)}</td>
        <td style="${td}">${esc(b.retailer)}</td>
        <td style="${td}">${b.url ? `<a href="${esc(b.url)}" style="color:${BRAND}">View</a>` : ""}</td>
      </tr>`,
        )
        .join("")
    : "";

  const nothingHappened =
    !alertRows && !dropRows && !increaseRows && !oosRows && !bestRows;

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:720px;margin:0 auto;padding:24px">

    <div style="background:${BRAND};color:#fff;padding:20px 24px;border-radius:10px 10px 0 0">
      <h1 style="margin:0;font-size:20px;font-weight:600">LuggageTracker — Daily Report</h1>
      <p style="margin:4px 0 0;opacity:.85;font-size:14px">${esc(data.date)} · ${data.totalTracked} product(s) tracked</p>
    </div>

    <div style="background:#fff;padding:20px 24px;border-radius:0 0 10px 10px">

      ${
        data.targetAlerts.length > 0
          ? `<div style="background:#ecfdf5;border:1px solid ${SUCCESS};border-radius:8px;padding:12px 16px;margin-bottom:8px">
               <strong style="color:${SUCCESS}">${data.targetAlerts.length} product(s) hit your target price</strong>
             </div>
             ${table(["Product", "Price", "Target", "Retailer", ""], alertRows)}`
          : ""
      }

      ${section(`Price drops (${data.drops.length})`, table(["Product", "Was", "Now", "Change", "Retailer", ""], dropRows))}
      ${section(`Price increases (${data.increases.length})`, table(["Product", "Was", "Now", "Change", "Retailer", ""], increaseRows))}
      ${section(`Out of stock (${data.outOfStock.length})`, table(["Product", "Status"], oosRows))}
      ${section("Best prices right now", table(["Product", "Price", "Retailer", ""], bestRows))}

      ${
        nothingHappened
          ? `<p style="color:#6b7280;font-size:14px;margin:20px 0">No price movement since the last check. Everything you track is holding steady.</p>`
          : ""
      }

      ${
        appUrl
          ? `<p style="margin:28px 0 0"><a href="${esc(appUrl)}/dashboard" style="display:inline-block;background:${BRAND};color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Open dashboard</a></p>`
          : ""
      }
    </div>

    <p style="text-align:center;color:#9ca3af;font-size:12px;margin-top:16px">
      All prices in CAD, captured at the time of the last check. Confirm on the retailer's site before purchasing.
    </p>
  </div>
</body>
</html>`;
}

function buildSubject(data: ReportData): string {
  if (data.targetAlerts.length > 0) {
    return `${data.targetAlerts.length} target price${data.targetAlerts.length === 1 ? "" : "s"} reached — LuggageTracker`;
  }
  if (data.drops.length > 0) {
    return `${data.drops.length} price drop${data.drops.length === 1 ? "" : "s"} today — LuggageTracker`;
  }
  return `Daily luggage price report — ${data.date}`;
}

/* ------------------------------------------------------------------ */

/**
 * Send the daily report. Returns the Resend message id, or null when email
 * isn't configured (which is not an error — the cron job still ran).
 */
export async function sendDailyReport(
  data: ReportData,
  opts: ReportOptions,
): Promise<{ id: string } | null> {
  if (!emailConfigured()) return null;

  const from = process.env.REPORT_FROM_EMAIL ?? "LuggageTracker <onboarding@resend.dev>";
  const to = opts.to || process.env.REPORT_TO_EMAIL || "";
  if (!to) return null;

  const { data: sent, error } = await client().emails.send({
    from,
    to,
    subject: buildSubject(data),
    html: buildReportHtml(data, opts),
  });

  if (error) throw new Error(`Resend: ${error.message}`);
  return sent ? { id: sent.id } : null;
}
