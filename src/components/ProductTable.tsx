"use client";

import Link from "next/link";
import { ArrowUpDown, MoreHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChangeBadge, RelTime, RetailerTag, StockBadge } from "@/components/Bits";
import { ProductThumb } from "@/components/ProductThumb";
import { lowestOffer, priceChange, type Product } from "@/lib/data";
import { usd } from "@/lib/format";

type SortKey = "name" | "price" | "change" | "checked";

export function ProductTable({
  products,
  selected,
  onSelectedChange,
  onRemove,
}: {
  products: Product[];
  selected: string[];
  onSelectedChange: (ids: string[]) => void;
  onRemove: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [brand, setBrand] = useState("all");
  const [stock, setStock] = useState("all");
  const [trend, setTrend] = useState("all");
  const [range, setRange] = useState("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [asc, setAsc] = useState(true);
  const [page, setPage] = useState(1);
  const perPage = 20;

  const brands = useMemo(
    () => Array.from(new Set(products.map((p) => p.brand))).sort(),
    [products],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = products.filter((p) => {
      const low = lowestOffer(p);
      const ch = priceChange(p);
      if (
        needle &&
        !`${p.name} ${p.brand} ${p.upc} ${p.model}`.toLowerCase().includes(needle)
      )
        return false;
      if (brand !== "all" && p.brand !== brand) return false;
      if (stock === "in" && !low.inStock) return false;
      if (stock === "out" && low.inStock) return false;
      if (trend === "down" && ch >= 0) return false;
      if (trend === "up" && ch <= 0) return false;
      if (trend === "flat" && ch !== 0) return false;
      if (range === "u150" && low.price >= 150) return false;
      if (range === "150-350" && (low.price < 150 || low.price > 350)) return false;
      if (range === "o350" && low.price <= 350) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      const dir = asc ? 1 : -1;
      if (sort === "name") return a.name.localeCompare(b.name) * dir;
      if (sort === "price") return (lowestOffer(a).price - lowestOffer(b).price) * dir;
      if (sort === "change") return (priceChange(a) - priceChange(b)) * dir;
      return (
        (lowestOffer(a).lastCheckedMinutesAgo - lowestOffer(b).lastCheckedMinutesAgo) * dir
      );
    });
    return list;
  }, [products, q, brand, stock, trend, range, sort, asc]);

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages);
  const slice = filtered.slice((current - 1) * perPage, current * perPage);
  const allChecked = slice.length > 0 && slice.every((p) => selected.includes(p.id));

  function toggleSort(key: SortKey) {
    if (sort === key) setAsc(!asc);
    else {
      setSort(key);
      setAsc(true);
    }
  }

  return (
    <div className="card-surface overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
        <Input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Search products, brands, UPC..."
          className="h-9 w-full sm:max-w-xs"
        />
        <Select value={brand} onValueChange={setBrand}>
          <SelectTrigger className="h-9 w-[150px]">
            <SelectValue placeholder="Brand" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All brands</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={range} onValueChange={setRange}>
          <SelectTrigger className="h-9 w-[150px]">
            <SelectValue placeholder="Price range" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any price</SelectItem>
            <SelectItem value="u150">Under $150</SelectItem>
            <SelectItem value="150-350">$150 – $350</SelectItem>
            <SelectItem value="o350">Over $350</SelectItem>
          </SelectContent>
        </Select>
        <Select value={stock} onValueChange={setStock}>
          <SelectTrigger className="h-9 w-[140px]">
            <SelectValue placeholder="Stock" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All stock</SelectItem>
            <SelectItem value="in">In Stock</SelectItem>
            <SelectItem value="out">Out of Stock</SelectItem>
          </SelectContent>
        </Select>
        <Select value={trend} onValueChange={setTrend}>
          <SelectTrigger className="h-9 w-[140px]">
            <SelectValue placeholder="Change" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any change</SelectItem>
            <SelectItem value="down">Dropping</SelectItem>
            <SelectItem value="up">Rising</SelectItem>
            <SelectItem value="flat">Stable</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allChecked}
                onCheckedChange={(v) =>
                  onSelectedChange(
                    v
                      ? Array.from(new Set([...selected, ...slice.map((p) => p.id)]))
                      : selected.filter((id) => !slice.some((p) => p.id === id)),
                  )
                }
                aria-label="Select all"
              />
            </TableHead>
            <TableHead className="w-14" />
            <TableHead>
              <button className="inline-flex items-center gap-1" onClick={() => toggleSort("name")}>
                Product <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead>
              <button
                className="inline-flex items-center gap-1"
                onClick={() => toggleSort("price")}
              >
                Lowest Price <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead>Retailer</TableHead>
            <TableHead>
              <button
                className="inline-flex items-center gap-1"
                onClick={() => toggleSort("change")}
              >
                Change <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead>Stock</TableHead>
            <TableHead>
              <button
                className="inline-flex items-center gap-1"
                onClick={() => toggleSort("checked")}
              >
                Last Checked <ArrowUpDown className="h-3 w-3" />
              </button>
            </TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {slice.map((p) => {
            const low = lowestOffer(p);
            return (
              <TableRow key={p.id} className="hover:bg-muted/60">
                <TableCell>
                  <Checkbox
                    checked={selected.includes(p.id)}
                    onCheckedChange={(v) =>
                      onSelectedChange(
                        v ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                      )
                    }
                    aria-label={`Select ${p.name}`}
                  />
                </TableCell>
                <TableCell>
                  <ProductThumb id={p.id} name={p.name} size={40} />
                </TableCell>
                <TableCell>
                  <Link
                    href={`/products/${p.id}`}
                    className="block max-w-xs"
                  >
                    <span className="font-medium hover:text-primary">{p.name}</span>
                    <span className="block text-sm text-muted-foreground">{p.brand}</span>
                    <span className="block text-xs text-muted-foreground">UPC {p.upc}</span>
                  </Link>
                </TableCell>
                <TableCell className="text-base font-semibold">{usd(low.price)}</TableCell>
                <TableCell>
                  <RetailerTag retailer={low.retailer} />
                </TableCell>
                <TableCell>
                  <ChangeBadge change={priceChange(p)} />
                </TableCell>
                <TableCell>
                  <StockBadge inStock={low.inStock} />
                </TableCell>
                <TableCell>
                  <RelTime minutes={low.lastCheckedMinutesAgo} />
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Actions">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link href={`/products/${p.id}`}>
                          View Details
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-danger"
                        onClick={() => onRemove(p.id)}
                      >
                        Remove from Tracking
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
          {slice.length === 0 ? (
            <TableRow>
              <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                No products match these filters.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted-foreground">
        <span>
          {filtered.length} product{filtered.length === 1 ? "" : "s"} · page {current} of {pages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={current >= pages}
            onClick={() => setPage(current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
