import { Link } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangeBadge, RetailerTag, StockBadge } from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { Sparkline } from "@/components/Sparkline";
import { lowestOffer, lowestOnDate, priceChange, seriesDates, type Product } from "@/lib/data";
import { usd } from "@/lib/format";

export function TrackedProductCard({
  product,
  onRemove,
}: {
  product: Product;
  onRemove: (id: string) => void;
}) {
  const low = lowestOffer(product);
  const spark = seriesDates(6)
    .map((d) => lowestOnDate(product, d))
    .filter((v): v is number => v !== null);
  const change = priceChange(product);

  return (
    <div className="card-surface card-hover flex flex-col overflow-hidden">
      <Link to="/products/$productId" params={{ productId: product.id }} className="block">
        <ProductThumb id={product.id} name={product.name} className="h-36 w-full rounded-none" />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <Link
              to="/products/$productId"
              params={{ productId: product.id }}
              className="line-clamp-2 font-medium hover:text-primary"
            >
              {product.name}
            </Link>
            <p className="text-sm text-muted-foreground">{product.brand}</p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/products/$productId" params={{ productId: product.id }}>
                  View Details
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem className="text-danger" onClick={() => onRemove(product.id)}>
                Remove from Tracking
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="text-2xl font-semibold tracking-tight">{usd(low.price)}</p>
        <RetailerTag retailer={low.retailer} />
        <div className="flex items-center gap-2">
          <ChangeBadge change={change} />
          <StockBadge inStock={low.inStock} />
        </div>
        <div className="mt-auto pt-2">
          <Sparkline data={spark} color={change > 0 ? "#EF4444" : change < 0 ? "#10B981" : "#5B6B4A"} />
          <p className="text-xs text-muted-foreground">7-day trend</p>
        </div>
      </div>
    </div>
  );
}
