import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { NextRequest } from "next/server";

/** Resolve the public key — supports both old and new Supabase naming. */
function publicKey(): string {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    ""
  );
}

function projectUrl(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

export function supabaseConfigured(): boolean {
  return !!projectUrl() && !!publicKey();
}

export function serviceRoleConfigured(): boolean {
  return !!projectUrl() && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

/**
 * Service-role client. Bypasses RLS entirely.
 *
 * ONLY for cron jobs, which have no user context. Never use this to serve a
 * user request — doing so was how the old API routes let any caller read and
 * write any user's data by passing a userId in the body.
 */
export function getSupabaseAdmin(): SupabaseClient {
  const url = projectUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Cron jobs need the service-role key; set it in .env.local.",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/* ------------------------------------------------------------------ */
/*  User-scoped access                                                */
/* ------------------------------------------------------------------ */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type AuthedContext = {
  supabase: SupabaseClient;
  userId: string;
  email: string | null;
};

function bearerToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Build a Supabase client that acts AS the calling user.
 *
 * Every query made through this client is subject to row-level security, so
 * a user can only ever reach their own tracked products and settings — the
 * database enforces it, not our code.
 */
export async function requireUser(req: NextRequest): Promise<AuthedContext> {
  if (!supabaseConfigured()) {
    throw new ApiError(
      503,
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  const token = bearerToken(req);
  if (!token) throw new ApiError(401, "Not signed in.");

  const supabase = createClient(projectUrl(), publicKey(), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new ApiError(401, "Session expired. Please sign in again.");

  return { supabase, userId: data.user.id, email: data.user.email ?? null };
}
