import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Middleware: pass-through.
 *
 * The Supabase browser client stores its session in localStorage, not
 * cookies, so middleware genuinely cannot see it. Adding @supabase/ssr would
 * enable cookie-based sessions and real edge redirects — worth doing, but it
 * is not what protects the data.
 *
 * The security boundary is the API layer: every route calls requireUser(),
 * which validates the caller's access token and builds a Supabase client
 * scoped to that user, so row-level security decides what they can read and
 * write. Reaching /dashboard without a session shows an empty shell whose
 * requests all return 401.
 *
 * AppLayout handles the client-side redirect to the login page.
 */
export async function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/search/:path*",
    "/tracked/:path*",
    "/history/:path*",
    "/settings/:path*",
    "/products/:path*",
  ],
};
