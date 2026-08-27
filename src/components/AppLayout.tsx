"use client";

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  BookmarkCheck,
  LayoutGrid,
  LogOut,
  Luggage,
  Menu,
  Search,
  Settings as SettingsIcon,
  TrendingUp,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useStore, useHydrated } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { AiChat } from "@/components/AiChat";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutGrid },
  { href: "/search", label: "Search Products", icon: Search },
  { href: "/tracked", label: "Tracked Products", icon: BookmarkCheck },
  { href: "/history", label: "Price History", icon: TrendingUp },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
] as const;

export function AppLayout({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { authed, email, signOut } = useStore();
  const hydrated = useHydrated();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (hydrated && !authed) router.push("/");
  }, [hydrated, authed, router]);

  if (!hydrated || !authed) {
    return <div className="min-h-screen bg-background" />;
  }

  const sidebar = (
    <div className="flex h-full w-64 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-sidebar-primary">
          <Luggage className="h-4.5 w-4.5 text-sidebar-primary-foreground" />
        </span>
        <span className="text-[15px] font-semibold text-sidebar-accent-foreground">
          LuggageTracker
        </span>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-sidebar-primary text-sidebar-primary-foreground"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-sidebar-border px-3 py-4">
        <div className="flex items-center gap-3 px-2 py-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-accent-foreground">
            AD
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-sidebar-accent-foreground">Admin</p>
            <p className="truncate text-xs text-sidebar-foreground">{email}</p>
          </div>
        </div>
        <button
          onClick={() => {
            signOut();
            router.push("/");
          }}
          className="mt-1 flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <LogOut className="h-4 w-4" />
          Log out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="sticky top-0 hidden h-screen lg:block">{sidebar}</aside>

      {open ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-foreground/40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 h-full shadow-lift">{sidebar}</div>
          <button
            className="absolute top-4 right-4 rounded-md bg-card p-2"
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-border bg-card/90 px-5 py-4 backdrop-blur lg:px-8">
          <button
            className="rounded-md border border-border p-2 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
          >
            <Menu className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? (
              <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          {actions ?? (
            <Button asChild>
              <Link href="/search">+ Add Product</Link>
            </Button>
          )}
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-5 py-8 lg:px-8">{children}</main>
      </div>
      <AiChat />
    </div>
  );
}
