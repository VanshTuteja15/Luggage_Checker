/* ------------------------------------------------------------------ */
/*  Source health check (daily job)                                   */
/*                                                                     */
/*  One robots.txt read per store we're permitted to contact (and the   */
/*  /.well-known/ucp document for stores with an agent channel). Keeps  */
/*  the robots cache warm, refreshes block/circuit state, and gives     */
/*  /admin a daily heartbeat per source. Never touches stores whose     */
/*  terms forbid automated access: they have no storefront fetch host.  */
/* ------------------------------------------------------------------ */

import type { EngineRuntime } from "../recorder";
import type { FetchOutcome, SourceRecord } from "../types";

export type HealthCheckRow = { sourceId: string; robots: FetchOutcome | "skipped"; ucp: FetchOutcome | "skipped" | null };

const STOREFRONT_ROUTES = new Set(["shopify_ucp", "shopify_product_json", "html_structured"]);

function storefrontHost(s: SourceRecord): string | null {
  const host = s.marketHost && s.fetchHosts.includes(s.marketHost) ? s.marketHost : s.fetchHosts.find((h) => s.allowedDomains.includes(h));
  return host ?? null;
}

export async function checkSourceHealth(rt: EngineRuntime, opts: { sourceIds?: string[]; signal?: AbortSignal } = {}): Promise<HealthCheckRow[]> {
  const sources = (await rt.sources()).filter(
    (s) =>
      s.status === "active" &&
      s.enabled &&
      (!opts.sourceIds || opts.sourceIds.includes(s.id)) &&
      s.routes.some((r) => STOREFRONT_ROUTES.has(r.adapter)),
  );

  const rows = await Promise.all(
    sources.map(async (s): Promise<HealthCheckRow> => {
      const host = storefrontHost(s);
      if (!host) return { sourceId: s.id, robots: "skipped", ucp: null };
      const robots = await rt.fetcher.fetch({ source: s, url: `https://${host}/robots.txt`, adapter: "robots", signal: opts.signal, maxBytes: 512_000 });
      let ucp: HealthCheckRow["ucp"] = null;
      if (s.routes.some((r) => r.adapter === "shopify_ucp")) {
        const wk = await rt.fetcher.fetch({ source: s, url: `https://${host}/.well-known/ucp`, adapter: "shopify_ucp", signal: opts.signal, maxBytes: 200_000 });
        ucp = wk.outcome;
      }
      return { sourceId: s.id, robots: robots.outcome, ucp };
    }),
  );
  await rt.recorder.flush();
  return rows;
}
