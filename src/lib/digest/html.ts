/* ------------------------------------------------------------------ */
/*  Morning email: HTML part (R1.8–R1.12)                              */
/*                                                                     */
/*  Pure. Inline styles only (email clients drop <style> blocks), one  */
/*  column up to 640 px so it reads on a phone, no images, no scripts, */
/*  no tracking pixels, no charts. Every piece of text goes through    */
/*  esc(); links are the store's own https page.                       */
/* ------------------------------------------------------------------ */

import { esc } from "@/lib/email";
import type { DigestLine, DigestProduct, DigestRow, DigestView } from "./build";

const INK = "#111827";
const MUTED = "#6b7280";
const LINE = "#e5e7eb";
const BRAND = "#5B6B4A";
const DOWN = "#047857"; // cheaper: green, always with ▼
const UP = "#b91c1c"; // dearer: red, always with ▲
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Only the store's own https page is ever linked. */
function safeUrl(url: string): string | null {
  return /^https:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

function link(url: string, text: string, style = `color:${BRAND}`): string {
  const href = safeUrl(url);
  return href ? `<a href="${esc(href)}" style="${style}">${esc(text)}</a>` : esc(text);
}

function changeCell(r: DigestRow): string {
  const colour = r.change.kind === "down" ? DOWN : r.change.kind === "up" ? UP : MUTED;
  const since = r.change.since
    ? `<br><span style="color:${MUTED};font-size:12px">${esc(r.change.since)}</span>`
    : "";
  return `<span style="color:${colour};white-space:nowrap">${esc(r.change.text)}</span>${since}`;
}

function rowHtml(r: DigestRow): string {
  const td = `padding:8px 6px;border-top:1px solid ${LINE};vertical-align:top;font-size:14px`;
  const tone = r.current ? INK : MUTED;
  const stockColour = r.stock === "out_of_stock" ? UP : r.stock === "in_stock" ? INK : MUTED;
  return `<tr>
  <td style="${td};color:${tone}">${link(r.url, r.retailer, `color:${tone};font-weight:600`)}<br><span style="color:${MUTED};font-size:12px">${esc(r.label)}</span></td>
  <td style="${td};color:${tone};font-weight:600;white-space:nowrap;text-align:right">${esc(r.priceText)}</td>
  <td style="${td};text-align:right">${changeCell(r)}</td>
  <td style="${td};color:${stockColour};white-space:nowrap">${esc(r.stockText)}</td>
</tr>`;
}

function lowestHtml(p: DigestProduct, l: DigestLine): string {
  const out = p.allOutOfStock
    ? `<p style="margin:4px 0 0;color:${UP};font-size:13px;font-weight:600">Out of stock everywhere we checked</p>`
    : "";
  const verified = p.lowestVerified
    ? `<p style="margin:6px 0 0;font-size:13px;color:${INK}">Lowest verified: <strong>${esc(p.lowestVerified.priceText)}</strong> at ${link(p.lowestVerified.url, p.lowestVerified.retailer)} <span style="color:${MUTED}">(${esc(p.lowestVerified.label)})</span></p>`
    : "";
  return `<p style="margin:10px 0 0;font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${p.lowestVerified ? "Possibly lower" : "Lowest price now"}</p>
<p style="margin:2px 0 0;font-size:26px;line-height:1.2;font-weight:700;color:${INK}">${esc(l.priceText)} <span style="font-size:15px;font-weight:500">at ${link(l.url, l.retailer)}</span></p>
<p style="margin:2px 0 0;font-size:13px;color:${MUTED}">${esc(l.label)}</p>${out}${verified}`;
}

function productHtml(p: DigestProduct): string {
  const meta = [p.brand, p.size, p.colours.join(" · ")].filter(Boolean).join(" · ");
  const head = `<h2 style="margin:0;font-size:17px;line-height:1.3;color:${INK}">${esc(p.name)}</h2>
<p style="margin:2px 0 0;font-size:13px;color:${MUTED}">${esc(meta)}</p>`;
  const lowest = p.lowest
    ? lowestHtml(p, p.lowest)
    : p.rows.length
      ? `<p style="margin:10px 0 0;font-size:13px;color:${MUTED}">No store could be checked today. The prices below are the last ones we saw.</p>`
      : "";
  const target = p.target
    ? `<p style="margin:8px 0 0;font-size:13px;font-weight:600;color:${DOWN}">✓ ${esc(p.target)}</p>`
    : "";
  const low30 = p.low30
    ? `<p style="margin:6px 0 0;font-size:13px;color:${INK}">${esc(p.low30)}</p>`
    : "";
  const body = p.empty
    ? `<p style="margin:10px 0 0;font-size:14px;color:${MUTED}">${esc(p.empty)}</p>`
    : `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:12px">
<tr>
  <th align="left" style="padding:0 6px 4px;font-size:12px;color:${MUTED};font-weight:600">Store</th>
  <th align="right" style="padding:0 6px 4px;font-size:12px;color:${MUTED};font-weight:600">Price</th>
  <th align="right" style="padding:0 6px 4px;font-size:12px;color:${MUTED};font-weight:600">Since yesterday</th>
  <th align="left" style="padding:0 6px 4px;font-size:12px;color:${MUTED};font-weight:600">Stock</th>
</tr>
${p.rows.map(rowHtml).join("\n")}
</table>`;
  return `<div style="background:#ffffff;border:1px solid ${LINE};border-radius:10px;padding:16px;margin:0 0 14px">
${head}${lowest}${target}${low30}${body}
</div>`;
}

export function renderDigestHtml(v: DigestView): string {
  const note = v.note
    ? `<div style="background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin:0 0 14px;font-size:14px;color:${INK}">${esc(v.note)}</div>`
    : "";
  const summary = v.summary
    .map((s) => `<p style="margin:0 0 4px;font-size:14px;color:${INK}">${esc(s)}</p>`)
    .join("\n");
  const products = v.products.length
    ? v.products.map(productHtml).join("\n")
    : `<p style="font-size:14px;color:${MUTED}">No products are chosen for this email yet.</p>`;
  const app = safeUrl(v.footer.appUrl);
  const links = app
    ? `<p style="margin:8px 0 0">${link(v.footer.appUrl, "Open LuggageTracker")} · ${link(v.footer.emailUrl, "Change products or recipients")}</p>`
    : "";
  return `<!doctype html>
<html lang="en-CA">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(v.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:${FONT};color:${INK}">
<div style="max-width:640px;margin:0 auto;padding:16px">
<h1 style="margin:0 0 4px;font-size:20px;color:${INK}">${esc(v.heading)}</h1>
<div style="margin:0 0 16px">
${summary}
</div>
${note}
${products}
<div style="font-size:12px;line-height:1.5;color:${MUTED};padding:8px 2px">
<p style="margin:0">${esc(v.footer.disclaimer)}</p>
${links}
<p style="margin:8px 0 0">${esc(v.footer.schedule)}</p>
</div>
</div>
</body>
</html>`;
}
