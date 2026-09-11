"use client";

import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookmarkCheck,
  BookmarkPlus,
  ChevronDown,
  Clock,
  ExternalLink,
  Globe,
  Loader2,
  Search as SearchIcon,
  ShoppingBag,
  Sparkles,
  Star,
  TrendingDown,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { EmptyState } from "@/components/Bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usd } from "@/lib/format";
import {
  errorMessage,
  useSearch,
  useSearchProvider,
  useTrackProduct,
  useTrackedProducts,
  type SearchApiResponse,
} from "@/lib/queries";
import { PRIORITY_RETAILERS, retailerColor } from "@/lib/retailers";
import type { Offer, SearchProduct } from "@/lib/search/types";
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
  { label: "Samsonite carry-on spinner", icon: ShoppingBag },
  { label: "TUMI Alpha 3", icon: ShoppingBag },
  { label: "hardside luggage set under $400", icon: TrendingDown },
  { label: "Away Bigger Carry-On", icon: ShoppingBag },
  { label: "lightweight checked bag under $250", icon: TrendingDown },
  { label: "Briggs & Riley Baseline", icon: Globe },
];

export default function SearchPage() {
  const { recentSearches, addSearch, authed } = useStore();
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchApiResponse | null>(null);

  const searchMutation = useSearch();
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
      if (!term || searchMutation.isPending) return;

      setQuery(term);
      addSearch(term);
      setResponse(null);

      searchMutation.mutate(
        { query: term, refresh: forceRefresh, mode: "compare" },
        { onSuccess: (data) => setResponse(data) },
      );
    },
    [query, addSearch, searchMutation],
  );

  const notConfigured = provider.data && provider.data.configured === false;

  // Only nag about the allowance when it's actually getting tight.
  const lowBudget = (provider.data?.budgets ?? []).find(
    (b) => b.remaining <= 25 && !b.exhausted,
  );
  const hasSearched = searchMutation.isSuccess || searchMutation.isError || searchMutation.isPending;

  return (
    <AppLayout
      title="Search Products"
      subtitle="Live lowest prices from Amazon, Walmart, Samsonite and 15+ Canadian retailers"
      actions={<div />}
    >
      {/* ── Search bar ──────────────────────────────────────── */}
      <div className="mx-auto mb-8 max-w-3xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
          className="relative"
        >
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask like a search engine — e.g. Samsonite Winfield 2 28 inch under $400"
            className="h-14 rounded-2xl pl-12 pr-28 text-base shadow-sm"
            disabled={searchMutation.isPending}
            maxLength={200}
          />
          <Button
            type="submit"
            disabled={!query.trim() || searchMutation.isPending}
            className="absolute right-2 top-1/2 h-10 -translate-y-1/2 gap-2 rounded-xl px-5"
          >
            {searchMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SearchIcon className="h-4 w-4" />
            )}
            Search
          </Button>
        </form>

        <p className="mt-2 text-center text-xs text-muted-foreground">
          {provider.data?.providerLabel
            ? `AI search via ${provider.data.providerLabel} · live CAD prices`
            : "AI search across major Canadian retailers"}
          {lowBudget && (
            <>
              {" · "}
              <span className="font-medium text-danger">
                {lowBudget.remaining} search{lowBudget.remaining === 1 ? "" : "es"} left
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
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: retailerColor(name) }}
              />
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
            No price source is configured
          </p>
          <p className="mt-1 text-muted-foreground">
            Add a <code className="rounded bg-muted px-1">SERPER_API_KEY</code> (2,500 free
            searches) or <code className="rounded bg-muted px-1">SERPAPI_KEY</code> (250 free per
            month) to <code className="rounded bg-muted px-1">.env.local</code>, then restart the
            app. Both are free and neither asks for a card.
          </p>
        </div>
      )}

      {/* ── Pre-search ──────────────────────────────────────── */}
      {!hasSearched && !notConfigured && (
        <div className="mx-auto max-w-3xl space-y-8">
          <div>
            <p className="mb-3 text-sm font-medium text-muted-foreground">Try a search</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => runSearch(s.label)}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
                >
                  <s.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {recentSearches.length > 0 && (
            <div>
              <p className="mb-3 text-sm font-medium text-muted-foreground">Recent searches</p>
              <div className="flex flex-wrap gap-2">
                {recentSearches.map((s) => (
                  <button
                    key={s}
                    onClick={() => runSearch(s)}
                    className="rounded-full border border-border bg-card px-4 py-1.5 text-sm transition-colors hover:bg-muted"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Loading ─────────────────────────────────────────── */}
      {searchMutation.isPending && (
        <div className="mx-auto max-w-4xl space-y-3">
          <div className="flex items-center justify-center gap-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Checking Amazon, Walmart, Samsonite and more for &ldquo;{query}&rdquo;…
          </div>
          {[0, 1, 2].map((i) => (
            <div key={i} className="animate-pulse rounded-xl border border-border bg-card p-4">
              <div className="flex gap-4">
                <div className="h-24 w-24 shrink-0 rounded-lg bg-muted" />
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
      {searchMutation.isError && !searchMutation.isPending && (
        <EmptyState
          title="Search failed"
          description={errorMessage(searchMutation.error, "Something went wrong.")}
          action={
            <Button variant="outline" onClick={() => runSearch()}>
              Try again
            </Button>
          }
        />
      )}

      {/* ── Results ─────────────────────────────────────────── */}
      {response && !searchMutation.isPending && (
        <div className="mx-auto max-w-4xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2 text-sm">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span className="text-muted-foreground">{response.intent.explanation}</span>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {/* A cached result is free but must never look live. */}
              {response.cached && (
                <button
                  onClick={() => runSearch(query, true)}
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  title="Re-check prices now (uses one search from your allowance)"
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

          {response.warnings.length > 0 && (
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
              <p className="mb-3 text-sm text-muted-foreground">
                Lowest prices across {response.products.length} product
                {response.products.length === 1 ? "" : "s"} · {response.offersFound} live listings
              </p>
              <div className="space-y-3">
                {response.products.map((product) => (
                  <ProductResult
                    key={product.key + product.lowestPrice}
                    product={product}
                    alreadyTracked={
                      trackedKeys.has(product.key) ||
                      (!!product.upc && trackedKeys.has(product.upc))
                    }
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </AppLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Result card                                                       */
/* ------------------------------------------------------------------ */

function ProductResult({
  product,
  alreadyTracked,
}: {
  product: SearchProduct;
  alreadyTracked: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const track = useTrackProduct();

  const best = product.offers[0];
  const savings = product.spread;

  return (
    <div className="rounded-xl border border-border bg-card transition-colors hover:border-foreground/20">
      <div className="flex gap-4 p-4">
        {/* Thumbnail */}
        <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
          {product.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.imageUrl}
              alt={product.name}
              className="h-full w-full object-contain p-1"
              loading="lazy"
            />
          ) : (
            <ShoppingBag className="h-8 w-8 text-muted-foreground" />
          )}
        </div>

        {/* Details */}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{product.name}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {product.brand}
            {product.size ? ` · ${product.size}` : ""}
            {product.color ? ` · ${product.color}` : ""}
            {product.productType ? ` · ${product.productType}` : ""}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: retailerColor(best.retailer) }}
              />
              Best at {best.retailer}
            </span>
            <span>
              {product.retailerCount} retailer{product.retailerCount === 1 ? "" : "s"}
            </span>
            {savings > 0 && (
              <span className="font-medium text-success">Save {usd(savings)} vs highest</span>
            )}
            {best.rating != null && (
              <span className="inline-flex items-center gap-1">
                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                {best.rating.toFixed(1)}
                {best.reviews != null && ` (${best.reviews.toLocaleString()})`}
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {product.offers.slice(0, 4).map((offer) => (
              <span key={offer.url} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: retailerColor(offer.retailer) }}
                />
                {offer.retailer.replace(".ca", "")} {usd(offer.price)}
              </span>
            ))}
          </div>

          {product.retailerCount > 1 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              {expanded ? "Hide" : "Compare"} all {product.retailerCount} retailer prices
              <ChevronDown
                className={`h-3 w-3 transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </div>

        {/* Price + track */}
        <div className="flex shrink-0 flex-col items-end justify-between gap-2">
          <div className="text-right">
            <p className="text-lg font-bold leading-tight">{usd(product.lowestPrice)}</p>
            {product.highestPrice > product.lowestPrice && (
              <p className="text-xs text-muted-foreground line-through">
                {usd(product.highestPrice)}
              </p>
            )}
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

      {/* Offer comparison */}
      {expanded && (
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          <div className="space-y-1.5">
            {product.offers.map((offer) => (
              <OfferRow key={offer.url} offer={offer} isBest={offer === best} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OfferRow({ offer, isBest }: { offer: Offer; isBest: boolean }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: retailerColor(offer.retailer) }}
      />
      <span className="min-w-0 flex-1 truncate">{offer.retailer}</span>
      {!offer.inStock && (
        <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-xs text-danger">
          Out of stock
        </span>
      )}
      <span className={`shrink-0 tabular-nums ${isBest ? "font-semibold text-success" : ""}`}>
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
