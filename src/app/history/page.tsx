"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { AppLayout } from "@/components/AppLayout";
import { SectionTitle } from "@/components/Bits";
import { Sparkline } from "@/components/Sparkline";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  lowestOffer,
  lowestOnDate,
  priceChange,
  seriesDates,
} from "@/lib/data";
import { usd, prettyDate } from "@/lib/format";
import { useStore } from "@/lib/store";

const CHART_COLORS = [
  "#5B6B4A",
  "#8B7D5B",
  "#A0522D",
  "#6B8E6B",
  "#7C6E4F",
  "#4A6B5B",
  "#9B8E6E",
  "#6D8B74",
  "#BFA87A",
  "#5A7F6A",
];

export default function HistoryPage() {
  const { tracked } = useStore();
  const [range, setRange] = useState<7 | 30>(30);
  const [brand, setBrand] = useState("all");

  const brands = useMemo(
    () => Array.from(new Set(tracked.map((p) => p.brand))).sort(),
    [tracked],
  );

  const filtered = useMemo(() => {
    if (brand === "all") return tracked;
    return tracked.filter((p) => p.brand === brand);
  }, [tracked, brand]);

  // Build chart data — lowest price per product per date
  const dates = seriesDates(range);
  const chartData = useMemo(() => {
    return dates.map((date) => {
      const row: Record<string, string | number> = { date: prettyDate(date) };
      for (const p of filtered.slice(0, 10)) {
        const price = lowestOnDate(p, date);
        if (price !== null) row[p.id] = price;
      }
      return row;
    });
  }, [filtered, dates]);

  // History comparison table data
  const tableData = useMemo(() => {
    const d7 = seriesDates(7)[0];
    const d30 = seriesDates(30)[0];
    return filtered.map((p) => {
      const prices = Object.values(p.history)
        .flat()
        .map((pt) => pt.price);
      const lowestEver = Math.min(...prices);
      const current = lowestOffer(p).price;
      const ago7 = lowestOnDate(p, d7);
      const ago30 = lowestOnDate(p, d30);
      const ch = priceChange(p);
      const spark = seriesDates(6)
        .map((d) => lowestOnDate(p, d))
        .filter((v): v is number => v !== null);
      return { product: p, current, ago7, ago30, lowestEver, change: ch, spark };
    });
  }, [filtered]);

  return (
    <AppLayout title="Price History" subtitle="Price trends across all tracked products">
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
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => setRange(d)}
              className={`px-3 py-1.5 ${range === d ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {/* Multi-line chart */}
      {filtered.length > 0 && (
        <div className="mb-8">
          <SectionTitle
            title="Price Trends"
            description={`Lowest price per product over ${range} days (top 10 shown)`}
          />
          <div className="card-surface p-4">
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
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "var(--card)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(value: number, name: string) => {
                      const p = filtered.find((x) => x.id === name);
                      return [usd(value), p?.name ?? name];
                    }}
                  />
                  <Legend
                    formatter={(value: string) => {
                      const p = filtered.find((x) => x.id === value);
                      const name = p?.name ?? value;
                      return name.length > 30 ? name.slice(0, 28) + "..." : name;
                    }}
                  />
                  {filtered.slice(0, 10).map((p, i) => (
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
          </div>
        </div>
      )}

      {/* Comparison table */}
      <SectionTitle title="Price Comparison Table" />
      <div className="card-surface overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left">
              <th className="px-4 py-3 font-medium text-muted-foreground">Product</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Current</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">7d Ago</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">30d Ago</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">Lowest Ever</th>
              <th className="px-4 py-3 font-medium text-muted-foreground">7d Trend</th>
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
                <td className="px-4 py-3 font-semibold">{usd(row.current)}</td>
                <td className="px-4 py-3 text-muted-foreground">
                  {row.ago7 !== null ? usd(row.ago7) : "—"}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {row.ago30 !== null ? usd(row.ago30) : "—"}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{usd(row.lowestEver)}</td>
                <td className="px-4 py-3">
                  <div className="w-24">
                    <Sparkline
                      data={row.spark}
                      color={
                        row.change < 0
                          ? "#10B981"
                          : row.change > 0
                            ? "#EF4444"
                            : "#5B6B4A"
                      }
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AppLayout>
  );
}
