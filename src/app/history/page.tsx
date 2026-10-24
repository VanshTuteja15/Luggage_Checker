"use client";

/* ------------------------------------------------------------------ */
/*  Price History (R4.2): readable as tables and sentences, no charts. */
/*  Changes table with filters, "Biggest drops this week", and a       */
/*  comparison table. Tables become stacked cards under 640 px.        */
/* ------------------------------------------------------------------ */

import Link from "next/link";
import { useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { EmptyState, ErrorState, SectionTitle, TableSkeleton } from "@/components/Bits";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usd } from "@/lib/format";
import { biggestDrops, priceChanges, type PriceChange } from "@/lib/history/tables";
import { errorMessage, useTrackedProducts } from "@/lib/queries";
import { useStore } from "@/lib/store";
import { addDays, formatYmdWeekday, localDate } from "@/lib/time/local";
import type { TrackedProduct } from "@/lib/types";

type Range = 7 | 30 | 90;
const ALL = "all";

/** The last recorded lowest price on or before a date. */
function lowestOnOrBefore(product: TrackedProduct, date: string): number | null {
  let result: number | null = null;
  for (const point of product.history) {
    if (point.date <= date) result = point.price;
    else break;
  }
  return result;
}

function ChangeCell({ c }: { c: PriceChange }) {
  return (
    <span className={c.kind === "down" ? "font-medium text-success" : "font-medium text-danger"}>
      {c.text}
    </span>
  );
}

export default function HistoryPage() {
  const { authed, ready } = useStore();
  const [range, setRange] = useState<Range>(30);
  const [productId, setProductId] = useState(ALL);
  const [retailer, setRetailer] = useState(ALL);

  // A week more than the range, so the first change in range has the price before it.
  const { data, isLoading, isError, error, refetch } = useTrackedProducts(
    range + 8,
    ready && authed,
  );
  const tracked = useMemo(() => data ?? [], [data]);
  const today = localDate(new Date());
  const from = addDays(today, -(range - 1));

  const retailers = useMemo(
    () =>
      [...new Set(tracked.flatMap((p) => Object.keys(p.historyByRetailer)))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [tracked],
  );

  const changes = useMemo(
    () =>
      priceChanges(tracked, {
        from,
        productId: productId === ALL ? null : productId,
        retailer: retailer === ALL ? null : retailer,
      }),
    [tracked, from, productId, retailer],
  );
  const drops = useMemo(() => biggestDrops(changes, addDays(today, -6)), [changes, today]);

  const shown = productId === ALL ? tracked : tracked.filter((p) => p.id === productId);
  const comparison = shown.map((p) => {
    const inRange = p.history.filter((h) => h.date >= from).map((h) => h.price);
    return {
      product: p,
      current: p.lowestPrice,
      ago7: lowestOnOrBefore(p, addDays(today, -7)),
      ago30: lowestOnOrBefore(p, addDays(today, -30)),
      lowest: inRange.length ? Math.min(...inRange) : null,
    };
  });

  return (
    <AppLayout title="Price History" subtitle="Every price change, newest first">
      {isLoading ? (
        <TableSkeleton rows={6} />
      ) : isError ? (
        <ErrorState
          message={errorMessage(error, "Couldn't load price history.")}
          onRetry={refetch}
        />
      ) : tracked.length === 0 ? (
        <EmptyState
          title="No history yet"
          description="Track a product and its price history builds up every day it is checked."
          action={
            <Button asChild>
              <Link href="/tracked">Add products</Link>
            </Button>
          }
        />
      ) : (
        <>
          {/* Filters */}
          <div className="mb-6 grid gap-3 sm:flex sm:flex-wrap sm:items-end">
            <div className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground" id="range-label">
                Period
              </span>
              <div
                className="flex rounded-md border border-border text-sm"
                role="group"
                aria-labelledby="range-label"
              >
                {([7, 30, 90] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setRange(d)}
                    aria-pressed={range === d}
                    className={`flex-1 px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      range === d
                        ? "bg-muted font-medium"
                        : "text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {d} days
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1 sm:w-64">
              <Label htmlFor="history-product" className="text-xs text-muted-foreground">
                Product
              </Label>
              <Select value={productId} onValueChange={setProductId}>
                <SelectTrigger id="history-product" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All products</SelectItem>
                  {tracked.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 sm:w-56">
              <Label htmlFor="history-store" className="text-xs text-muted-foreground">
                Store
              </Label>
              <Select value={retailer} onValueChange={setRetailer}>
                <SelectTrigger id="history-store" className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All stores</SelectItem>
                  {retailers.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Biggest drops this week */}
          <section className="mb-8" aria-labelledby="drops-title">
            <div id="drops-title">
              <SectionTitle
                title="Biggest drops this week"
                description="The last 7 days, largest first"
              />
            </div>
            <div className="card-surface p-4">
              {drops.length === 0 ? (
                <p className="text-sm text-muted-foreground">No price drops in the last 7 days.</p>
              ) : (
                <ol className="space-y-2">
                  {drops.map((c, i) => (
                    <li
                      key={`${c.productId}-${c.retailer}-${c.date}`}
                      className="flex gap-3 text-sm"
                    >
                      <span className="w-5 shrink-0 text-right tabular-nums text-muted-foreground">
                        {i + 1}.
                      </span>
                      <span className="min-w-0">
                        <Link
                          href={`/products/${c.productId}`}
                          className="font-medium hover:text-primary"
                        >
                          {c.productName}
                        </Link>{" "}
                        at {c.retailer}: {usd(c.oldPrice)} →{" "}
                        <strong className="tabular-nums">{usd(c.newPrice)}</strong>{" "}
                        <ChangeCell c={c} />{" "}
                        <span className="text-muted-foreground">· {formatYmdWeekday(c.date)}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </section>

          {/* Changes */}
          <section className="mb-8" aria-labelledby="changes-title">
            <div id="changes-title">
              <SectionTitle
                title="Changes"
                description={`${changes.length} price change${changes.length === 1 ? "" : "s"} in the last ${range} days`}
              />
            </div>
            {changes.length === 0 ? (
              <div className="card-surface p-4 text-sm text-muted-foreground">
                No price changes in the last {range} days for this selection.
              </div>
            ) : (
              <div className="card-surface">
                <table className="hidden w-full text-sm sm:table">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Date</th>
                      <th className="px-4 py-3 font-medium">Product</th>
                      <th className="px-4 py-3 font-medium">Store</th>
                      <th className="px-4 py-3 text-right font-medium">Old → new</th>
                      <th className="px-4 py-3 text-right font-medium">Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {changes.map((c) => (
                      <tr key={`${c.productId}-${c.retailer}-${c.date}`}>
                        <td className="whitespace-nowrap px-4 py-3">{formatYmdWeekday(c.date)}</td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/products/${c.productId}`}
                            className="font-medium hover:text-primary"
                          >
                            {c.productName}
                          </Link>
                          <p className="text-xs text-muted-foreground">{c.brand}</p>
                        </td>
                        <td className="px-4 py-3">{c.retailer}</td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                          {usd(c.oldPrice)} → <strong>{usd(c.newPrice)}</strong>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                          <ChangeCell c={c} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-border sm:hidden">
                  {changes.map((c) => (
                    <li
                      key={`${c.productId}-${c.retailer}-${c.date}`}
                      className="space-y-0.5 p-3 text-sm"
                    >
                      <Link href={`/products/${c.productId}`} className="block font-medium">
                        {c.productName}
                      </Link>
                      <p className="text-muted-foreground">
                        {c.retailer} · {formatYmdWeekday(c.date)}
                      </p>
                      <p className="tabular-nums">
                        {usd(c.oldPrice)} → <strong>{usd(c.newPrice)}</strong> <ChangeCell c={c} />
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* Comparison */}
          <section aria-labelledby="compare-title">
            <div id="compare-title">
              <SectionTitle
                title="Lowest price by product"
                description="Today, a week ago and a month ago"
              />
            </div>
            <div className="card-surface">
              <table className="hidden w-full text-sm sm:table">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Product</th>
                    <th className="px-4 py-3 text-right font-medium">Now</th>
                    <th className="px-4 py-3 text-right font-medium">7 days ago</th>
                    <th className="px-4 py-3 text-right font-medium">30 days ago</th>
                    <th className="px-4 py-3 text-right font-medium">Lowest ({range} days)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {comparison.map((row) => (
                    <tr key={row.product.id}>
                      <td className="px-4 py-3">
                        <Link
                          href={`/products/${row.product.id}`}
                          className="font-medium hover:text-primary"
                        >
                          {row.product.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{row.product.brand}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {row.current === null ? "—" : usd(row.current)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {row.ago7 === null ? "—" : usd(row.ago7)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {row.ago30 === null ? "—" : usd(row.ago30)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                        {row.lowest === null ? "—" : usd(row.lowest)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="divide-y divide-border sm:hidden">
                {comparison.map((row) => (
                  <li key={row.product.id} className="p-3 text-sm">
                    <Link href={`/products/${row.product.id}`} className="block font-medium">
                      {row.product.name}
                    </Link>
                    <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums">
                      <dt className="text-muted-foreground">Now</dt>
                      <dd className="text-right font-semibold">
                        {row.current === null ? "—" : usd(row.current)}
                      </dd>
                      <dt className="text-muted-foreground">7 days ago</dt>
                      <dd className="text-right">{row.ago7 === null ? "—" : usd(row.ago7)}</dd>
                      <dt className="text-muted-foreground">30 days ago</dt>
                      <dd className="text-right">{row.ago30 === null ? "—" : usd(row.ago30)}</dd>
                      <dt className="text-muted-foreground">Lowest ({range} days)</dt>
                      <dd className="text-right">{row.lowest === null ? "—" : usd(row.lowest)}</dd>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}
    </AppLayout>
  );
}
