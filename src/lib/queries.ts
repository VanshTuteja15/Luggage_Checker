"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, ApiRequestError } from "@/lib/api-client";
import type { ProviderBudget } from "@/lib/search/quota";
import type { SearchProduct, SearchResponse } from "@/lib/search/types";
import type { TrackedProduct, UserSettings } from "@/lib/types";

/* ------------------------------------------------------------------ */
/*  Query keys                                                        */
/* ------------------------------------------------------------------ */

export const keys = {
  products: (days: number) => ["products", days] as const,
  product: (id: string, days: number) => ["product", id, days] as const,
  settings: ["settings"] as const,
  provider: ["search-provider"] as const,
};

/* ------------------------------------------------------------------ */
/*  Tracked products                                                  */
/* ------------------------------------------------------------------ */

export function useTrackedProducts(days = 30, enabled = true) {
  return useQuery({
    queryKey: keys.products(days),
    enabled,
    staleTime: 30_000,
    queryFn: () =>
      apiFetch<{ products: TrackedProduct[] }>(`/api/products?days=${days}`).then(
        (r) => r.products,
      ),
  });
}

export function useTrackedProduct(productId: string, days = 30, enabled = true) {
  return useQuery({
    queryKey: keys.product(productId, days),
    enabled: enabled && !!productId,
    staleTime: 30_000,
    queryFn: () =>
      apiFetch<{ product: TrackedProduct }>(
        `/api/products/${productId}?days=${days}`,
      ).then((r) => r.product),
  });
}

/* ------------------------------------------------------------------ */
/*  Tracking                                                          */
/* ------------------------------------------------------------------ */

function invalidateProducts(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["products"] });
  void qc.invalidateQueries({ queryKey: ["product"] });
}

export function useTrackProduct() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (product: SearchProduct) =>
      apiFetch<{ product: TrackedProduct }>("/api/track", {
        method: "POST",
        json: { product },
      }).then((r) => r.product),
    onSuccess: (product) => {
      invalidateProducts(qc);
      toast.success(`Now tracking ${product?.name ?? "product"}`);
    },
    onError: (err) => toast.error(errorMessage(err, "Couldn't track that product")),
  });
}

export function useUntrackProducts() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (productIds: string[]) =>
      apiFetch<{ removed: number }>("/api/track", {
        method: "DELETE",
        json: { productIds },
      }),
    onSuccess: (result) => {
      invalidateProducts(qc);
      toast.success(
        result.removed === 1 ? "Removed from tracking" : `Removed ${result.removed} products`,
      );
    },
    onError: (err) => toast.error(errorMessage(err, "Couldn't remove that product")),
  });
}

export function useSetPriceAlert() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: { productId: string; targetPrice: number | null }) =>
      apiFetch<{ product: TrackedProduct }>("/api/track", {
        method: "PATCH",
        json: input,
      }).then((r) => r.product),
    onSuccess: (_product, input) => {
      invalidateProducts(qc);
      toast.success(
        input.targetPrice === null
          ? "Price alert removed"
          : `Alert set for $${input.targetPrice.toFixed(2)}`,
      );
    },
    onError: (err) => toast.error(errorMessage(err, "Couldn't update the alert")),
  });
}

/* ------------------------------------------------------------------ */
/*  Refresh                                                           */
/* ------------------------------------------------------------------ */

export type RefreshResult = {
  checked: number;
  updated: number;
  drops: number;
  remaining: number;
};

export function useRefreshPrices() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (productId?: string) =>
      apiFetch<RefreshResult>("/api/refresh", {
        method: "POST",
        json: productId ? { productId } : {},
      }),
    onSuccess: (result) => {
      invalidateProducts(qc);
      if (result.updated === 0) {
        toast.info("No new prices found.");
      } else if (result.drops > 0) {
        toast.success(
          `Updated ${result.updated} product${result.updated === 1 ? "" : "s"} — ${result.drops} price drop${result.drops === 1 ? "" : "s"}.`,
        );
      } else {
        toast.success(`Updated ${result.updated} product${result.updated === 1 ? "" : "s"}.`);
      }
      if (result.remaining > 0) {
        toast.info(`${result.remaining} more queued — refresh again to continue.`);
      }
    },
    onError: (err) => toast.error(errorMessage(err, "Refresh failed")),
  });
}

/* ------------------------------------------------------------------ */
/*  Settings                                                          */
/* ------------------------------------------------------------------ */

export function useSettings(enabled = true) {
  return useQuery({
    queryKey: keys.settings,
    enabled,
    staleTime: 60_000,
    queryFn: () => apiFetch<{ settings: UserSettings }>("/api/settings").then((r) => r.settings),
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (patch: Partial<UserSettings>) =>
      apiFetch<{ settings: UserSettings }>("/api/settings", {
        method: "PUT",
        json: patch,
      }).then((r) => r.settings),
    onSuccess: (settings) => {
      qc.setQueryData(keys.settings, settings);
      // Retailer changes affect what search returns.
      void qc.invalidateQueries({ queryKey: ["products"] });
    },
    onError: (err) => toast.error(errorMessage(err, "Couldn't save settings")),
  });
}

/* ------------------------------------------------------------------ */
/*  Search                                                            */
/* ------------------------------------------------------------------ */

export type SearchApiResponse = SearchResponse & {
  providerLabel: string;
  budgets: ProviderBudget[];
};

export function useSearch() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      query: string;
      allRetailers?: boolean;
      refresh?: boolean;
      mode?: "compare" | "catalog";
    }) =>
      apiFetch<SearchApiResponse>("/api/search", {
        method: "POST",
        json: input,
      }),
    onSuccess: () => {
      // A search may have spent quota — keep the Settings readout honest.
      void qc.invalidateQueries({ queryKey: keys.provider });
    },
  });
}

export function useSearchProvider(enabled = true) {
  return useQuery({
    queryKey: keys.provider,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () =>
      apiFetch<{
        provider: string | null;
        providerLabel: string | null;
        configured: boolean;
        providers: string[];
        budgets: ProviderBudget[];
      }>("/api/search"),
  });
}

/* ------------------------------------------------------------------ */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
