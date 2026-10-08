/* ------------------------------------------------------------------ */
/*  Admin / observability logic (HTTP-free, testable)                  */
/* ------------------------------------------------------------------ */

import { parseFeed } from "./adapters/feed-import";
import { manualOffer, type ManualInput } from "./adapters/manual-entry";
import { describeConfig } from "./config";
import { FLAG_DEFAULTS, isKnownFlag, resolveFlags } from "./flags";
import { observeOffer } from "./observe";
import type { EngineRuntime } from "./recorder";
import { checkRoutes } from "./registry";
import type { CategoryPack } from "./types";

export async function adminOverview(rt: EngineRuntime) {
  const store = rt.store;
  const [health, failures, rejections, sessions, flagRows, counts, reviews, sources] =
    await Promise.all([
      store.sourceHealthStats(),
      store.recentFailures(60),
      store.recentRejections(60),
      store.sessionTimings(60),
      store.listFlagRows(),
      store.countListingsBySource(),
      store.listReviews("pending", 200),
      rt.sources(),
    ]);
  const flags = resolveFlags(flagRows);
  const routeCtx = { flags, config: rt.config };
  const byId = new Map(sources.map((s) => [s.id, s]));
  const finished = sessions.filter((s) => s.totalMs !== null);
  const pct = (xs: number[], p: number) =>
    xs.length
      ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((xs.length - 1) * p))]
      : null;
  return {
    config: describeConfig(rt.config),
    store: store.kind,
    sources: health.map((h) => {
      const s = byId.get(h.sourceId);
      const checks = s ? checkRoutes(s, routeCtx) : [];
      return {
        ...h,
        enabled: s?.enabled ?? false,
        status: s?.status ?? "unknown",
        listings: counts[h.sourceId] ?? 0,
        blockRate24h: h.attempts24h ? h.blocked24h / h.attempts24h : null,
        successRate7d: h.attempts7d ? h.ok7d / h.attempts7d : null,
        routes: checks.map((c) => ({
          adapter: c.route.adapter,
          usable: c.usable,
          reason: c.message,
          crossCheckOnly: !!c.route.crossCheckOnly,
        })),
      };
    }),
    failures,
    rejections,
    sessions,
    sessionStats: {
      count: finished.length,
      firstPriceP50: pct(
        finished.map((s) => s.firstPriceMs).filter((x): x is number => x !== null),
        0.5,
      ),
      firstPriceP95: pct(
        finished.map((s) => s.firstPriceMs).filter((x): x is number => x !== null),
        0.95,
      ),
      totalP50: pct(
        finished.map((s) => s.totalMs as number),
        0.5,
      ),
      totalP95: pct(
        finished.map((s) => s.totalMs as number),
        0.95,
      ),
      deadlineHits: finished.filter((s) => s.deadlineHit).length,
    },
    flags: Object.keys(FLAG_DEFAULTS).map((key) => ({
      key,
      enabled: flags[key] === true,
      default: FLAG_DEFAULTS[key as keyof typeof FLAG_DEFAULTS],
      description: flagRows.find((r) => r.key === key)?.description ?? null,
    })),
    reviews,
  };
}

export async function setFlagAdmin(
  rt: EngineRuntime,
  key: string,
  enabled: boolean,
  userId: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isKnownFlag(key)) return { ok: false, error: "unknown flag" };
  await rt.store.setFlag(key, enabled, userId);
  rt.invalidate();
  return { ok: true };
}

export type FeedImportRequest = {
  sourceId: string;
  format: "csv" | "json";
  asOf: string;
  name: string;
  content: string;
};

export async function importFeedAdmin(
  rt: EngineRuntime,
  pack: CategoryPack,
  req: FeedImportRequest,
  userId: string,
) {
  const source = (await rt.sources()).find((s) => s.id === req.sourceId);
  if (!source) return { ok: false as const, error: "unknown store" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.asOf))
    return { ok: false as const, error: "asOf must be a YYYY-MM-DD date" };
  if (req.content.length > 5_000_000)
    return { ok: false as const, error: "feed is larger than 5 MB" };
  const parsed = parseFeed(req.content, req.format, source, pack, req.asOf, req.name.slice(0, 120));
  let accepted = 0;
  let rejected = parsed.errors.length;
  for (const o of parsed.offers) {
    const r = await observeOffer(rt.store, pack, source, o, {
      sessionId: null,
      discoveredVia: "feed",
      persist: true,
      resolve: true,
    });
    if (r.validation.outcome === "rejected") rejected++;
    else accepted++;
  }
  const id = await rt.store.recordFeedImport({
    sourceId: source.id,
    name: req.name.slice(0, 120),
    format: req.format,
    asOf: req.asOf,
    rowCount: parsed.offers.length + parsed.errors.length,
    accepted,
    rejected,
    importedBy: userId,
  });
  rt.invalidate();
  return { ok: true as const, id, accepted, rejected, errors: parsed.errors.slice(0, 50) };
}

export async function recordManualAdmin(
  rt: EngineRuntime,
  pack: CategoryPack,
  sourceId: string,
  input: Omit<ManualInput, "enteredBy">,
  userId: string,
) {
  const source = (await rt.sources()).find((s) => s.id === sourceId);
  if (!source) return { ok: false as const, error: "unknown store" };
  const m = manualOffer(source, pack, { ...input, enteredBy: userId });
  if (!m.ok) return { ok: false as const, error: m.reason };
  const r = await observeOffer(rt.store, pack, source, m.offer, {
    sessionId: null,
    discoveredVia: "manual",
    persist: true,
    resolve: true,
  });
  rt.invalidate();
  return {
    ok: true as const,
    listingId: r.listing.id,
    outcome: r.validation.outcome,
    reasons: r.validation.reasons,
  };
}
