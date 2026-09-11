"use client";

import Link from "next/link";
import { useState } from "react";
import { BookmarkCheck, Globe, Loader2, RefreshCw, TrendingDown, TrendingUp } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import {
  ChangeBadge,
  EmptyState,
  ErrorState,
  Freshness,
  RetailerTag,
  SectionTitle,
  StatCardSkeleton,
  StockBadge,
  TableSkeleton,
} from "@/components/Bits";
import { ProductTable } from "@/components/ProductTable";
import { ProductThumb } from "@/components/ProductThumb";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/format";
import {
  errorMessage,
  useRefreshPrices,
  useTrackedProducts,
  useUntrackProducts,
} from "@/lib/queries";
import { MAJOR_RETAILERS } from "@/lib/retailers";
import { useStore } from "@/lib/store";
import type { TrackedProduct } from "@/lib/types";

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="card-surface flex items-center gap-4 p-5">
      <div
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg"
        style={{ backgroundColor: color + "18" }}
      >
        <Icon className="h-5 w-5" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function ChangeRow({ product }: { product: TrackedProduct }) {
  return (
    <Link
      href={`/products/${product.id}`}
      className="flex flex-wrap items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/60"
    >
      <ProductThumb id={product.id} name={product.name} imageUrl={product.imageUrl} size={36} />
      <div className="min-w-[160px] flex-1">
        <p className="truncate text-sm font-medium">{product.name}</p>
        <p className="text-xs text-muted-foreground">{product.brand}</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold tabular-nums">
          {product.lowestPrice === null ? "—" : usd(product.lowestPrice)}
        </p>
        {product.previousLowest !== null && (
          <p className="text-xs text-muted-foreground line-through tabular-nums">
            {usd(product.previousLowest)}
          </p>
        )}
      </div>
      <ChangeBadge change={product.change} />
      {product.lowestRetailer && <RetailerTag retailer={product.lowestRetailer} />}
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {product.retailerCount} store{product.retailerCount === 1 ? "" : "s"}
      </span>
      <StockBadge inStock={product.inStock} />
    </Link>
  );
}

export default function DashboardPage() {
  const { authed, ready } = useStore();
  const [selected, setSelected] = useState<string[]>([]);

  const { data: products, isLoading, isError, error, refetch } = useTrackedProducts(30, ready && authed);
  const untrack = useUntrackProducts();
  const refresh = useRefreshPrices();

  const list = products ?? [];
  const drops = list.filter((p) => p.change < 0);
  const rises = list.filter((p) => p.change > 0);

  // Real count of retailers actually carrying something we track — the old
  // dashboard printed a hardcoded "15" here.
  const activeRetailers = new Set(list.flatMap((p) => p.offers.map((o) => o.retailer)));
  const bestDrop = drops.slice().sort((a, b) => a.change - b.change)[0];

  const staleest = list
    .map((p) => p.lastCheckedAt)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;

  const refreshAction = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        onClick={() => refresh.mutate(undefined)}
        disabled={refresh.isPending || list.length === 0}
        className="gap-2"
      >
        {refresh.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        Refresh prices
      </Button>
      <Button asChild>
        <Link href="/tracked">+ Add Product</Link>
      </Button>
    </div>
  );

  return (
    <AppLayout
      title="Dashboard"
      subtitle="Your luggage price monitoring overview"
      actions={refreshAction}
    >
      {isLoading ? (
        <>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <StatCardSkeleton key={i} />
            ))}
          </div>
          <TableSkeleton rows={6} />
        </>
      ) : isError ? (
        <ErrorState message={errorMessage(error, "Couldn't load your products.")} onRetry={refetch} />
      ) : list.length === 0 ? (
        <EmptyState
          title="Nothing tracked yet"
          description="Add a product from Tracked Products. Prices and history start recording from that moment."
          action={
            <Button asChild>
              <Link href="/tracked">Add products</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Tracked Products"
              value={String(list.length)}
              icon={BookmarkCheck}
              color="#5B6B4A"
            />
            <StatCard
              label="Price Drops"
              value={String(drops.length)}
              hint={bestDrop ? `Best: ${usd(Math.abs(bestDrop.change))} off` : undefined}
              icon={TrendingDown}
              color="#10B981"
            />
            <StatCard
              label="Price Increases"
              value={String(rises.length)}
              icon={TrendingUp}
              color="#EF4444"
            />
            <StatCard
              label="Retailers Carrying"
              value={String(activeRetailers.size)}
              hint={`of ${MAJOR_RETAILERS.length} majors monitored`}
              icon={Globe}
              color="#6B7280"
            />
          </div>

          {drops.length > 0 && (
            <div className="mb-8">
              <SectionTitle
                title="Price Drops"
                description={`${drops.length} product${drops.length === 1 ? "" : "s"} cheaper than the last check`}
              />
              <div className="card-surface divide-y divide-border overflow-hidden">
                {drops.map((p) => (
                  <ChangeRow key={p.id} product={p} />
                ))}
              </div>
            </div>
          )}

          {rises.length > 0 && (
            <div className="mb-8">
              <SectionTitle
                title="Price Increases"
                description={`${rises.length} product${rises.length === 1 ? "" : "s"} went up`}
              />
              <div className="card-surface divide-y divide-border overflow-hidden">
                {rises.map((p) => (
                  <ChangeRow key={p.id} product={p} />
                ))}
              </div>
            </div>
          )}

          <SectionTitle
            title="All Tracked Products"
            description={`${list.length} product${list.length === 1 ? "" : "s"} monitored`}
            right={<Freshness isoDate={staleest} />}
          />
          <ProductTable
            products={list}
            selected={selected}
            onSelectedChange={setSelected}
            onRemove={(id) => {
              untrack.mutate([id]);
              setSelected((s) => s.filter((x) => x !== id));
            }}
            onRefresh={(id) => refresh.mutate(id)}
            refreshingId={refresh.isPending ? (refresh.variables ?? null) : null}
          />

          {selected.length > 0 && (
            <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-3 shadow-lift">
                <span className="text-sm font-medium">{selected.length} selected</span>
                <button
                  onClick={() => {
                    untrack.mutate(selected);
                    setSelected([]);
                  }}
                  disabled={untrack.isPending}
                  className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-danger-foreground transition-colors hover:bg-danger/90 disabled:opacity-60"
                >
                  Remove Selected
                </button>
                <button
                  onClick={() => setSelected([])}
                  className="text-sm text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </AppLayout>
  );
}
