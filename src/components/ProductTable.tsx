"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ExternalLink, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react";
import { ChangeBadge, Freshness, StockBadge, TargetBadge } from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usd } from "@/lib/format";
import { retailerColor } from "@/lib/retailers";
import type { TrackedProduct } from "@/lib/types";

export function ProductTable({
  products,
  selected,
  onSelectedChange,
  onRemove,
  onRefresh,
  refreshingId,
}: {
  products: TrackedProduct[];
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  onRemove: (id: string) => void;
  onRefresh?: (id: string) => void;
  refreshingId?: string | null;
}) {
  const allSelected = useMemo(
    () => products.length > 0 && products.every((p) => selected.includes(p.id)),
    [products, selected],
  );

  function toggleAll(checked: boolean) {
    onSelectedChange(checked ? products.map((p) => p.id) : []);
  }

  function toggleOne(id: string, checked: boolean) {
    onSelectedChange(checked ? [...selected, id] : selected.filter((x) => x !== id));
  }

  return (
    <div className="card-surface overflow-x-auto">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-border text-left">
            <th className="w-10 px-4 py-3">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => toggleAll(v === true)}
                aria-label="Select all products"
              />
            </th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Product</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Best price</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Change</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Retailers</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Stock</th>
            <th className="px-4 py-3 font-medium text-muted-foreground">Checked</th>
            <th className="w-10 px-4 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {products.map((p) => (
            <tr key={p.id} className="hover:bg-muted/40">
              <td className="px-4 py-3">
                <Checkbox
                  checked={selected.includes(p.id)}
                  onCheckedChange={(v) => toggleOne(p.id, v === true)}
                  aria-label={`Select ${p.name}`}
                />
              </td>

              <td className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <ProductThumb id={p.id} name={p.name} imageUrl={p.imageUrl} size={36} />
                  <div className="min-w-0">
                    <Link
                      href={`/products/${p.id}`}
                      className="block max-w-[280px] truncate font-medium hover:text-primary"
                    >
                      {p.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.brand}
                      {p.color ? ` · ${p.color}` : ""}
                    </p>
                  </div>
                </div>
              </td>

              <td className="px-4 py-3">
                {p.lowestPrice === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="space-y-0.5">
                    <p className="font-semibold tabular-nums">{usd(p.lowestPrice)}</p>
                    {p.lowestRetailer && (
                      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: retailerColor(p.lowestRetailer) }}
                        />
                        {p.lowestRetailer}
                      </p>
                    )}
                  </div>
                )}
              </td>

              <td className="px-4 py-3">
                <div className="flex flex-col items-start gap-1">
                  <ChangeBadge change={p.change} />
                  <TargetBadge target={p.targetPrice} current={p.lowestPrice} />
                </div>
              </td>

              <td className="px-4 py-3 text-muted-foreground">
                {p.retailerCount}
                {p.spread > 0 && (
                  <span className="ml-1 text-xs">(spread {usd(p.spread)})</span>
                )}
              </td>

              <td className="px-4 py-3">
                <StockBadge inStock={p.inStock} />
              </td>

              <td className="px-4 py-3">
                <Freshness isoDate={p.lastCheckedAt} />
              </td>

              <td className="px-4 py-3">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={`Actions for ${p.name}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem asChild>
                      <Link href={`/products/${p.id}`}>View details</Link>
                    </DropdownMenuItem>
                    {onRefresh && (
                      <DropdownMenuItem
                        onClick={() => onRefresh(p.id)}
                        disabled={refreshingId === p.id}
                      >
                        <RefreshCw
                          className={`mr-2 h-3.5 w-3.5 ${refreshingId === p.id ? "animate-spin" : ""}`}
                        />
                        Refresh price
                      </DropdownMenuItem>
                    )}
                    {p.offers[0]?.url && (
                      <DropdownMenuItem asChild>
                        <a href={p.offers[0].url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="mr-2 h-3.5 w-3.5" />
                          Open best offer
                        </a>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      onClick={() => onRemove(p.id)}
                      className="text-danger focus:text-danger"
                    >
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                      Stop tracking
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
