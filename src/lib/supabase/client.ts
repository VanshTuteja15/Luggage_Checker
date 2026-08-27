import { createClient } from "@supabase/supabase-js";

/** Resolve the public key — supports both old (ANON_KEY) and new (PUBLISHABLE_KEY) naming. */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  "";

/**
 * Browser-side Supabase client.
 * Returns null when env vars are missing (demo mode).
 */
export function getSupabaseBrowser() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_KEY);
}

/** True when Supabase env vars are configured. */
export const isLiveMode = !!SUPABASE_URL && !!SUPABASE_KEY;
