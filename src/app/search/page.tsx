"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  BookmarkCheck,
  BookmarkPlus,
  ChevronDown,
  Clock,
  ExternalLink,
  Globe,
  LayoutList,
  Loader2,
  Palette,
  ShoppingBag,
  Sparkles,
  Store,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { EmptyState } from "@/components/Bits";
import { SearchBox } from "@/components/SearchBox";
import { Button } from "@/components/ui/button";
import { usd } from "@/lib/format";
import {
  useSearchProvider,
  useStreamingSearch,
  useTrackProduct,
  useTrackedProducts,
} from "@/lib/queries";
import { PRIORITY_RETAILERS, retailerColor } from "@/lib/retailers";
import type { AlsoCheck, Offer, SearchProduct } from "@/lib/search/types";
import { useStore } from "@/lib/store";

/** "cached 12 min ago" / "cached 3h ago" — short enough for a chip. */
function formatAge(minutes: number): string {
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const SUGGESTIONS = [
  "Samsonite Outline Pro",
  "Samsonite Freeform 21",
  "TUMI Alpha 3",
  "hardside luggage set under $400",
  "Travelpro Maxlite 5 carry-on",
  "Briggs & Riley Baseline",
];

type SortKey = "price-asc" | "price-desc" | "stores";
type View = "products" | "stores";

/** Full matches before partial ones, whatever the sort. */
function tier(p: SearchProduct): number {
  return (p.relevance ?? 1) >= 0.99 ? 0 : 1;
}

function sortProducts(products: SearchProduct[], sort: SortKey): SearchProduct[] {
  // The server already orders best match → lowest price, with accessories
  // last. "Lowest price" keeps that order exactly.
  if (sort === "price-asc") return products;
  return [...products].sort((a, b) => {
    if (tier(a) !== tier(b)) return tier(a) - tier(b);
    if (sort === "price-desc") return b.lowestPrice - a.lowestPrice;
    if (a.retailerCount !== b.retailerCount) return b.retailerCount - a.retailerCount;
    return a.lowestPrice - b.lowestPrice;
  });
}

export default function SearchPage() {
  const { recentSearches, addSearch, removeSearch, clearSearches, authed } = useStore();
  const [query, setQuery] = useState("");
  const [lastTerm, setLastTerm] = useState("");
  const [sort, setSort] = useState<SortKey>("price-asc");
  const [view, setView] = useState<View>("products");

  const search = useStreamingSearch();
  const provider = useSearchProvider(authed);
  const { data: tracked } = useTrackedProducts(30, authed);

  const trackedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of tracked ?? []) {
      set.add(p.slug);
      if (p.upc) set.add(p.upc);
    }
    return set;
  }, [tracked]);

  const runSearch = useCallback(
    (raw?: string, forceRefresh = false) => {
      const term = (raw ?? query).trim();
      if (!term) return;
      setQuery(term);
      setLastTerm(term);
      addSearch(term);
      void search.run({ query: term, refresh: forceRefresh });
    },
    [query, addSearch, search],
  );

  const response = search.data;
  const notConfigured = provider.data && provider.data.configured === false;
  const lowBudget = (provider.data?.budgets ?? []).find((b) => b.remaining <= 25 && !b.exhausted);
  const hasSearched = search.status !== "idle";

  const products = useMemo(
    () => (response ? sortProducts(response.products, sort) : []),
    [response, sort],
  );

  return (
    <AppLayout
      title="Search Products"
      subtitle="Live lowest prices from Amazon, Walmart, Samsonite and 15+ Canadian retailers"
      actions={<div />}
    >
      {/* ── Search bar ──────────────────────────────────────── */}
      <div className="mx-auto mb-8 max-w-3xl">
        <SearchBox
          value={query}
          onChange={setQuery}
          onSearch={(t) => runSearch(t)}
          history={recentSearches}
          onRemoveHistory={removeSearch}
          onClearHistory={clearSearches}
          suggestions={SUGGESTIONS}
          pending={search.isPending}
          placeholder="Search like Google — e.g. Samsonite Outline Pro carry-on"
        />

        <p className="mt-2 text-center text-xs text-muted-foreground">
          {provider.data?.providerLabel
            ? `AI search via ${provider.data.providerLabel} · live CAD prices`
            : "AI search across major Canadian retailers"}
          {lowBudget && (
            <>
              {" · "}
              <span className="font-medium text-danger">
                {lowBudget.remaining} credit{lowBudget.remaining === 1 ? "" : "s"} left
              </span>
            </>
          )}
        </p>

        <div className="mt-3 flex flex-wrap justify-center gap-1.5">
          {PRIORITY_RETAILERS.slice(0, 8).map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground"
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: retailerColor(name) }} />
              {name.replace(".ca", "")}
            </span>
          ))}
        </div>
      </div>

      {/* ── No price source configured ──────────────────────── */}
      {notConfigured && (
        <div className="mx-auto mb-8 max-w-3xl rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm">
          <p className="flex items-center gap-2 font-medium text-danger">
            <AlertTriangle className="h-4 w-4" />
            No research provider is configured
          </p>
          <p className="mt-1 text-muted-foreground">
            Add <code className="rounded bg-muted px-1">TAVILY_API_KEY</code> to{" "}
            <code className="rounded bg-muted px-1">.env.local</code>, then restart the app. The free
            plan gives 1,000 credits a month with no card, and the app stops before the limit.
          </p>
        </div>
      )}

      {/* ── Pre-search ──────────────────────────────────────── */}
      {!hasSearched && !notConfigured && (
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 text-sm font-medium text-muted-foreground">Try a search</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SUGGESTIONS.map((label) => (
              <button
                key={label}
                onClick={() => runSearch(label)}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
              >
                <ShoppingBag className="h-4 w-4 shrink-0 text-muted-foreground" />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Searching (nothing to show yet) ─────────────────── */}
      {search.status === "searching" && (
        <div className="mx-auto max-w-4xl space-y-3">
          <div className="flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Searching Amazon, Walmart, Samsonite and more for &ldquo;{lastTerm}&rdquo;…
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse rounded-xl border border-border bg-card p-4">
              <div className="flex gap-4">
                <div className="h-20 w-20 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2 py-1">
                  <div className="h-4 w-2/3 rounded bg-muted" />
                  <div className="h-3 w-1/3 rounded bg-muted" />
                  <div className="h-3 w-1/2 rounded bg-muted" />
                </div>
                <div className="h-6 w-20 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────── */}
      {search.status === "error" && (
        <EmptyState
          title="Search failed"
          description={search.error ?? "Something went wrong."}
          action={
            <Button variant="outline" onClick={() => runSearch(lastTerm)}>
              Try again
            </Button>
          }
        />
      )}

      {/* ── Results (first results while reading, then final) ─ */}
      {response && (search.status === "reading" || search.status === "done") && (
        <div className="mx-auto max-w-4xl">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2 text-sm">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="text-muted-foreground">{response.intent.explanation}</span>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {response.cached && search.status === "done" && (
                <button
                  onClick={() => runSearch(lastTerm, true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  title="Re-check prices now (uses research credits)"
                >
                  <Clock className="h-3 w-3" />
                  cached {formatAge(response.cached.ageMinutes)} · re-check
                </button>
              )}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                <Globe className="h-3 w-3" />
                {response.providerLabel}
              </span>
            </div>
          </div>

          {search.status === "reading" && (
            <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              First results shown · reading prices from more store pages (brand store, Walmart, Best Buy…)
            </div>
          )}

          {response.warnings.length > 0 && search.status === "done" && (
            <div className="mb-4 space-y-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
              {response.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 text-xs text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {w}
                </p>
              ))}
            </div>
          )}

          {response.products.length === 0 ? (
            <EmptyState
              title="No products found"
              description={
                response.offersFound > 0
                  ? `Found ${response.offersFound} listings but none matched your filters. Try widening your retailer selection in Settings.`
                  : `Nothing found for "${response.query}". Try a broader search.`
              }
            />
          ) : (
            <>
              <ResultsToolbar
                productCount={response.products.length}
                listingCount={response.products.reduce((n, p) => n + p.offers.length, 0)}
                storeCount={new Set(response.products.flatMap((p) => p.offers.map((o) => o.retailer))).size}
                sort={sort}
                onSort={setSort}
                view={view}
                onView={setView}
              />

              {view === "products" ? (
                <div className="space-y-3">
                  {products.map((product, i) => (
                    <ProductResult
                      key={product.key + product.lowestPrice + i}
                      product={product}
                      rank={i}
                      alreadyTracked={
                        trackedKeys.has(product.key) || (!!product.upc && trackedKeys.has(product.upc))
                      }
                    />
                  ))}
                </div>
              ) : (
                <AllStoresList products={products} sort={sort} />
              )}
            </>
          )}

          {search.status === "done" && (response.alsoCheck?.length ?? 0) > 0 && (
            <AlsoCheckList links={response.alsoCheck ?? []} />
          )}
        </div>
      )}
    </AppLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Toolbar: counts, sort, view                                       */
/* ------------------------------------------------------------------ */

function ResultsToolbar({
  productCount,
  listingCount,
  storeCount,
  sort,
  onSort,
  view,
  onView,
}: {
  productCount: number;
  listingCount: number;
  storeCount: number;
  sort: SortKey;
  onSort: (s: SortKey) => void;
  view: View;
  onView: (v: View) => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">
        {productCount} product{productCount === 1 ? "" : "s"} · {listingCount} listing
        {listingCount === 1 ? "" : "s"} · {storeCount} store{storeCount === 1 ? "" : "s"}
      </p>

      <div className="flex items-center gap-2">
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5 text-xs">
          <button
            onClick={() => onView("products")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${
              view === "products" ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
            }`}
          >
            <LayoutList className="h-3.5 w-3.5" />
            By product
          </button>
          <button
            onClick={() => onView("stores")}
            className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 ${
              view === "stores" ? "bg-muted font-medium text-foreground" : "text-muted-foreground"
            }`}
          >
            <Store className="h-3.5 w-3.5" />
            All stores
          </button>
        </div>

        <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground">
          <ArrowDownUp className="h-3.5 w-3.5" />
          <span className="sr-only">Sort</span>
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value as SortKey)}
            className="bg-transparent text-foreground outline-none"
          >
            <option value="price-asc">Price: low to high</option>
            <option value="price-desc">Price: high to low</option>
            <option value="stores">Most stores</option>
          </select>
        </label>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Product card                                                      */
/* ------------------------------------------------------------------ */

function ProductResult({
  product,
  rank,
  alreadyTracked,
}: {
  product: SearchProduct;
  rank: number;
  alreadyTracked: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const track = useTrackProduct();

  const best = product.offers[0];
  const savings = product.spread;
  const colours = product.colours ?? (product.color ? [product.color] : []);

  return (
    <div className="rounded-xl border border-border bg-card transition-colors hover:border-foreground/20">
      <div className="flex gap-4 p-4">
        <div className="relative flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-1" loading="lazy" />
          ) : (
            <ShoppingBag className="h-7 w-7 text-muted-foreground" />
          )}
          {rank === 0 && (product.relevance ?? 1) >= 0.99 && (
            <span className="absolute inset-x-0 bottom-0 bg-success py-0.5 text-center text-[10px] font-semibold text-success-foreground">
              LOWEST
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{product.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {product.brand}
            {product.size ? ` · ${product.size}` : ""}
            {product.productType ? ` · ${product.productType}` : ""}
          </p>
          {specLine(product) && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground/80">{specLine(product)}</p>
          )}

          {colours.length > 0 && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Palette className="h-3 w-3 shrink-0" />
              <span className="line-clamp-1">
                {colours.slice(0, 6).join(" · ")}
                {colours.length > 6 ? ` +${colours.length - 6} more` : ""}
              </span>
            </p>
          )}

          {/* Every store, cheapest first */}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {product.offers.slice(0, 5).map((offer, i) => (
              <a
                key={offer.url}
                href={offer.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1 text-[11px] hover:underline ${
                  i === 0 ? "font-semibold text-success" : "text-muted-foreground"
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: retailerColor(offer.retailer) }} />
                {offer.retailer.replace(/\.ca$/, "")} {usd(offer.price)}
              </a>
            ))}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              {product.retailerCount} store{product.retailerCount === 1 ? "" : "s"}
            </span>
            {savings > 0 && <span className="font-medium text-success">Save {usd(savings)} vs highest</span>}
            {product.retailerCount > 1 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                {expanded ? "Hide" : "Compare"} all prices
                <ChevronDown className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`} />
              </button>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end justify-between gap-2">
          <div className="text-right">
            <p className="text-lg font-bold leading-tight">{usd(product.lowestPrice)}</p>
            <p className="text-[11px] text-muted-foreground">at {best.retailer}</p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={alreadyTracked ? "outline" : "default"}
              size="sm"
              disabled={alreadyTracked || track.isPending}
              className="h-8 gap-1.5 text-xs"
              onClick={() => track.mutate(product)}
            >
              {track.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : alreadyTracked ? (
                <BookmarkCheck className="h-3.5 w-3.5" />
              ) : (
                <BookmarkPlus className="h-3.5 w-3.5" />
              )}
              {alreadyTracked ? "Tracked" : "Track"}
            </Button>
            <a
              href={best.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Visit <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          <div className="space-y-1.5">
            {product.offers.map((offer, i) => (
              <OfferRow key={offer.url} offer={offer} position={i + 1} isBest={i === 0} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Specs the retailer pages stated, as one compact line. Empty if none. */
function specLine(product: SearchProduct): string {
  const d = product.details;
  if (!d) return "";
  return [
    d.dimensions,
    d.weight,
    d.capacity,
    d.material,
    d.wheels,
    d.expandable ? "Expandable" : null,
    d.tsaLock ? "TSA lock" : null,
    d.warranty ? `${d.warranty} warranty` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function OfferRow({ offer, position, isBest }: { offer: Offer; position: number; isBest: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{position}</span>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: retailerColor(offer.retailer) }} />
      <span className="min-w-0 flex-1 truncate">
        {offer.retailer}
        {offer.colour && <span className="text-muted-foreground"> · {offer.colour}</span>}
      </span>
      {!offer.inStock && (
        <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-xs text-danger">Out of stock</span>
      )}
      <span
        className={`shrink-0 tabular-nums ${isBest ? "font-semibold text-success" : ""}`}
        title={offer.evidence ? `Read from the page: ${offer.evidence}` : undefined}
      >
        {usd(offer.price)}
      </span>
      <a
        href={offer.url}
        target="_blank"
        rel="noopener noreferrer"
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        aria-label={`Open ${offer.retailer} listing`}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  All stores: every listing in one list, cheapest first             */
/* ------------------------------------------------------------------ */

function AllStoresList({ products, sort }: { products: SearchProduct[]; sort: SortKey }) {
  const rows = useMemo(() => {
    const list = products.flatMap((p) => p.offers.map((o) => ({ o, p, t: tier(p) })));
    return list.sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t;
      if (sort === "price-desc") return b.o.price - a.o.price;
      return a.o.price - b.o.price;
    });
  }, [products, sort]);

  const firstRelated = rows.findIndex((r) => r.t > 0);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {rows.map(({ o, p, t }, i) => (
        <div key={o.url + i}>
          {i === firstRelated && i > 0 && (
            <div className="border-t border-border bg-muted/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Related listings
            </div>
          )}
          <a
            href={o.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/50 ${
              i > 0 ? "border-t border-border" : ""
            }`}
          >
            <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: retailerColor(o.retailer) }} />
            <span className="w-32 shrink-0 truncate font-medium">{o.retailer}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {p.name}
              {o.colour ? ` · ${o.colour}` : ""}
            </span>
            {!o.inStock && (
              <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-xs text-danger">Out of stock</span>
            )}
            {i === 0 && t === 0 && (
              <span className="shrink-0 rounded bg-success/10 px-1.5 py-0.5 text-[10px] font-semibold text-success">
                LOWEST
              </span>
            )}
            <span
              className={`w-24 shrink-0 text-right tabular-nums ${i === 0 && t === 0 ? "font-bold text-success" : "font-semibold"}`}
              title={o.evidence ? `Read from the page: ${o.evidence}` : undefined}
            >
              {usd(o.price)}
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </a>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Stores that list it without a readable price                      */
/* ------------------------------------------------------------------ */

function AlsoCheckList({ links }: { links: AlsoCheck[] }) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-border px-4 py-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Also listed at — price not readable automatically, check on the store&rsquo;s site
      </p>
      <div className="flex flex-wrap gap-2">
        {links.map((l) => (
          <a
            key={l.url}
            href={l.url}
            target="_blank"
            rel="noopener noreferrer"
            title={l.title}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs hover:bg-muted"
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: retailerColor(l.retailer) }} />
            {l.retailer}
            <ExternalLink className="h-3 w-3 text-muted-foreground" />
          </a>
        ))}
      </div>
    </div>
  );
}
