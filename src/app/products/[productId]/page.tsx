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
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
import {
  errorMessage,
  useRefreshPrices,
  useSetPriceAlert,
  useTrackedProduct,
  useUntrackProducts,
} from "@/lib/queries";
import { retailerColor } from "@/lib/retailers";
import { useStore } from "@/lib/store";
import { priceStats } from "@/lib/types";

export default function ProductDetailPage() {
  const params = useParams<{ productId: string }>();
  const productId = params?.productId ?? "";
  const { authed, ready } = useStore();
  const [range, setRange] = useState<7 | 30 | 90>(30);

  const { data: product, isLoading, isError, error, refetch } = useTrackedProduct(
    productId,
    range,
    ready && authed,
  );

  const refresh = useRefreshPrices();
  const untrack = useUntrackProducts();
  const setAlert = useSetPriceAlert();

  const [targetInput, setTargetInput] = useState("");
  const [editingAlert, setEditingAlert] = useState(false);

  const stats = useMemo(() => priceStats(product?.history ?? []), [product?.history]);

  const chartData = useMemo(() => {
    if (!product) return [];
    const retailers = Object.keys(product.historyByRetailer);
    const dates = new Set<string>();
    for (const series of Object.values(product.historyByRetailer)) {
      for (const point of series) dates.add(point.date);
    }
    return [...dates].sort().map((date) => {
      const row: Record<string, string | number> = { date: prettyDate(date) };
      for (const r of retailers) {
        const point = product.historyByRetailer[r].find((p) => p.date === date);
        if (point) row[r] = point.price;
      }
      return row;
    });
  }, [product]);

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
      <div className="card-surface mb-8 overflow-x-auto">
        <table className="w-full min-w-[620px] text-sm">
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

      {/* ── History ─────────────────────────────────────────── */}
      <SectionTitle
        title="Price History"
        description="One line per retailer"
        right={
          <div className="flex rounded-md border border-border text-sm">
            {([7, 30, 90] as const).map((d) => (
              <button
                key={d}
                onClick={() => setRange(d)}
                className={`px-3 py-1.5 ${
                  range === d ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        }
      />

      <div className="card-surface mb-8 p-4">
        {chartData.length < 2 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Not enough history yet — prices are recorded on each refresh, so this fills in over the
            next few days.
          </p>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickFormatter={(v: number) => `$${v}`}
                  tickLine={false}
                  width={60}
                  domain={["auto", "auto"]}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: number, name: string) => [usd(value), name]}
                />
                <Legend />
                {Object.keys(product.historyByRetailer).map((retailer) => (
                  <Line
                    key={retailer}
                    type="monotone"
                    dataKey={retailer}
                    stroke={retailerColor(retailer)}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* ── Stats ───────────────────────────────────────────── */}
      <SectionTitle title="Statistics" description={`Based on ${stats.days} day(s) of recorded history`} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatBox
          label={`Lowest (${range}d)`}
          value={stats.lowest ? usd(stats.lowest.price) : "—"}
          hint={stats.lowest ? prettyDate(stats.lowest.date) : undefined}
        />
        <StatBox
          label={`Highest (${range}d)`}
          value={stats.highest ? usd(stats.highest.price) : "—"}
          hint={stats.highest ? prettyDate(stats.highest.date) : undefined}
        />
        <StatBox label={`Average (${range}d)`} value={stats.average ? usd(stats.average) : "—"} />
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
