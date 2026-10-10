/* ------------------------------------------------------------------ */
/*  Local time (one module for every time-zone question)              */
/*                                                                     */
/*  Everything goes through Intl.DateTimeFormat with a timeZone, so    */
/*  daylight-saving changes (2026-11-01, 2027-03-14 in Calgary) come   */
/*  from the platform's tz database, never from hand-written offsets.  */
/*  Pure functions: callers pass the instant ("now") in, so tests can  */
/*  use a fake clock.                                                  */
/* ------------------------------------------------------------------ */

export const DEFAULT_TIME_ZONE = "America/Edmonton";

/** Canadian zones offered for the morning email, with plain names. */
export const CANADIAN_TIME_ZONES: readonly { id: string; label: string }[] = [
  { id: "America/St_Johns", label: "Newfoundland (St. John's)" },
  { id: "America/Halifax", label: "Atlantic (Halifax)" },
  { id: "America/Moncton", label: "Atlantic (Moncton)" },
  { id: "America/Toronto", label: "Eastern (Toronto, Ottawa, Montréal)" },
  { id: "America/Winnipeg", label: "Central (Winnipeg)" },
  { id: "America/Regina", label: "Saskatchewan (Regina, no daylight saving)" },
  { id: "America/Edmonton", label: "Mountain (Calgary, Edmonton)" },
  { id: "America/Vancouver", label: "Pacific (Vancouver)" },
  { id: "America/Whitehorse", label: "Yukon (Whitehorse)" },
];

/** True for any IANA zone this runtime knows (validated server-side before saving). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  const supported = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (supported) {
    try {
      if (supported("timeZone").includes(tz)) return true;
    } catch {
      /* fall through to the constructor check */
    }
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type LocalParts = {
  /** YYYY-MM-DD in the zone. */
  date: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** Minutes since local midnight. */
  minutes: number;
};

const partsCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function localParts(at: Date, tz: string = DEFAULT_TIME_ZONE): LocalParts {
  const parts = partsFormatter(tz).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") % 24;
  const minute = get("minute");
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    year,
    month,
    day,
    hour,
    minute,
    minutes: hour * 60 + minute,
  };
}

/** Local calendar date (YYYY-MM-DD) of an instant. */
export function localDate(at: Date, tz: string = DEFAULT_TIME_ZONE): string {
  return localParts(at, tz).date;
}

/** "09:00" → 540. Accepts "9:00" and "09:00:00" (Postgres `time`). */
export function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 540 → "09:00". */
export function formatClock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** YYYY-MM-DD plus n calendar days. */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/**
 * The UTC instant at which the zone's wall clock reads `ymd hh:mm`.
 * Uses the zone's real offset at that moment (found through Intl), so it is
 * correct on DST days. A wall time that doesn't exist (the skipped hour in
 * spring) resolves to the next valid minute.
 */
export function zonedTimeToUtc(ymd: string, hhmm: string, tz: string = DEFAULT_TIME_ZONE): Date {
  const minutes = parseClock(hhmm) ?? 0;
  const [y, mo, d] = ymd.split("-").map(Number);
  const wantUtc = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Guess with the offset at the naive instant, then correct once or twice.
  let guess = wantUtc;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wantUtc - seen;
    if (diff === 0) return new Date(guess);
    guess += diff;
  }
  return new Date(guess);
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();
function fmt(key: string, tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${key}|${tz}`;
  let f = timeFormatters.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: tz });
    timeFormatters.set(k, f);
  }
  return f;
}

/** "9:02 a.m." */
export function formatTime(at: Date | string, tz: string = DEFAULT_TIME_ZONE): string {
  return fmt("time", tz, { hour: "numeric", minute: "2-digit" }).format(new Date(at));
}

/** "Oct 9" */
export function formatDay(at: Date | string, tz: string = DEFAULT_TIME_ZONE): string {
  return fmt("day", tz, { month: "short", day: "numeric" }).format(new Date(at));
}

/** "Fri, Oct 10" */
export function formatWeekdayDate(at: Date | string, tz: string = DEFAULT_TIME_ZONE): string {
  return fmt("wday", tz, { weekday: "short", month: "short", day: "numeric" }).format(new Date(at));
}

/** "Oct 9" for a YYYY-MM-DD calendar date (no time zone shift). */
export function formatYmd(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return formatDay(new Date(Date.UTC(y, m - 1, d, 12)), "UTC");
}

/** "Fri, Oct 10" for a YYYY-MM-DD calendar date. */
export function formatYmdWeekday(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return formatWeekdayDate(new Date(Date.UTC(y, m - 1, d, 12)), "UTC");
}

/** True when the instant falls on the same local calendar day as `now`. */
export function isSameLocalDay(
  at: Date | string,
  now: Date,
  tz: string = DEFAULT_TIME_ZONE,
): boolean {
  return localDate(new Date(at), tz) === localDate(now, tz);
}
