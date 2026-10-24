/* ------------------------------------------------------------------ */
/*  Morning email: fresh prices before the send (R1.5, R3.6)           */
/*                                                                     */
/*  At send time − 60 min each chosen product is re-checked:            */
/*    1. the engine first (verified routes), on the worker when there  */
/*       is one, otherwise here within a time limit;                   */
/*    2. then web estimates for the stores we can't read live, within  */
/*       the email's share of the free Tavily credits. When credits are */
/*       short, products take turns: the oldest estimate goes first and */
/*       the others keep their last one ("Last seen <date>").          */
/*  A product already re-checked since the window opened is skipped,   */
/*  so the ticks at :00, :15, :30, :45 continue rather than repeat.     */
/* ------------------------------------------------------------------ */

import { sendPriceAlert } from "@/lib/email";
import { PgTrackedBridge } from "@/lib/engine/bridge/tracked";
import { runScheduledEngine } from "@/lib/engine/cron";
import {
  allowance,
  daysLeftInMonth,
  estimateDailyBudget,
  rotate,
} from "@/lib/engine/estimates/budget";
import { estimateDeps } from "@/lib/engine/estimates/deps";
import { cacheKeyFor, findEstimates, referencePrices } from "@/lib/engine/estimates/run";
import { expectedFromTracked } from "@/lib/engine/estimates/validate";
import { flagOn } from "@/lib/engine/flags";
import { verifyTracked } from "@/lib/engine/jobs/verify-tracked";
import type { EngineRuntime } from "@/lib/engine/recorder";
import { liveRoutes } from "@/lib/engine/registry";
import { callWorker } from "@/lib/engine/server";
import { pgPoolOf } from "@/lib/engine/store/pg";
import type { CategoryPack } from "@/lib/engine/types";
import { DEFAULT_TIME_ZONE, localDate, localParts, zonedTimeToUtc } from "@/lib/time/local";
import type { PrepareFn } from "./tick";

/** One Tavily search for one product: never wait past the tick's deadline for it. */
const MIN_TIME_FOR_ESTIMATE_MS = 10_000;

export function serverPrepare(rt: EngineRuntime, pack: CategoryPack): PrepareFn {
  return async (_userId, chosen, ctx) => {
    const pool = pgPoolOf(rt.store);
    if (!pool) return { done: true, verified: 0, estimated: 0 };
    const sinceIso = ctx.since.toISOString();
    const timeLeft = () => ctx.deadlineAt - Date.now();

    /* ── 1. verified prices ────────────────────────────────────────── */
    let verified = 0;
    let verifyDone = true;
    const stale = chosen.filter((c) => !c.lastCheckedAt || c.lastCheckedAt < sinceIso);
    if (stale.length) {
      const productIds = stale.map((c) => c.productId);
      const status = await callWorker("/v1/jobs", {
        name: "verify.tracked",
        data: { productIds, maxProducts: productIds.length },
      });
      if (status === 202) {
        verified = productIds.length; // handed to the worker; it finishes well before the send
      } else {
        const signal = AbortSignal.timeout(Math.max(5_000, Math.floor(timeLeft() * 0.6)));
        const { stats } = await verifyTracked(rt, pack, new PgTrackedBridge(pool), {
          productIds,
          maxProducts: productIds.length,
          sendAlert: sendPriceAlert,
          signal,
          trigger: "cron",
        });
        verified = stats.verified;
        verifyDone = !signal.aborted && stats.skippedForBudget === 0;
      }
    }

    /* ── 2. web estimates within the email's budget ───────────────── */
    let estimated = 0;
    let estimatesDone = true;
    const flags = await rt.flags();
    const sources = await rt.sources();
    const stores = flagOn(flags, "estimates.web")
      ? sources.filter(
          (s) =>
            s.status === "active" &&
            s.allowedDomains.length > 0 &&
            liveRoutes(s, { flags, config: rt.config }).length === 0 &&
            (!ctx.storeIds || ctx.storeIds.has(s.id)),
        )
      : [];
    const deps = estimateDeps(rt, pack, sources);
    const usage = stores.length ? await deps.usage().catch(() => null) : null;
    if (usage) {
      const today = localDate(ctx.now, ctx.timeZone);
      const nowIso = ctx.now.toISOString();
      const budget = estimateDailyBudget();
      let credits = allowance(
        "email",
        {
          cap: usage.cap,
          usedThisMonth: usage.used,
          emailSpentToday: await deps.estimates.spentOn(today, "email").catch(() => 0),
          emailDailyNeed: Math.min(budget, chosen.length),
          daysLeftInMonth: daysLeftInMonth(today),
          emailDoneToday: false,
        },
        budget,
      );
      const items = [];
      for (const c of chosen) {
        const expected = expectedFromTracked(c, pack);
        const { key } = cacheKeyFor(c.name, expected);
        const last = await deps.estimates.lastSearchedAt(key).catch(() => null);
        if (last && last >= sinceIso) continue; // already estimated this window
        items.push({ c, expected, key, lastEstimateAt: last });
      }
      for (const item of rotate(items, items.length).now) {
        if (timeLeft() < MIN_TIME_FOR_ESTIMATE_MS) {
          estimatesDone = false;
          break;
        }
        const cached = await deps.estimates.cachedSearch(item.key, nowIso).catch(() => null);
        if (!cached && credits < 1) continue; // out of credits: keeps its last estimate
        const res = await findEstimates(
          {
            purpose: "email",
            query: item.c.name,
            expected: item.expected,
            stores,
            preBudgeted: true,
            timeoutMs: 8_000,
            references: () => referencePrices(rt.store, pack, item.expected, [], ctx.now.getTime()),
          },
          { ...deps, now: () => ctx.now.getTime(), timeZone: ctx.timeZone },
        );
        if (!cached) credits -= Math.max(1, res.credits);
        if (res.skipped === null) estimated += 1;
        if (res.skipped === "cap") break;
      }
    }

    return { done: verifyDone && estimatesDone, verified, estimated };
  };
}

/**
 * The daily engine jobs (re-check every tracked product, retention), once
 * per local day from 05:00 Calgary time, whichever trigger comes first.
 * An advisory lock makes parallel ticks agree on who runs them.
 */
export function serverDailyJobs(rt: EngineRuntime): (now: Date) => Promise<Record<string, unknown> | null> {
  return async (now) => {
    const pool = pgPoolOf(rt.store);
    if (!pool) return null;
    const local = localParts(now, DEFAULT_TIME_ZONE);
    if (local.hour < 5) return null;
    const midnight = zonedTimeToUtc(local.date, "00:00", DEFAULT_TIME_ZONE).toISOString();
    const client = await pool.connect();
    let runId: string | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('luggagetracker.tick.daily'))");
      const { rows } = await client.query(
        `INSERT INTO engine_runs (job, trigger)
         SELECT 'tick.daily', 'cron'
          WHERE NOT EXISTS (SELECT 1 FROM engine_runs WHERE job = 'tick.daily' AND started_at >= $1)
         RETURNING id`,
        [midnight],
      );
      await client.query("COMMIT");
      runId = rows[0] ? String(rows[0].id) : null;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    if (!runId) return null; // already done today
    const result = await runScheduledEngine({ timeLimitMs: 100_000 });
    await pool.query(
      "UPDATE engine_runs SET finished_at = now(), ok = true, stats = $2::jsonb WHERE id = $1",
      [runId, JSON.stringify({ mode: result.mode })],
    );
    return { mode: result.mode, verifiedProducts: result.verifiedProductIds.length };
  };
}
