/* ------------------------------------------------------------------ */
/*  Resend email — daily price report                                 */
/* ------------------------------------------------------------------ */

import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export type PriceChangeItem = {
  productName: string;
  brand: string;
  retailer: string;
  oldPrice: number;
  newPrice: number;
  url: string;
};

export type ReportData = {
  date: string;
  totalTracked: number;
  drops: PriceChangeItem[];
  increases: PriceChangeItem[];
  outOfStock: { productName: string; retailer: string }[];
  lowestFinds: { productName: string; retailer: string; price: number; url: string }[];
};

function cad(n: number) {
  return `$${n.toFixed(2)}`;
}

function changeArrow(oldP: number, newP: number) {
  const diff = newP - oldP;
  const pct = ((diff / oldP) * 100).toFixed(1);
  return diff < 0 ? `↓ ${cad(Math.abs(diff))} (${Math.abs(Number(pct))}%)` : `↑ ${cad(diff)} (${pct}%)`;
}

/**
 * Build the HTML email body for the daily report.
 */
function buildReportHtml(data: ReportData): string {
  const { date, totalTracked, drops, increases, outOfStock, lowestFinds } = data;

  const dropRows = drops
    .map(
      (d) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">
          <strong>${d.productName}</strong><br/>
          <span style="color:#6b7280;font-size:13px">${d.brand}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;text-decoration:line-through;color:#9ca3af">${cad(d.oldPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;color:#10b981;font-weight:600">${cad(d.newPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;color:#10b981">${changeArrow(d.oldPrice, d.newPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">${d.retailer}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">
          <a href="${d.url}" style="color:#5B6B4A;text-decoration:underline">View</a>
        </td>
      </tr>`,
    )
    .join("");

  const increaseRows = increases
    .map(
      (d) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">${d.productName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">${cad(d.oldPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;color:#ef4444;font-weight:600">${cad(d.newPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5;color:#ef4444">${changeArrow(d.oldPrice, d.newPrice)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">${d.retailer}</td>
      </tr>`,
    )
    .join("");

  const oosRows = outOfStock
    .map(
      (o) => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">${o.productName}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e5e5">${o.retailer}</td>
      </tr>`,
    )
    .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;padding:20px;color:#1a1a1a">

  <div style="background:#5B6B4A;color:white;padding:20px 24px;border-radius:8px 8px 0 0">
    <h1 style="margin:0;font-size:20px">LuggageTracker Daily Report</h1>
    <p style="margin:4px 0 0;opacity:0.85;font-size:14px">${date} · ${totalTracked} products monitored</p>
  </div>

  <div style="border:1px solid #e5e5e5;border-top:none;border-radius:0 0 8px 8px;padding:24px">

    ${drops.length > 0 ? `
    <h2 style="color:#10b981;font-size:16px;margin:0 0 12px">Price Drops (${drops.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Product</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Was</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Now</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Change</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Retailer</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5"></th>
        </tr>
      </thead>
      <tbody>${dropRows}</tbody>
    </table>
    ` : '<p style="color:#6b7280;margin-bottom:24px">No price drops today.</p>'}

    ${increases.length > 0 ? `
    <h2 style="color:#ef4444;font-size:16px;margin:0 0 12px">Price Increases (${increases.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Product</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Was</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Now</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Change</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Retailer</th>
        </tr>
      </thead>
      <tbody>${increaseRows}</tbody>
    </table>
    ` : ""}

    ${outOfStock.length > 0 ? `
    <h2 style="color:#f59e0b;font-size:16px;margin:0 0 12px">Out of Stock Alerts (${outOfStock.length})</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
      <thead>
        <tr style="background:#f9fafb">
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Product</th>
          <th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e5e5e5">Retailer</th>
        </tr>
      </thead>
      <tbody>${oosRows}</tbody>
    </table>
    ` : ""}

    ${lowestFinds.length > 0 ? `
    <h2 style="color:#5B6B4A;font-size:16px;margin:0 0 12px">Best Deals Right Now</h2>
    <div style="margin-bottom:24px">
      ${lowestFinds.map((l) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #f3f4f6">
          <div>
            <strong>${l.productName}</strong>
            <span style="color:#6b7280;font-size:13px"> at ${l.retailer}</span>
          </div>
          <div>
            <span style="font-weight:700;color:#5B6B4A;font-size:16px">${cad(l.price)}</span>
            <a href="${l.url}" style="margin-left:8px;color:#5B6B4A;text-decoration:underline;font-size:13px">View</a>
          </div>
        </div>
      `).join("")}
    </div>
    ` : ""}

    <hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0"/>
    <p style="color:#9ca3af;font-size:12px;margin:0">
      Sent by LuggageTracker · Prices in CAD · Data from Google Shopping Canada via SerpAPI
    </p>
  </div>
</body>
</html>`;
}

/**
 * Send the daily price report email via Resend.
 */
export async function sendDailyReport(data: ReportData) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const from = process.env.REPORT_FROM_EMAIL ?? "LuggageTracker <onboarding@resend.dev>";
  const to = process.env.REPORT_TO_EMAIL ?? "yycluggagedepot@gmail.com";

  const subject = data.drops.length > 0
    ? `LuggageTracker: ${data.drops.length} price drop${data.drops.length > 1 ? "s" : ""} found!`
    : `LuggageTracker: Daily Report — ${data.date}`;

  const { data: result, error } = await resend.emails.send({
    from,
    to,
    subject,
    html: buildReportHtml(data),
  });

  if (error) throw new Error(`Resend error: ${JSON.stringify(error)}`);
  return result;
}
