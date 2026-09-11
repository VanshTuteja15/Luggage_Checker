import { NextResponse } from "next/server";
import { ApiError } from "@/lib/supabase/server";
import { NoProviderError } from "@/lib/search/types";

/**
 * Turn any thrown value into a sensible HTTP response.
 *
 * Keeps route handlers free of repetitive try/catch shapes and makes sure a
 * configuration problem reads as a configuration problem rather than a
 * generic 500 the user can't act on.
 */
export function errorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }

  if (err instanceof NoProviderError) {
    return NextResponse.json({ error: err.message, code: "no_provider" }, { status: 503 });
  }

  const message = err instanceof Error ? err.message : "Unexpected error";
  console.error(`${context}:`, err);

  // Missing configuration is the operator's problem, not a server fault.
  if (/not configured|Missing NEXT_PUBLIC|service-role/i.test(message)) {
    return NextResponse.json({ error: message, code: "not_configured" }, { status: 503 });
  }

  return NextResponse.json({ error: message }, { status: 500 });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
