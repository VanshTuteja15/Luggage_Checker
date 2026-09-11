"use client";

import Link from "next/link";
import { ExternalLink, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { ChangeBadge, Freshness, RetailerTag, StockBadge, TargetBadge } from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { Sparkline } from "@/components/Sparkline";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usd } from "@/lib/format";
import type { TrackedProduct } from "@/lib/types";

export function TrackedProductCard({
  product,
  onRemove,
  onRefresh,
  refreshing,
}: {
  product: TrackedProduct;
  onRemove: (id: string) => void;
  onRefresh?: (id: string) => void;
  refreshing?: boolean;
}) {
  const spark = product.history.slice(-14).map((p) => p.price);

  return (
    <div className="card-surface flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <ProductThumb
          id={product.id}
          name={product.name}
          imageUrl={product.imageUrl}
          size={48}
        />
        <div className="min-w-0 flex-1">
          <Link
            href={`/products/${product.id}`}
            className="line-clamp-2 text-sm font-medium leading-snug hover:text-primary"
          >
            {product.name}
          </Link>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {product.brand}
            {product.color ? ` · ${product.color}` : ""}
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={`Actions for ${product.name}`}
          >
            <MoreHorizontal className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={`/products/${product.id}`}>View details</Link>
            </DropdownMenuItem>
            {onRefresh && (
              <DropdownMenuItem onClick={() => onRefresh(product.id)} disabled={refreshing}>
                <RefreshCw className={`mr-2 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
                Refresh price
              </DropdownMenuItem>
            )}
            {product.offers[0]?.url && (
              <DropdownMenuItem asChild>
                <a href={product.offers[0].url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  Open best offer
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onRemove(product.id)}
              className="text-danger focus:text-danger"
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Stop tracking
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-xl font-semibold tabular-nums">
            {product.lowestPrice === null ? "—" : usd(product.lowestPrice)}
          </p>
          {product.lowestRetailer && <RetailerTag retailer={product.lowestRetailer} />}
        </div>
        <div className="flex flex-col items-end gap-1">
          <ChangeBadge change={product.change} />
          <TargetBadge target={product.targetPrice} current={product.lowestPrice} />
        </div>
      </div>

      {spark.length > 1 && (
        <Sparkline
          data={spark}
          color={product.change < 0 ? "#10B981" : product.change > 0 ? "#EF4444" : "#5B6B4A"}
        />
      )}

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <span className="text-xs text-muted-foreground">
          {product.retailerCount} retailer{product.retailerCount === 1 ? "" : "s"}
          {product.spread > 0 && ` · spread ${usd(product.spread)}`}
        </span>
        <StockBadge inStock={product.inStock} />
      </div>

      <Freshness isoDate={product.lastCheckedAt} />
    </div>
  );
}
