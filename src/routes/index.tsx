import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Luggage } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useHydrated, useStore } from "@/lib/store";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Sign in — LuggageTracker" },
      {
        name: "description",
        content:
          "Sign in to LuggageTracker to monitor luggage prices across Amazon, Walmart, Target and more.",
      },
      { property: "og:title", content: "Sign in — LuggageTracker" },
      {
        property: "og:description",
        content: "Admin access to the LuggageTracker price monitoring dashboard.",
      },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const { authed, signIn } = useStore();
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const [email, setEmail] = useState("admin@luggagetracker.app");
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (hydrated && authed) navigate({ to: "/dashboard" });
  }, [hydrated, authed, navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary">
            <Luggage className="h-5 w-5 text-primary-foreground" />
          </span>
          <span className="text-lg font-semibold tracking-tight">LuggageTracker</span>
        </div>
        <div className="card-surface p-6">
          <h1 className="text-center text-base font-semibold">Sign in to your account</h1>
          <p className="mt-1 text-center text-sm text-muted-foreground">
            Admin access only
          </p>
          <form
            className="mt-6 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!email.trim() || !password.trim()) {
                toast.error("Enter your email and password");
                return;
              }
              signIn(email.trim());
              toast.success("Welcome back");
              navigate({ to: "/dashboard" });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@luggagetracker.app"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="remember" defaultChecked />
              <Label htmlFor="remember" className="text-sm font-normal text-muted-foreground">
                Remember me
              </Label>
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
