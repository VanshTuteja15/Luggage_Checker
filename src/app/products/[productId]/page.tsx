"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  ExternalLink,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import {
  ChangeBadge,
  ErrorState,
  Freshness,
  SectionTitle,
  StockBadge,
  TableSkeleton,
} from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { prettyDate, percentChange, usd } from "@/lib/format";
import { byStore, dailyLowest, productSummary } from "@/lib/history/tables";
import {
  errorMessage,
  useRefreshPrices,
  useSetPriceAlert,
  useTrackedProduct,
  useUntrackProducts,
} from "@/lib/queries";
import { retailerColor } from "@/lib/retailers";
import { useStore } from "@/lib/store";
import { addDays, formatYmdWeekday, localDate } from "@/lib/time/local";
import { priceStats } from "@/lib/types";

/** Tables cover the last 30 days (R4.3). */
const DAYS = 30;

export default function ProductDetailPage() {
  const params = useParams<{ productId: string }>();
  const productId = params?.productId ?? "";
  const { authed, ready } = useStore();

  // A week more than the tables show, so "7 days ago" and the first day's change have data.
  const { data: product, isLoading, isError, error, refetch } = useTrackedProduct(
    productId,
    DAYS + 8,
    ready && authed,
  );
  const today = localDate(new Date());

  const refresh = useRefreshPrices();
  const untrack = useUntrackProducts();
  const setAlert = useSetPriceAlert();

  const [targetInput, setTargetInput] = useState("");
  const [editingAlert, setEditingAlert] = useState(false);

  const stats = useMemo(
    () =>
      priceStats((product?.history ?? []).filter((h) => h.date >= addDays(today, -(DAYS - 1)))),
    [product?.history, today],
  );
  const daily = useMemo(() => (product ? dailyLowest(product, today, DAYS) : []), [product, today]);
  const stores = useMemo(() => (product ? byStore(product, today) : []), [product, today]);
  const summary = useMemo(() => (product ? productSummary(product, today) : null), [product, today]);

  if (isLoading) {
    return (
      <AppLayout title="Product" subtitle="Loading…">
        <TableSkeleton rows={6} />
      </AppLayout>
    );
  }

  if (isError || !product) {
    return (
      <AppLayout title="Product" subtitle="">
        <ErrorState
          message={errorMessage(error, "This product isn't in your tracked list.")}
          onRetry={refetch}
        />
        <div className="mt-4 text-center">
          <Button asChild variant="outline">
            <Link href="/tracked">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to tracked products
            </Link>
          </Button>
        </div>
      </AppLayout>
    );
  }

  const isRefreshing = refresh.isPending && refresh.variables === product.id;

  function saveAlert() {
    const value = targetInput.trim();
    if (!value) {
      setAlert.mutate({ productId: product!.id, targetPrice: null });
    } else {
      const n = Number(value.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(n) || n <= 0) return;
      setAlert.mutate({ productId: product!.id, targetPrice: Math.round(n * 100) / 100 });
    }
    setEditingAlert(false);
  }

  return (
    <AppLayout
      title={product.name}
      subtitle={`${product.brand}${product.color ? ` · ${product.color}` : ""}${product.upc ? ` · UPC ${product.upc}` : ""}`}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => refresh.mutate(product.id)}
            disabled={isRefreshing}
            className="gap-2"
          >
            {isRefreshing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh price
          </Button>
          <Button
            variant="outline"
            onClick={() => untrack.mutate([product.id])}
            disabled={untrack.isPending}
            className="gap-2 text-danger"
          >
            <Trash2 className="h-4 w-4" />
            Stop tracking
          </Button>
        </div>
      }
    >
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2 gap-2">
        <Link href="/tracked">
          <ArrowLeft className="h-4 w-4" />
          All tracked products
        </Link>
      </Button>

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="card-surface mb-6 flex flex-wrap items-start gap-6 p-6">
        <ProductThumb
          id={product.id}
          name={product.name}
          imageUrl={product.imageUrl}
          className="h-28 w-28"
        />

        <div className="min-w-[200px] flex-1">
          <p className="text-sm text-muted-foreground">Best price right now</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="text-3xl font-semibold tabular-nums">
              {product.lowestPrice === null ? "—" : usd(product.lowestPrice)}
            </span>
            <ChangeBadge change={product.change} />
            <StockBadge inStock={product.inStock} />
          </div>
          {product.lowestRetailer && (
            <p className="mt-1 text-sm text-muted-foreground">
              at <span className="font-medium text-foreground">{product.lowestRetailer}</span>
              {product.previousLowest !== null && product.change !== 0 && (
                <>
                  {" · was "}
                  {usd(product.previousLowest)} ({percentChange(product.previousLowest, product.lowestPrice ?? 0)})
                </>
              )}
            </p>
          )}
          {summary && (
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{summary.sentence}</span>
              {summary.badge && (
                <span
                  className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                    summary.badge === "Lowest in 30 days"
                      ? "bg-success-soft text-success"
                      : "bg-danger/10 text-danger"
                  }`}
                >
                  {summary.badge}
                </span>
              )}
            </p>
          )}
          <div className="mt-2">
            <Freshness isoDate={product.lastCheckedAt} />
          </div>
        </div>

        {/* Price alert */}
        <div className="min-w-[220px] rounded-lg border border-border p-4">
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            {product.targetPrice !== null ? (
              <Bell className="h-4 w-4 text-primary" />
            ) : (
              <BellOff className="h-4 w-4 text-muted-foreground" />
            )}
            Price alert
          </p>

          {editingAlert ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveAlert()}
                placeholder="e.g. 249.99"
                className="h-8 text-sm"
                inputMode="decimal"
              />
              <Button size="sm" className="h-8" onClick={saveAlert} disabled={setAlert.isPending}>
                Save
              </Button>
            </div>
          ) : product.targetPrice !== null ? (
            <>
              <p className="text-sm text-muted-foreground">
                Email me when it drops below{" "}
                <span className="font-semibold text-foreground">{usd(product.targetPrice)}</span>
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  className="text-xs text-primary hover:underline"
                  onClick={() => {
                    setTargetInput(String(product.targetPrice));
                    setEditingAlert(true);
                  }}
                >
                  Change
                </button>
                <button
                  className="text-xs text-muted-foreground hover:underline"
                  onClick={() => setAlert.mutate({ productId: product.id, targetPrice: null })}
                >
                  Remove
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Get an email when this drops below a price you set.
              </p>
              <button
                className="mt-2 text-xs text-primary hover:underline"
                onClick={() => {
                  setTargetInput(
                    product.lowestPrice ? String(Math.floor(product.lowestPrice * 0.9)) : "",
                  );
                  setEditingAlert(true);
                }}
              >
                Set an alert
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Retailer comparison ─────────────────────────────── */}
      <SectionTitle
        title="Retailer Prices"
        description={`${product.retailerCount} retailer${product.retailerCount === 1 ? "" : "s"}${
          product.spread > 0 ? ` · ${usd(product.spread)} between cheapest and dearest` : ""
        }`}
      />
      <div className="card-surface mb-8 sm:overflow-x-auto">
        <ul className="divide-y divide-border sm:hidden">
          {product.offers.map((offer, i) => (
            <li key={`${offer.retailer}-${i}`} className="space-y-1 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-2 font-medium">
                  {offer.retailer}
                  {i === 0 && (
                    <span className="rounded bg-success-soft px-1.5 py-0.5 text-xs font-medium text-success">
                      Best
                    </span>
                  )}
                </span>
                <span className="font-semibold tabular-nums">{usd(offer.price)}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <StockBadge inStock={offer.inStock} />
                <Freshness isoDate={offer.lastCheckedAt} />
                {offer.url && (
                  <a
                    href={offer.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Visit <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
        <table className="hidden w-full min-w-[620px] text-sm sm:table">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">Retailer</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Price</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">vs best</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Stock</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Checked</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {product.offers.map((offer, i) => {
              const diff = product.lowestPrice !== null ? offer.price - product.lowestPrice : 0;
              return (
                <tr key={`${offer.retailer}-${i}`} className="hover:bg-muted/40">
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: retailerColor(offer.retailer) }}
                      />
                      {offer.retailer}
                      {i === 0 && (
                        <span className="rounded bg-success-soft px-1.5 py-0.5 text-xs font-medium text-success">
                          Best
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-semibold tabular-nums">{usd(offer.price)}</td>
                  <td className="px-4 py-3 tabular-nums text-muted-foreground">
                    {diff <= 0 ? "—" : `+${usd(diff)}`}
                  </td>
                  <td className="px-4 py-3">
                    <StockBadge inStock={offer.inStock} />
                  </td>
                  <td className="px-4 py-3">
                    <Freshness isoDate={offer.lastCheckedAt} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {offer.url && (
                      <a
                        href={offer.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Visit <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── History: tables, no charts (R4.3) ──────────────── */}
      <SectionTitle title="Daily lowest price" description={`The last ${DAYS} days, newest first`} />
      <div className="card-surface mb-8">
        {daily.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No prices recorded yet. A row is added each day the price is checked.
          </p>
        ) : (
          <>
            <table className="hidden w-full text-sm sm:table">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 text-right font-medium">Lowest price</th>
                  <th className="px-4 py-3 font-medium">Store</th>
                  <th className="px-4 py-3 text-right font-medium">vs day before</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {daily.map((d) => (
                  <tr key={d.date}>
                    <td className="whitespace-nowrap px-4 py-3">{formatYmdWeekday(d.date)}</td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{usd(d.price)}</td>
                    <td className="px-4 py-3">{d.retailers.join(", ")}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                      <DayChange kind={d.kind} text={d.change} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-border sm:hidden">
              {daily.map((d) => (
                <li key={d.date} className="flex items-start justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{formatYmdWeekday(d.date)}</p>
                    <p className="text-muted-foreground">{d.retailers.join(", ")}</p>
                  </div>
                  <div className="text-right tabular-nums">
                    <p className="font-semibold">{usd(d.price)}</p>
                    <DayChange kind={d.kind} text={d.change} />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <SectionTitle
        title="By store"
        description="Recorded prices; a dash means the store wasn't checked that day"
      />
      <div className="card-surface mb-8">
        {stores.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No store prices recorded yet.</p>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">Store</th>
                  <th className="px-4 py-3 text-right font-medium">Today</th>
                  <th className="px-4 py-3 text-right font-medium">Yesterday</th>
                  <th className="px-4 py-3 text-right font-medium">7 days ago</th>
                  <th className="px-4 py-3 text-right font-medium">30-day lowest</th>
                  <th className="px-4 py-3 text-right font-medium">30-day highest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stores.map((r) => (
                  <tr key={r.retailer}>
                    <td className="px-4 py-3">{r.retailer}</td>
                    {[r.today, r.yesterday, r.weekAgo, r.low30, r.high30].map((v, i) => (
                      <td
                        key={i}
                        className={`px-4 py-3 text-right tabular-nums ${i === 0 ? "font-semibold" : "text-muted-foreground"}`}
                      >
                        {v === null ? "—" : usd(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-border md:hidden">
              {stores.map((r) => (
                <li key={r.retailer} className="p-3 text-sm">
                  <p className="font-medium">{r.retailer}</p>
                  <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
                    {(
                      [
                        ["Today", r.today],
                        ["Yesterday", r.yesterday],
                        ["7 days ago", r.weekAgo],
                        ["30-day lowest", r.low30],
                        ["30-day highest", r.high30],
                      ] as const
                    ).map(([label, v]) => (
                      <div key={label} className="contents">
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="text-right">{v === null ? "—" : usd(v)}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {/* ── Stats ───────────────────────────────────────────── */}
      <SectionTitle title="Last 30 days" description={`Based on ${stats.days} day(s) of recorded prices`} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatBox
          label="Lowest"
          value={stats.lowest ? usd(stats.lowest.price) : "—"}
          hint={stats.lowest ? prettyDate(stats.lowest.date) : undefined}
        />
        <StatBox
          label="Highest"
          value={stats.highest ? usd(stats.highest.price) : "—"}
          hint={stats.highest ? prettyDate(stats.highest.date) : undefined}
        />
        <StatBox label="Average" value={stats.average ? usd(stats.average) : "—"} />
        <StatBox
          label="Retailer spread"
          value={product.spread > 0 ? usd(product.spread) : "—"}
          hint={product.spread > 0 ? "cheapest vs dearest" : undefined}
        />
      </div>
    </AppLayout>
  );
}

function StatBox({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card-surface p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function DayChange({ kind, text }: { kind: "down" | "up" | "same" | null; text: string | null }) {
  if (!text) return <span className="text-muted-foreground">—</span>;
  const tone =
    kind === "down"
      ? "font-medium text-success"
      : kind === "up"
        ? "font-medium text-danger"
        : "text-muted-foreground";
  return <span className={tone}>{text}</span>;
}
