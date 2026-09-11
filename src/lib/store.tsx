"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSupabaseBrowser, isLiveMode } from "./supabase/client";

/* ------------------------------------------------------------------ */
/*  Session store                                                     */
/*                                                                     */
/*  This holds the auth session and a few per-device conveniences.     */
/*                                                                     */
/*  It deliberately does NOT hold tracked products or settings any     */
/*  more. Those used to live in localStorage, which meant your tracked */
/*  list didn't follow you to another device, and a second person      */
/*  signing in on the same browser inherited the first person's list.  */
/*  They now live in Supabase, scoped to the user by RLS.              */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "luggagetracker.session.v2";
const LEGACY_KEY = "luggagetracker.state.v1";

type Persisted = {
  recentSearches: string[];
};

type State = {
  /** True once the session has been resolved — render nothing before this. */
  ready: boolean;
  authed: boolean;
  email: string;
  userId: string | null;
  /** True when Supabase is configured. */
  liveMode: boolean;

  signIn: (email: string, userId?: string) => void;
  signOut: () => Promise<void>;

  recentSearches: string[];
  addSearch: (query: string) => void;
  clearSearches: () => void;
};

const Ctx = createContext<State | null>(null);

function readPersisted(): Persisted {
  if (typeof window === "undefined") return { recentSearches: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { recentSearches: [] };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      recentSearches: Array.isArray(parsed.recentSearches)
        ? parsed.recentSearches.filter((s): s is string => typeof s === "string").slice(0, 8)
        : [],
    };
  } catch {
    return { recentSearches: [] };
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  // ── Hydrate per-device state ───────────────────────────────
  useEffect(() => {
    setRecentSearches(readPersisted().recentSearches);
    // The v1 store kept tracked products and settings client-side. That data
    // is now server-owned, so drop the stale copy rather than leaving a
    // previous user's tracked list sitting in the browser.
    try {
      window.localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ recentSearches }));
    } catch {
      /* ignore */
    }
  }, [recentSearches]);

  // ── Resolve the Supabase session ───────────────────────────
  useEffect(() => {
    if (!isLiveMode) {
      setReady(true);
      return;
    }

    const supabase = getSupabaseBrowser();
    if (!supabase) {
      setReady(true);
      return;
    }

    let active = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return;
        const session = data.session;
        if (session?.user) {
          setAuthed(true);
          setEmail(session.user.email ?? "");
          setUserId(session.user.id);
        }
      })
      .finally(() => {
        if (active) setReady(true);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      if (session?.user) {
        setAuthed(true);
        setEmail(session.user.email ?? "");
        setUserId(session.user.id);
      } else {
        setAuthed(false);
        setUserId(null);
      }
      setReady(true);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback((nextEmail: string, nextUserId?: string) => {
    setAuthed(true);
    setEmail(nextEmail);
    if (nextUserId) setUserId(nextUserId);
  }, []);

  const signOut = useCallback(async () => {
    if (isLiveMode) {
      const supabase = getSupabaseBrowser();
      await supabase?.auth.signOut();
    }
    setAuthed(false);
    setUserId(null);
    setEmail("");
    // Signing out should leave nothing of this person behind on the device.
    setRecentSearches([]);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const addSearch = useCallback((query: string) => {
    const q = query.trim();
    if (!q) return;
    setRecentSearches((prev) => [q, ...prev.filter((x) => x !== q)].slice(0, 6));
  }, []);

  const clearSearches = useCallback(() => setRecentSearches([]), []);

  const value = useMemo<State>(
    () => ({
      ready,
      authed,
      email,
      userId,
      liveMode: isLiveMode,
      signIn,
      signOut,
      recentSearches,
      addSearch,
      clearSearches,
    }),
    [ready, authed, email, userId, recentSearches, signIn, signOut, addSearch, clearSearches],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): State {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside StoreProvider");
  return ctx;
}

/** True after the first client render — for suppressing hydration mismatch. */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
