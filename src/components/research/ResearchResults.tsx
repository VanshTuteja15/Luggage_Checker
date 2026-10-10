"use client";

/* ------------------------------------------------------------------ */
/*  Verified prices: live per-store progress, products, every price    */
/*  with its freshness label and source link, "couldn't verify at      */
/*  <store>" rows, and Re-verify now.                                   */
/* ------------------------------------------------------------------ */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  BookmarkCheck,
  BookmarkPlus,
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Clock,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShoppingBag,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/format";
import { SIZE_LABELS, luggagePack, type SizeClass } from "@/lib/engine/packs/luggage";
import {
  compareOffers,
  freshnessLabel,
  groupOffers,
  rankProducts,
} from "@/lib/engine/research/answer";
import { haystackFor, matchScore } from "@/lib/engine/store/terms";
import type {
  AnswerOffer,
  AnswerProduct,
  StoreStatusRow,
  StoreTaskState,
} from "@/lib/engine/types";
import type { ResearchView } from "@/lib/research-client";
import { retailerColor } from "@/lib/retailers";
import { cn } from "@/lib/utils";
import { toSearchProduct } from "./track";

export type ResearchSort = "price-asc" | "price-desc" | "stores";
type View = "products" | "stores";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

const STATE_TEXT: Record<StoreTaskState, string> = {
  pending: "Waiting",
  running: "Checking…",
  verified: "Verified",
  no_match: "Not found",
  blocked: "Blocked",
  not_permitted: "Not permitted",
  not_configured: "Not set up",
  timed_out: "Timed out",
  error: "Couldn't read",
  link_only: "Link only",
};

function StateIcon({ state, className }: { state: StoreTaskState; className?: string }) {
  const c = cn("h-3.5 w-3.5 shrink-0", className);
  switch (state) {
    case "running":
    case "pending":
      return <Loader2 className={cn(c, state === "running" && "animate-spin")} aria-hidden />;
    case "verified":
      return <CheckCircle2 className={cn(c, "text-success")} aria-hidden />;
    case "blocked":
    case "not_permitted":
      return <ShieldAlert className={cn(c, "text-danger")} aria-hidden />;
    case "link_only":
      return <Link2 className={cn(c, "text-muted-foreground")} aria-hidden />;
    case "timed_out":
      return <Clock className={cn(c, "text-warning")} aria-hidden />;
    case "error":
      return <XCircle className={cn(c, "text-danger")} aria-hidden />;
    default:
      return <CircleSlash className={cn(c, "text-muted-foreground")} aria-hidden />;
  }
}

export function FreshnessBadge({ offer }: { offer: AnswerOffer }) {
  const kind = offer.freshness.kind;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        kind === "live" && "bg-success-soft text-success",
        (kind === "feed" || kind === "manual") && "bg-primary-soft text-primary",
        kind === "stale" && "bg-warning-soft text-warning",
      )}
    >
      {kind === "stale" ? <Clock className="h-3 w-3" aria-hidden /> : null}
      {freshnessLabel(offer.freshness)}
    </span>
  );
}

/* ── progress ─────────────────────────────────────────────────────── */

function StoreProgress({
  rows,
  status,
}: {
  rows: StoreStatusRow[];
  status: ResearchView["status"];
}) {
  // Shoppers see only what was checked and verified. Why a store couldn't be
  // read (blocked, terms, not connected) is internal: see /admin → Sources.
  const running = status === "running" || status === "starting";
  const verified = rows.filter((r) => r.state === "verified");
  const shown = rows.filter(
    (r) => r.state === "verified" || (running && (r.state === "running" || r.state === "pending")),
  );
  if (!running && verified.length === 0) return null;
  return (
    <div className="mb-4 rounded-xl border border-border bg-card p-3">
      <p role="status" aria-live="polite" className="mb-2 text-xs text-muted-foreground">
        {running
          ? `Checking stores live… ${verified.length} verified so far`
          : `Prices verified live at ${verified.length} store${verified.length === 1 ? "" : "s"}`}
      </p>
      <ul className="flex flex-wrap gap-1.5" aria-label="Store progress">
        {shown.map((r) => (
          <li
            key={r.sourceId}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11px]"
          >
            <StateIcon state={r.state} />
            <span>{r.retailer}</span>
            <span className="sr-only">: {STATE_TEXT[r.state]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── products ─────────────────────────────────────────────────────── */

function OfferLine({ offer, position }: { offer: AnswerOffer; position: number }) {
  return (
    <li className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          {position}
        </span>
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: retailerColor(offer.retailer) }}
          aria-hidden
        />
        <span className="truncate font-medium">{offer.retailer}</span>
        {offer.colour && <span className="truncate text-muted-foreground">· {offer.colour}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-7 sm:pl-0">
        <FreshnessBadge offer={offer} />
        {offer.availability === "out_of_stock" && (
          <span className="rounded bg-danger-soft px-1.5 py-0.5 text-[11px] text-danger">
            Out of stock
          </span>
        )}
        {offer.lowConfidence && (
          <span
            className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-[11px] text-warning"
            title={offer.reasons.join("; ")}
          >
            <AlertTriangle className="h-3 w-3" aria-hidden /> Check:{" "}
            {offer.reasons[0] ?? "low confidence"}
          </span>
        )}
        <span
          className={cn(
            "w-20 text-right tabular-nums",
            offer.freshness.kind === "stale"
              ? "text-muted-foreground line-through decoration-1"
              : "font-semibold",
          )}
          title={offer.evidence ?? undefined}
        >
          {usd(offer.price)}
        </span>
        <a
          href={offer.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "inline-flex items-center gap-1 text-xs text-primary hover:underline",
            FOCUS,
          )}
          aria-label={`Open ${offer.retailer}'s page (source of this price)`}
        >
          Source <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
    </li>
  );
}

function ProductCard({
  product,
  rank,
  tracked,
  onTrack,
  trackPending,
}: {
  product: AnswerProduct;
  rank: number;
  tracked: boolean;
  onTrack: (p: AnswerProduct) => void;
  trackPending: boolean;
}) {
  const [open, setOpen] = useState(rank === 0);
  const current = product.offers.filter((o) => o.freshness.kind !== "stale");
  const best = current[0];
  const trackable = !!toSearchProduct(product);
  const size =
    product.sizeClass && product.sizeClass in SIZE_LABELS
      ? SIZE_LABELS[product.sizeClass as SizeClass]
      : null;

  return (
    <article
      className="rounded-xl border border-border bg-card"
      aria-labelledby={`p-${product.key}`}
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl}
              alt=""
              className="h-full w-full object-contain p-1"
              loading="lazy"
            />
          ) : (
            <ShoppingBag className="h-6 w-6 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={`p-${product.key}`} className="line-clamp-2 text-sm font-medium leading-snug">
            {product.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[product.brand, size].filter(Boolean).join(" · ")}
            {product.identifiers.find((i) => i.kind === "gtin")
              ? ` · UPC ${product.identifiers.find((i) => i.kind === "gtin")!.value.replace(/^0+(?=\d{12})/, "")}`
              : ""}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {new Set(current.map((o) => o.sourceId)).size} store
            {new Set(current.map((o) => o.sourceId)).size === 1 ? "" : "s"} with a current price
          </p>
        </div>
        <div className="flex shrink-0 items-start justify-between gap-3 sm:flex-col sm:items-end">
          <div className="sm:text-right">
            {best ? (
              <>
                <p className="text-lg font-bold leading-tight">{usd(best.price)}</p>
                <p className="text-[11px] text-muted-foreground">at {best.retailer}</p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No current price</p>
            )}
          </div>
          <Button
            variant={tracked ? "outline" : "default"}
            size="sm"
            className="h-8 gap-1.5 text-xs"
            disabled={tracked || trackPending || !trackable}
            onClick={() => onTrack(product)}
            title={trackable ? undefined : "Only current prices can be tracked"}
          >
            {trackPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : tracked ? (
              <BookmarkCheck className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
            )}
            {tracked ? "Tracked" : "Track"}
          </Button>
        </div>
      </div>
      <div className="border-t border-border px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "flex w-full items-center justify-between py-2 text-xs font-medium text-primary",
            FOCUS,
          )}
        >
          {open ? "Hide" : "Show"} all {product.offers.length} price
          {product.offers.length === 1 ? "" : "s"}, cheapest first
          <ChevronDown
            className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
        {open && (
          <ul className="divide-y divide-border pb-2">
            {product.offers.map((o, i) => (
              <OfferLine key={`${o.url}-${i}`} offer={o} position={i + 1} />
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function AllStores({ products, sort }: { products: AnswerProduct[]; sort: ResearchSort }) {
  const rows = useMemo(() => {
    const list = products.flatMap((p) => p.offers.map((o) => ({ o, p })));
    return list.sort((a, b) => (sort === "price-desc" ? -1 : 1) * compareOffers(a.o, b.o));
  }, [products, sort]);
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card px-4">
      {rows.map(({ o, p }, i) => (
        <li key={`${o.url}-${i}`} className="py-1">
          <p className="truncate pl-7 pt-1 text-[11px] text-muted-foreground">{p.name}</p>
          <ul>
            <OfferLine offer={o} position={i + 1} />
          </ul>
        </li>
      ))}
    </ul>
  );
}

/* ── other stores (links only, no reasons) ─────────────────────── */

function OtherStores({ rows }: { rows: StoreStatusRow[] }) {
  const links = rows.filter((r) => !!r.url);
  if (links.length === 0) return null;
  return (
    <section
      className="mt-5 rounded-xl border border-border bg-card px-4 py-3"
      aria-labelledby="other-stores"
    >
      <h2 id="other-stores" className="mb-2 text-xs font-medium text-muted-foreground">
        Also compare at these stores
      </h2>
      <ul className="flex flex-wrap gap-1.5">
        {links.map((r) => (
          <li key={r.sourceId}>
            <a
              href={r.url!}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted",
                FOCUS,
              )}
              aria-label={`Search ${r.retailer} for this product (opens their site)`}
            >
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: retailerColor(r.retailer) }}
                aria-hidden
              />
              {r.retailer}
              <ExternalLink className="h-3 w-3 text-muted-foreground" aria-hidden />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ── the whole view ───────────────────────────────────────────────── */

export function ResearchResults({
  view,
  sort,
  onSort,
  onReverify,
  onCancel,
  onTrack,
  trackedKeys,
  trackPending,
}: {
  view: ResearchView;
  sort: ResearchSort;
  onSort: (s: ResearchSort) => void;
  onReverify: () => void;
  onCancel: () => void;
  onTrack: (p: AnswerProduct) => void;
  trackedKeys: Set<string>;
  trackPending: boolean;
}) {
  const [tab, setTab] = useState<View>("products");
  const rows = useMemo(
    () => Object.values(view.rows).sort((a, b) => a.retailer.localeCompare(b.retailer)),
    [view.rows],
  );

  const products = useMemo(() => {
    const parsed = luggagePack.parseQuery(view.query);
    const base =
      view.answer?.products ??
      rankProducts(groupOffers(view.offers, luggagePack), (p) =>
        matchScore(
          parsed,
          haystackFor({ brand: p.brand, title: p.name, identifiers: p.identifiers }),
          p.sizeClass,
        ),
      );
    if (sort === "price-asc") return base;
    return [...base].sort((a, b) =>
      sort === "price-desc"
        ? (b.lowestPrice ?? -1) - (a.lowestPrice ?? -1)
        : new Set(b.offers.map((o) => o.sourceId)).size -
          new Set(a.offers.map((o) => o.sourceId)).size,
    );
  }, [view.answer, view.offers, view.query, sort]);

  const unverified = rows.filter(
    (r) => r.state !== "verified" && r.state !== "running" && r.state !== "pending",
  );
  const running = view.status === "running" || view.status === "starting";
  const answer = view.answer;

  return (
    <div className="mx-auto max-w-4xl">
      {rows.length > 0 && <StoreProgress rows={rows} status={view.status} />}

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {products.length} product{products.length === 1 ? "" : "s"} ·{" "}
          {products.reduce((n, p) => n + p.offers.length, 0)} price
          {products.reduce((n, p) => n + p.offers.length, 0) === 1 ? "" : "s"}
          {answer && (
            <>
              {" "}
              · first price{" "}
              {answer.firstPriceMs !== null ? `${(answer.firstPriceMs / 1000).toFixed(1)} s` : "—"},
              done in {(answer.totalMs / 1000).toFixed(1)} s
            </>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onCancel}>
              Stop
            </Button>
          ) : (
            view.sessionId && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-xs"
                onClick={onReverify}
                aria-label="Re-verify these prices now"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Re-verify now
              </Button>
            )
          )}
          <div
            className="inline-flex rounded-lg border border-border bg-card p-0.5 text-xs"
            role="group"
            aria-label="View"
          >
            {(["products", "stores"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={tab === t}
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-md px-2.5 py-1",
                  tab === t ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
                  FOCUS,
                )}
              >
                {t === "products" ? "By product" : "All stores"}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
            <span className="sr-only">Sort</span>
            <select
              value={sort}
              onChange={(e) => onSort(e.target.value as ResearchSort)}
              className={cn("bg-transparent text-foreground", FOCUS)}
            >
              <option value="price-asc">Price: low to high</option>
              <option value="price-desc">Price: high to low</option>
              <option value="stores">Most stores</option>
            </select>
          </label>
        </div>
      </div>

      {view.status === "error" && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {view.error}
        </p>
      )}
      {view.status === "cancelled" && (
        <p className="mb-3 text-sm text-muted-foreground">
          Stopped. Prices found so far are shown.
        </p>
      )}
      {answer?.deadlineHit && (
        <p className="mb-3 text-xs text-muted-foreground">
          Showing the prices found within {Math.round((answer.totalMs ?? 0) / 1000)} seconds. Press
          Re-verify now to check again.
        </p>
      )}

      {products.length === 0 && !running ? (
        <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
          No verified price for &ldquo;{view.query}&rdquo; yet. Try a shorter or different product
          name, or compare at the stores below.
        </p>
      ) : tab === "products" ? (
        <div className="space-y-3">
          {products.map((p, i) => (
            <ProductCard
              key={p.key}
              product={p}
              rank={i}
              tracked={trackedKeys.has(p.key)}
              onTrack={onTrack}
              trackPending={trackPending}
            />
          ))}
        </div>
      ) : (
        <AllStores products={products} sort={sort} />
      )}

      <OtherStores rows={unverified} />

      {products.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          Prices are each store&rsquo;s listed price in Canadian dollars, before GST/HST and
          shipping, as read at the time shown.
        </p>
      )}
    </div>
  );
}
