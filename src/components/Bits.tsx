import { ArrowDownRight, ArrowUpRight, Bell, Clock, Minus, PackageSearch } from "lucide-react";
import { cn } from "@/lib/utils";
import { usd, relativeFromIso, fullDateFromIso } from "@/lib/format";
import { retailerColor } from "@/lib/retailers";

export function ChangeBadge({ change }: { change: number }) {
  if (Math.abs(change) < 0.005) {
    return (
      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <Minus className="h-3.5 w-3.5" /> —
      </span>
    );
  }
  const down = change < 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-medium",
        down ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      {down ? <ArrowDownRight className="h-3.5 w-3.5" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
      {down ? "-" : "+"}
      {usd(Math.abs(change))}
    </span>
  );
}

export function StockBadge({ inStock }: { inStock: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        inStock ? "bg-success-soft text-success" : "bg-danger-soft text-danger",
      )}
    >
      {inStock ? "In Stock" : "Out of Stock"}
    </span>
  );
}

export function RetailerTag({ retailer }: { retailer: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: retailerColor(retailer) }}
      />
      {retailer}
    </span>
  );
}

/**
 * How fresh a price is.
 *
 * A price tracker that doesn't say when it last checked is asking you to
 * trust a number that might be four days old — this is shown wherever a
 * price is.
 */
export function Freshness({
  isoDate,
  className,
}: {
  isoDate: string | null;
  className?: string;
}) {
  if (!isoDate) {
    return (
      <span className={cn("inline-flex items-center gap-1 text-xs text-muted-foreground", className)}>
        <Clock className="h-3 w-3" />
        never checked
      </span>
    );
  }

  const ageMs = Date.now() - new Date(isoDate).getTime();
  const stale = ageMs > 36 * 3600 * 1000;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs",
        stale ? "text-danger" : "text-muted-foreground",
        className,
      )}
      title={fullDateFromIso(isoDate)}
    >
      <Clock className="h-3 w-3" />
      {relativeFromIso(isoDate)}
    </span>
  );
}

/** Shows a product's price alert threshold, if one is set. */
export function TargetBadge({
  target,
  current,
}: {
  target: number | null;
  current: number | null;
}) {
  if (target === null) return null;
  const hit = current !== null && current <= target;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        hit ? "bg-success-soft text-success" : "bg-muted text-muted-foreground",
      )}
      title={hit ? "Target price reached" : `Alert when it drops below ${usd(target)}`}
    >
      <Bell className="h-3 w-3" />
      {usd(target)}
    </span>
  );
}

export function SectionTitle({
  title,
  description,
  right,
}: {
  title: string;
  description?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon: Icon = PackageSearch,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ElementType;
}) {
  return (
    <div className="card-surface flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Icon className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading skeletons                                                 */
/*                                                                     */
/*  Data used to come from a synchronous constant, so no page had a    */
/*  loading state. Now that it's fetched, every page needs one.        */
/* ------------------------------------------------------------------ */

export function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

export function StatCardSkeleton() {
  return (
    <div className="card-surface flex items-center gap-4 p-5">
      <SkeletonBlock className="h-11 w-11 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <SkeletonBlock className="h-3 w-24" />
        <SkeletonBlock className="h-5 w-12" />
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="card-surface divide-y divide-border overflow-hidden">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          <SkeletonBlock className="h-9 w-9 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonBlock className="h-3.5 w-1/3" />
            <SkeletonBlock className="h-3 w-1/5" />
          </div>
          <SkeletonBlock className="h-4 w-16" />
          <SkeletonBlock className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function CardGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card-surface space-y-3 p-4">
          <SkeletonBlock className="h-28 w-full rounded-lg" />
          <SkeletonBlock className="h-4 w-3/4" />
          <SkeletonBlock className="h-3 w-1/2" />
          <SkeletonBlock className="h-5 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/** Consistent inline error with a retry affordance. */
export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card-surface flex flex-col items-center gap-3 px-6 py-12 text-center">
      <p className="font-medium text-danger">Couldn&apos;t load this</p>
      <p className="max-w-md text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="rounded-md border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"
        >
          Try again
        </button>
      )}
    </div>
  );
}
