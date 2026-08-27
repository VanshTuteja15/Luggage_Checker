import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Middleware: lightweight pass-through.
 *
 * Auth is handled client-side by the store (useStore → authed).
 * Supabase JS stores sessions in localStorage, not cookies,
 * so server-side cookie checks don't work without @supabase/ssr.
 *
 * The AppLayout component handles redirecting unauthenticated
 * users to the login page on the client side.
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
