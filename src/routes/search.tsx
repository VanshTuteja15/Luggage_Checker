import { createFileRoute } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { Search as SearchIcon, X } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { EmptyState, RetailerTag, StockBadge } from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { lowestOffer, type Product } from "@/lib/data";
import { usd } from "@/lib/format";
import { useStore } from "@/lib/store";

export const Route = createFileRoute("/search")({
  head: () => ({
    meta: [{ title: "Search Products — LuggageTracker" }],
  }),
  component: SearchPage,
});

function SearchPage() {
  const { catalog, isTracked, track, recentSearches, addSearch } = useStore();
  const [query, setQuery] = useState("");
  const [searchType, setSearchType] = useState("all");
  const [searched, setSearched] = useState(false);
  const [detail, setDetail] = useState<Product | null>(null);

  const results = useMemo(() => {
    if (!searched || !query.trim()) return [];
    const needle = query.trim().toLowerCase();
    return catalog.filter((p) => {
      const haystack =
        searchType === "upc"
          ? p.upc
          : searchType === "brand"
            ? p.brand
            : searchType === "color"
              ? p.color
              : `${p.name} ${p.brand} ${p.upc} ${p.model} ${p.color}`;
      return haystack.toLowerCase().includes(needle);
    });
  }, [catalog, query, searchType, searched]);

  function doSearch(q?: string) {
    const term = (q ?? query).trim();
    if (!term) return;
    setQuery(term);
    setSearched(true);
    addSearch(term);
  }

  return (
    <AppLayout title="Search Products" subtitle="Find and track luggage across retailers" actions={<div />}>
      {/* Search bar */}
      <div className="card-surface mx-auto mb-8 max-w-2xl p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doSearch();
          }}
          className="flex gap-2"
        >
          <Select value={searchType} onValueChange={setSearchType}>
            <SelectTrigger className="h-10 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="name">Product Name</SelectItem>
              <SelectItem value="upc">UPC</SelectItem>
              <SelectItem value="brand">Brand</SelectItem>
              <SelectItem value="color">Color</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by product name, UPC, brand, or model..."
            className="h-10 flex-1"
          />
          <Button type="submit" className="h-10 gap-2">
            <SearchIcon className="h-4 w-4" />
            Search
          </Button>
        </form>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Search across Amazon, Walmart, Target, and more
        </p>
      </div>

      {/* Recent searches */}
      {!searched && recentSearches.length > 0 && (
        <div className="mx-auto mb-8 max-w-2xl">
          <p className="mb-2 text-sm font-medium text-muted-foreground">Recent Searches</p>
          <div className="flex flex-wrap gap-2">
            {recentSearches.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setQuery(s);
                  doSearch(s);
                }}
                className="rounded-full border border-border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Results */}
      {searched && results.length === 0 && (
        <EmptyState
          title="No products found"
          description="Try a different search term or change the filter type."
        />
      )}

      {results.length > 0 && (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {results.length} result{results.length > 1 ? "s" : ""} found
          </p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {results.map((p) => {
              const low = lowestOffer(p);
              const prices = p.offers.map((o) => o.price);
              const tracked = isTracked(p.id);
              return (
                <div
                  key={p.id}
                  className="card-surface card-hover flex cursor-pointer flex-col overflow-hidden"
                  onClick={() => setDetail(p)}
                >
                  <ProductThumb id={p.id} name={p.name} className="h-36 w-full rounded-none" />
                  <div className="flex flex-1 flex-col gap-1.5 p-4">
                    <p className="line-clamp-2 text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">{p.brand}</p>
                    <p className="mt-auto pt-2 text-base font-semibold">
                      From {usd(Math.min(...prices))} — {usd(Math.max(...prices))}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Found at {p.offers.length} retailer{p.offers.length > 1 ? "s" : ""}
                    </p>
                    <Button
                      variant={tracked ? "outline" : "default"}
                      size="sm"
                      className="mt-2 w-full"
                      disabled={tracked}
                      onClick={(e) => {
                        e.stopPropagation();
                        track(p.id);
                        toast.success(`Now tracking ${p.name}`);
                      }}
                    >
                      {tracked ? "Already Tracked" : "Track This Product"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Product detail modal */}
      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        {detail && (
          <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{detail.name}</DialogTitle>
            </DialogHeader>
            <ProductThumb id={detail.id} name={detail.name} className="h-48 w-full" />
            <div className="space-y-1 text-sm">
              <p>
                <span className="text-muted-foreground">Brand:</span> {detail.brand}
              </p>
              <p>
                <span className="text-muted-foreground">Model:</span> {detail.model}
              </p>
              <p>
                <span className="text-muted-foreground">Color:</span> {detail.color}
              </p>
              <p>
                <span className="text-muted-foreground">UPC:</span> {detail.upc}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Available at</p>
              {detail.offers.map((o) => (
                <div
                  key={o.retailer}
                  className="flex items-center gap-3 rounded-md border border-border p-3"
                >
                  <RetailerTag retailer={o.retailer} />
                  <span className="flex-1 text-right font-semibold">{usd(o.price)}</span>
                  <StockBadge inStock={o.inStock} />
                  <a
                    href={o.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Visit
                  </a>
                </div>
              ))}
            </div>
            <Button
              className="w-full"
              disabled={isTracked(detail.id)}
              onClick={() => {
                track(detail.id);
                toast.success(`Now tracking ${detail.name}`);
                setDetail(null);
              }}
            >
              {isTracked(detail.id) ? "Already Tracked" : "Add to Tracking"}
            </Button>
          </DialogContent>
        )}
      </Dialog>
    </AppLayout>
  );
}
