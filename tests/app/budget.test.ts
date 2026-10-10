/* ------------------------------------------------------------------ */
/*  A3.3: the web-estimate budget. The cap is never exceeded, the      */
/*  morning email has priority, and email products take turns.        */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  allowance,
  daysLeftInMonth,
  emailReserve,
  estimateDailyBudget,
  rotate,
  type BudgetState,
} from "@/lib/engine/estimates/budget";

const state = (over: Partial<BudgetState> = {}): BudgetState => ({
  cap: 950,
  usedThisMonth: 0,
  emailSpentToday: 0,
  emailDailyNeed: 20,
  daysLeftInMonth: 22,
  emailDoneToday: false,
  ...over,
});

describe("never past the cap", () => {
  it("allows nothing at or over the cap, whatever the purpose", () => {
    for (const used of [950, 951, 2000]) {
      expect(allowance("email", state({ usedThisMonth: used }))).toBe(0);
      expect(allowance("interactive", state({ usedThisMonth: used }))).toBe(0);
    }
  });

  it("never allows more than what is left under the cap", () => {
    for (let used = 0; used <= 950; used += 37) {
      for (const purpose of ["email", "interactive"] as const) {
        const s = state({ usedThisMonth: used, emailDailyNeed: 0 });
        expect(allowance(purpose, s, 500)).toBeLessThanOrEqual(950 - used);
      }
    }
  });

  it("spending every allowance in turn stops exactly at the cap", () => {
    let used = 0;
    for (let day = 0; day < 60 && used < 950; day++) {
      const s = state({ usedThisMonth: used, emailDailyNeed: 0, daysLeftInMonth: 1 });
      used += allowance("interactive", s);
    }
    expect(used).toBe(950);
  });
});

describe("the morning email comes first", () => {
  it("reserves today's need and every later day's for the email", () => {
    expect(emailReserve(state())).toBe(20 + 21 * 20);
    expect(emailReserve(state({ emailSpentToday: 5 }))).toBe(15 + 21 * 20);
    expect(emailReserve(state({ emailDoneToday: true }))).toBe(21 * 20);
  });

  it("interactive searches only get what's left after that reserve", () => {
    // 950 − (20 + 21×20) = 510 left for searches this month.
    expect(allowance("interactive", state())).toBe(510);
    // Late in the month with credits short, searches get nothing; the email still does.
    const short = state({ usedThisMonth: 900, daysLeftInMonth: 3 });
    expect(allowance("interactive", short)).toBe(0);
    expect(allowance("email", short)).toBe(20);
  });

  it("the email itself is capped by its daily budget", () => {
    expect(allowance("email", state({ emailSpentToday: 0 }), 20)).toBe(20);
    expect(allowance("email", state({ emailSpentToday: 18 }), 20)).toBe(2);
    expect(allowance("email", state({ emailSpentToday: 20 }), 20)).toBe(0);
  });

  it("with no email products chosen, searches may use everything left", () => {
    expect(allowance("interactive", state({ emailDailyNeed: 0, usedThisMonth: 100 }))).toBe(850);
  });
});

describe("rotation when credits are short", () => {
  it("gives new estimates to the products whose last one is oldest (never first)", () => {
    const items = [
      { id: "a", lastEstimateAt: "2026-10-09T15:00:00Z" },
      { id: "b", lastEstimateAt: null },
      { id: "c", lastEstimateAt: "2026-10-07T15:00:00Z" },
      { id: "d", lastEstimateAt: "2026-10-08T15:00:00Z" },
    ];
    const { now, later } = rotate(items, 2);
    expect(now.map((x) => x.id)).toEqual(["b", "c"]);
    expect(later.map((x) => x.id)).toEqual(["d", "a"]);
    expect(rotate(items, 0).now).toEqual([]);
    expect(rotate(items, 10).now).toHaveLength(4);
  });

  it("over two short days, every product gets its turn", () => {
    let items = ["a", "b", "c", "d"].map((id) => ({ id, lastEstimateAt: null as string | null }));
    const seen = new Set<string>();
    for (const day of ["2026-10-10", "2026-10-11"]) {
      const { now } = rotate(items, 2);
      for (const x of now) seen.add(x.id);
      items = items.map((x) =>
        now.some((n) => n.id === x.id) ? { ...x, lastEstimateAt: `${day}T15:00:00Z` } : x,
      );
    }
    expect(seen).toEqual(new Set(["a", "b", "c", "d"]));
  });
});

describe("settings", () => {
  it("reads ESTIMATE_DAILY_BUDGET, default 20", () => {
    expect(estimateDailyBudget(undefined)).toBe(20);
    expect(estimateDailyBudget("")).toBe(20);
    expect(estimateDailyBudget("5")).toBe(5);
    expect(estimateDailyBudget("-3")).toBe(20);
  });
  it("counts the days left in a month, today included", () => {
    expect(daysLeftInMonth("2026-10-10")).toBe(22);
    expect(daysLeftInMonth("2026-10-31")).toBe(1);
    expect(daysLeftInMonth("2027-02-01")).toBe(28);
  });
});
