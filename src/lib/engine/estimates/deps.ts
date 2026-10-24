/* ------------------------------------------------------------------ */
/*  Real dependencies for web estimates (server and worker)            */
/*                                                                     */
/*  Tavily search with every guard of src/lib/tavily.ts (hard monthly   */
/*  cap, pay-as-you-go refusal), the month's usage read first, and the  */
/*  estimate store on the engine database (in memory without one).      */
/* ------------------------------------------------------------------ */

import { Deadline } from "@/lib/search/deadline";
import { DEFAULT_TIME_ZONE, localDate } from "@/lib/time/local";
import { fetchTavilyUsage, tavilyConfigured, tavilyCreditStatus, tavilySearch } from "@/lib/tavily";
import type { EngineRuntime } from "../recorder";
import { pgPoolOf } from "../store/pg";
import type { CategoryPack } from "../types";
import { estimateDailyBudget } from "./budget";
import { findEstimates, type EstimateDeps, type EstimateRequest, type EstimateResult } from "./run";
import { MemoryEstimateStore, PgEstimateStore, type EstimateStore } from "./store";

export type EstimateFinder = (req: EstimateRequest) => Promise<EstimateResult>;

const memory = new MemoryEstimateStore();

/** A basic snippet-only search answers in 1–2 s; with less than this left it isn't sent. */
export const SNIPPET_MIN_ATTEMPT_MS = 4_000;

export function estimateStoreFor(rt: EngineRuntime): EstimateStore {
  const pool = pgPoolOf(rt.store);
  return pool ? new PgEstimateStore(pool) : memory;
}

/** The month's Tavily usage (free to read). null when web estimates aren't configured. */
export async function tavilyUsage(): Promise<{ cap: number; used: number } | null> {
  if (!tavilyConfigured()) return null;
  await fetchTavilyUsage();
  const s = tavilyCreditStatus();
  return { cap: s.cap, used: s.usedEstimate };
}

export function estimateDeps(
  rt: EngineRuntime,
  pack: CategoryPack,
  sources: EstimateDeps["sources"],
): EstimateDeps {
  const pool = pgPoolOf(rt.store);
  return {
    engine: rt.store,
    estimates: estimateStoreFor(rt),
    pack,
    sources,
    search: async (req, timeoutMs) => {
      // Snippets only, so a few seconds is enough: the brand-store search follows the first one.
      const res = await tavilySearch(req, {
        deadline: Deadline.in(timeoutMs),
        minAttemptMs: SNIPPET_MIN_ATTEMPT_MS,
      });
      return { results: res.results, creditsUsed: res.creditsUsed };
    },
    usage: tavilyUsage,
    // The morning email's daily need: one search per chosen product, up to the budget.
    emailDailyNeed: async () => {
      if (!pool) return 0;
      try {
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM email_digest_products");
        return Math.min(estimateDailyBudget(), rows[0]?.n ?? 0);
      } catch {
        return 0; // table not there yet (migration 006 not run)
      }
    },
    emailDoneToday: async () => {
      if (!pool) return false;
      try {
        const { rows } = await pool.query(
          "SELECT 1 FROM email_digest_runs WHERE kind = 'daily' AND local_date = $1 AND prepared_at IS NOT NULL LIMIT 1",
          [localDate(new Date(), DEFAULT_TIME_ZONE)],
        );
        return rows.length > 0;
      } catch {
        return false;
      }
    },
    now: Date.now,
  };
}

/** A finder bound to this runtime (sources read fresh on every call). */
export function createEstimateFinder(rt: EngineRuntime, pack: CategoryPack): EstimateFinder {
  return async (req) => findEstimates(req, estimateDeps(rt, pack, await rt.sources()));
}
