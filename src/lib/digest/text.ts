/* ------------------------------------------------------------------ */
/*  Morning email: plain-text part                                     */
/*                                                                     */
/*  Pure. The same content as the HTML part, for mail apps that show    */
/*  text only and for spam filters that expect both parts.             */
/* ------------------------------------------------------------------ */

import type { DigestProduct, DigestView } from "./build";

/** Same rule as the HTML part: only the store's own https page is shown. */
function urlLine(url: string): string[] {
  return /^https:\/\/\S+$/i.test(url) ? [`  ${url}`] : [];
}

function productText(p: DigestProduct): string {
  const lines: string[] = [];
  lines.push(p.name.toUpperCase());
  const meta = [p.brand, p.size, p.colours.join(" · ")].filter(Boolean).join(" · ");
  if (meta) lines.push(meta);
  if (p.lowest) {
    lines.push(
      `${p.lowestVerified ? "Possibly lower" : "Lowest price now"}: ${p.lowest.priceText} at ${p.lowest.retailer} (${p.lowest.label})`,
    );
    lines.push(...urlLine(p.lowest.url));
    if (p.allOutOfStock) lines.push("Out of stock everywhere we checked");
    if (p.lowestVerified)
      lines.push(
        `Lowest verified: ${p.lowestVerified.priceText} at ${p.lowestVerified.retailer} (${p.lowestVerified.label})`,
      );
  } else if (p.rows.length) {
    lines.push("No store could be checked today. The prices below are the last ones we saw.");
  }
  if (p.target) lines.push(p.target);
  if (p.low30) lines.push(p.low30);
  if (p.empty) {
    lines.push(p.empty);
  } else {
    lines.push("");
    for (const r of p.rows) {
      const change =
        r.change.kind === "none"
          ? ""
          : ` · ${r.change.kind === "same" ? "no change" : r.change.text}${r.change.since ? ` ${r.change.since}` : ""}`;
      lines.push(`- ${r.retailer}: ${r.priceText}${change} · ${r.stockText} · ${r.label}`);
      lines.push(...urlLine(r.url));
    }
  }
  return lines.join("\n");
}

export function renderDigestText(v: DigestView): string {
  const parts: string[] = [v.heading, "", ...v.summary];
  if (v.note) parts.push("", `Note: ${v.note}`);
  parts.push("");
  if (v.products.length === 0) parts.push("No products are chosen for this email yet.");
  for (const p of v.products) parts.push("", productText(p));
  parts.push(
    "",
    "--",
    v.footer.disclaimer,
    `Open LuggageTracker: ${v.footer.appUrl}`,
    `Change products or recipients: ${v.footer.emailUrl}`,
    v.footer.schedule,
  );
  return parts.join("\n");
}
