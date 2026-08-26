"use client";

import Link from "next/link";
import { useState } from "react";
import { BookmarkCheck, Globe, TrendingDown, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { ChangeBadge, RetailerTag, SectionTitle, StockBadge } from "@/components/Bits";
import { ProductTable } from "@/components/ProductTable";
import { ProductThumb } from "@/components/ProductThumb";
import { lowestOffer, priceChange, retailerCount, type Product } from "@/lib/data";
import { usd } from "@/lib/format";
import { useStore } from "@/lib/store";

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
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
      </div>
    </div>
  );
}

function ChangeRow({ product }: { product: Product }) {
  const low = lowestOffer(product);
  const change = priceChange(product);
  return (
    <Link
      href={`/products/${product.id}`}
      className="flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-muted/60"
    >
      <ProductThumb id={product.id} name={product.name} size={36} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{product.name}</p>
        <p className="text-xs text-muted-foreground">{product.brand}</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold">{usd(low.price)}</p>
        <p className="text-xs text-muted-foreground line-through">
          {usd(product.previousLowest)}
        </p>
      </div>
      <ChangeBadge change={change} />
      <RetailerTag retailer={low.retailer} />
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {retailerCount(product)} stores
      </span>
      <StockBadge inStock={low.inStock} />
    </Link>
  );
}

export default function DashboardPage() {
  const { tracked, untrack } = useStore();
  const [selected, setSelected] = useState<string[]>([]);

  const drops = tracked.filter((p) => priceChange(p) < 0);
  const rises = tracked.filter((p) => priceChange(p) > 0);

  function handleRemove(id: string) {
    untrack(id);
    setSelected((s) => s.filter((x) => x !== id));
    toast.success("Removed from tracking");
  }

  return (
    <AppLayout title="Dashboard" subtitle="Your luggage price monitoring overview">
      {/* Stat cards */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Tracked Products"
          value={String(tracked.length)}
          icon={BookmarkCheck}
          color="#5B6B4A"
        />
        <StatCard
          label="Price Drops Today"
          value={String(drops.length)}
          icon={TrendingDown}
          color="#10B981"
        />
        <StatCard
          label="Price Increases Today"
          value={String(rises.length)}
          icon={TrendingUp}
          color="#EF4444"
        />
        <StatCard
          label="Retailers Monitored"
          value="15"
          icon={Globe}
          color="#6B7280"
        />
      </div>

      {/* Price drops */}
      {drops.length > 0 && (
        <div className="mb-8">
          <SectionTitle
            title="Today's Price Drops"
            description={`${drops.length} product${drops.length > 1 ? "s" : ""} dropped in price`}
          />
          <div className="card-surface divide-y divide-border overflow-hidden">
            {drops.map((p) => (
              <ChangeRow key={p.id} product={p} />
            ))}
          </div>
        </div>
      )}

      {/* Price increases */}
      {rises.length > 0 && (
        <div className="mb-8">
          <SectionTitle
            title="Today's Price Increases"
            description={`${rises.length} product${rises.length > 1 ? "s" : ""} went up in price`}
          />
          <div className="card-surface divide-y divide-border overflow-hidden">
            {rises.map((p) => (
              <ChangeRow key={p.id} product={p} />
            ))}
          </div>
        </div>
      )}

      {/* All tracked products table */}
      <SectionTitle
        title="All Tracked Products"
        description={`${tracked.length} products monitored`}
      />
      <ProductTable
        products={tracked}
        selected={selected}
        onSelectedChange={setSelected}
        onRemove={handleRemove}
      />

      {/* Bulk actions */}
      {selected.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-5 py-3 shadow-lift">
            <span className="text-sm font-medium">{selected.length} selected</span>
            <button
              onClick={() => {
                untrack(selected);
                setSelected([]);
                toast.success(`Removed ${selected.length} products`);
              }}
              className="rounded-md bg-danger px-3 py-1.5 text-sm font-medium text-danger-foreground transition-colors hover:bg-danger/90"
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
    </AppLayout>
  );
}
