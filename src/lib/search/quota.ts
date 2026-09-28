/* ------------------------------------------------------------------ */
/*  Provider quota tracking and search caching                        */
/*                                                                     */
/*  Every free price-provider allowance is small. Two mechanisms make  */
/*  one last:                                                          */
/*                                                                     */
/*    Cache  — a repeated search costs nothing. This is the bigger     */
/*             win by far: the same query within the TTL is free, and  */
/*             refreshes reuse a recent search instead of paying again.*/
/*                                                                     */
/*    Budget — count every call and refuse once the allowance is gone, */
/*             with a message that says so, rather than letting the    */
/*             provider fail with an opaque 429.                       */
/*                                                                     */
/*  Both degrade gracefully: with no database handle, search still     */
/*  works, it just spends more.                                        */
/* ------------------------------------------------------------------ */

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lastKnownTavilyUsage, monthlyCreditCap } from "@/lib/tavily";
import type { ProviderName, SearchResponse } from "./types";


/* ------------------------------------------------------------------ */
/*  Bounded database access                                           */
/*                                                                     */
/*  Caching and metering are OPTIMISATIONS. They exist to make a small */
/*  free allowance last — they are not allowed to cost the user their  */
/*  search.                                                            */
/*                                                                     */
/*  On a slow connection a single Supabase round trip was observed     */
/*  taking 5-11 seconds. A search makes four of them (cache read,      */
/*  quota reserve per attempt, cache write), so the database alone     */
/*  could spend the entire 50-second budget before Google was ever     */
/*  asked for a price.                                                 */
/*                                                                     */
/*  So every call here is bounded and fails OPEN: if the database is   */
/*  slow or down, we skip the optimisation and run the search.         */
/* ------------------------------------------------------------------ */

/** How long any single metering/caching query may take. */
function dbTimeoutMs(): number {
  const raw = Number(process.env.SEARCH_DB_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_500;
}

/**
 * Run a database call with a hard ceiling, returning `fallback` if it is
 * slow or throws. Never rejects.
 */
async function bounded<T>(work: Promise<T> | (() => Promise<T>), fallback: T): Promise<T> {
  const promise = typeof work === "function" ? work() : work;
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve(promise).catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `[search] a Supabase call exceeded ${dbTimeoutMs()}ms and was skipped — search continues without it.`,
          );
          resolve(fallback);
        }, dbTimeoutMs());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  Allowances                                                        */
/* ------------------------------------------------------------------ */

type Allowance = {
  limit: number;
  /** 'month' resets on the 1st; 'total' is a one-time pot that never refills. */
  period: "month" | "total";
  label: string;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Free-tier allowances, overridable by env when you upgrade a plan.
 *
 * These are deliberately the *free* numbers — the guard should bite before
 * a provider starts refusing calls, not after.
 */
export function allowanceFor(provider: ProviderName): Allowance | null {
  switch (provider) {
    case "tavily":
      // Tavily's free plan is 1,000 credits a month. The app stops at 950 by
      // default, so a stray manual test or dashboard playground query can't
      // push the account over — and "over" is the only way money could ever
      // be involved.
      return {
        // Same parser as the research client, so the two can't disagree.
        limit: monthlyCreditCap(),
        period: "month",
        label: "Tavily research credits",
      };
    case "serper":
      return {
        limit: envInt("SERPER_CREDIT_LIMIT", 2500),
        period: "total",
        label: "Serper.dev",
      };
    case "serpapi":
      return {
        limit: envInt("SERPAPI_MONTHLY_LIMIT", 250),
        period: "month",
        label: "SerpAPI",
      };
    case "gemini-grounded":
      // Requires billing; Google meters it separately. Nothing to guard.
      return null;
    default:
      return null;
  }
}

function periodKey(allowance: Allowance): string {
  if (allowance.period === "total") return "total";
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

export type ProviderBudget = {
  provider: ProviderName;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  period: "month" | "total";
  exhausted: boolean;
  /** Plain-language note for the UI. */
  note: string;
};

/* ------------------------------------------------------------------ */
/*  Reads                                                             */
/* ------------------------------------------------------------------ */

export async function getBudget(
  db: SupabaseClient,
  provider: ProviderName,
): Promise<ProviderBudget | null> {
  const allowance = allowanceFor(provider);
  if (!allowance) return null;

  const period = periodKey(allowance);

  const { data } = await bounded<{ data: { calls?: unknown } | null }>(
    () =>
      db
        .from("provider_usage")
        .select("calls")
        .eq("provider", provider)
        .eq("period", period)
        .maybeSingle() as unknown as Promise<{ data: { calls?: unknown } | null }>,
    { data: null },
  );

  let used = typeof data?.calls === "number" ? data.calls : 0;

  // Tavily reports its own count; when we've seen it recently, trust
  // whichever figure is higher. Our counter can miss calls made outside
  // the app (dashboard playground, other machines); Tavily's can't.
  if (provider === "tavily") {
    const remote = lastKnownTavilyUsage();
    if (remote && remote.used > used) used = remote.used;
  }
  const remaining = Math.max(0, allowance.limit - used);

  return {
    provider,
    label: allowance.label,
    used,
    limit: allowance.limit,
    remaining,
    period: allowance.period,
    exhausted: remaining <= 0,
    note:
      provider === "tavily"
        ? "Free monthly credits — the app stops before the limit, so nothing is ever charged"
        : allowance.period === "month"
          ? "Resets on the 1st of each month"
          : "One-time free allowance — does not refill",
  };
}

/** Budgets for every provider that has a key configured. */
export async function getAllBudgets(
  db: SupabaseClient,
  providers: ProviderName[],
): Promise<ProviderBudget[]> {
  const results = await Promise.all(providers.map((p) => getBudget(db, p)));
  return results.filter((b): b is ProviderBudget => b !== null);
}

/* ------------------------------------------------------------------ */
/*  Reserving a call                                                  */
/* ------------------------------------------------------------------ */

export class QuotaExhaustedError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string,
  ) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

/**
 * Claim one call against a provider's allowance.
 *
 * Increments first and checks after, because two concurrent searches must
 * not both read 249 and both proceed. If the increment pushes us over, the
 * claim is handed back so the counter stays honest.
 */
export async function reserveCall(
  db: SupabaseClient | undefined,
  provider: ProviderName,
  units = 1,
): Promise<void> {
  if (!db) return; // No database handle — nothing to meter against.

  const allowance = allowanceFor(provider);
  if (!allowance) return;

  const period = periodKey(allowance);

  const { data, error } = await bounded<{ data: unknown; error: unknown }>(
    () =>
      db.rpc("increment_provider_usage", {
        p_provider: provider,
        p_period: period,
        p_amount: units,
      }) as unknown as Promise<{ data: unknown; error: unknown }>,
    // Timed out: treat metering as unavailable and let the search proceed.
    { data: null, error: new Error("metering timed out") },
  );

  // If metering is unavailable, let the search through rather than blocking
  // the feature — the provider's own limit is the backstop.
  if (error || typeof data !== "number") return;

  if (data > allowance.limit) {
    await db
      .rpc("increment_provider_usage", {
        p_provider: provider,
        p_period: period,
        p_amount: -units,
      })
      .then(
        () => undefined,
        () => undefined,
      );

    throw new QuotaExhaustedError(
      provider,
      allowance.period === "month"
        ? `${allowance.label}: this month's free allowance is used up (${allowance.limit}). Research resumes when it resets — nothing is charged.`
        : `${allowance.label}: the free allowance is used up (${allowance.limit}).`,
    );
  }
}

/**
 * Hand a reserved call back.
 *
 * Called when a provider failed in a way that clearly didn't consume the
 * account's allowance — a rejected key, or a request that never left the
 * building. Without this, a run of transient failures silently eats a
 * month's quota and the usage readout lies to the user.
 */
export async function refundCall(
  db: SupabaseClient | undefined,
  provider: ProviderName,
  units = 1,
): Promise<void> {
  await adjustCall(db, provider, -units);
}

/**
 * Nudge the counter by `delta` without an allowance check — used to
 * reconcile a reservation with what the provider says a call really cost.
 * Bounded and fire-safe like everything else here.
 */
export async function adjustCall(
  db: SupabaseClient | undefined,
  provider: ProviderName,
  delta: number,
): Promise<void> {
  if (!db || !delta) return;

  const allowance = allowanceFor(provider);
  if (!allowance) return;

  await bounded(
    () =>
      db.rpc("increment_provider_usage", {
        p_provider: provider,
        p_period: periodKey(allowance),
        p_amount: delta,
      }) as unknown as Promise<unknown>,
    undefined,
  );
}

/* ------------------------------------------------------------------ */
/*  Search cache                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_TTL_MINUTES = envInt("SEARCH_CACHE_TTL_MINUTES", 360); // 6 hours

/**
 * Stable key for a search. Normalised so casing, spacing, punctuation and
 * word order don't cause a miss: "Samsonite luggage", "luggage samsonite"
 * and "Samsonite  Luggage!" are one search, and should cost one credit.
 */
export function normaliseQuery(query: string): string {
  return [
    ...new Set(
      query
        .toLowerCase()
        .replace(/[^a-z0-9$.:\s-]/g, " ")
        .split(/\s+/)
        .filter(Boolean),
    ),
  ]
    .sort()
    .join(" ");
}

export function cacheKey(
  query: string,
  allowedRetailers: string[],
  limit: number,
): string {
  const normalised = normaliseQuery(query);
  const retailers = [...allowedRetailers].sort().join(",");
  return createHash("sha256")
    .update(`${normalised}|${retailers}|${limit}`)
    .digest("hex")
    .slice(0, 48);
}

export type CachedSearch = {
  response: SearchResponse;
  fetchedAt: string;
  ageMinutes: number;
};

export async function readCache(
  db: SupabaseClient | undefined,
  key: string,
): Promise<CachedSearch | null> {
  if (!db) return null;

  const { data, error } = await bounded<{ data: Record<string, unknown> | null; error: unknown }>(
    () =>
      db
        .from("search_cache")
        .select("response, fetched_at, expires_at")
        .eq("cache_key", key)
        .maybeSingle() as unknown as Promise<{ data: Record<string, unknown> | null; error: unknown }>,
    // Timed out: behave exactly like a cache miss.
    { data: null, error: null },
  );

  if (error || !data) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) return null;

  const fetchedAt = data.fetched_at as string;
  const ageMinutes = Math.max(
    0,
    Math.round((Date.now() - new Date(fetchedAt).getTime()) / 60_000),
  );

  return {
    response: data.response as SearchResponse,
    fetchedAt,
    ageMinutes,
  };
}

export async function writeCache(
  db: SupabaseClient | undefined,
  key: string,
  response: SearchResponse,
  ttlMinutes = DEFAULT_TTL_MINUTES,
): Promise<void> {
  if (!db) return;

  const now = new Date();
  const expires = new Date(now.getTime() + ttlMinutes * 60_000);

  // Cache failures must never break a search that already succeeded.
  await db
    .from("search_cache")
    .upsert(
      {
        cache_key: key,
        query: response.query,
        provider: response.provider,
        response: response as unknown as Record<string, unknown>,
        fetched_at: now.toISOString(),
        expires_at: expires.toISOString(),
      },
      { onConflict: "cache_key" },
    )
    .then(
      () => undefined,
      () => undefined,
    );
}
