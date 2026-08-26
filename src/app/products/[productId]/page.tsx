"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
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
import { ChangeBadge, RetailerTag, StockBadge } from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { Button } from "@/components/ui/button";
import {
  CATALOG,
  retailerColor,
  lowestOffer,
  priceChange,
  priceSpread,
  retailerCount,
  stats,
  seriesDates,
} from "@/lib/data";
import { usd, prettyDate } from "@/lib/format";
import { useStore } from "@/lib/store";

export default function ProductDetailPage() {
  const params = useParams();
  const productId = params.productId as string;
  const { isTracked, track, untrack } = useStore();
  const [range, setRange] = useState<7 | 30 | 90>(30);

  const product = CATALOG.find((p) => p.id === productId);

  if (!product) {
    return (
      <AppLayout title="Product Not Found">
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <p className="text-muted-foreground">This product doesn&apos;t exist in the catalog.</p>
          <Button asChild variant="outline">
            <Link href="/dashboard">Back to Dashboard</Link>
          </Button>
        </div>
      </AppLayout>
    );
  }

  const low = lowestOffer(product);
  const change = priceChange(product);
  const s = stats(product);
  const tracked = isTracked(product.id);
  const retailers = Object.keys(product.history);

  // Build chart data
  const dates = seriesDates(Math.min(range, 30)); // data only has 30 days
  const chartData = dates.map((date) => {
    const row: Record<string, string | number> = { date: prettyDate(date) };
    for (const r of retailers) {
      const pt = product.history[r]?.find((p) => p.date === date);
      if (pt) row[r] = pt.price;
    }
    return row;
  });

  return (
    <AppLayout
      title={product.name}
      subtitle={`${product.brand} · ${product.model}`}
      actions={
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard">
              <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
              Back
            </Link>
          </Button>
          {tracked ? (
            <Button
              variant="outline"
              size="sm"
              className="border-danger text-danger hover:bg-danger-soft"
              onClick={() => {
                untrack(product.id);
                toast.success("Removed from tracking");
              }}
            >
              Remove from Tracking
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                track(product.id);
                toast.success("Now tracking this product");
              }}
            >
              Track This Product
            </Button>
          )}
        </div>
      }
    >
      {/* Lowest price banner */}
      <div className="mb-6 rounded-lg border-2 border-success/40 bg-success-soft/30 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-success">Lowest Price Found Online</p>
            <p className="text-3xl font-bold tracking-tight text-success">{usd(low.price)}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              at <span className="font-medium text-foreground">{low.retailer}</span>
              {" · "}Found across {retailerCount(product)} retailers · Save up to {usd(priceSpread(product))}
            </p>
          </div>
          <a
            href={low.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md bg-success px-4 py-2 text-sm font-medium text-success-foreground transition-colors hover:bg-success/90"
          >
            View Deal <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {/* Product header */}
      <div className="card-surface mb-8 flex flex-col gap-6 p-6 md:flex-row">
        <ProductThumb id={product.id} name={product.name} className="h-48 w-full md:w-64" />
        <div className="flex-1 space-y-3">
          <h2 className="text-2xl font-semibold">{product.name}</h2>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <span>Brand: <span className="text-foreground">{product.brand}</span></span>
            <span>Model: <span className="text-foreground">{product.model}</span></span>
            <span>Color: <span className="text-foreground">{product.color}</span></span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">UPC:</span>
            <code className="rounded bg-muted px-2 py-0.5 text-xs">{product.upc}</code>
            <button
              onClick={() => {
                navigator.clipboard.writeText(product.upc);
                toast.success("UPC copied");
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-3 pt-2">
            <span className="text-3xl font-bold tracking-tight" style={{ color: "#5B6B4A" }}>
              {usd(low.price)}
            </span>
            <RetailerTag retailer={low.retailer} />
            <ChangeBadge change={change} />
          </div>
        </div>
      </div>

      {/* Retailer comparison */}
      <div className="mb-8">
        <h3 className="mb-3 text-lg font-semibold">Retailer Price Comparison</h3>
        <div className="card-surface overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-3 font-medium text-muted-foreground">Retailer</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Price</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Stock</th>
                <th className="px-4 py-3 font-medium text-muted-foreground">Last Checked</th>
                <th className="px-4 py-3 font-medium text-muted-foreground" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {product.offers
                .sort((a, b) => a.price - b.price)
                .map((o, i) => (
                  <tr
                    key={o.retailer}
                    className={i === 0 ? "bg-success-soft/40" : "hover:bg-muted/40"}
                  >
                    <td className="px-4 py-3">
                      <RetailerTag retailer={o.retailer} />
                    </td>
                    <td className="px-4 py-3 font-semibold">{usd(o.price)}</td>
                    <td className="px-4 py-3">
                      <StockBadge inStock={o.inStock} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {o.lastCheckedMinutesAgo < 60
                        ? `${o.lastCheckedMinutesAgo}m ago`
                        : `${Math.round(o.lastCheckedMinutesAgo / 60)}h ago`}
                    </td>
                    <td className="px-4 py-3">
                      <a
                        href={o.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Visit <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Price history chart */}
      <div className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Price History</h3>
          <div className="flex rounded-md border border-border text-sm">
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                onClick={() => setRange(d)}
                className={`px-3 py-1.5 ${range === d ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"}`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div className="card-surface p-4">
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
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "var(--card)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: number) => [usd(value), undefined]}
                />
                <Legend />
                {retailers.map((r) => (
                  <Line
                    key={r}
                    type="monotone"
                    dataKey={r}
                    name={r}
                    stroke={retailerColor(r)}
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

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        {[
          { label: "Current Lowest", value: usd(s.current) },
          { label: "Retailers Found", value: String(retailerCount(product)), sub: `Save up to ${usd(priceSpread(product))}` },
          { label: "Lowest Ever", value: `${usd(s.lowest.price)}`, sub: prettyDate(s.lowest.date) },
          { label: "Highest Ever", value: `${usd(s.highest.price)}`, sub: prettyDate(s.highest.date) },
          { label: "Average Price", value: usd(s.average) },
          { label: "Price Checks", value: String(s.checks) },
        ].map((stat) => (
          <div key={stat.label} className="card-surface p-4">
            <p className="text-xs text-muted-foreground">{stat.label}</p>
            <p className="text-lg font-semibold">{stat.value}</p>
            {"sub" in stat && stat.sub && (
              <p className="text-xs text-muted-foreground">{stat.sub}</p>
            )}
          </div>
        ))}
      </div>
    </AppLayout>
  );
}
