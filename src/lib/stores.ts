/* ------------------------------------------------------------------ */
/*  Stores the client can choose (R5.3)                               */
/*                                                                     */
/*  The list comes from the source registry (one place, 23 active      */
/*  stores), not the old hand-written retailer list that still named  */
/*  Hudson's Bay, RIMOWA and CALPAK. `user_settings.retailers` holds    */
/*  the chosen stores' labels; rows saved before this change hold the  */
/*  old names and are translated, with stores the old list never had   */
/*  (Canada Luggage Depot, Delsey.ca…) counted as chosen.              */
/* ------------------------------------------------------------------ */

import { SOURCE_SEED } from "@/lib/engine/registry/seed";
import type { SourceCategory } from "@/lib/engine/types";
import { RETAILER_NAMES } from "@/lib/retailers";

export type StoreInfo = { id: string; label: string; group: SourceCategory };

export const STORES: readonly StoreInfo[] = SOURCE_SEED.filter(
  (s) => s.status !== "defunct" && s.enabled,
).map((s) => ({ id: s.id, label: s.retailerLabel, group: s.category }));

export const STORE_GROUPS: readonly { id: SourceCategory; label: string }[] = [
  { id: "specialty_retailer", label: "Luggage stores" },
  { id: "brand_direct", label: "Brand stores" },
  { id: "major_retailer", label: "Major Canadian stores" },
  { id: "marketplace", label: "Marketplaces" },
];

const LABELS = new Set(STORES.map((s) => s.label));

/** Old retailer names whose registry label is spelled differently. */
const LEGACY_ALIASES: Record<string, string> = { Travelpro: "Travelpro.ca" };

/** Chosen store labels. Nothing saved, or nothing recognisable, means every store. */
export function enabledStoreLabels(saved: readonly string[] | null | undefined): string[] {
  if (!saved || saved.length === 0) return STORES.map((s) => s.label);
  const isLegacy = saved.some((name) => !LABELS.has(name));
  if (!isLegacy) return STORES.filter((s) => saved.includes(s.label)).map((s) => s.label);

  const legacyUniverse = new Set<string>(RETAILER_NAMES.map((n) => LEGACY_ALIASES[n] ?? n));
  const chosen = new Set(saved.map((n) => LEGACY_ALIASES[n] ?? n));
  const out = STORES.filter((s) => chosen.has(s.label) || !legacyUniverse.has(s.label)).map(
    (s) => s.label,
  );
  return out.length > 0 ? out : STORES.map((s) => s.label);
}

export function enabledStoreIds(saved: readonly string[] | null | undefined): string[] {
  const labels = new Set(enabledStoreLabels(saved));
  return STORES.filter((s) => labels.has(s.label)).map((s) => s.id);
}

/** True when every store is chosen (no filter needed). */
export function allStoresChosen(saved: readonly string[] | null | undefined): boolean {
  return enabledStoreLabels(saved).length === STORES.length;
}

/**
 * The same choice in the old retailer names, for the web-research code that
 * still filters by them. Names the registry doesn't know stay out.
 */
export function legacyRetailerNames(saved: readonly string[] | null | undefined): string[] {
  const labels = new Set(enabledStoreLabels(saved));
  return RETAILER_NAMES.filter((n) => labels.has(LEGACY_ALIASES[n] ?? n));
}

/** The old-name filter for web research: [] (no filter) when every store is chosen. */
export function legacyRetailerFilter(saved: readonly string[] | null | undefined): string[] {
  return allStoresChosen(saved) ? [] : legacyRetailerNames(saved);
}

/** Validate a list sent by the browser: registry labels only. */
export function cleanStoreLabels(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out = input.filter((v): v is string => typeof v === "string" && LABELS.has(v));
  return [...new Set(out)];
}
