"use client";

/* ------------------------------------------------------------------ */
/*  Search: one search, lowest price first (R2)                       */
/*                                                                     */
/*  Every search is a live price check (the engine's research session) */
/*  across the stores chosen in Settings. Prices stream in store by    */
/*  store; each carries where and when it was found. If a live check   */
/*  can't run, saved prices are shown with their own dates and a retry. */
/*  There is no separate "web research" mode any more.                 */
/* ------------------------------------------------------------------ */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, ShoppingBag } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { SearchBox } from "@/components/SearchBox";
import { Button } from "@/components/ui/button";
import {
  ResearchResults,
  SavedPrices,
  type ResearchSort,
} from "@/components/research/ResearchResults";
import { toSearchProduct } from "@/components/research/track";
import type { AnswerProduct } from "@/lib/engine/types";
import { useTrackProduct, useTrackedProducts } from "@/lib/queries";
import { useLastKnown, useResearch } from "@/lib/research-client";
import { useStore } from "@/lib/store";

/** Left over from the removed two-mode search; cleared so it can't steer anything. */
const OLD_MODE_KEY = "luggagetracker.searchMode";

const SUGGESTIONS = [
  "Samsonite Paralux Medium",
  "Samsonite Omni 3.0 Large",
  "Delsey Chatelet Air 2.0 Medium",
  "Aluminum Carry-On",
  "TUMI Alpha Bravo",
  "Travelpro Maxlite 5 carry-on",
];

export default function SearchPage() {
  const { recentSearches, addSearch, removeSearch, clearSearches, authed } = useStore();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ResearchSort>("price-asc");

  const research = useResearch();
  const { data: tracked } = useTrackedProducts(30, authed);
  const track = useTrackProduct();

  useEffect(() => {
    try {
      window.localStorage.removeItem(OLD_MODE_KEY);
    } catch {
      /* storage unavailable: nothing to clear */
    }
  }, []);

  const trackedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of tracked ?? []) {
      set.add(p.slug);
      if (p.upc) set.add(`gtin-${p.upc}`);
    }
    return set;
  }, [tracked]);

  const onTrack = (p: AnswerProduct) => {
    const sp = toSearchProduct(p);
    if (sp) track.mutate(sp);
  };

  const runSearch = useCallback(
    (raw?: string) => {
      const term = (raw ?? query).trim();
      if (!term) return;
      setQuery(term);
      addSearch(term);
      void research.search(term);
    },
    [query, addSearch, research],
  );

  const state = research.state;
  const running = state.status === "running" || state.status === "starting";
  const failed = state.status === "error";
  const lastKnown = useLastKnown(state.query, failed);
  const hasSearched = state.status !== "idle";

  return (
    <AppLayout
      title="Search Products"
      subtitle="Lowest prices first. Every price shows where and when it was found."
      actions={<div />}
    >
      <div className="mx-auto mb-8 max-w-3xl">
        <SearchBox
          value={query}
          onChange={setQuery}
          onSearch={(t) => runSearch(t)}
          history={recentSearches}
          onRemoveHistory={removeSearch}
          onClearHistory={clearSearches}
          suggestions={SUGGESTIONS}
          pending={running}
          placeholder="Brand, collection and size, e.g. Samsonite Paralux Medium"
        />
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Prices in Canadian dollars, read from each store&rsquo;s own site or official channel.
          Stores we can&rsquo;t read are listed as links.
        </p>
      </div>

      {!hasSearched && (
        <div className="mx-auto max-w-3xl">
          <p className="mb-3 text-sm font-medium text-muted-foreground">Try a search</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SUGGESTIONS.map((label) => (
              <button
                key={label}
                type="button"
                onClick={() => runSearch(label)}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ShoppingBag className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {failed && (
        <div className="mx-auto max-w-4xl">
          <div
            role="alert"
            className="mb-4 flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
              <span>
                {state.error ?? "We couldn't check stores live just now."}{" "}
                {lastKnown.data?.products.length
                  ? "Below are the prices we saved earlier, each with its date."
                  : lastKnown.isLoading
                    ? "Looking for saved prices…"
                    : "No saved prices for this search yet."}
              </span>
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              onClick={() => runSearch(state.query)}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
            </Button>
          </div>
          <SavedPrices
            products={lastKnown.data?.products ?? []}
            query={state.query}
            onTrack={onTrack}
            trackedKeys={trackedKeys}
            trackPending={track.isPending}
          />
        </div>
      )}

      {hasSearched && !failed && (
        <ResearchResults
          view={state}
          sort={sort}
          onSort={setSort}
          onReverify={research.reverify}
          onCancel={() => void research.cancel()}
          onTrack={onTrack}
          trackedKeys={trackedKeys}
          trackPending={track.isPending}
        />
      )}
    </AppLayout>
  );
}
