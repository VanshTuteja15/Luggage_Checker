"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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
import { EmptyState, ErrorState, SectionTitle, TableSkeleton } from "@/components/Bits";
import { Sparkline } from "@/components/Sparkline";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { prettyDate, usd } from "@/lib/format";
import { errorMessage, useTrackedProducts } from "@/lib/queries";
import { useStore } from "@/lib/store";
import type { TrackedProduct } from "@/lib/types";

const CHART_COLORS = [
  "#5B6B4A", "#8B7D5B", "#A0522D", "#6B8E6B", "#7C6E4F",
  "#4A6B5B", "#9B8E6E", "#6D8B74", "#BFA87A", "#5A7F6A",
];

/** How many series stay readable on one chart. */
const MAX_SERIES = 8;

type Range = 7 | 30 | 90;

/** Price on or before a target date — the last known price, not a gap. */
function priceOnOrBefore(product: TrackedProduct, isoDate: string): number | null {
  let result: number | null = null;
  for (const point of product.history) {
    if (point.date <= isoDate) result = point.price;
    else break;
  }
  return result;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

export default function HistoryPage() {
  const { authed, ready } = useStore();
  const [range, setRange] = useState<Range>(30);
  const [brand, setBrand] = useState("all");
  const [charted, setCharted] = useState<string[]>([]);

  const { data, isLoading, isError, error, refetch } = useTrackedProducts(
    range,
    ready && authed,
  );

  const tracked = useMemo(() => data ?? [], [data]);

  const brands = useMemo(
    () => Array.from(new Set(tracked.map((p) => p.brand))).sort(),
    [tracked],
  );

  const filtered = useMemo(
    () => (brand === "all" ? tracked : tracked.filter((p) => p.brand === brand)),
    [tracked, brand],
  );

  // Default the chart to the first few products, but let the user choose.
  // The old page silently sliced to 10 with no way to see the rest.
  useEffect(() => {
    setCharted((current) => {
      const stillValid = current.filter((id) => filtered.some((p) => p.id === id));
      if (stillValid.length > 0) return stillValid;
      return filtered.slice(0, MAX_SERIES).map((p) => p.id);
    });
  }, [filtered]);

  const chartProducts = filtered.filter((p) => charted.includes(p.id));

  const chartData = useMemo(() => {
    const dates = new Set<string>();
    for (const p of chartProducts) for (const point of p.history) dates.add(point.date);

    return [...dates]
      .sort()
      .map((date) => {
        const row: Record<string, string | number> = { date: prettyDate(date) };
        for (const p of chartProducts) {
          const point = p.history.find((h) => h.date === date);
          if (point) row[p.id] = point.price;
        }
        return row;
      });
  }, [chartProducts]);

  const tableData = useMemo(() => {
    const iso7 = daysAgoIso(7);
    const iso30 = daysAgoIso(30);

    return filtered.map((p) => {
      const prices = p.history.map((h) => h.price);
      const lowestInRange = prices.length > 0 ? Math.min(...prices) : null;
      return {
        product: p,
        current: p.lowestPrice,
        ago7: priceOnOrBefore(p, iso7),
        ago30: priceOnOrBefore(p, iso30),
        lowestInRange,
        change: p.change,
        spark: p.history.slice(-14).map((h) => h.price),
      };
    });
  }, [filtered]);

  function toggleSeries(id: string) {
    setCharted((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length >= MAX_SERIES
          ? current
          : [...current, id],
    );
  }

  return (
    <AppLayout title="Price History" subtitle="Price trends across your tracked products">
      {isLoading ? (
        <TableSkeleton rows={6} />
      ) : isError ? (
        <ErrorState message={errorMessage(error, "Couldn't load price history.")} onRetry={refetch} />
      ) : tracked.length === 0 ? (
        <EmptyState
          title="No history yet"
          description="Track a product and its price history builds automatically on every refresh."
          action={
            <Button asChild>
              <Link href="/tracked">Add products</Link>
            </Button>
          }
        />
      ) : (
        <>
          {/* Controls */}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <Select value={brand} onValueChange={setBrand}>
              <SelectTrigger className="h-9 w-[150px]">
                <SelectValue placeholder="Brand" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All brands</SelectItem>
                {brands.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex rounded-md border border-border text-sm">
              {([7, 30, 90] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setRange(d)}
                  className={`px-3 py-1.5 ${
                    range === d ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>

          {/* Chart */}
          <div className="mb-8">
            <SectionTitle
              title="Price Trends"
              description={`Lowest price per product over ${range} days`}
            />

            {/* Explicit series picker — no silent truncation. */}
            {filtered.length > 1 && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Showing {chartProducts.length} of {filtered.length}
                  {filtered.length > MAX_SERIES && ` (max ${MAX_SERIES})`}:
                </span>
                {filtered.map((p, i) => {
                  const on = charted.includes(p.id);
                  const atLimit = !on && charted.length >= MAX_SERIES;
                  return (
                    <button
                      key={p.id}
                      onClick={() => toggleSeries(p.id)}
                      disabled={atLimit}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        on
                          ? "border-transparent bg-muted font-medium"
                          : "border-border text-muted-foreground hover:bg-muted/50"
                      } ${atLimit ? "cursor-not-allowed opacity-40" : ""}`}
                      title={atLimit ? `Deselect one to add another` : p.name}
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{
                          backgroundColor: on
                            ? CHART_COLORS[chartProducts.findIndex((c) => c.id === p.id) % CHART_COLORS.length]
                            : "transparent",
                          border: on ? undefined : "1px solid currentColor",
                        }}
                      />
                      {p.name.length > 26 ? `${p.name.slice(0, 24)}…` : p.name}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="card-surface p-4">
              {chartData.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                  No price points recorded yet. Prices are recorded on each refresh.
                </p>
              ) : (
                <div className="h-96">
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
                        formatter={(value: number, name: string) => {
                          const p = chartProducts.find((x) => x.id === name);
                          return [usd(value), p?.name ?? name];
                        }}
                      />
                      <Legend
                        formatter={(value: string) => {
                          const p = chartProducts.find((x) => x.id === value);
                          const name = p?.name ?? value;
                          return name.length > 30 ? `${name.slice(0, 28)}…` : name;
                        }}
                      />
                      {chartProducts.map((p, i) => (
                        <Line
                          key={p.id}
                          type="monotone"
                          dataKey={p.id}
                          stroke={CHART_COLORS[i % CHART_COLORS.length]}
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
          </div>

          {/* Table */}
          <SectionTitle
            title="Price Comparison"
            description={`Figures cover the last ${range} days of recorded history`}
          />
          <div className="card-surface overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">Product</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Current</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">7d ago</th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">30d ago</th>
                  {/* Previously mislabelled "Lowest Ever" while only covering the window. */}
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Lowest ({range}d)
                  </th>
                  <th className="px-4 py-3 font-medium text-muted-foreground">Trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tableData.map((row) => (
                  <tr key={row.product.id} className="hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link
                        href={`/products/${row.product.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {row.product.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{row.product.brand}</p>
                    </td>
                    <td className="px-4 py-3 font-semibold tabular-nums">
                      {row.current === null ? "—" : usd(row.current)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {row.ago7 === null ? "—" : usd(row.ago7)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {row.ago30 === null ? "—" : usd(row.ago30)}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {row.lowestInRange === null ? "—" : usd(row.lowestInRange)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="w-24">
                        {row.spark.length > 1 ? (
                          <Sparkline
                            data={row.spark}
                            color={
                              row.change < 0 ? "#10B981" : row.change > 0 ? "#EF4444" : "#5B6B4A"
                            }
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">Not enough data</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AppLayout>
  );
}
