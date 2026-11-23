/* ------------------------------------------------------------------ */
/*  Single-page reads (v4 A6.2, decision D5): OFF                       */
/*                                                                     */
/*  With `discovery.single_page_reads` on (the owner keeps it off,      */
/*  2026-10-30), one page of one candidate store whose probe passed     */
/*  (single_page_ok) may be read for a search: through the PoliteFetcher */
/*  (robots.txt honoured), within 3 s, labelled "Read once from <store> */
/*  · not reviewed yet", and without keeping its image. Nothing here is */
/*  stored. Not wired into searches: that waits until it is wanted.      */
/* ------------------------------------------------------------------ */

import { ADAPTERS } from "../adapters";
import { flagOn } from "../flags";
import type { EngineRuntime } from "../recorder";
import type { CategoryPack, RawOffer, SourceRecord } from "../types";

export const SINGLE_PAGE_BUDGET_MS = 3_000;

export const singlePageLabel = (store: string) => `Read once from ${store} · not reviewed yet`;

export type SinglePageRead = {
  status: "off" | "not_allowed" | "ok" | "failed";
  reason: string;
  offers: (RawOffer & { label: string })[];
};

function onOwnHost(source: SourceRecord, url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && source.fetchHosts.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** At most one page of one store per search (U-POLICY-2): the first one allowed. */
export function pickSinglePageRead(
  sources: SourceRecord[],
  found: { sourceId: string; url: string }[],
): { source: SourceRecord; url: string } | null {
  for (const f of found) {
    const s = sources.find((x) => x.id === f.sourceId);
    if (s?.discovery?.state === "single_page_ok" && onOwnHost(s, f.url))
      return { source: s, url: f.url };
  }
  return null;
}

export async function readOnce(
  rt: EngineRuntime,
  pack: CategoryPack,
  source: SourceRecord,
  url: string,
  opts: { signal?: AbortSignal } = {},
): Promise<SinglePageRead> {
  if (!flagOn(await rt.flags(), "discovery.single_page_reads"))
    return { status: "off", reason: "single-page reads are off", offers: [] };
  if (source.discovery?.state !== "single_page_ok")
    return { status: "not_allowed", reason: "this store's probe hasn't passed", offers: [] };
  if (!onOwnHost(source, url))
    return { status: "not_allowed", reason: "that page isn't on the store's own host", offers: [] };
  const signal = AbortSignal.any([
    AbortSignal.timeout(SINGLE_PAGE_BUDGET_MS),
    ...(opts.signal ? [opts.signal] : []),
  ]);
  const r = await ADAPTERS.html_structured.verify(
    {
      source,
      fetcher: rt.fetcher,
      config: rt.config,
      pack,
      now: Date.now,
      signal,
      deadlineAt: Date.now() + SINGLE_PAGE_BUDGET_MS,
      sessionId: null,
    },
    { url, externalId: null, identifiers: [], title: "", brand: null },
  );
  if (r.status !== "ok") return { status: "failed", reason: r.message ?? r.status, offers: [] };
  const label = singlePageLabel(source.name);
  return {
    status: "ok",
    reason: label,
    offers: r.offers.map((o) => ({ ...o, imageUrl: null, label })),
  };
}
