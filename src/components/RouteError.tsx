"use client";

/* ------------------------------------------------------------------ */
/*  Friendly page-level error (React error boundary content, §9)      */
/*                                                                     */
/*  Shown by a route's error.tsx when something on the page throws.    */
/*  The person sees a plain sentence and a retry; the technical detail */
/*  goes to the browser console only.                                  */
/* ------------------------------------------------------------------ */

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RouteError({
  error,
  reset,
  what,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** e.g. "search results" */
  what: string;
}) {
  useEffect(() => {
    console.error(`page error (${what}):`, error);
  }, [error, what]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-background px-4">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center"
      >
        <AlertTriangle className="mx-auto h-8 w-8 text-warning" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold">Something went wrong showing the {what}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing was lost. Try again, or go back to the dashboard.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button onClick={reset} className="gap-2">
            <RefreshCw className="h-4 w-4" aria-hidden /> Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/dashboard">Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
