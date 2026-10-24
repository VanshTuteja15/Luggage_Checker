/* ------------------------------------------------------------------ */
/*  Morning email: the view model (R1.8–R1.11)                         */
/*                                                                     */
/*  Pure: (chosen products + their latest prices + verified history)    */
/*  → everything the email says. The HTML and text renderers, the       */
/*  preview on /email, the test send and the daily send all use this    */
/*  one result, so what the owner previews is what the team receives.  */
/*                                                                     */
/*  Rows reuse the search's one-row-per-store logic (storeRows,        */
/*  headlineFor). A price not read today is a "Last seen · Oct 8" row:  */
/*  it sorts after today's prices and never becomes the headline       */
/*  (R1.5, rule 5). Web estimates never count as history.              */
/* ------------------------------------------------------------------ */

import { SIZE_LABELS, type SizeClass } from "@/lib/engine/packs/luggage";
import { freshnessLabel, freshnessTime } from "@/lib/engine/research/answer";
import {
  STOCK_TEXT,
  headlineFor,
  storeRows,
  type StockState,
  type StoreRow,
} from "@/lib/engine/research/rows";
import type { AnswerOffer, Availability, Freshness, PriceMethod } from "@/lib/engine/types";
import { usd } from "@/lib/format";
import {
  CANADIAN_TIME_ZONES,
  addDays,
  formatClock,
  formatYmd,
  formatYmdWeekday,
  localDate,
  parseClock,
} from "@/lib/time/local";

/* ── Input ─────────────────────────────────────────────────────────── */

/** The latest price we hold for a chosen product at one store page. */
export type DigestOffer = {
  sourceId: string;
  retailer: string;
  price: number;
  url: string;
  title: string;
  colour: string | null;
  availability: Availability;
  /** As recorded: when and how it was read. Relabelled "Last seen" here if not today. */
  freshness: Freshness;
  method: PriceMethod;
};

/** A verified price range (never an estimate): this price from first to last seen. */
export type DigestHistoryPoint = {
  sourceId: string;
  retailer: string;
  price: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type DigestProductInput = {
  trackedProductId: string;
  productId: string;
  name: string;
  brand: string;
  sizeClass: string | null;
  /** The colour the product was tracked in, if any. */
  colour: string;
  targetPrice: number | null;
  offers: DigestOffer[];
  history: DigestHistoryPoint[];
};

export type DigestInput = {
  now: Date;
  timeZone: string;
  /** "09:00" */
  sendTime: string;
  /** Where the app runs, for the footer links (no trailing slash). */
  appUrl: string;
  /** The chosen products, in the chosen order. */
  products: DigestProductInput[];
  /** A short note about the previous email's problems (R1.7), or null. */
  note: string | null;
};

/* ── Output ────────────────────────────────────────────────────────── */

export type DigestChange = {
  kind: "down" | "up" | "same" | "none";
  /** Absolute dollars and percent, rounded to cents / one decimal. */
  amount: number;
  pct: number;
  /** "▼ $35.00 (−7.4%)", "▲ $10.00 (+2.1%)", "No change", or "—" (nothing to compare). */
  text: string;
  /** "since Oct 8" when the comparison isn't with yesterday, else null. */
  since: string | null;
};

export type DigestRow = {
  retailer: string;
  price: number;
  priceText: string;
  change: DigestChange;
  stock: StockState;
  stockText: string;
  label: string;
  url: string;
  /** Read today (false: a "Last seen" price). */
  current: boolean;
  colours: string[];
};

export type DigestLine = {
  price: number;
  priceText: string;
  retailer: string;
  label: string;
  url: string;
  estimate: boolean;
};

export type DigestProduct = {
  trackedProductId: string;
  name: string;
  brand: string;
  size: string | null;
  colours: string[];
  /** The lowest price now (R2.3 rules), or null when nothing was read today. */
  lowest: DigestLine | null;
  /** When the lowest is a web estimate: the lowest price that isn't one. */
  lowestVerified: DigestLine | null;
  allOutOfStock: boolean;
  rows: DigestRow[];
  /** "Lowest in 30 days: $X at Store (Oct 3)" / "This is the lowest in 30 days". */
  low30: string | null;
  /** "Target $399.00 reached" */
  target: string | null;
  /** Shown instead of the table when there is no price at all. */
  empty: string | null;
};

export type DigestView = {
  subject: string;
  /** "Luggage prices · Fri, Oct 10" */
  heading: string;
  localDate: string;
  note: string | null;
  /** The three summary lines (R1.9). */
  summary: [string, string, string];
  counts: { drops: number; increases: number; targetsHit: number; unchecked: string[] };
  products: DigestProduct[];
  footer: {
    disclaimer: string;
    appUrl: string;
    emailUrl: string;
    schedule: string;
  };
};

/* ── Helpers ───────────────────────────────────────────────────────── */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Live readings and estimates are "today's" only on the day they were read. */
function isToday(f: Freshness, now: Date, tz: string): boolean {
  if (f.kind === "live" || f.kind === "estimate")
    return localDate(new Date(freshnessTime(f)), tz) === localDate(now, tz);
  // Staff-checked and dealer-list prices carry their own date in the label.
  return f.kind === "feed" || f.kind === "manual";
}

function toAnswerOffer(o: DigestOffer, now: Date, tz: string): AnswerOffer {
  const today = isToday(o.freshness, now, tz);
  return {
    sourceId: o.sourceId,
    retailer: o.retailer,
    url: o.url,
    title: o.title,
    brand: null,
    sizeClass: null,
    identifiers: [],
    imageUrl: null,
    reasons: [],
    price: o.price,
    listPrice: null,
    currency: "CAD",
    availability: o.availability,
    colour: o.colour,
    freshness: today ? o.freshness : { kind: "stale", lastSeenAt: freshnessTime(o.freshness) },
    confidence: 1,
    lowConfidence: false,
    method: o.method,
    observationId: null,
    listingId: null,
    productId: null,
    evidence: null,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The store's verified price before today: the latest range that started before today. */
function priceBeforeToday(
  history: DigestHistoryPoint[],
  sourceId: string,
  today: string,
  tz: string,
): { price: number; date: string } | null {
  let best: DigestHistoryPoint | null = null;
  for (const h of history) {
    if (h.sourceId !== sourceId) continue;
    if (localDate(new Date(h.firstSeenAt), tz) >= today) continue;
    if (
      !best ||
      h.firstSeenAt > best.firstSeenAt ||
      (h.firstSeenAt === best.firstSeenAt && h.price < best.price)
    )
      best = h;
  }
  if (!best) return null;
  const lastDay = localDate(new Date(best.lastSeenAt), tz);
  // A range still running today means the price was the same yesterday.
  return { price: best.price, date: lastDay >= today ? addDays(today, -1) : lastDay };
}

function changeFor(
  row: StoreRow,
  history: DigestHistoryPoint[],
  today: string,
  tz: string,
): DigestChange {
  const none: DigestChange = { kind: "none", amount: 0, pct: 0, text: "—", since: null };
  // Only a price read today can have changed today; estimates have no verified past.
  if (!row.current || row.offer.freshness.kind === "estimate") return none;
  const prev = priceBeforeToday(history, row.sourceId, today, tz);
  if (!prev || prev.date < addDays(today, -7)) return none;
  const diff = round2(row.price - prev.price);
  if (Math.abs(diff) < 0.005)
    return { kind: "same", amount: 0, pct: 0, text: "No change", since: null };
  const since = prev.date === addDays(today, -1) ? null : `since ${formatYmd(prev.date)}`;
  const pct = prev.price > 0 ? Math.round((Math.abs(diff) / prev.price) * 1000) / 10 : 0;
  return diff < 0
    ? { kind: "down", amount: -diff, pct, text: `▼ ${usd(-diff)} (−${pct}%)`, since }
    : { kind: "up", amount: diff, pct, text: `▲ ${usd(diff)} (+${pct}%)`, since };
}

function lineFor(
  row: StoreRow,
  original: Map<AnswerOffer, Freshness>,
  now: Date,
  tz: string,
): DigestLine {
  return {
    price: row.price,
    priceText: usd(row.price),
    retailer: row.retailer,
    label: freshnessLabel(original.get(row.offer) ?? row.offer.freshness, now, tz),
    url: row.offer.url,
    estimate: row.offer.freshness.kind === "estimate",
  };
}

function low30Text(
  history: DigestHistoryPoint[],
  currentVerified: number | null,
  now: Date,
  tz: string,
): string | null {
  const since = now.getTime() - 30 * 86_400_000;
  const recent = history.filter((h) => Date.parse(h.lastSeenAt) >= since);
  if (recent.length === 0) return null;
  const low = recent.reduce((a, b) =>
    b.price < a.price || (b.price === a.price && b.lastSeenAt > a.lastSeenAt) ? b : a,
  );
  if (currentVerified !== null && currentVerified <= low.price + 0.005)
    return "This is the lowest in 30 days";
  return `Lowest in 30 days: ${usd(low.price)} at ${low.retailer} (${formatYmd(localDate(new Date(low.lastSeenAt), tz))})`;
}

function zoneName(tz: string): string {
  return CANADIAN_TIME_ZONES.find((z) => z.id === tz)?.label ?? tz;
}

/** "09:00" → "9:00 a.m." */
export function clockText(hhmm: string): string {
  const m = parseClock(hhmm) ?? 540;
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "a.m." : "p.m."}`;
}

/* ── Builder ───────────────────────────────────────────────────────── */

export function buildDigest(input: DigestInput): DigestView {
  const { now, timeZone: tz } = input;
  const today = localDate(now, tz);
  const unchecked = new Set<string>();
  let drops = 0;
  let increases = 0;
  let targetsHit = 0;
  // Assigned inside the map below; the cast stops TS narrowing it to null here.
  let biggestDrop = null as { amount: number; text: string } | null;

  const products: DigestProduct[] = input.products.map((p) => {
    const original = new Map<AnswerOffer, Freshness>();
    // At equal prices the row links to the colour the product is tracked in.
    const tracked = p.colour.trim().toLowerCase();
    const ordered = tracked
      ? [...p.offers].sort(
          (a, b) =>
            Number((b.colour ?? "").toLowerCase() === tracked) -
            Number((a.colour ?? "").toLowerCase() === tracked),
        )
      : p.offers;
    const offers = ordered.map((o) => {
      const a = toAnswerOffer(o, now, tz);
      original.set(a, o.freshness);
      return a;
    });
    const rows = storeRows(offers);
    const headline = headlineFor(rows);
    const size =
      p.sizeClass && p.sizeClass in SIZE_LABELS ? SIZE_LABELS[p.sizeClass as SizeClass] : null;
    const colours = [
      ...new Set(
        [p.colour, ...rows.flatMap((r) => r.colours)].filter((c): c is string => !!c?.trim()),
      ),
    ].slice(0, 6);

    const digestRows: DigestRow[] = rows.map((r) => {
      const change = changeFor(r, p.history, today, tz);
      if (change.kind === "down") {
        drops++;
        if (!biggestDrop || change.amount > biggestDrop.amount)
          biggestDrop = {
            amount: change.amount,
            text: `▼ ${usd(change.amount)} on ${p.name} at ${r.retailer}`,
          };
      }
      if (change.kind === "up") increases++;
      if (!r.current) unchecked.add(r.retailer);
      return {
        retailer: r.retailer,
        price: r.price,
        priceText: usd(r.price),
        change,
        stock: r.stock,
        stockText: STOCK_TEXT[r.stock],
        label: freshnessLabel(original.get(r.offer) ?? r.offer.freshness, now, tz),
        url: r.offer.url,
        current: r.current,
        colours: r.colours,
      };
    });

    const lowest = headline ? lineFor(headline.row, original, now, tz) : null;
    const lowestVerified = headline?.confirmed
      ? lineFor(headline.confirmed, original, now, tz)
      : null;
    const verifiedNow = rows
      .filter((r) => r.current && r.offer.freshness.kind !== "estimate")
      .reduce<number | null>((m, r) => (m === null || r.price < m ? r.price : m), null);

    let target: string | null = null;
    if (p.targetPrice !== null && lowest && lowest.price <= p.targetPrice + 0.005) {
      targetsHit++;
      target = lowest.estimate
        ? `Target ${usd(p.targetPrice)} reached at ${lowest.retailer} (web estimate, confirm on site)`
        : `Target ${usd(p.targetPrice)} reached`;
    }

    return {
      trackedProductId: p.trackedProductId,
      name: p.name,
      brand: p.brand,
      size,
      colours,
      lowest,
      lowestVerified,
      allOutOfStock: headline?.allOutOfStock ?? false,
      rows: digestRows,
      low30: low30Text(p.history, verifiedNow, now, tz),
      target,
      empty:
        digestRows.length === 0
          ? "No price found yet at the stores you chose. It will appear once a store is checked."
          : null,
    };
  });

  // A store read today for any product was checked; its older rows still say "Last seen".
  for (const p of products) for (const r of p.rows) if (r.current) unchecked.delete(r.retailer);
  const uncheckedList = [...unchecked].sort((a, b) => a.localeCompare(b));
  const summary: [string, string, string] = [
    drops === 0
      ? "No prices dropped since yesterday."
      : `${plural(drops, "price", "prices")} dropped since yesterday${biggestDrop ? ` (biggest: ${biggestDrop.text})` : ""}.`,
    increases === 0 ? "No prices went up." : `${plural(increases, "price", "prices")} went up.`,
    `${targetsHit === 0 ? "No targets hit" : `${plural(targetsHit, "target", "targets")} hit`}. ${
      uncheckedList.length === 0
        ? "Every store with a price was checked today."
        : `Couldn't check today: ${uncheckedList.join(", ")}.`
    }`,
  ];

  const day = formatYmdWeekday(today); // "Fri, Oct 10"
  const subjectParts = [
    `Luggage prices · ${day.replace(",", "")}`,
    drops === 0 ? "no drops" : plural(drops, "drop", "drops"),
  ];
  if (targetsHit > 0) subjectParts.push(`${plural(targetsHit, "target", "targets")} hit`);

  const appUrl = input.appUrl.replace(/\/+$/, "");
  return {
    subject: subjectParts.join(" · "),
    heading: `Luggage prices · ${day}`,
    localDate: today,
    note: input.note,
    summary,
    counts: { drops, increases, targetsHit, unchecked: uncheckedList },
    products,
    footer: {
      disclaimer:
        "Prices are each store's listed price in CAD before GST/HST and shipping, as read at the time shown.",
      appUrl,
      emailUrl: `${appUrl}/email`,
      schedule: `Sent every day at ${clockText(formatClock(parseClock(input.sendTime) ?? 540))}, ${zoneName(tz)} time.`,
    },
  };
}
