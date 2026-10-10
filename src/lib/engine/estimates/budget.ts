/* ------------------------------------------------------------------ */
/*  Web-estimate budget planner (R3.6)                                 */
/*                                                                     */
/*  Tavily's free plan is the only source of web estimates, and the    */
/*  app stops at TAVILY_MONTHLY_CREDIT_CAP (950). The morning email     */
/*  comes first: its prepare run may spend up to ESTIMATE_DAILY_BUDGET  */
/*  (default 20) a day, and interactive searches only spend what is    */
/*  left after the email's need for the rest of the month is set aside. */
/*  When credits are short, email products take turns (oldest estimate */
/*  first). At the cap nothing is spent and the app carries on with     */
/*  verified, staff-checked and dealer prices plus links.              */
/*                                                                     */
/*  Pure: the caller reads the month's usage first and passes it in.   */
/*  The hard stop stays in src/lib/tavily.ts (no request past the cap). */
/* ------------------------------------------------------------------ */

export type EstimatePurpose = "email" | "interactive";

export const DEFAULT_ESTIMATE_DAILY_BUDGET = 20;

export function estimateDailyBudget(
  raw: string | undefined = process.env.ESTIMATE_DAILY_BUDGET,
): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 200) : DEFAULT_ESTIMATE_DAILY_BUDGET;
}

export type BudgetState = {
  /** Monthly cap actually enforced (app cap or Tavily's lower limit). */
  cap: number;
  /** Credits used this month, by the most pessimistic ledger (Tavily + this app). */
  usedThisMonth: number;
  /** Credits the morning-email prepare spent today. */
  emailSpentToday: number;
  /** Credits the email needs per day: min(daily budget, products chosen). */
  emailDailyNeed: number;
  /** Days left in the calendar month, today included (≥ 1). */
  daysLeftInMonth: number;
  /** True once today's prepare run has finished. */
  emailDoneToday: boolean;
};

export function remainingThisMonth(s: Pick<BudgetState, "cap" | "usedThisMonth">): number {
  return Math.max(0, s.cap - s.usedThisMonth);
}

/** Credits held back for the morning email: what today still needs plus every later day. */
export function emailReserve(s: BudgetState): number {
  const today = s.emailDoneToday ? 0 : Math.max(0, s.emailDailyNeed - s.emailSpentToday);
  const laterDays = Math.max(0, s.daysLeftInMonth - 1) * s.emailDailyNeed;
  return today + laterDays;
}

/** Credits a purpose may spend right now. Never more than what's left under the cap. */
export function allowance(
  purpose: EstimatePurpose,
  s: BudgetState,
  dailyBudget = estimateDailyBudget(),
): number {
  const remaining = remainingThisMonth(s);
  if (remaining <= 0) return 0;
  if (purpose === "email") return Math.min(remaining, Math.max(0, dailyBudget - s.emailSpentToday));
  return Math.max(0, remaining - emailReserve(s));
}

/** Days left in the month of `ymd`, today included. */
export function daysLeftInMonth(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.max(1, last - d + 1);
}

/**
 * Which email products get a new estimate today when credits are short:
 * the ones whose last estimate is oldest (never first). The rest keep their
 * last estimate, shown as "Last seen <date>".
 */
export function rotate<T extends { lastEstimateAt: string | null }>(
  items: T[],
  credits: number,
): { now: T[]; later: T[] } {
  const sorted = [...items].sort((a, b) => {
    if (a.lastEstimateAt === b.lastEstimateAt) return 0;
    if (a.lastEstimateAt === null) return -1;
    if (b.lastEstimateAt === null) return 1;
    return a.lastEstimateAt.localeCompare(b.lastEstimateAt);
  });
  const n = Math.max(0, Math.floor(credits));
  return { now: sorted.slice(0, n), later: sorted.slice(n) };
}
