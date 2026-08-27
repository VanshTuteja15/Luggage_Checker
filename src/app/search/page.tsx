"use client";

import { useCallback, useState } from "react";
import {
  ExternalLink,
  Globe,
  Loader2,
  Search as SearchIcon,
  ShoppingBag,
  Star,
  TrendingDown,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { EmptyState } from "@/components/Bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usd } from "@/lib/format";
import { useStore } from "@/lib/store";
import { retailerColor } from "@/lib/data";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type SearchResult = {
  title: string;
  source: string;
  price: number;
  url: string;
  thumbnail?: string;
  rating?: number;
  reviews?: number;
  snippet?: string;
  knownRetailer: string | null;
};

type SearchResponse = {
  source: "serpapi" | "gemini" | "local";
  results: SearchResult[];
  query: string;
  error?: string;
};

/* ------------------------------------------------------------------ */
/*  Suggested searches                                                */
/* ------------------------------------------------------------------ */

const SUGGESTIONS = [
  { label: "Samsonite carry-on", icon: ShoppingBag },
  { label: "TUMI luggage", icon: ShoppingBag },
  { label: "Away suitcase", icon: ShoppingBag },
  { label: "Luggage set under $300", icon: TrendingDown },
  { label: "Hard shell luggage Canada", icon: Globe },
  { label: "Travelpro checked bag", icon: ShoppingBag },
];

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export default function SearchPage() {
  const { recentSearches, addSearch } = useStore();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchSource, setSearchSource] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const doSearch = useCallback(
    async (q?: string) => {
      const term = (q ?? query).trim();
      if (!term || loading) return;

      setQuery(term);
      setSearched(true);
      setLoading(true);
      setError(null);
      setResults([]);
      addSearch(term);

      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: term }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? `Search failed (${res.status})`);
        }

        const data: SearchResponse = await res.json();
        setResults(data.results ?? []);
        setSearchSource(data.source);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Search failed";
        setError(msg);
        toast.error(msg);
      } finally {
        setLoading(false);
      }
    },
    [query, loading, addSearch],
  );

  const sourceLabel =
    searchSource === "serpapi"
      ? "Google Shopping"
      : searchSource === "gemini"
        ? "AI-Powered"
        : searchSource === "local"
          ? "Local Catalog"
          : "";

  return (
    <AppLayout
      title="Search Luggage"
      subtitle="Search the web for luggage deals across Canadian retailers"
      actions={<div />}
    >
      {/* ── Search bar ─────────────────────────────────────────── */}
      <div className="mx-auto mb-10 max-w-3xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doSearch();
          }}
          className="relative"
        >
          <SearchIcon className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search for any luggage — brand, type, size, or model…"
            className="h-14 rounded-2xl pl-12 pr-28 text-base shadow-sm"
            disabled={loading}
          />
          <Button
            type="submit"
            disabled={!query.trim() || loading}
            className="absolute right-2 top-1/2 h-10 -translate-y-1/2 gap-2 rounded-xl px-5"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <SearchIcon className="h-4 w-4" />
            )}
            Search
          </Button>
        </form>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Searches Google Shopping Canada for real-time luggage prices
        </p>
      </div>

      {/* ── Pre-search: suggestions + recents ──────────────────── */}
      {!searched && (
        <div className="mx-auto max-w-3xl space-y-8">
          {/* Suggestions */}
          <div>
            <p className="mb-3 text-sm font-medium text-muted-foreground">
              Popular searches
            </p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.label}
                  onClick={() => {
                    setQuery(s.label);
                    doSearch(s.label);
                  }}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-muted"
                >
                  <s.icon className="h-4 w-4 text-muted-foreground" />
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Recent searches */}
          {recentSearches.length > 0 && (
            <div>
              <p className="mb-3 text-sm font-medium text-muted-foreground">
                Recent searches
              </p>
              <div className="flex flex-wrap gap-2">
                {recentSearches.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      setQuery(s);
                      doSearch(s);
                    }}
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

      {/* ── Loading state ──────────────────────────────────────── */}
      {loading && (
        <div className="flex flex-col items-center justify-center gap-4 py-20">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Searching the web for &quot;{query}&quot;…
          </p>
        </div>
      )}

      {/* ── Error ──────────────────────────────────────────────── */}
      {error && !loading && (
        <EmptyState
          title="Search failed"
          description={error}
          action={
            <Button variant="outline" onClick={() => doSearch()}>
              Try again
            </Button>
          }
        />
      )}

      {/* ── No results ─────────────────────────────────────────── */}
      {searched && !loading && !error && results.length === 0 && (
        <EmptyState
          title="No results found"
          description={`Nothing found for "${query}". Try a different search term.`}
        />
      )}

      {/* ── Results ────────────────────────────────────────────── */}
      {results.length > 0 && !loading && (
        <div className="mx-auto max-w-4xl">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {results.length} result{results.length !== 1 ? "s" : ""} found
            </p>
            {sourceLabel && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
                <Globe className="h-3 w-3" />
                {sourceLabel}
              </span>
            )}
          </div>

          <div className="space-y-3">
            {results.map((r, i) => (
              <ResultCard key={`${r.url}-${i}`} result={r} />
            ))}
          </div>
        </div>
      )}
    </AppLayout>
  );
}

/* ------------------------------------------------------------------ */
/*  Result card                                                       */
/* ------------------------------------------------------------------ */

function ResultCard({ result }: { result: SearchResult }) {
  const r = result;
  const color = r.knownRetailer
    ? retailerColor(r.knownRetailer)
    : "#6B7280";

  return (
    <a
      href={r.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-4 rounded-xl border border-border bg-card p-4 transition-all hover:border-foreground/20 hover:shadow-md"
    >
      {/* Thumbnail */}
      <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
        {r.thumbnail ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={r.thumbnail}
            alt={r.title}
            className="h-full w-full object-contain p-1"
          />
        ) : (
          <ShoppingBag className="h-8 w-8 text-muted-foreground" />
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 text-sm font-medium leading-snug group-hover:text-primary">
          {r.title}
        </h3>

        {/* Retailer + rating */}
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: color }}
            />
            {r.source}
          </span>

          {r.rating != null && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              {r.rating.toFixed(1)}
              {r.reviews != null && (
                <span className="text-muted-foreground/70">
                  ({r.reviews.toLocaleString()})
                </span>
              )}
            </span>
          )}
        </div>

        {/* Snippet */}
        {r.snippet && (
          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
            {r.snippet}
          </p>
        )}
      </div>

      {/* Price + action */}
      <div className="flex shrink-0 flex-col items-end justify-between">
        <p className="text-lg font-bold">{usd(r.price)}</p>
        <span className="inline-flex items-center gap-1 text-xs text-primary opacity-0 transition-opacity group-hover:opacity-100">
          Visit <ExternalLink className="h-3 w-3" />
        </span>
      </div>
    </a>
  );
}
