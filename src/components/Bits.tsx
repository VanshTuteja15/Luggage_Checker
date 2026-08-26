import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { usd, relativeFromMinutes, fullDateFromMinutes } from "@/lib/format";
import { RETAILER_COLOR, type Retailer } from "@/lib/data";

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
      {usd(Math.abs(change)).replace("$", "$")}
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

export function RetailerTag({ retailer }: { retailer: Retailer | string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: RETAILER_COLOR[retailer as Retailer] ?? "#6B7280" }}
      />
      {retailer}
    </span>
  );
}

export function RelTime({ minutes }: { minutes: number }) {
  return (
    <span className="text-sm text-muted-foreground" title={fullDateFromMinutes(minutes)}>
      {relativeFromMinutes(minutes)}
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
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="card-surface flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Minus className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
