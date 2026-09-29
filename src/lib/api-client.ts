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

/**
 * POST a JSON body and read a newline-delimited JSON stream, calling
 * `onLine` for each object as it arrives. Rejects with ApiRequestError when
 * the request itself fails (before any streaming starts).
 */
export async function apiStream(
  path: string,
  json: unknown,
  onLine: (line: unknown) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = await accessToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const res = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(json),
    cache: "no-store",
    signal,
  });

  if (!res.ok || !res.body) {
    const payload = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiRequestError(res.status, payload?.error ?? `Request failed (${res.status})`, payload?.code);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      onLine(JSON.parse(trimmed));
    } catch {
      /* ignore a malformed line */
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      emit(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  emit(buffer + decoder.decode());
}
