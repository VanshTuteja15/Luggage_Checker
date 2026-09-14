/* ------------------------------------------------------------------ */
/*  Time budget                                                       */
/*                                                                     */
/*  The search route has a hard 60s ceiling on Vercel. The pipeline    */
/*  has four stages that can each block, and their worst-case timeouts */
/*  added up to more than that — so a slow-but-recoverable search      */
/*  could be killed mid-flight, AFTER the provider had already been    */
/*  billed. The user pays for a search and sees a generic crash.       */
/*                                                                     */
/*  A shared deadline makes every stage aware of the time left, so the */
/*  pipeline degrades (skip the retry, cluster faster) instead of      */
/*  being cut off.                                                     */
/* ------------------------------------------------------------------ */

export class Deadline {
  private constructor(private readonly endsAt: number) {}

  static in(ms: number): Deadline {
    return new Deadline(Date.now() + ms);
  }

  /** Milliseconds left before the budget is spent. Never negative. */
  get remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  get expired(): boolean {
    return this.remaining <= 0;
  }

  /** True when at least `ms` remain. */
  hasAtLeast(ms: number): boolean {
    return this.remaining >= ms;
  }

  /**
   * A timeout for the next step: no more than `preferred`, and never so long
   * that it eats the time `reserve`d for the stages that follow.
   */
  budget(preferred: number, reserve = 0): number {
    return Math.max(0, Math.min(preferred, this.remaining - reserve));
  }
}

/* ------------------------------------------------------------------ */
/*  Per-attempt metering                                              */
/*                                                                     */
/*  Shopping APIs bill per HTTP request, so a provider that retries    */
/*  internally spends TWO searches while the caller reserved one. That */
/*  silently undercounts the allowance — the opposite of what the      */
/*  budget guard is for.                                              */
/*                                                                     */
/*  Providers call these around every request they actually make, so   */
/*  the counter matches what the provider will bill.                   */
/* ------------------------------------------------------------------ */

export type Meter = {
  /** Claim one call. Throws if the allowance is gone — stops the retry. */
  beforeAttempt: () => Promise<void>;
  /** Hand the claim back when the attempt provably wasn't billable. */
  refundAttempt: () => Promise<void>;
};

/** A meter that counts nothing — for tests and unmetered callers. */
export const NO_METER: Meter = {
  beforeAttempt: async () => {},
  refundAttempt: async () => {},
};
