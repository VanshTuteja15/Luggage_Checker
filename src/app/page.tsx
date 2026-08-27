"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Bell,
  Check,
  Loader2,
  Lock,
  Luggage,
  Mail,
  MailCheck,
  Store,
  TrendingDown,
} from "lucide-react";
import { useEffect, useState, Suspense } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHydrated, useStore } from "@/lib/store";
import { getSupabaseBrowser, isLiveMode } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type Tab = "signin" | "signup";
type Panel = "form" | "forgot" | "verify" | "reset";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validatePassword(pw: string) {
  const minLength = pw.length >= 8;
  const hasSpecial = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pw);
  const strength = [minLength, hasSpecial, pw.length >= 12].filter(Boolean).length;
  return { minLength, hasSpecial, valid: minLength && hasSpecial, strength };
}

function authErrorMessage(message: string) {
  const m = message.toLowerCase();
  if (m.includes("invalid login") || m.includes("invalid credentials")) {
    return "Invalid email or password";
  }
  if (m.includes("user not found") || m.includes("no user")) {
    return "No account found with that email";
  }
  if (m.includes("already registered") || m.includes("already been registered")) {
    return "An account with this email already exists";
  }
  if (m.includes("email not confirmed")) {
    return "Please verify your email before signing in";
  }
  return message;
}

function FieldFeedback({
  show,
  ok,
  okText,
  badText,
}: {
  show: boolean;
  ok: boolean;
  okText: string;
  badText: string;
}) {
  if (!show) return null;
  return (
    <p
      className={cn(
        "mt-1.5 flex items-center gap-1 text-xs",
        ok ? "text-success" : "text-destructive",
      )}
    >
      {ok && <Check className="h-3.5 w-3.5 shrink-0" />}
      {ok ? okText : badText}
    </p>
  );
}

function PasswordStrengthBar({ password }: { password: string }) {
  const { strength } = validatePassword(password);
  const color =
    strength >= 3 ? "bg-success" : strength === 2 ? "bg-warning" : "bg-destructive";

  return (
    <div className="mt-2" aria-hidden>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all duration-300", color)}
          style={{ width: `${password.length === 0 ? 0 : (strength / 3) * 100}%` }}
        />
      </div>
    </div>
  );
}

function BrandingPanel() {
  return (
    <aside className="relative overflow-hidden bg-[#5B6B4A] px-8 py-10 text-white lg:flex lg:w-[44%] lg:min-h-screen lg:flex-col lg:justify-between lg:px-12 lg:py-16">
      <Luggage
        className="pointer-events-none absolute -bottom-10 -right-10 h-72 w-72 text-white/[0.07]"
        strokeWidth={1}
        aria-hidden
      />
      <div className="relative">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20">
            <Luggage className="h-6 w-6" />
          </span>
          <span className="text-xl font-semibold tracking-tight">LuggageTracker</span>
        </div>
        <p className="mt-5 max-w-sm text-base leading-relaxed text-white/85 lg:mt-8 lg:text-lg">
          Monitor luggage prices across 15+ Canadian retailers
        </p>
        <ul className="mt-8 hidden space-y-5 lg:block">
          {[
            { icon: Store, text: "Compare prices across 15+ Canadian retailers" },
            { icon: Bell, text: "Get notified the moment a tracked bag drops" },
            { icon: TrendingDown, text: "Watch 30-day price history in one place" },
          ].map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/12">
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-sm leading-6 text-white/90">{text}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="relative mt-8 hidden text-xs text-white/50 lg:block">
        Built for Canadian travellers who wait for the right price.
      </p>
    </aside>
  );
}

function AuthCard() {
  const { authed, signIn } = useStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirect = searchParams.get("redirect") || "/dashboard";

  const [tab, setTab] = useState<Tab>("signin");
  const [panel, setPanel] = useState<Panel>("form");
  const [email, setEmail] = useState(isLiveMode ? "" : "admin@luggagetracker.app");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const emailOk = EMAIL_RE.test(email.trim());
  const pw = validatePassword(password);
  const confirmOk = confirmPassword.length > 0 && confirmPassword === password;

  const canSubmit =
    !loading &&
    (panel === "forgot"
      ? emailOk
      : tab === "signin"
        ? emailOk && pw.valid
        : emailOk && pw.valid && confirmOk);

  useEffect(() => {
    if (hydrated && authed) router.push(redirect);
  }, [hydrated, authed, router, redirect]);

  function switchTab(next: Tab) {
    setTab(next);
    setPanel("form");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    if (panel === "forgot") {
      await handleReset();
      return;
    }
    if (tab === "signup") {
      await handleSignUp();
      return;
    }
    await handleSignIn();
  }

  async function handleSignIn() {
    if (!isLiveMode) {
      signIn(email.trim());
      toast.success("Welcome back");
      router.push(redirect);
      return;
    }

    setLoading(true);
    try {
      const supabase = getSupabaseBrowser();
      if (!supabase) throw new Error("Supabase not configured");

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password: password.trim(),
      });

      if (error) {
        toast.error(authErrorMessage(error.message));
        return;
      }

      signIn(email.trim());
      toast.success("Welcome back");
      router.push(redirect);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignUp() {
    if (!isLiveMode) {
      setPanel("verify");
      return;
    }

    setLoading(true);
    try {
      const supabase = getSupabaseBrowser();
      if (!supabase) throw new Error("Supabase not configured");

      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password: password.trim(),
      });

      if (error) {
        toast.error(authErrorMessage(error.message));
        return;
      }

      if (data.user?.identities?.length === 0) {
        toast.error("An account with this email already exists");
        return;
      }

      if (data.session) {
        signIn(email.trim());
        toast.success("Welcome to LuggageTracker");
        router.push(redirect);
        return;
      }

      setPanel("verify");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sign up failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleReset() {
    if (!isLiveMode) {
      setPanel("reset");
      return;
    }

    setLoading(true);
    try {
      const supabase = getSupabaseBrowser();
      if (!supabase) throw new Error("Supabase not configured");

      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/`,
      });

      if (error) {
        toast.error(authErrorMessage(error.message));
        return;
      }

      setPanel("reset");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send reset email");
    } finally {
      setLoading(false);
    }
  }

  const isSignup = tab === "signup";
  const heading =
    panel === "forgot"
      ? "Reset your password"
      : panel === "verify"
        ? "Check your email to verify"
        : panel === "reset"
          ? "Check your email"
          : isSignup
            ? "Create your account"
            : "Welcome back";
  const subtitle =
    panel === "forgot"
      ? "Enter the email associated with your account and we'll send a reset link."
      : panel === "verify"
        ? `We sent a verification link to ${email.trim()}`
        : panel === "reset"
          ? `We sent a password reset link to ${email.trim()}`
          : isLiveMode
            ? isSignup
              ? "Start tracking luggage prices in minutes."
              : "Sign in to continue tracking prices."
            : "Demo mode — use a valid email and password";

  const submitLabel = loading
    ? panel === "forgot"
      ? "Sending…"
      : isSignup
        ? "Creating account…"
        : "Signing in…"
    : panel === "forgot"
      ? "Send reset link"
      : isSignup
        ? "Create account"
        : "Sign in";

  return (
    <div className="w-full max-w-md">
      <div className="rounded-xl border border-border bg-card p-6 shadow-lift sm:p-8">
        {panel === "form" && (
          <div className="grid grid-cols-2 rounded-lg bg-muted p-1">
            {(["signin", "signup"] as const).map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={tab === id}
                onClick={() => switchTab(id)}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-all duration-200",
                  tab === id
                    ? "bg-card text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {id === "signin" ? "Sign In" : "Create Account"}
              </button>
            ))}
          </div>
        )}

        <div
          key={panel + tab}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
        >
          <h1 className={cn("text-lg font-semibold tracking-tight", panel === "form" ? "mt-6" : "mt-0")}>
            {heading}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>

          {(panel === "verify" || panel === "reset") && (
            <div className="mt-6 text-center">
              <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-primary-soft">
                <MailCheck className="h-7 w-7 text-primary" />
              </span>
              <Button
                type="button"
                variant="outline"
                className="mt-6 h-12 w-full rounded-lg"
                onClick={() => {
                  setPanel("form");
                  setTab("signin");
                }}
              >
                Back to Sign In
              </Button>
            </div>
          )}

          {(panel === "form" || panel === "forgot") && (
            <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    spellCheck={false}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    aria-invalid={email.length > 0 && !emailOk}
                    className="h-12 rounded-lg pl-10"
                  />
                </div>
                <FieldFeedback
                  show={email.length > 0}
                  ok={emailOk}
                  okText="Valid email"
                  badText="Enter a valid email address"
                />
              </div>

              {panel === "form" && (
                <>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="password">Password</Label>
                      {tab === "signin" && (
                        <button
                          type="button"
                          onClick={() => setPanel("forgot")}
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        id="password"
                        type="password"
                        autoComplete={isSignup ? "new-password" : "current-password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="••••••••"
                        aria-invalid={password.length > 0 && !pw.valid}
                        className="h-12 rounded-lg pl-10"
                      />
                    </div>
                    <PasswordStrengthBar password={password} />
                    {password.length > 0 && (
                      <div className="space-y-1">
                        <FieldFeedback
                          show
                          ok={pw.minLength}
                          okText="At least 8 characters"
                          badText="Must be at least 8 characters"
                        />
                        <FieldFeedback
                          show
                          ok={pw.hasSpecial}
                          okText="Contains a special character"
                          badText="Must include a special character (!@#$%^&*…)"
                        />
                      </div>
                    )}
                  </div>

                  {isSignup && (
                    <div className="space-y-1.5">
                      <Label htmlFor="confirm-password">Confirm password</Label>
                      <div className="relative">
                        <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="confirm-password"
                          type="password"
                          autoComplete="new-password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="••••••••"
                          aria-invalid={confirmPassword.length > 0 && !confirmOk}
                          className="h-12 rounded-lg pl-10"
                        />
                      </div>
                      <FieldFeedback
                        show={confirmPassword.length > 0}
                        ok={confirmOk}
                        okText="Passwords match"
                        badText="Passwords do not match"
                      />
                    </div>
                  )}
                </>
              )}

              {panel === "forgot" && (
                <button
                  type="button"
                  onClick={() => setPanel("form")}
                  className="text-xs font-medium text-primary hover:underline"
                >
                  Back to Sign In
                </button>
              )}

              <Button
                type="submit"
                disabled={!canSubmit}
                className="h-12 w-full rounded-lg bg-[#5B6B4A] text-white hover:bg-[#4a5840]"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitLabel}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <BrandingPanel />
      <main className="flex flex-1 flex-col items-center justify-center bg-background px-4 py-10 sm:px-8">
        <Suspense
          fallback={
            <div className="h-[28rem] w-full max-w-md animate-pulse rounded-xl bg-card" />
          }
        >
          <AuthCard />
        </Suspense>
        <p className="mt-8 text-xs text-muted-foreground">Powered by Supabase</p>
      </main>
    </div>
  );
}
