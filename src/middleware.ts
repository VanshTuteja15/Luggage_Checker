import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * Middleware: protects all routes except login, API cron endpoints, and static assets.
 * In demo mode (no Supabase URL), all routes are accessible.
 */
export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Demo mode — no auth
  if (!url || !key) return NextResponse.next();

  // Read the auth token from cookies
  const token =
    req.cookies.get("sb-access-token")?.value ??
    req.cookies.get(`sb-${new URL(url).hostname.split(".")[0]}-auth-token`)?.value;

  // If no token, try the Authorization header (for API calls)
  const authHeader = req.headers.get("authorization");

  if (!token && !authHeader) {
    // Redirect to login
    const loginUrl = new URL("/", req.url);
    loginUrl.searchParams.set("redirect", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Verify the token with Supabase
  if (token) {
    try {
      const supabase = createClient(url, key);
      const { error } = await supabase.auth.getUser(token);
      if (error) {
        const loginUrl = new URL("/", req.url);
        return NextResponse.redirect(loginUrl);
      }
    } catch {
      // If verification fails, redirect to login
      const loginUrl = new URL("/", req.url);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Protect these routes
    "/dashboard/:path*",
    "/search/:path*",
    "/tracked/:path*",
    "/history/:path*",
    "/settings/:path*",
    "/products/:path*",
  ],
};
