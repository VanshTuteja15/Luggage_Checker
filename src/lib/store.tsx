"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CATALOG, DEFAULT_TRACKED_IDS, type Product } from "./data";
import { getSupabaseBrowser, isLiveMode } from "./supabase/client";

/* ------------------------------------------------------------------ */
/*  Settings type                                                     */
/* ------------------------------------------------------------------ */

export type Settings = {
  adminEmail: string;
  timezone: string;
  refreshInterval: string;
  dailyReport: boolean;
  reportEmail: string;
  include: { drops: boolean; increases: boolean; oos: boolean; summary: boolean };
  serpApiKey: string;
  retailers: string[];
};

const DEFAULT_SETTINGS: Settings = {
  adminEmail: "admin@luggagetracker.app",
  timezone: "America/Edmonton",
  refreshInterval: "24h",
  dailyReport: true,
  reportEmail: "admin@luggagetracker.app",
  include: { drops: true, increases: true, oos: true, summary: true },
  serpApiKey: "",
  retailers: [
    "Amazon.ca", "Costco.ca", "Walmart.ca", "Hudson's Bay",
    "Canadian Tire", "Bentley", "Best Buy Canada", "London Drugs",
    "Samsonite.ca", "TUMI.ca", "Away", "Travelpro",
    "Monos", "Briggs & Riley", "eBay.ca",
  ],
};

/* ------------------------------------------------------------------ */
/*  State type                                                        */
/* ------------------------------------------------------------------ */

type State = {
  authed: boolean;
  signIn: (email: string) => void;
  signOut: () => void;
  email: string;
  userId: string | null;
  catalog: Product[];
  trackedIds: string[];
  tracked: Product[];
  isTracked: (id: string) => boolean;
  track: (id: string) => void;
  untrack: (id: string | string[]) => void;
  clearHistoryFlag: boolean;
  clearHistory: () => void;
  recentSearches: string[];
  addSearch: (q: string) => void;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => void;
  /** True when Supabase is configured and connected. */
  liveMode: boolean;
};

const Ctx = createContext<State | null>(null);
const KEY = "luggagetracker.state.v1";

type Persisted = {
  authed: boolean;
  email: string;
  userId: string | null;
  trackedIds: string[];
  recentSearches: string[];
  settings: Settings;
  clearHistoryFlag: boolean;
};

/* ------------------------------------------------------------------ */
/*  Provider                                                          */
/* ------------------------------------------------------------------ */

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>({
    authed: false,
    email: DEFAULT_SETTINGS.adminEmail,
    userId: null,
    trackedIds: DEFAULT_TRACKED_IDS,
    recentSearches: ["samsonite 28 inch", "tumi alpha", "042810178423", "travelpro", "away large"],
    settings: DEFAULT_SETTINGS,
    clearHistoryFlag: false,
  });
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setState((s) => ({ ...s, ...(JSON.parse(raw) as Persisted) }));
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  // Persist to localStorage
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state, hydrated]);

  // Check Supabase auth session on mount (live mode only)
  useEffect(() => {
    if (!isLiveMode) return;
    const supabase = getSupabaseBrowser();
    if (!supabase) return;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.user) {
        setState((s) => ({
          ...s,
          authed: true,
          email: session.user.email ?? s.email,
          userId: session.user.id,
        }));
      }
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        if (session?.user) {
          setState((s) => ({
            ...s,
            authed: true,
            email: session.user.email ?? s.email,
            userId: session.user.id,
          }));
        } else {
          setState((s) => ({ ...s, authed: false, userId: null }));
        }
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  const patch = useCallback((p: Partial<Persisted>) => setState((s) => ({ ...s, ...p })), []);

  const value = useMemo<State>(() => {
    const trackedIds = state.trackedIds;
    return {
      authed: state.authed,
      email: state.email,
      userId: state.userId,
      liveMode: isLiveMode,
      signIn: (email: string) => patch({ authed: true, email }),
      signOut: async () => {
        if (isLiveMode) {
          const supabase = getSupabaseBrowser();
          await supabase?.auth.signOut();
        }
        patch({ authed: false, userId: null });
      },
      catalog: CATALOG,
      trackedIds,
      tracked: CATALOG.filter((p) => trackedIds.includes(p.id)),
      isTracked: (id: string) => trackedIds.includes(id),
      track: (id: string) =>
        setState((s) =>
          s.trackedIds.includes(id) ? s : { ...s, trackedIds: [...s.trackedIds, id] },
        ),
      untrack: (id: string | string[]) =>
        setState((s) => {
          const ids = Array.isArray(id) ? id : [id];
          return { ...s, trackedIds: s.trackedIds.filter((x) => !ids.includes(x)) };
        }),
      clearHistoryFlag: state.clearHistoryFlag,
      clearHistory: () => patch({ clearHistoryFlag: true }),
      recentSearches: state.recentSearches,
      addSearch: (q: string) =>
        setState((s) => ({
          ...s,
          recentSearches: [q, ...s.recentSearches.filter((x) => x !== q)].slice(0, 5),
        })),
      settings: state.settings,
      updateSettings: (p: Partial<Settings>) =>
        setState((s) => ({ ...s, settings: { ...s.settings, ...p } })),
    };
  }, [state, patch]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                             */
/* ------------------------------------------------------------------ */

export function useStore() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}
