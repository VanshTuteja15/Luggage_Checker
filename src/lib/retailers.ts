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
 * Retailers shown first wherever the app lists "who we check": the three the
 * client named explicitly (Amazon, Walmart, Samsonite), then the other
 * majors. The Search page's retailer chips read this.
 */
export const PRIORITY_RETAILERS: string[] = [
  ...new Set(["Amazon.ca", "Walmart.ca", "Samsonite.ca", ...MAJOR_RETAILERS]),
];

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

/* ------------------------------------------------------------------ */
/*  Merchant URL validation                                           */
/* ------------------------------------------------------------------ */

/**
 * Hosts that aggregate other people's listings rather than selling anything.
 *
 * Google Shopping rows sometimes carry no merchant `link` at all — only a
 * `product_link` pointing back at google.com/shopping/product/…, usually on
 * a "Various sellers" row. Those are poison for this app in two ways: the
 * Buy button sends the client to Google instead of a retailer, and the
 * nightly refresh re-reads a page that has no single price to read.
 *
 * A price we cannot attribute to a retailer and cannot re-check tomorrow is
 * not an offer. Drop it at the provider boundary.
 */
const NON_MERCHANT_HOSTS = [
  "google.com",
  "google.ca",
  "googleusercontent.com",
  "gstatic.com",
  "bing.com",
  "duckduckgo.com",
  "shopping.google.com",
];

/** True when `url` looks like a real retailer product page we can re-fetch. */
export function isMerchantUrl(url: string): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;

  const host = hostOf(url);
  if (!host) return false;

  return !NON_MERCHANT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/* ------------------------------------------------------------------ */
/*  Canadian storefronts                                              */
/*                                                                     */
/*  A web search returns amazon.com next to amazon.ca, and samsonite.  */
/*  com next to samsonite.ca. The .com prices are in US dollars. Shown */
/*  as Canadian prices they'd be wrong by ~35% — so a price is only    */
/*  accepted from a page we can tell is a Canadian storefront.         */
/* ------------------------------------------------------------------ */

/** Storefronts that price in USD. Never a source of Canadian prices. */
export const US_STOREFRONTS = [
  "amazon.com",
  "walmart.com",
  "samsonite.com",
  "tumi.com",
  "ebay.com",
  "bestbuy.com",
  "costco.com",
  "target.com",
  "macys.com",
  "kohls.com",
  "nordstrom.com",
  "dillards.com",
  "jcpenney.com",
  "zappos.com",
  "ebags.com",
  "luggagepros.com",
];

/** Canadian retailers whose domain isn't .ca, but whose prices are CAD. */
const CANADIAN_DOT_COM = ["thebay.com", "hbc.com", "hudsonsbay.com", "londondrugs.com"];

function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** A path like /en-ca/, /fr-ca/ or /ca/en/ marks a site's Canadian store. */
const CANADIAN_LOCALE_PATH = /\/(?:en|fr)[-_]ca(?:\/|$)|\/ca\/(?:en|fr)(?:\/|$)/i;

/** Explicit Canadian-dollar markers in page text. */
const CAD_MARKER = /\bCAD\b|\bCA\$|\bC\$|\$\s?CAD\b/;

/** French-Canadian price format: comma decimals, dollar sign after ("129,99 $"). */
const FRENCH_CAD_PRICE = /\d,\d{2}\s?\$/;

/**
 * Is this page a Canadian storefront? Decided from the URL first (reliable),
 * then from explicit currency markers in the page text (for .com retailers
 * that serve Canada without saying so in the domain).
 */
export function isCanadianStorefront(url: string, pageText = ""): boolean {
  const host = hostOf(url);
  if (!host) return false;

  if (hostMatches(host, US_STOREFRONTS)) {
    // Some .com brands run their Canadian store under a locale path.
    return CANADIAN_LOCALE_PATH.test(url);
  }

  if (host.endsWith(".ca")) return true;
  if (hostMatches(host, CANADIAN_DOT_COM)) return true;
  if (CANADIAN_LOCALE_PATH.test(url)) return true;

  return CAD_MARKER.test(pageText) || FRENCH_CAD_PRICE.test(pageText);
}

/**
 * Domains to rank first in web research: every registry retailer's own
 * domain, excluding US storefronts. Used with "prefer", so other Canadian
 * shops still appear — this steers, it doesn't restrict.
 */
export function preferredResearchDomains(): string[] {
  const domains = new Set<string>();
  for (const info of Object.values(RETAILER_INFO)) {
    for (const d of [info.domain, ...(info.altDomains ?? [])]) {
      if (!hostMatches(d, US_STOREFRONTS)) domains.add(d);
    }
  }
  return [...domains];
}

/**
 * Domains that never carry a Canadian retail price: US storefronts, social
 * networks, video, forums and review sites. Excluding them up front means
 * the result slots a credit buys go to pages that can actually answer.
 */
export const RESEARCH_EXCLUDED_DOMAINS = [
  ...US_STOREFRONTS,
  "reddit.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "pinterest.com",
  "pinterest.ca",
  "x.com",
  "twitter.com",
  "quora.com",
  "wikipedia.org",
  "trustpilot.com",
  "google.com",
  "google.ca",
];
