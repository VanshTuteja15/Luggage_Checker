"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch, apiStream, ApiRequestError } from "@/lib/api-client";
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
      apiFetch<{ product: TrackedProduct }>(`/api/products/${productId}?days=${days}`).then(
        (r) => r.product,
      ),
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
      /** UI hint; the API ignores it. Kept so callers can tag their intent. */
      mode?: string;
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

export type SearchStatus = "idle" | "searching" | "reading" | "done" | "error";

type StreamLine =
  | { type: "partial" | "final"; data: SearchApiResponse }
  | { type: "error"; error: string; status?: number };

/**
 * Search with progressive results: the first results arrive while store
 * pages are still being read ("reading"), then the complete answer
 * ("done"). A new search cancels the one in flight.
 */
export function useStreamingSearch() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [data, setData] = useState<SearchApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(
    async (input: { query: string; refresh?: boolean; allRetailers?: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus("searching");
      setData(null);
      setError(null);

      let finished = false;
      try {
        await apiStream(
          "/api/search",
          { ...input, mode: "compare", stream: true },
          (raw) => {
            if (controller.signal.aborted) return;
            const line = raw as StreamLine;
            if (line.type === "partial") {
              setData(line.data);
              setStatus("reading");
            } else if (line.type === "final") {
              finished = true;
              setData(line.data);
              setStatus("done");
            } else if (line.type === "error") {
              finished = true;
              setError(line.error || "Search failed.");
              setStatus("error");
            }
          },
          controller.signal,
        );
        if (!finished && !controller.signal.aborted) {
          setError("The connection closed before the search finished. Try again.");
          setStatus("error");
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(errorMessage(err, "Search failed."));
        setStatus("error");
      } finally {
        if (!controller.signal.aborted) void qc.invalidateQueries({ queryKey: keys.provider });
      }
    },
    [qc],
  );

  return {
    run,
    status,
    data,
    error,
    /** True until the final answer (or an error) arrives. */
    isPending: status === "searching" || status === "reading",
  };
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

/** Optional parts of the app that are switched on (e.g. the assistant). */
export function useFeatures(enabled = true) {
  return useQuery({
    queryKey: ["features"] as const,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: () => apiFetch<{ chat: boolean }>("/api/features"),
  });
}

/* ------------------------------------------------------------------ */
/*  Morning email                                                     */
/* ------------------------------------------------------------------ */

export type EmailRecipient = {
  address: string;
  lastDeliveredAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

export type EmailProduct = {
  productId: string;
  name: string;
  brand: string;
  color: string;
  imageUrl: string | null;
  targetPrice: number | null;
  chosen: boolean;
  position: number | null;
};

export type EmailLogRow = {
  id: string;
  localDate: string;
  kind: "daily" | "test";
  status: string;
  statusText: string;
  sentAt: string | null;
  products: number;
  delivered: number;
  failed: number;
  details: string[];
};

export type EmailOverview = {
  settings: { enabled: boolean; sendTime: string; timeZone: string; recipients: EmailRecipient[] };
  provider: {
    configured: boolean;
    from: string | null;
    warning: string | null;
    missing: string | null;
    dailyLimit: number;
    sentLast24h: number;
  };
  products: EmailProduct[];
  log: EmailLogRow[];
  banner: string | null;
  timeZones: { id: string; label: string }[];
};

export type EmailSettingsPatch = Partial<{
  enabled: boolean;
  sendTime: string;
  timeZone: string;
  recipients: string[];
}>;

const emailKey = ["email"] as const;

export function useEmailOverview(enabled = true) {
  return useQuery({
    queryKey: emailKey,
    enabled,
    staleTime: 30_000,
    queryFn: () => apiFetch<EmailOverview>("/api/email"),
  });
}

export function useSaveEmailSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: EmailSettingsPatch) =>
      apiFetch<{ settings: EmailSettingsPatch }>("/api/email/settings", { method: "PUT", json: patch }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: emailKey }),
  });
}

export function useSaveEmailProducts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (productIds: string[]) =>
      apiFetch<{ chosen: number }>("/api/email/products", { method: "PUT", json: { productIds } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: emailKey }),
  });
}

export function useEmailPreview() {
  return useMutation({
    mutationFn: () =>
      apiFetch<{ subject: string; html: string; text: string; productCount: number }>(
        "/api/email/preview",
      ),
  });
}

export function useSendTestEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (to: string) =>
      apiFetch<{ status: string; providerId: string | null }>("/api/email/test", {
        method: "POST",
        json: { to },
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: emailKey }),
  });
}

/**
 * "Add to morning email" from search (R1.2): track the product first when
 * needed (through the existing /api/track flow), then add it to the email.
 * The toast's Undo takes it out again, and untracks it if this action
 * tracked it.
 */
export function useAddToEmail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { productId?: string; product?: SearchProduct }) => {
      let productId = input.productId;
      let newlyTracked = false;
      if (!productId && input.product) {
        const r = await apiFetch<{ product: TrackedProduct }>("/api/track", {
          method: "POST",
          json: { product: input.product },
        });
        productId = r.product.id;
        newlyTracked = true;
      }
      if (!productId) throw new Error("This product can't be added yet.");
      await apiFetch("/api/email/products", { method: "POST", json: { productId } });
      return { productId, newlyTracked };
    },
    onSuccess: ({ productId, newlyTracked }) => {
      invalidateProducts(qc);
      void qc.invalidateQueries({ queryKey: emailKey });
      toast.success(newlyTracked ? "Tracked and added to the morning email" : "Added to the morning email", {
        action: {
          label: "Undo",
          onClick: () => {
            void (async () => {
              try {
                await apiFetch(`/api/email/products?productId=${encodeURIComponent(productId)}`, {
                  method: "DELETE",
                });
                if (newlyTracked)
                  await apiFetch("/api/track", { method: "DELETE", json: { productIds: [productId] } });
                invalidateProducts(qc);
                void qc.invalidateQueries({ queryKey: emailKey });
                toast.info("Taken out of the morning email");
              } catch (err) {
                toast.error(errorMessage(err, "Couldn't undo that. Untick it on Morning Email."));
              }
            })();
          },
        },
      });
    },
    onError: (err) => toast.error(errorMessage(err, "Couldn't add that to the morning email")),
  });
}

/* ------------------------------------------------------------------ */

export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}
