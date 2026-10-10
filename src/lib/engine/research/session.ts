/* ------------------------------------------------------------------ */
/*  Research session runner                                           */
/*                                                                     */
/*  One user request for current prices:                               */
/*    1. plan    — which stores can be checked, how, and which listings */
/*                 (from the index: zero external requests)            */
/*    2. run     — every store in parallel; the host limiter keeps each */
/*                 store polite; identical verifications within 90 s   */
/*                 are shared (single-flight)                          */
/*    3. answer  — at the deadline (10–12 s) or when all stores finish. */
/*                 Stores still working are reported as timed out; any  */
/*                 late reading is stored as evidence but never added   */
/*                 to the finished answer.                             */
/*  Events stream out as they happen (store_started, store_offers,     */
/*  store_done), so the page shows fast stores first.                  */
/* ------------------------------------------------------------------ */

import { ADAPTERS, type AdapterContext, type AdapterResult, type ListingRef } from "../adapters";
import { canonicalUrl } from "../adapters/base";
import { discoverViaTavily } from "../discovery";
import { flagOn } from "../flags";
import type { SingleFlight } from "../politeness/singleflight";
import type { EngineRuntime } from "../recorder";
import {
  LIVE_ADAPTERS,
  checkRoutes,
  linkOnlyUrl,
  unverifiableReason,
  type RouteContext,
} from "../registry";
import { haystackFor, matchScore } from "../store/terms";
import type {
  AdapterId,
  AnswerOffer,
  CategoryPack,
  Freshness,
  ListingRecord,
  Observation,
  ParsedQuery,
  RawOffer,
  ResearchAnswer,
  ResearchSessionRecord,
  RouteSpec,
  SessionEvent,
  SessionEventType,
  SourceRecord,
  StoreStatusRow,
  StoreTaskState,
} from "../types";
import { referencePrices, type EstimateRequest, type EstimateResult } from "../estimates/run";
import { expectedFromQuery } from "../estimates/validate";
import { resolveListing } from "../identity/resolve";
import { observeOffer } from "../observe";
import type { ExpectedIdentity } from "../validate";
import { groupOffers, rankProducts } from "./answer";

export type SessionRunDeps = {
  rt: EngineRuntime;
  pack: CategoryPack;
  /** Process-wide single-flight for verifications (90 s window). */
  shared: SingleFlight<AdapterResult>;
  /** Called synchronously for every event (in-process subscribers). */
  onEvent?: (e: SessionEvent) => void;
  signal?: AbortSignal;
  /** Polled every 500 ms; true cancels the session. */
  isCancelled?: () => Promise<boolean>;
  maxPagesPerStore?: number;
  now?: () => number;
  /**
   * Web estimates (R3) for the stores we can't read live. Absent = none
   * (tests, scripts); the server and worker pass the real finder.
   */
  estimates?: (req: EstimateRequest) => Promise<EstimateResult>;
};

const STALE_WINDOW_MS = 30 * 86_400_000;
const SEARCH_ADAPTERS: ReadonlySet<AdapterId> = new Set([
  "shopify_ucp",
  "ebay_browse_api",
  "amazon_creators_api",
]);

class EventWriter {
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    private readonly rt: EngineRuntime,
    private readonly sessionId: string,
    private readonly onEvent?: (e: SessionEvent) => void,
  ) {}

  emit(type: SessionEventType, sourceId: string | null, payload: Record<string, unknown>): void {
    const e: SessionEvent = {
      sessionId: this.sessionId,
      seq: ++this.seq,
      type,
      sourceId,
      payload,
      createdAt: new Date().toISOString(),
    };
    try {
      this.onEvent?.(e);
    } catch {
      /* a subscriber's problem never breaks the session */
    }
    // Persist in order (Realtime and the NDJSON stream read these rows).
    this.chain = this.chain.then(() => this.rt.store.appendEvent(e)).catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.chain;
  }
}

function expectedFrom(q: ParsedQuery): ExpectedIdentity {
  return { gtin: q.gtin, sizeClass: q.sizeClass, brand: q.brand };
}

function answerUrl(source: SourceRecord, url: string, title: string): string {
  if (/^https:/.test(url)) return url;
  // Feed / manual rows without a public page: send the user to the store's search.
  return linkOnlyUrl(source, title) ?? (source.marketHost ? `https://${source.marketHost}/` : url);
}

function evidenceLine(o: Pick<RawOffer, "adapter" | "evidence">): string {
  const e = o.evidence as Record<string, unknown>;
  const where =
    typeof e.request === "string"
      ? e.request
      : typeof e.endpoint === "string"
        ? e.endpoint
        : typeof e.feed === "string"
          ? `feed ${e.feed}`
          : "";
  const field =
    typeof e.field === "string"
      ? ` → ${e.field}`
      : typeof e.from === "string"
        ? ` (${e.from})`
        : "";
  return `${o.adapter}${where ? ` ${where}` : ""}${field}`.slice(0, 300);
}

function toAnswerOffer(
  source: SourceRecord,
  pack: CategoryPack,
  o: RawOffer,
  v: { outcome: string; confidence: number; reasons: string[] },
  freshness: Freshness,
  ids: { listingId: string | null; observationId: string | null; productId: string | null },
): AnswerOffer {
  return {
    sourceId: source.id,
    retailer: source.retailerLabel,
    url: answerUrl(source, o.url, o.title),
    title: o.title,
    brand: o.brand,
    sizeClass: pack.sizeClassOf([o.title, ...o.options].join(" ")),
    identifiers: o.identifiers,
    imageUrl: o.imageUrl,
    reasons: v.reasons,
    price: o.price as number,
    listPrice: o.listPrice,
    currency: "CAD",
    availability: o.availability,
    colour: o.colour,
    freshness,
    confidence: v.confidence,
    lowConfidence: v.outcome === "low_confidence",
    method: o.adapter,
    observationId: ids.observationId,
    listingId: ids.listingId,
    productId: ids.productId,
    evidence: evidenceLine(o),
  };
}

function offerFromObservation(
  source: SourceRecord,
  pack: CategoryPack,
  l: ListingRecord,
  obs: Observation,
  freshness: Freshness,
): AnswerOffer {
  return {
    sourceId: source.id,
    retailer: source.retailerLabel,
    url: answerUrl(source, l.url, l.title),
    title: l.title,
    brand: l.brand,
    sizeClass: l.sizeClass ?? pack.sizeClassOf(l.title),
    identifiers: l.identifiers,
    imageUrl: l.imageUrl,
    reasons: obs.validation.reasons,
    price: obs.price,
    listPrice: obs.listPrice,
    currency: "CAD",
    availability: obs.availability,
    colour: l.colour,
    freshness,
    confidence: obs.validation.confidence,
    lowConfidence: obs.validation.outcome === "low_confidence",
    method: obs.adapter,
    observationId: obs.id,
    listingId: l.id,
    productId: l.productId,
    evidence:
      `${obs.adapter} ${String((obs.evidence as Record<string, unknown>).request ?? "")}`.trim(),
  };
}

const STATE_FOR: Record<string, StoreTaskState> = {
  ok: "verified",
  not_found: "no_match",
  blocked: "blocked",
  not_permitted: "not_permitted",
  not_configured: "not_configured",
  timeout: "timed_out",
  error: "error",
  garbage: "error",
};

const MESSAGE_FOR: Partial<Record<StoreTaskState, string>> = {
  verified: "verified live",
  no_match: "no matching product at this store",
  blocked: "the store refused our request",
  not_permitted: "not permitted (robots.txt or policy)",
  timed_out: "still checking when time ran out",
  error: "couldn't read a price",
};

export async function runResearchSession(
  sessionId: string,
  deps: SessionRunDeps,
): Promise<ResearchAnswer | null> {
  const { rt, pack } = deps;
  const store = rt.store;
  const now = deps.now ?? Date.now;

  const session = await store.getSession(sessionId);
  if (!session || session.status !== "queued") return session?.answer ?? null;

  const started = now();
  const startedIso = new Date(started).toISOString();
  await store.updateSession(sessionId, { status: "running", startedAt: startedIso });
  const writer = new EventWriter(rt, sessionId, deps.onEvent);
  const parsed = pack.parseQuery(session.query);
  const deadlineAt = started + session.deadlineMs;
  writer.emit("session_started", null, {
    query: session.query,
    deadlineMs: session.deadlineMs,
    parsed,
  });

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  deps.signal?.addEventListener("abort", onOuterAbort, { once: true });

  try {
    const flags = await rt.flags();
    if (!flagOn(flags, "engine.enabled"))
      throw new Error("the price engine is switched off (engine.enabled)");

    /* ── plan ─────────────────────────────────────────────────────── */
    const [sources, feedSources, manualSources] = await Promise.all([
      rt.sources(),
      store.sourcesWithAdapter("feed_import"),
      store.sourcesWithAdapter("manual_entry"),
    ]);
    const routeCtx: RouteContext = { flags, config: rt.config, feedSources, manualSources };
    const candidates = await planListings(session, parsed, deps);
    const bySource = new Map<string, ListingRecord[]>();
    for (const l of candidates) bySource.set(l.sourceId, [...(bySource.get(l.sourceId) ?? []), l]);

    const rows = new Map<string, StoreStatusRow>();
    const tasks: { sourceId: string; run: () => Promise<void> }[] = [];
    const collected: AnswerOffer[] = [];
    let firstPriceMs: number | null = null;
    let finished = false;
    // Listings seen for the first time this session: resolved to catalog
    // products in the background, after their prices are already shown.
    const toResolve: ListingRecord[] = [];
    let resolving: Promise<void> = Promise.resolve();
    const drainResolve = () => {
      const batch = toResolve.splice(0);
      if (batch.length === 0) return;
      resolving = resolving.then(async () => {
        for (const l of batch) await resolveListing(store, pack, l).catch(() => undefined);
      });
    };

    const setRow = (row: StoreStatusRow, emit: boolean) => {
      if (finished) return;
      rows.set(row.sourceId, row);
      if (emit) writer.emit("store_done", row.sourceId, { row });
    };
    const addOffers = (sourceId: string, offers: AnswerOffer[]) => {
      if (finished || offers.length === 0) return;
      collected.push(...offers);
      if (firstPriceMs === null && offers.some((o) => o.freshness.kind === "live"))
        firstPriceMs = now() - started;
      writer.emit("store_offers", sourceId, { offers });
    };

    const active = sources.filter(
      (s) =>
        s.status === "active" &&
        s.enabled &&
        (!session.storeIds || session.storeIds.includes(s.id)),
    );
    for (const source of active) {
      const checks = checkRoutes(source, routeCtx);
      const live = checks
        .filter((c) => c.usable && !c.route.crossCheckOnly && LIVE_ADAPTERS.has(c.route.adapter))
        .map((c) => c.route);
      const stored = checks
        .filter(
          (c) =>
            c.usable && (c.route.adapter === "feed_import" || c.route.adapter === "manual_entry"),
        )
        .map((c) => c.route);
      const listings = bySource.get(source.id) ?? [];
      const link = linkOnlyUrl(source, session.query);
      const base = {
        sourceId: source.id,
        retailer: source.retailerLabel,
        url: link,
        durationMs: null,
      };

      if (live.length && listings.length) {
        rows.set(source.id, { ...base, state: "pending", message: "queued" });
        tasks.push({ sourceId: source.id, run: () => verifyStore(source, live, listings) });
      } else if (live.some((r) => SEARCH_ADAPTERS.has(r.adapter) && ADAPTERS[r.adapter].search)) {
        rows.set(source.id, { ...base, state: "pending", message: "queued" });
        tasks.push({
          sourceId: source.id,
          run: () =>
            searchStore(
              source,
              live.filter((r) => SEARCH_ADAPTERS.has(r.adapter)),
              listings,
            ),
        });
      } else if (stored.length && listings.length) {
        rows.set(source.id, { ...base, state: "pending", message: "queued" });
        tasks.push({ sourceId: source.id, run: () => storedStore(source, listings) });
      } else if (live.length) {
        rows.set(source.id, {
          ...base,
          state: "no_match",
          message: "not in our product index yet",
        });
      } else if (source.liveClass === "none") {
        rows.set(source.id, {
          ...base,
          url: null,
          state: "link_only",
          message: `${source.retailerLabel} doesn't publish prices online`,
        });
      } else if (source.permission === "forbidden" || source.liveClass === "not_permitted") {
        rows.set(source.id, {
          ...base,
          state: "link_only",
          message: `${unverifiableReason(source, routeCtx)}: check the price on their site`,
        });
      } else if (source.liveClass === "blocked") {
        rows.set(source.id, {
          ...base,
          state: "blocked",
          message: unverifiableReason(source, routeCtx),
        });
      } else {
        rows.set(source.id, {
          ...base,
          state: "not_configured",
          message: unverifiableReason(source, routeCtx),
        });
      }
    }
    writer.emit("plan", null, { stores: [...rows.values()] });

    // Stores with no live route get a web estimate try (R3), if switched on.
    const estimateStores =
      deps.estimates && flagOn(flags, "estimates.web")
        ? active.filter((s) => {
            const r = rows.get(s.id);
            return (
              !!r &&
              (r.state === "link_only" || r.state === "blocked" || r.state === "not_configured") &&
              s.allowedDomains.length > 0
            );
          })
        : [];

    /* ── per-store tasks ──────────────────────────────────────────── */

    function ctxFor(source: SourceRecord): AdapterContext {
      return {
        source,
        fetcher: rt.fetcher,
        config: rt.config,
        pack,
        now,
        signal: controller.signal,
        deadlineAt,
        sessionId,
      };
    }

    function begin(source: SourceRecord): number {
      const t = now();
      if (!finished) {
        rows.set(source.id, {
          ...(rows.get(source.id) as StoreStatusRow),
          state: "running",
          message: "checking",
        });
        writer.emit("store_started", source.id, {});
      }
      return t;
    }

    function finish(
      source: SourceRecord,
      t0: number,
      state: StoreTaskState,
      message: string | null,
    ) {
      setRow(
        {
          sourceId: source.id,
          retailer: source.retailerLabel,
          state,
          message: message ?? MESSAGE_FOR[state] ?? state,
          url: state === "verified" ? null : linkOnlyUrl(source, session!.query),
          durationMs: now() - t0,
        },
        true,
      );
    }

    /** Validate, store and convert one adapter result. Late readings are stored, not shown. */
    async function record(
      source: SourceRecord,
      res: AdapterResult,
      shared: boolean,
      discoveredVia: ListingRecord["discoveredVia"],
      parent: ListingRecord | null,
    ): Promise<AnswerOffer[]> {
      const out: AnswerOffer[] = [];
      for (const o of res.offers) {
        // Identity is resolved after the prices are on screen (below), not before.
        const {
          listing,
          validation: v,
          observationId,
        } = await observeOffer(store, pack, source, o, {
          sessionId,
          discoveredVia,
          parent,
          expected: expectedFrom(parsed),
          persist: !shared,
          resolve: false,
          now: now(),
        });
        if (v.outcome !== "rejected" && o.price !== null) {
          out.push(
            toAnswerOffer(
              source,
              pack,
              o,
              v,
              { kind: "live", fetchedAt: o.fetchedAt },
              { listingId: listing.id, observationId, productId: listing.productId },
            ),
          );
          if (!listing.productId) toResolve.push(listing);
        }
      }
      return out;
    }

    /** Primary route, then at most one alternate when the first fails or yields nothing showable. */
    async function verifyPage(
      source: SourceRecord,
      routes: RouteSpec[],
      page: ListingRecord,
    ): Promise<{ status: string; message: string | null; offers: AnswerOffer[] }> {
      let last: { status: string; message: string | null; offers: AnswerOffer[] } = {
        status: "error",
        message: null,
        offers: [],
      };
      for (const route of routes.slice(0, 2)) {
        const adapter = ADAPTERS[route.adapter];
        const ref: ListingRef = {
          url: page.url,
          externalId: page.externalId,
          identifiers: page.identifiers,
          title: page.title,
          brand: page.brand,
        };
        const key = `${route.adapter}:${canonicalUrl(page.url)}`;
        const { value, shared } = await deps.shared.run(
          key,
          () => adapter.verify(ctxFor(source), ref),
          (r) => r.status === "ok",
        );
        if (value.status === "ok") {
          const offers = await record(source, value, shared, page.discoveredVia, page);
          if (offers.length) return { status: "ok", message: null, offers };
          last = { status: "error", message: "every reading failed validation", offers: [] };
          continue;
        }
        last = { status: value.status, message: value.message, offers: [] };
        if (value.status === "blocked") break; // a refusal isn't retried another way this session
      }
      return last;
    }

    async function verifyStore(
      source: SourceRecord,
      routes: RouteSpec[],
      listings: ListingRecord[],
    ): Promise<void> {
      const t0 = begin(source);
      // Variant listings share one product page: verify each page once.
      const pages = new Map<string, ListingRecord>();
      for (const l of listings) {
        const k = /^https:/.test(l.url) ? canonicalUrl(l.url) : l.url;
        if (!pages.has(k)) pages.set(k, l);
      }
      const perPageMs = source.crawlDelaySec * 1000 + 500;
      const budget = Math.max(1, Math.floor((deadlineAt - now()) / perPageMs));
      const plan = [...pages.values()].slice(0, Math.min(budget, deps.maxPagesPerStore ?? 4));

      let shown = 0;
      let lastStatus = "no_match";
      let lastMessage: string | null = null;
      for (const page of plan) {
        if (controller.signal.aborted) break;
        const r = await verifyPage(source, routes, page);
        lastStatus = r.status;
        lastMessage = r.message;
        if (r.offers.length) {
          shown += r.offers.length;
          addOffers(source.id, r.offers);
          drainResolve();
        }
        if (r.status === "blocked") break;
      }
      if (shown === 0) await addStale(source, listings);
      const state = shown ? "verified" : (STATE_FOR[lastStatus] ?? "error");
      finish(
        source,
        t0,
        state,
        shown ? `verified live (${shown} price${shown === 1 ? "" : "s"})` : lastMessage,
      );
    }

    async function searchStore(
      source: SourceRecord,
      routes: RouteSpec[],
      listings: ListingRecord[],
    ): Promise<void> {
      const t0 = begin(source);
      let lastStatus = "no_match";
      let lastMessage: string | null = null;
      for (const route of routes.slice(0, 2)) {
        const adapter = ADAPTERS[route.adapter];
        if (!adapter.search) continue;
        const key = `${route.adapter}:search:${source.id}:${parsed.tokens.join(" ")}`;
        const { value, shared } = await deps.shared.run(
          key,
          () => adapter.search!(ctxFor(source), parsed, 10),
          (r) => r.status === "ok",
        );
        if (value.status !== "ok") {
          lastStatus = value.status;
          lastMessage = value.message;
          if (value.status === "blocked") break;
          continue;
        }
        // Only offers that actually match the query are kept (and indexed).
        const relevant = value.offers.filter(
          (o) =>
            matchScore(
              parsed,
              haystackFor({ brand: o.brand, title: o.title, identifiers: o.identifiers }),
              pack.sizeClassOf(o.title),
            ) > 0,
        );
        const offers = await record(
          source,
          { ...value, offers: relevant },
          shared,
          "live_search",
          null,
        );
        if (offers.length) {
          addOffers(source.id, offers);
          drainResolve();
          finish(
            source,
            t0,
            "verified",
            `verified live (${offers.length} price${offers.length === 1 ? "" : "s"})`,
          );
          return;
        }
        lastStatus = "not_found";
        lastMessage = "no matching product at this store";
      }
      await addStale(source, listings);
      finish(source, t0, STATE_FOR[lastStatus] ?? "error", lastMessage);
    }

    /** Feed and manual prices: no network, always labelled with their date. */
    async function storedStore(source: SourceRecord, listings: ListingRecord[]): Promise<void> {
      const t0 = begin(source);
      const offers: AnswerOffer[] = [];
      for (const l of listings) {
        const obs = await store.latestObservation(l.id, { shownOnly: true });
        if (!obs || (obs.adapter !== "feed_import" && obs.adapter !== "manual_entry")) continue;
        const date = obs.asOf ?? obs.fetchedAt;
        offers.push(
          offerFromObservation(
            source,
            pack,
            l,
            obs,
            obs.adapter === "feed_import"
              ? { kind: "feed", asOf: date }
              : { kind: "manual", checkedAt: date },
          ),
        );
      }
      addOffers(source.id, offers);
      finish(
        source,
        t0,
        offers.length ? "verified" : "no_match",
        offers.length ? "from a dealer feed / manual check (dated)" : "no matching product on file",
      );
    }

    /** A store we couldn't check now: show its last accepted price, clearly marked not current. */
    async function addStale(source: SourceRecord, listings: ListingRecord[]): Promise<void> {
      const stale: AnswerOffer[] = [];
      for (const l of listings.slice(0, 6)) {
        const obs = await store.latestObservation(l.id, { shownOnly: true });
        if (
          !obs ||
          // Only prices we read ourselves come back as "last seen"; an estimate stays an estimate.
          obs.adapter === "web_estimate" ||
          obs.adapter === "tracked_record" ||
          !LIVE_ADAPTERS.has(obs.adapter) ||
          now() - Date.parse(obs.fetchedAt) > STALE_WINDOW_MS
        )
          continue;
        stale.push(
          offerFromObservation(source, pack, l, obs, { kind: "stale", lastSeenAt: obs.fetchedAt }),
        );
      }
      addOffers(source.id, stale);
    }

    /* ── run under the deadline ───────────────────────────────────── */

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const cancelledP = new Promise<"cancelled">((resolve) => {
      if (deps.signal?.aborted) return resolve("cancelled");
      deps.signal?.addEventListener("abort", () => resolve("cancelled"), { once: true });
      if (deps.isCancelled) {
        pollTimer = setInterval(() => {
          void deps.isCancelled!().then((c) => {
            if (c) resolve("cancelled");
          });
        }, 500);
      }
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    const deadlineP = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(() => resolve("deadline"), Math.max(0, deadlineAt - now()));
    });
    const liveP = Promise.allSettled(
      tasks.map((t) =>
        t.run().catch((err: unknown) => {
          const row = rows.get(t.sourceId);
          if (row)
            setRow(
              {
                ...row,
                state: "error",
                message: err instanceof Error ? err.message.slice(0, 200) : "failed",
                durationMs: now() - started,
              },
              true,
            );
        }),
      ),
    );

    // Web estimates: the search starts now, alongside the stores; judging the
    // results waits for the verified prices (or the deadline) so rule d can
    // compare against them. Estimates that arrive after the answer is frozen
    // are stored, not added.
    const estimateP = (async () => {
      if (!deps.estimates || estimateStores.length === 0) return;
      writer.emit("estimates_started", null, { stores: estimateStores.length });
      const expected = expectedFromQuery(parsed);
      try {
        const res = await deps.estimates({
          purpose: "interactive",
          query: session.query,
          expected,
          stores: estimateStores,
          sessionId,
          timeoutMs: Math.max(1_500, deadlineAt - now() - 1_500),
          references: async () => {
            await Promise.race([
              liveP,
              new Promise((r) => setTimeout(r, Math.max(0, deadlineAt - now() - 1_200))),
            ]);
            return referencePrices(
              store,
              pack,
              expected,
              collected.filter((o) => o.freshness.kind !== "estimate"),
              now(),
            );
          },
        });
        const bySource = new Map<string, AnswerOffer[]>();
        for (const o of res.offers)
          bySource.set(o.sourceId, [...(bySource.get(o.sourceId) ?? []), o]);
        for (const [sourceId, offers] of bySource) addOffers(sourceId, offers);
        if (!finished)
          writer.emit("estimates_done", null, {
            accepted: res.accepted,
            rejected: res.rejected,
            fromCache: res.fromCache,
            skipped: res.skipped,
          });
      } catch {
        if (!finished)
          writer.emit("estimates_done", null, { accepted: 0, rejected: 0, skipped: "error" });
      }
    })();

    const allP = Promise.all([liveP, estimateP]).then(() => "done" as const);

    const outcome = await Promise.race([allP, deadlineP, cancelledP]);
    if (pollTimer) clearInterval(pollTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);

    if (outcome === "cancelled") {
      cancelled = true;
      finished = true;
      controller.abort();
      await store.updateSession(sessionId, {
        status: "cancelled",
        finishedAt: new Date(now()).toISOString(),
      });
      writer.emit("session_cancelled", null, {});
      await writer.flush();
      return null;
    }

    // Freeze the answer. Tasks still running carry on and store what they
    // read, but nothing more reaches this answer or its event stream.
    const finalRows = [...rows.values()].map((r) =>
      r.state === "running" || r.state === "pending"
        ? {
            ...r,
            state: "timed_out" as const,
            message: MESSAGE_FOR.timed_out!,
            durationMs: now() - started,
          }
        : r,
    );
    for (const r of finalRows)
      if (rows.get(r.sourceId)?.state !== r.state)
        writer.emit("store_done", r.sourceId, { row: r });
    finished = true;

    const products = rankProducts(groupOffers(collected, pack), (p) =>
      matchScore(
        parsed,
        haystackFor({ brand: p.brand, title: p.name, identifiers: p.identifiers }),
        p.sizeClass,
      ),
    );
    const finishedAt = now();
    const answer: ResearchAnswer = {
      query: session.query,
      parsed,
      products,
      stores: finalRows.sort((a, b) => a.retailer.localeCompare(b.retailer)),
      startedAt: startedIso,
      finishedAt: new Date(finishedAt).toISOString(),
      firstPriceMs,
      totalMs: finishedAt - started,
      deadlineHit: outcome === "deadline",
      notes:
        candidates.length === 0
          ? [
              "Nothing in the product index matched; only stores with a live search channel were asked.",
            ]
          : [],
    };
    await store.updateSession(sessionId, { status: "done", finishedAt: answer.finishedAt, answer });
    writer.emit("session_done", null, { answer });
    await writer.flush();
    void rt.recorder.flush();
    void cancelled;
    return answer;
  } catch (err) {
    const message = err instanceof Error ? err.message : "research failed";
    await store
      .updateSession(sessionId, {
        status: "failed",
        finishedAt: new Date(now()).toISOString(),
        error: message.slice(0, 500),
      })
      .catch(() => undefined);
    writer.emit("session_failed", null, { error: message.slice(0, 300) });
    await writer.flush();
    return null;
  } finally {
    deps.signal?.removeEventListener("abort", onOuterAbort);
  }
}

/** Listings to verify: the parent session's (re-verify), else the index. */
async function planListings(
  session: ResearchSessionRecord,
  parsed: ParsedQuery,
  deps: SessionRunDeps,
): Promise<ListingRecord[]> {
  const store = deps.rt.store;
  if (session.parentSessionId) {
    const parent = await store.getSession(session.parentSessionId);
    const ids = [
      ...new Set(
        (parent?.answer?.products ?? [])
          .flatMap((p) => p.offers.map((o) => o.listingId))
          .filter((x): x is string => !!x),
      ),
    ];
    const listings = (
      await Promise.all(ids.slice(0, 200).map((id) => store.getListing(id)))
    ).filter((l): l is ListingRecord => !!l);
    if (listings.length) return listings;
  }
  // A query that states inches ("Nexis Large 28") skips listings that state another size.
  const fits = (l: ListingRecord) => {
    const n = parsed.inches ? deps.pack.inchesOf(l.title) : null;
    return !n || n === parsed.inches;
  };
  const found = (
    await store.searchListings(parsed, {
      limit: 150,
      sourceIds: session.storeIds ?? undefined,
    })
  ).filter(fits);
  if (found.length > 0) return found;
  // Nothing indexed: optional Tavily discovery (flag discovery.tavily) may add
  // listing URLs on verifiable stores; their prices are then read by us.
  const added = await discoverViaTavily(deps.rt, deps.pack, parsed);
  return added
    ? (
        await store.searchListings(parsed, { limit: 150, sourceIds: session.storeIds ?? undefined })
      ).filter(fits)
    : found;
}
