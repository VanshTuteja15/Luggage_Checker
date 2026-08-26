import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { LayoutGrid, List } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { EmptyState, SectionTitle } from "@/components/Bits";
import { TrackedProductCard } from "@/components/ProductCard";
import { ProductTable } from "@/components/ProductTable";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { lowestOffer, priceChange } from "@/lib/data";
import { useStore } from "@/lib/store";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/tracked")({
  head: () => ({
    meta: [{ title: "Tracked Products — LuggageTracker" }],
  }),
  component: TrackedPage,
});

type SortOption = "name" | "price-asc" | "price-desc" | "drop" | "recent";

function TrackedPage() {
  const { tracked, untrack } = useStore();
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selected, setSelected] = useState<string[]>([]);
  const [brand, setBrand] = useState("all");
  const [stock, setStock] = useState("all");
  const [trend, setTrend] = useState("all");
  const [sortBy, setSortBy] = useState<SortOption>("name");

  const brands = useMemo(
    () => Array.from(new Set(tracked.map((p) => p.brand))).sort(),
    [tracked],
  );

  const filtered = useMemo(() => {
    let list = tracked.filter((p) => {
      const low = lowestOffer(p);
      const ch = priceChange(p);
      if (brand !== "all" && p.brand !== brand) return false;
      if (stock === "in" && !low.inStock) return false;
      if (stock === "out" && low.inStock) return false;
      if (trend === "down" && ch >= 0) return false;
      if (trend === "up" && ch <= 0) return false;
      if (trend === "flat" && ch !== 0) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "price-asc") return lowestOffer(a).price - lowestOffer(b).price;
      if (sortBy === "price-desc") return lowestOffer(b).price - lowestOffer(a).price;
      if (sortBy === "drop") return priceChange(a) - priceChange(b);
      return b.addedDaysAgo - a.addedDaysAgo; // recent = lower addedDaysAgo first... but data is "days ago" so recent = small
    });
    return list;
  }, [tracked, brand, stock, trend, sortBy]);

  function handleRemove(id: string) {
    untrack(id);
    setSelected((s) => s.filter((x) => x !== id));
    toast.success("Removed from tracking");
  }

  return (
    <AppLayout title="Tracked Products" subtitle={`${tracked.length} products monitored`}>
      {tracked.length === 0 ? (
        <EmptyState
          title="No products tracked yet"
          description="Start by searching for luggage products and adding them to tracking."
          action={
            <Button asChild>
              <Link to="/search">Search Products</Link>
            </Button>
          }
        />
      ) : (
        <>
          {/* Toolbar */}
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
              <SelectTrigger className="h-9 w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">Name</SelectItem>
                <SelectItem value="price-asc">Price: Low → High</SelectItem>
                <SelectItem value="price-desc">Price: High → Low</SelectItem>
                <SelectItem value="drop">Biggest Drop</SelectItem>
                <SelectItem value="recent">Recently Added</SelectItem>
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

          <p className="mb-4 text-sm text-muted-foreground">
            {filtered.length} product{filtered.length !== 1 ? "s" : ""}
          </p>

          {view === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((p) => (
                <TrackedProductCard key={p.id} product={p} onRemove={handleRemove} />
              ))}
            </div>
          ) : (
            <ProductTable
              products={filtered}
              selected={selected}
              onSelectedChange={setSelected}
              onRemove={handleRemove}
            />
          )}

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
        </>
      )}
    </AppLayout>
  );
}
