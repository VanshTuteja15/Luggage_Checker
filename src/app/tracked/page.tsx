"use client";

import { useCallback, useMemo, useState } from "react";
import {
  BookmarkCheck,
  BookmarkPlus,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Search as SearchIcon,
  ShoppingBag,
  X,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { CardGridSkeleton, EmptyState, ErrorState, SectionTitle } from "@/components/Bits";
import { TrackedProductCard } from "@/components/ProductCard";
import { ProductTable } from "@/components/ProductTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usd } from "@/lib/format";
import {
  errorMessage,
  useRefreshPrices,
  useSearch,
  useTrackProduct,
  useTrackedProducts,
  useUntrackProducts,
  type SearchApiResponse,
} from "@/lib/queries";
import { retailerColor } from "@/lib/retailers";
import type { SearchProduct } from "@/lib/search/types";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

type SortOption = "name" | "price-asc" | "price-desc" | "drop" | "recent" | "stale";

const CATALOG_SUGGESTIONS = [
  "American Tourister",
  "Samsonite Winfield",
  "Away Carry-On",
  "TUMI Alpha 3",
  "Travelpro Maxlite",
];

export default function TrackedPage() {
  const { authed, ready } = useStore();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [brand, setBrand] = useState("all");
  const [stock, setStock] = useState("all");
  const [trend, setTrend] = useState("all");
  const [sortBy, setSortBy] = useState<SortOption>("name");
  const [adding, setAdding] = useState(false);

  const { data, isLoading, isError, error, refetch } = useTrackedProducts(30, ready && authed);
  const untrack = useUntrackProducts();
  const refresh = useRefreshPrices();

  const tracked = useMemo(() => data ?? [], [data]);

  const trackedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of tracked) {
      set.add(p.slug);
      if (p.upc) set.add(p.upc);
    }
    return set;
  }, [tracked]);

  const brands = useMemo(
    () => Array.from(new Set(tracked.map((p) => p.brand))).sort(),
    [tracked],
  );

  const filtered = useMemo(() => {
    const list = tracked.filter((p) => {
      if (brand !== "all" && p.brand !== brand) return false;
      if (stock === "in" && !p.inStock) return false;
      if (stock === "out" && p.inStock) return false;
      if (trend === "down" && p.change >= 0) return false;
      if (trend === "up" && p.change <= 0) return false;
      if (trend === "flat" && p.change !== 0) return false;
      return true;
    });

    return [...list].sort((a, b) => {
      switch (sortBy) {
        case "price-asc":
          return (a.lowestPrice ?? Infinity) - (b.lowestPrice ?? Infinity);
        case "price-desc":
          return (b.lowestPrice ?? -Infinity) - (a.lowestPrice ?? -Infinity);
        case "drop":
          return a.change - b.change;
        case "recent":
          return b.trackedAt.localeCompare(a.trackedAt);
        case "stale":
          return (a.lastCheckedAt ?? "").localeCompare(b.lastCheckedAt ?? "");
        default:
          return a.name.localeCompare(b.name);
      }
    });
  }, [tracked, brand, stock, trend, sortBy]);

  function handleRemove(id: string) {
    untrack.mutate([id]);
    setSelected((s) => s.filter((x) => x !== id));
  }

  const actions = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        onClick={() => refresh.mutate(undefined)}
        disabled={refresh.isPending || tracked.length === 0}
        className="gap-2"
      >
        {refresh.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="h-4 w-4" />
        )}
        Refresh
      </Button>
      <Button
        onClick={() => setAdding((v) => !v)}
        variant={adding ? "outline" : "default"}
        className="gap-2"
      >
        {adding ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        {adding ? "Close" : "Add Product"}
      </Button>
    </div>
  );

  return (
    <AppLayout
      title="Tracked Products"
      subtitle={isLoading ? "Loading…" : `${tracked.length} product${tracked.length === 1 ? "" : "s"} monitored`}
      actions={actions}
    >
      {adding && (
        <CatalogAddPanel
          trackedKeys={trackedKeys}
          onClose={() => setAdding(false)}
        />
      )}

      {isLoading ? (
        <CardGridSkeleton />
      ) : isError ? (
        <ErrorState message={errorMessage(error, "Couldn't load your products.")} onRetry={refetch} />
      ) : tracked.length === 0 && !adding ? (
        <EmptyState
          title="No products tracked yet"
          description="Search a brand or product name below to see live types, sizes and colours — then add the ones you want to watch."
          action={
            <Button onClick={() => setAdding(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add products
            </Button>
          }
        />
      ) : tracked.length === 0 && adding ? null : (
        <>
          <div className="mb-6 flex flex-wrap items-center gap-2">
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

            <Select value={stock} onValueChange={setStock}>
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stock</SelectItem>
                <SelectItem value="in">In Stock</SelectItem>
                <SelectItem value="out">Out of Stock</SelectItem>
              </SelectContent>
            </Select>

            <Select value={trend} onValueChange={setTrend}>
              <SelectTrigger className="h-9 w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any trend</SelectItem>
                <SelectItem value="down">Dropping</SelectItem>
                <SelectItem value="up">Rising</SelectItem>
                <SelectItem value="flat">Stable</SelectItem>
              </SelectContent>
            </Select>

            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
              <SelectTrigger className="h-9 w-[170px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="price-asc">Price: Low → High</SelectItem>
                <SelectItem value="price-desc">Price: High → Low</SelectItem>
                <SelectItem value="drop">Biggest Drop</SelectItem>
                <SelectItem value="recent">Recently Added</SelectItem>
                <SelectItem value="stale">Least Recently Checked</SelectItem>
              </SelectContent>
            </Select>

            <div className="ml-auto flex rounded-md border border-border">
              <button
                onClick={() => setView("grid")}
                className={`p-2 ${view === "grid" ? "bg-muted" : ""}`}
                aria-label="Grid view"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
              <button
                onClick={() => setView("list")}
                className={`p-2 ${view === "list" ? "bg-muted" : ""}`}
                aria-label="List view"
              >
                <List className="h-4 w-4" />
              </button>
            </div>
          </div>

          <SectionTitle
            title={`${filtered.length} product${filtered.length === 1 ? "" : "s"}`}
            description={
              filtered.length !== tracked.length
                ? `Filtered from ${tracked.length} tracked`
                : undefined
            }
          />

          {filtered.length === 0 ? (
            <EmptyState
              title="Nothing matches those filters"
              description="Try clearing a filter to see your tracked products."
            />
          ) : view === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p) => (
                <TrackedProductCard
                  key={p.id}
                  product={p}
                  onRemove={handleRemove}
                  onRefresh={(id) => refresh.mutate(id)}
                  refreshing={refresh.isPending && refresh.variables === p.id}
                />
              ))}
            </div>
          ) : (
            <ProductTable
              products={filtered}
              selected={selected}
              onSelectedChange={setSelected}
              onRemove={handleRemove}
              onRefresh={(id) => refresh.mutate(id)}
              refreshingId={refresh.isPending ? (refresh.variables ?? null) : null}
            />
          )}

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

/* ------------------------------------------------------------------ */
/*  Catalog add — live variant search, independent of Search Products */
/* ------------------------------------------------------------------ */

function CatalogAddPanel({
  trackedKeys,
  onClose,
}: {
  trackedKeys: Set<string>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchApiResponse | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sizeFilter, setSizeFilter] = useState("all");
  const [colorFilter, setColorFilter] = useState("all");
  const searchMutation = useSearch();

  const runSearch = useCallback(
    (raw?: string) => {
      const term = (raw ?? query).trim();
      if (!term || searchMutation.isPending) return;
      setQuery(term);
      setResponse(null);
      setTypeFilter("all");
      setSizeFilter("all");
      setColorFilter("all");
      searchMutation.mutate(
        { query: term, mode: "catalog", allRetailers: true },
        { onSuccess: (data) => setResponse(data) },
      );
    },
    [query, searchMutation],
  );

  const products = response?.products ?? [];

  const types = useMemo(
    () => unique(products.map((p) => p.productType).filter(Boolean) as string[]),
    [products],
  );
  const sizes = useMemo(
    () => unique(products.map((p) => p.size).filter(Boolean)),
    [products],
  );
  const colors = useMemo(
    () => unique(products.map((p) => p.color).filter(Boolean)),
    [products],
  );

  const visible = useMemo(
    () =>
      products.filter((p) => {
        if (typeFilter !== "all" && p.productType !== typeFilter) return false;
        if (sizeFilter !== "all" && p.size !== sizeFilter) return false;
        if (colorFilter !== "all" && p.color !== colorFilter) return false;
        return true;
      }),
    [products, typeFilter, sizeFilter, colorFilter],
  );

  const families = useMemo(() => groupFamilies(visible), [visible]);

  return (
    <div className="card-surface mb-8">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Add products to track</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Search a brand or name. We&apos;ll list live types, sizes and colours from Canadian retailers.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close add panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-5 py-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
          className="relative max-w-2xl"
        >
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="American Tourister, Samsonite Winfield, Away Bigger Carry-On…"
            className="h-12 rounded-lg pl-10 pr-28"
            disabled={searchMutation.isPending}
            maxLength={200}
          />
          <Button
            type="submit"
            disabled={!query.trim() || searchMutation.isPending}
            className="absolute right-1.5 top-1/2 h-9 -translate-y-1/2 gap-2 rounded-md px-4"
          >
            {searchMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SearchIcon className="h-4 w-4" />
            )}
            Search
          </Button>
        </form>

        {!response && !searchMutation.isPending && !searchMutation.isError && (
          <div className="mt-3 flex flex-wrap gap-2">
            {CATALOG_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => runSearch(s)}
                className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {searchMutation.isPending && (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Looking up live variants for &ldquo;{query}&rdquo;…
          </p>
        )}

        {searchMutation.isError && !searchMutation.isPending && (
          <p className="mt-4 text-sm text-danger">
            {errorMessage(searchMutation.error, "Search failed.")}{" "}
            <button type="button" className="underline" onClick={() => runSearch()}>
              Try again
            </button>
          </p>
        )}

        {response && !searchMutation.isPending && (
          <div className="mt-5">
            <p className="text-sm text-muted-foreground">{response.intent.explanation}</p>

            {products.length > 0 && (types.length > 0 || sizes.length > 0 || colors.length > 0) && (
              <div className="mt-3 flex flex-wrap gap-2">
                <ChipFilter label="Type" value={typeFilter} options={types} onChange={setTypeFilter} />
                <ChipFilter label="Size" value={sizeFilter} options={sizes} onChange={setSizeFilter} />
                <ChipFilter label="Colour" value={colorFilter} options={colors} onChange={setColorFilter} />
              </div>
            )}

            {visible.length === 0 ? (
              <p className="mt-4 text-sm text-muted-foreground">
                {products.length === 0
                  ? `Nothing live for "${response.query}". Try a broader brand name.`
                  : "No variants match those filters."}
              </p>
            ) : (
              <div className="mt-4 space-y-6">
                {families.map((family) => (
                  <div key={family.key}>
                    <p className="mb-2 text-sm font-semibold">
                      {family.brand}
                      {family.model && family.model !== family.brand ? ` ${family.model}` : ""}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {family.variants.length} variant
                        {family.variants.length === 1 ? "" : "s"}
                      </span>
                    </p>
                    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                      {family.variants.map((product) => (
                        <VariantRow
                          key={product.key + product.lowestPrice}
                          product={product}
                          alreadyTracked={
                            trackedKeys.has(product.key) ||
                            (!!product.upc && trackedKeys.has(product.upc))
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ChipFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn(
          "rounded-full px-2.5 py-0.5 text-xs",
          value === "all" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        All
      </button>
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={cn(
            "rounded-full px-2.5 py-0.5 text-xs",
            value === opt ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function VariantRow({
  product,
  alreadyTracked,
}: {
  product: SearchProduct;
  alreadyTracked: boolean;
}) {
  const track = useTrackProduct();
  const best = product.offers[0];

  return (
    <div className="flex items-center gap-3 bg-card px-3 py-2.5">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={product.imageUrl}
            alt=""
            className="h-full w-full object-contain p-0.5"
            loading="lazy"
          />
        ) : (
          <ShoppingBag className="h-4 w-4 text-muted-foreground" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{product.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {product.productType ? <span>{product.productType}</span> : null}
          {product.size ? <span>{product.size}</span> : null}
          {product.color ? <span>{product.color}</span> : null}
          {best && (
            <span className="inline-flex items-center gap-1">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: retailerColor(best.retailer) }}
              />
              {best.retailer}
            </span>
          )}
        </p>
      </div>

      <p className="shrink-0 text-sm font-semibold tabular-nums">{usd(product.lowestPrice)}</p>

      <Button
        size="sm"
        variant={alreadyTracked ? "outline" : "default"}
        disabled={alreadyTracked || track.isPending}
        className="h-8 shrink-0 gap-1.5 text-xs"
        onClick={() => track.mutate(product)}
      >
        {track.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : alreadyTracked ? (
          <BookmarkCheck className="h-3.5 w-3.5" />
        ) : (
          <BookmarkPlus className="h-3.5 w-3.5" />
        )}
        {alreadyTracked ? "Added" : "Add"}
      </Button>
    </div>
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function groupFamilies(products: SearchProduct[]) {
  const map = new Map<string, { key: string; brand: string; model: string; variants: SearchProduct[] }>();
  for (const p of products) {
    const key = `${p.brand}|${p.model}`.toLowerCase();
    const existing = map.get(key);
    if (existing) existing.variants.push(p);
    else {
      map.set(key, {
        key,
        brand: p.brand,
        model: p.model || p.name,
        variants: [p],
      });
    }
  }
  return [...map.values()];
}
