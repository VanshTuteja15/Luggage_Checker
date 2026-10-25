import { NextResponse } from "next/server";
import { ApiError } from "@/lib/supabase/server";
import { NoProviderError } from "@/lib/search/types";

/** What people see when something on our side fails; the detail stays in the server log. */
export const SERVER_FAILED = "Something went wrong on our side. Please try again in a moment.";
export const NOT_SET_UP =
  "This part of LuggageTracker isn't set up yet. The person who set it up can finish it.";

/**
 * Turn any thrown value into a sensible HTTP response (R5.5).
 *
 * People get a plain sentence; the technical detail (stack, env names,
 * database errors) is logged with a short reference they can quote. A
 * configuration problem still answers 503 so it reads as "not set up",
 * not as a crash.
 */
export function errorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }

  const ref = crypto.randomUUID().slice(0, 8);
  console.error(`${context} [${ref}]:`, err);

  if (err instanceof NoProviderError) {
    return NextResponse.json({ error: NOT_SET_UP, code: "no_provider" }, { status: 503 });
  }

  const message = err instanceof Error ? err.message : "";
  // Missing configuration is the operator's problem, not a server fault.
  if (/not configured|Missing NEXT_PUBLIC|service-role/i.test(message)) {
    return NextResponse.json({ error: NOT_SET_UP, code: "not_configured" }, { status: 503 });
  }

  return NextResponse.json({ error: `${SERVER_FAILED} (ref ${ref})` }, { status: 500 });
}

export function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}
