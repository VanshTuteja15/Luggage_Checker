"use client";

import { getSupabaseBrowser } from "@/lib/supabase/client";

/**
 * Fetch wrapper that attaches the caller's Supabase access token.
 *
 * The API identifies the user from this token, so the browser never sends a
 * user id and can't ask for someone else's data.
 */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  /** True when the problem is missing configuration rather than user error. */
  get isConfigurationProblem(): boolean {
    return this.status === 503;
  }
}

async function accessToken(): Promise<string | null> {
  const supabase = getSupabaseBrowser();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const token = await accessToken();

  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");

  const res = await fetch(path, {
    ...init,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    cache: "no-store",
  });

  const payload = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; code?: string })
    | null;

  if (!res.ok) {
    throw new ApiRequestError(
      res.status,
      payload?.error ?? `Request failed (${res.status})`,
      payload?.code,
    );
  }

  return payload as T;
}
