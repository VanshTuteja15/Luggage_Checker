"use client";

/* ------------------------------------------------------------------ */
/*  Search results: one search, lowest price first (R2, R6)           */
/*                                                                     */
/*  Each product shows its headline price (the lowest current price we */
/*  can stand behind) and one row per store: that store's lowest price, */
/*  the colours at that price, stock, the label saying where and when   */
/*  the price was found, and a link to the store's own page. Stores     */
/*  with no number appear only as "Also compare at" links.             */
/* ------------------------------------------------------------------ */

import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BookmarkCheck,
  BookmarkPlus,
  Clock,
  ExternalLink,
  Loader2,
  RefreshCw,
  ShoppingBag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/format";
import { SIZE_LABELS, luggagePack, type SizeClass } from "@/lib/engine/packs/luggage";
import { freshnessLabel, groupOffers, rankProducts } from "@/lib/engine/research/answer";
import {
  productViews,
  STOCK_TEXT,
  type ProductView,
  type StockState,
  type StoreRow,
} from "@/lib/engine/research/rows";
import { haystackFor, matchScore } from "@/lib/engine/store/terms";
import type { AnswerOffer, AnswerProduct, StoreStatusRow } from "@/lib/engine/types";
import type { ResearchView } from "@/lib/research-client";
import { retailerColor } from "@/lib/retailers";
import { cn } from "@/lib/utils";
import { toSearchProduct } from "./track";

export type ResearchSort = "price-asc" | "price-desc" | "stores";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

export function FreshnessBadge({ offer }: { offer: Pick<AnswerOffer, "freshness"> }) {
  const kind = offer.freshness.kind;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
        kind === "live" && "bg-success-soft text-success",
        (kind === "feed" || kind === "manual") && "bg-primary-soft text-primary",
        kind === "estimate" && "bg-warning-soft text-warning",
        kind === "stale" && "bg-muted text-muted-foreground",
      )}
    >
      {kind === "stale" ? <Clock className="h-3 w-3" aria-hidden /> : null}
      {freshnessLabel(offer.freshness)}
    </span>
  );
}

export function StockBadge({ stock }: { stock: StockState }) {
  return (
    <span
      className={cn(
        "inline-flex rounded px-1.5 py-0.5 text-[11px]",
        stock === "in_stock" && "text-success",
        stock === "out_of_stock" && "bg-danger-soft text-danger",
        stock === "unknown" && "text-muted-foreground",
      )}
    >
      {stock === "unknown" ? "Stock unknown" : STOCK_TEXT[stock]}
    </span>
  );
}

/* ── progress ─────────────────────────────────────────────────────── */

function StoreProgress({ rows, running }: { rows: StoreStatusRow[]; running: boolean }) {
  const checking = rows.filter((r) => r.state === "running" || r.state === "pending").length;
  const withPrice = rows.filter((r) => r.state === "verified").length;
  return (
    <p role="status" aria-live="polite" className="mb-3 text-sm text-muted-foreground">
      {running ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {checking > 0
            ? `Checking ${checking} more store${checking === 1 ? "" : "s"}…`
            : "Checking stores…"}
          {withPrice > 0 && ` ${withPrice} with a price so far.`}
        </span>
      ) : withPrice > 0 ? (
        `Prices from ${withPrice} store${withPrice === 1 ? "" : "s"}.`
      ) : null}
    </p>
  );
}

/* ── one store row ────────────────────────────────────────────────── */

function StoreRowLine({ row }: { row: StoreRow }) {
  const [open, setOpen] = useState(false);
  const extraPages = row.pages.length - 1;
  return (
    <li className="py-2.5">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: retailerColor(row.retailer) }}
              aria-hidden
            />
            {row.retailer}
          </p>
          {row.colours.length > 0 && (
            <p className="mt-0.5 pl-4 text-xs text-muted-foreground">
              {row.colours.join(" · ")}
              {row.otherColours.length > 0 &&
                ` (other colours: ${row.otherColours.join(" · ")} at other prices)`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 pl-4 sm:justify-end sm:pl-0">
          <FreshnessBadge offer={row.offer} />
          <StockBadge stock={row.stock} />
          {row.offer.lowConfidence && (
            <span className="inline-flex items-center gap-1 rounded bg-warning-soft px-1.5 py-0.5 text-[11px] text-warning">
              <AlertTriangle className="h-3 w-3" aria-hidden /> Check on their site
            </span>
          )}
          <span
            className={cn(
              "min-w-[5.5rem] text-right tabular-nums",
              row.current ? "font-semibold" : "text-muted-foreground",
            )}
          >
            {usd(row.price)}
          </span>
          <a
            href={row.offer.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn("inline-flex items-center gap-1 text-xs text-primary hover:underline", FOCUS)}
            aria-label={`Open ${row.retailer}'s page for this price (opens their site)`}
          >
            Open <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>
      </div>
      {extraPages > 0 && (
        <div className="pl-4">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={cn("mt-1 text-xs text-primary hover:underline", FOCUS)}
          >
            {open ? "Hide pages" : `+${extraPages} more page${extraPages === 1 ? "" : "s"}`}
          </button>
          {open && (
            <ul className="mt-1 space-y-1">
              {row.pages.map((pg) => (
                <li key={pg.url} className="flex flex-wrap items-center gap-2 text-xs">
                  <a
                    href={pg.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn("min-w-0 max-w-full truncate text-primary hover:underline", FOCUS)}
                  >
                    {pg.title}
                  </a>
                  <span className="tabular-nums">{usd(pg.price)}</span>
                  <StockBadge stock={pg.stock} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/* ── product ──────────────────────────────────────────────────────── */

function HeadlineBlock({ view }: { view: ProductView }) {
  const h = view.headline;
  if (!h) return <p className="text-xs text-muted-foreground">No current price</p>;
  const isEstimate = h.row.offer.freshness.kind === "estimate";
  return (
    <div className="space-y-1 sm:text-right">
      {h.confirmed && (
        <p className="text-sm">
          Lowest {h.confirmed.offer.freshness.kind === "live" ? "verified" : "confirmed"}:{" "}
          <strong className="tabular-nums">{usd(h.confirmed.price)}</strong> at{" "}
          {h.confirmed.retailer}
        </p>
      )}
      <p className={cn(isEstimate && h.confirmed ? "text-sm" : "")}>
        {isEstimate && h.confirmed ? "Possibly lower: " : ""}
        <span
          className={cn(
            "font-bold tabular-nums",
            isEstimate && h.confirmed ? "text-base" : "text-2xl leading-tight",
          )}
        >
          {usd(h.row.price)}
        </span>{" "}
        <span className="text-xs text-muted-foreground">
          at {h.row.retailer}
          {isEstimate ? " (web estimate)" : ""}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
        <FreshnessBadge offer={h.row.offer} />
        <a
          href={h.row.offer.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn("inline-flex items-center gap-1 text-xs text-primary hover:underline", FOCUS)}
        >
          Open {h.row.retailer} <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </div>
      {h.allOutOfStock && (
        <p className="text-xs font-medium text-danger">Out of stock everywhere we checked</p>
      )}
    </div>
  );
}

function ProductCard({
  view,
  tracked,
  onTrack,
  trackPending,
  actions,
}: {
  view: ProductView;
  tracked: boolean;
  onTrack: (p: AnswerProduct) => void;
  trackPending: boolean;
  actions?: ReactNode;
}) {
  const product = view.product;
  const trackable = !!toSearchProduct(product);
  const size =
    product.sizeClass && product.sizeClass in SIZE_LABELS
      ? SIZE_LABELS[product.sizeClass as SizeClass]
      : null;
  const gtin = product.identifiers.find((i) => i.kind === "gtin")?.value;

  return (
    <article className="rounded-xl border border-border bg-card" aria-labelledby={`p-${product.key}`}>
      <div className="flex flex-col gap-3 p-4 sm:flex-row">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.imageUrl} alt="" className="h-full w-full object-contain p-1" loading="lazy" />
          ) : (
            <ShoppingBag className="h-6 w-6 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 id={`p-${product.key}`} className="line-clamp-2 text-sm font-medium leading-snug">
            {product.name}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {[product.brand, size, gtin ? `UPC ${gtin.replace(/^0+(?=\d{12})/, "")}` : null]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              variant={tracked ? "outline" : "default"}
              size="sm"
              className="h-8 gap-1.5 text-xs"
              disabled={tracked || trackPending || !trackable}
              onClick={() => onTrack(product)}
              title={trackable ? undefined : "Only prices found today at a store's own page can be tracked"}
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
            {actions}
          </div>
        </div>
        <div className="shrink-0 sm:max-w-[45%]">
          <HeadlineBlock view={view} />
        </div>
      </div>
      <div className="border-t border-border px-4">
        <h4 className="sr-only">Prices by store, lowest first</h4>
        <ul className="divide-y divide-border">
          {view.rows.map((r) => (
            <StoreRowLine key={r.sourceId} row={r} />
          ))}
        </ul>
      </div>
    </article>
  );
}

/* ── stores with no number: links only, no reasons ────────────────── */

function OtherStores({ rows }: { rows: StoreStatusRow[] }) {
  const links = rows.filter((r) => !!r.url);
  if (links.length === 0) return null;
  return (
    <section className="mt-5 rounded-xl border border-border bg-card px-4 py-3" aria-labelledby="other-stores">
      <h2 id="other-stores" className="mb-2 text-xs font-medium text-muted-foreground">
        Also compare at
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

/* ── saved prices (when a live check couldn't run) ────────────────── */

/** Last-known prices, each with its own date: the same cards, no live controls. */
export function SavedPrices({
  products,
  query,
  onTrack,
  trackedKeys,
  trackPending,
  renderActions,
}: {
  products: AnswerProduct[];
  query: string;
  onTrack: (p: AnswerProduct) => void;
  trackedKeys: Set<string>;
  trackPending: boolean;
  renderActions?: (p: AnswerProduct) => ReactNode;
}) {
  const views = useMemo(
    () =>
      productViews(products, {
        wantsAccessory: luggagePack.parseQuery(query).sizeClass === "accessory",
      }),
    [products, query],
  );
  if (views.length === 0) return null;
  return (
    <div className="space-y-3">
      {views.map((v) => (
        <ProductCard
          key={v.product.key}
          view={v}
          tracked={trackedKeys.has(v.product.key)}
          onTrack={onTrack}
          trackPending={trackPending}
          actions={renderActions?.(v.product)}
        />
      ))}
    </div>
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
  renderActions,
}: {
  view: ResearchView;
  sort: ResearchSort;
  onSort: (s: ResearchSort) => void;
  onReverify: () => void;
  onCancel: () => void;
  onTrack: (p: AnswerProduct) => void;
  trackedKeys: Set<string>;
  trackPending: boolean;
  /** Extra per-product buttons (e.g. "Add to morning email"). */
  renderActions?: (p: AnswerProduct) => ReactNode;
}) {
  const rows = useMemo(
    () => Object.values(view.rows).sort((a, b) => a.retailer.localeCompare(b.retailer)),
    [view.rows],
  );

  const views = useMemo(() => {
    const parsed = luggagePack.parseQuery(view.query);
    const base =
      view.answer?.products ??
      rankProducts(groupOffers(view.offers, luggagePack), (p) =>
        matchScore(parsed, haystackFor({ brand: p.brand, title: p.name, identifiers: p.identifiers }), p.sizeClass),
      );
    const list = productViews(base, { wantsAccessory: parsed.sizeClass === "accessory" });
    if (sort === "price-asc") return list;
    return [...list].sort((a, b) =>
      sort === "price-desc"
        ? (b.headline?.row.price ?? -1) - (a.headline?.row.price ?? -1)
        : b.rows.length - a.rows.length,
    );
  }, [view.answer, view.offers, view.query, sort]);

  // Stores with a price in the results don't need a link row as well.
  const shownSources = new Set(views.flatMap((v) => v.rows.map((r) => r.sourceId)));
  const others = rows.filter(
    (r) =>
      r.state !== "verified" &&
      r.state !== "running" &&
      r.state !== "pending" &&
      !shownSources.has(r.sourceId),
  );
  const running = view.status === "running" || view.status === "starting";
  const answer = view.answer;

  return (
    <div className="mx-auto max-w-4xl" aria-busy={running}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <StoreProgress rows={rows} running={running} />
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={onCancel}>
              Stop
            </Button>
          ) : (
            view.sessionId && (
              <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={onReverify}>
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Check prices again
              </Button>
            )
          )}
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
            <span>Sort</span>
            <select
              value={sort}
              onChange={(e) => onSort(e.target.value as ResearchSort)}
              className={cn("bg-transparent text-foreground", FOCUS)}
            >
              <option value="price-asc">Lowest price first</option>
              <option value="price-desc">Highest price first</option>
              <option value="stores">Most stores</option>
            </select>
          </label>
        </div>
      </div>

      {view.status === "cancelled" && (
        <p className="mb-3 text-sm text-muted-foreground">Stopped. Prices found so far are shown.</p>
      )}
      {answer?.deadlineHit && (
        <p className="mb-3 text-xs text-muted-foreground">
          Some stores took too long to answer. Press &ldquo;Check prices again&rdquo; to try them again.
        </p>
      )}

      <div aria-live="polite">
        {views.length === 0 && !running ? (
          <p className="rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            No price found for &ldquo;{view.query}&rdquo;. Try a shorter or different product name, or
            compare at the stores below.
          </p>
        ) : (
          <div className="space-y-3">
            {views.map((v) => (
              <ProductCard
                key={v.product.key}
                view={v}
                tracked={trackedKeys.has(v.product.key)}
                onTrack={onTrack}
                trackPending={trackPending}
                actions={renderActions?.(v.product)}
              />
            ))}
          </div>
        )}
      </div>

      {!running && <OtherStores rows={others} />}

      {views.length > 0 && (
        <p className="mt-4 text-xs text-muted-foreground">
          Prices are each store&rsquo;s listed price in Canadian dollars, before GST/HST and shipping,
          as read at the time shown.
        </p>
      )}
    </div>
  );
}
