/* ------------------------------------------------------------------ */
/*  Store status in plain words (R5.2)                                 */
/*                                                                     */
/*  What the owner sees by default on Store status: for each store,    */
/*  what we can get there, the last good check and any problem in one  */
/*  sentence; and how much of the free allowances is left. Route names, */
/*  flags and circuit states stay under Technical details.             */
/*                                                                     */
/*  Pure: the overview route gathers the inputs.                       */
/* ------------------------------------------------------------------ */

import { checkRoutes, LIVE_ADAPTERS, liveRoutes, type RouteContext } from "./registry";
import type { StoreCapability, StoreStatusRow } from "@/lib/store-status-view";
import type { SourceRecord } from "./types";

export type { StoreCapability, StoreStatusRow };

export type StoreHealthLite = {
  sourceId: string;
  circuit: string;
  attempts24h: number;
  blocked24h: number;
  lastOkAt: string | null;
};

/** Below this many checks a day, a block rate says little. */
const MIN_ATTEMPTS_FOR_RATE = 3;
const BLOCK_RATE_PROBLEM = 0.2;

/** Why prices there can't be read live, as a sentence. */
function notLiveSentence(source: SourceRecord, ctx: RouteContext): string {
  if (source.liveClass === "blocked") return "It blocks automated checks from our network.";
  if (source.permission === "forbidden" && source.liveClass !== "official_api")
    return "Its terms don't allow automated price checks.";
  if (source.liveClass === "none") return "It doesn't show prices online.";
  const first = checkRoutes(source, ctx).find(
    (c) => LIVE_ADAPTERS.has(c.route.adapter) && !c.route.crossCheckOnly,
  );
  if (!first) return "There is no way to read its prices live.";
  if (first.reason === "not_permitted") return "Its terms don't allow automated price checks.";
  return "Live checks aren't connected yet.";
}

export function storeStatusRows(
  sources: SourceRecord[],
  health: StoreHealthLite[],
  ctx: RouteContext & { estimatesOn: boolean },
): StoreStatusRow[] {
  const byId = new Map(health.map((h) => [h.sourceId, h]));
  return sources
    .filter((s) => s.status === "active")
    .map((s) => {
      const h = byId.get(s.id);
      const live = s.enabled && liveRoutes(s, ctx).length > 0;
      const gets: StoreCapability[] = [];
      if (live) gets.push("Verified live");
      if (!live && s.enabled && ctx.estimatesOn && s.allowedDomains.length > 0)
        gets.push("Web estimate");
      if (ctx.feedSources?.has(s.id)) gets.push("Dealer list");
      if (gets.length === 0) gets.push("Link only");

      let problem: string | null = null;
      if (!s.enabled) problem = "Switched off. It can be turned back on under Technical details.";
      else if (h?.circuit === "open")
        problem = "Checks are paused after repeated failures; they start again by themselves.";
      else if (h?.circuit === "half_open")
        problem = "Checks are being tried again after recent failures.";
      else if (
        h &&
        h.attempts24h >= MIN_ATTEMPTS_FOR_RATE &&
        h.blocked24h / h.attempts24h >= BLOCK_RATE_PROBLEM
      )
        problem = `The store turned away ${h.blocked24h} of ${h.attempts24h} checks in the last 24 hours.`;
      else if (!live) problem = notLiveSentence(s, ctx);
      else if (h && h.attempts24h > 0 && !h.lastOkAt) problem = "No successful check yet.";

      return {
        sourceId: s.id,
        name: s.retailerLabel,
        gets,
        lastOkAt: h?.lastOkAt ?? null,
        problem,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
