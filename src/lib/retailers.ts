/* ------------------------------------------------------------------ */
/*  Canonical retailer registry — Canada-focused                      */
/*                                                                     */
/*  Single source of truth for retailer identity, branding and         */
/*  priority. `tier` drives ranking: majors are the retailers the      */
/*  client cares about most and are never dropped from a result set.   */
/* ------------------------------------------------------------------ */

export type RetailerCategory = "major" | "specialty" | "other";

export type RetailerInfo = {
  name: string;
  color: string;
  category: RetailerCategory;
  /** Primary domain, used to identify a retailer from an offer URL. */
  domain: string;
  /** Additional domains that map to the same retailer. */
  altDomains?: string[];
};

/** All known retailers with metadata. Keyed by canonical display name. */
export const RETAILER_INFO: Record<string, RetailerInfo> = {
  // ── Major Canadian retailers ──
  "Amazon.ca": {
    name: "Amazon.ca",
    color: "#FF9900",
    category: "major",
    domain: "amazon.ca",
    altDomains: ["amazon.com"],
  },
  "Costco.ca": {
    name: "Costco.ca",
    color: "#E31837",
    category: "major",
    domain: "costco.ca",
  },
  "Walmart.ca": {
    name: "Walmart.ca",
    color: "#0071CE",
    category: "major",
    domain: "walmart.ca",
  },
  "Hudson's Bay": {
    name: "Hudson's Bay",
    color: "#004990",
    category: "major",
    domain: "thebay.com",
    altDomains: ["hbc.com", "hudsonsbay.com"],
  },
  "Canadian Tire": {
    name: "Canadian Tire",
    color: "#D52B1E",
    category: "major",
    domain: "canadiantire.ca",
  },
  Bentley: {
    name: "Bentley",
    color: "#1A1A1A",
    category: "major",
    domain: "bentley.ca",
  },
  "Best Buy Canada": {
    name: "Best Buy Canada",
    color: "#0046BE",
    category: "major",
    domain: "bestbuy.ca",
  },
  "London Drugs": {
    name: "London Drugs",
    color: "#ED1C24",
    category: "major",
    domain: "londondrugs.com",
  },

  // ── Specialty / brand direct ──
  "Samsonite.ca": {
    name: "Samsonite.ca",
    color: "#5B6B4A",
    category: "specialty",
    domain: "samsonite.ca",
    altDomains: ["samsonite.com"],
  },
  "TUMI.ca": {
    name: "TUMI.ca",
    color: "#111827",
    category: "specialty",
    domain: "tumi.ca",
    altDomains: ["tumi.com"],
  },
  Away: {
    name: "Away",
    color: "#0F766E",
    category: "specialty",
    domain: "awaytravel.com",
  },
  Travelpro: {
    name: "Travelpro",
    color: "#7C3AED",
    category: "specialty",
    domain: "travelpro.com",
    altDomains: ["travelproluggage.ca"],
  },
  Monos: {
    name: "Monos",
    color: "#C4A882",
    category: "specialty",
    domain: "monos.com",
    altDomains: ["monos.ca"],
  },
  "Briggs & Riley": {
    name: "Briggs & Riley",
    color: "#2D3748",
    category: "specialty",
    // NOTE: previously misspelled "brigsandriley.com", which silently
    // broke URL-based matching for this retailer.
    domain: "briggs-riley.com",
    altDomains: ["briggsandriley.com", "briggs-riley.ca"],
  },
  RIMOWA: {
    name: "RIMOWA",
    color: "#8A8A8A",
    category: "specialty",
    domain: "rimowa.com",
  },
  CALPAK: {
    name: "CALPAK",
    color: "#B49AC7",
    category: "specialty",
    domain: "calpaktravel.com",
  },

  // ── Marketplace / other ──
  "eBay.ca": {
    name: "eBay.ca",
    color: "#E53238",
    category: "other",
    domain: "ebay.ca",
    altDomains: ["ebay.com"],
  },
};

const CATEGORY_ORDER: Record<RetailerCategory, number> = {
  major: 0,
  specialty: 1,
  other: 2,
};

/** Ordered retailer names — majors first, then specialty, then other. */
export const RETAILER_NAMES: string[] = Object.entries(RETAILER_INFO)
  .sort((a, b) => CATEGORY_ORDER[a[1].category] - CATEGORY_ORDER[b[1].category])
  .map(([name]) => name);

/** Retailers the client always wants represented in a result set. */
export const MAJOR_RETAILERS: string[] = RETAILER_NAMES.filter(
  (n) => RETAILER_INFO[n].category === "major",
);

/**
 * Must-include stores for live price search: big-box plus brand-direct
 * sites the client named (Amazon, Walmart, Samsonite, …).
 */
export const PRIORITY_RETAILERS: string[] = [
  "Amazon.ca",
  "Walmart.ca",
  "Costco.ca",
  "Samsonite.ca",
  "Hudson's Bay",
  "Canadian Tire",
  "Best Buy Canada",
  "Bentley",
  "London Drugs",
  "TUMI.ca",
];

export function isPriorityRetailer(name: string | null | undefined): boolean {
  if (!name) return false;
  if (PRIORITY_RETAILERS.includes(name)) return true;
  return RETAILER_INFO[name]?.category === "major";
}

/** Get a retailer's brand colour, with a fallback for unknown retailers. */
export function retailerColor(name: string): string {
  return RETAILER_INFO[name]?.color ?? "#6B7280";
}

/** Get a retailer's category. Unknown retailers default to "other". */
export function retailerCategory(name: string): RetailerCategory {
  return RETAILER_INFO[name]?.category ?? "other";
}

/** Sort weight for a retailer — lower sorts first. */
export function retailerRank(name: string): number {
  return CATEGORY_ORDER[retailerCategory(name)];
}

/* ------------------------------------------------------------------ */
/*  Identification                                                    */
/* ------------------------------------------------------------------ */

/** Text aliases a shopping engine may report instead of the canonical name. */
const SOURCE_ALIASES: Record<string, string> = {
  amazon: "Amazon.ca",
  "amazon canada": "Amazon.ca",
  "amazon - canada": "Amazon.ca",
  "amazon.ca": "Amazon.ca",
  costco: "Costco.ca",
  "costco canada": "Costco.ca",
  "costco wholesale": "Costco.ca",
  "costco wholesale canada": "Costco.ca",
  "costco.ca": "Costco.ca",
  walmart: "Walmart.ca",
  "walmart canada": "Walmart.ca",
  "walmart - canada": "Walmart.ca",
  "walmart.ca": "Walmart.ca",
  "hudson's bay": "Hudson's Bay",
  "hudsons bay": "Hudson's Bay",
  "the bay": "Hudson's Bay",
  "thebay.com": "Hudson's Bay",
  thebay: "Hudson's Bay",
  "canadian tire": "Canadian Tire",
  "canadiantire.ca": "Canadian Tire",
  bentley: "Bentley",
  "bentley leathers": "Bentley",
  "best buy": "Best Buy Canada",
  "best buy canada": "Best Buy Canada",
  "bestbuy.ca": "Best Buy Canada",
  "london drugs": "London Drugs",
  "londondrugs.com": "London Drugs",
  samsonite: "Samsonite.ca",
  "samsonite canada": "Samsonite.ca",
  "samsonite.ca": "Samsonite.ca",
  tumi: "TUMI.ca",
  "tumi.ca": "TUMI.ca",
  away: "Away",
  "away travel": "Away",
  travelpro: "Travelpro",
  "travelpro.com": "Travelpro",
  monos: "Monos",
  "monos.com": "Monos",
  "briggs & riley": "Briggs & Riley",
  "briggs and riley": "Briggs & Riley",
  rimowa: "RIMOWA",
  calpak: "CALPAK",
  ebay: "eBay.ca",
  "ebay.ca": "eBay.ca",
};

/** Extract a lowercased hostname from a URL, or "" if unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Resolve a shopping-engine "source" label and/or URL to one of our known
 * retailers. Returns null when the offer comes from a retailer we don't
 * track — callers decide whether to keep it.
 */
export function matchRetailer(source: string, url = ""): string | null {
  const label = (source ?? "").trim();

  if (RETAILER_INFO[label]) return label;

  const lower = label.toLowerCase();
  if (SOURCE_ALIASES[lower]) return SOURCE_ALIASES[lower];

  for (const known of Object.keys(RETAILER_INFO)) {
    if (known.toLowerCase() === lower) return known;
  }

  const host = hostOf(url);
  if (host) {
    for (const [name, info] of Object.entries(RETAILER_INFO)) {
      const domains = [info.domain, ...(info.altDomains ?? [])];
      if (domains.some((d) => host === d || host.endsWith(`.${d}`))) return name;
    }
  }

  // Last resort: a known retailer name appearing inside the source label
  // (e.g. "Walmart Canada - Seller"). Longest match wins to avoid
  // "Away" matching inside unrelated words.
  const byLength = Object.keys(SOURCE_ALIASES).sort((a, b) => b.length - a.length);
  for (const alias of byLength) {
    if (alias.length >= 5 && lower.includes(alias)) return SOURCE_ALIASES[alias];
  }

  return null;
}

/** A display label for an offer's retailer, falling back to the raw source. */
export function displayRetailer(source: string, url = ""): string {
  return matchRetailer(source, url) ?? (source?.trim() || hostOf(url) || "Unknown");
}
