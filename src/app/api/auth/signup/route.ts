import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { SIGNUP_CLOSED_MESSAGE, signupAllowed } from "@/lib/auth/signup";
import { supabaseConfigured } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const input = z
  .object({
    email: z.string().trim().email("Enter a valid email address."),
    password: z.string().min(8, "Use at least 8 characters.").max(200),
  })
  .strict();

/**
 * POST /api/auth/signup — create an account, only when public sign-up is on.
 *
 * With one shared business login (R5.1) the switch is off by default and
 * this refuses before touching Supabase. When it is on, the account is
 * created here (not in the browser) so the switch is enforced server-side.
 */
export async function POST(req: NextRequest) {
  if (!signupAllowed()) {
    return NextResponse.json({ error: SIGNUP_CLOSED_MESSAGE }, { status: 403 });
  }
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the email and password." },
      { status: 400 },
    );
  }
  if (!supabaseConfigured()) {
    return NextResponse.json(
      { error: "Sign-in isn't set up on this server yet." },
      { status: 503 },
    );
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
      "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: `${req.nextUrl.origin}/` },
  });
  if (error) {
    console.error("POST /api/auth/signup:", error.message);
    const taken = /already/i.test(error.message);
    return NextResponse.json(
      {
        error: taken
          ? "An account with this email already exists."
          : "The account couldn't be created. Try again in a minute.",
      },
      { status: taken ? 409 : 502 },
    );
  }
  if (data.user?.identities?.length === 0) {
    return NextResponse.json(
      { error: "An account with this email already exists." },
      { status: 409 },
    );
  }
  return NextResponse.json({
    session: data.session
      ? { accessToken: data.session.access_token, refreshToken: data.session.refresh_token }
      : null,
    needsVerification: !data.session,
  });
}
