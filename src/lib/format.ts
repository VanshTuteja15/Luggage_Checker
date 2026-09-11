/** Format a number as Canadian dollars. */
export function usd(value: number) {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Compact CAD for tight spaces — $1.2k. */
export function usdCompact(value: number) {
  if (Math.abs(value) < 1000) return usd(value);
  return `$${(value / 1000).toFixed(1)}k`;
}

/* ------------------------------------------------------------------ */
/*  Relative time                                                     */
/*                                                                     */
/*  The old helpers took "minutes ago" because the mock data stored a  */
/*  fixed offset. Real records carry ISO timestamps.                   */
/* ------------------------------------------------------------------ */

export function relativeFromIso(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";

  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";

  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

export function fullDateFromIso(iso: string | null | undefined): string {
  if (!iso) return "Never checked";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

/** Format a YYYY-MM-DD date for chart axes and tables. */
export function prettyDate(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Percentage change, formatted with a sign. */
export function percentChange(from: number, to: number): string {
  if (from === 0) return "—";
  const pct = ((to - from) / from) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}
