/* ------------------------------------------------------------------ */
/*  What the probe touches — a deliberately small, fixed sample.       */
/*                                                                     */
/*  Policy (from docs/store-audit.json):                               */
/*   • Stores whose terms restrict scraping get ONLY their store-      */
/*     published agent channel (UCP) — no product JSON, no HTML.        */
/*   • Stores whose terms forbid automated access entirely (Amazon,    */
/*     Walmart, Costco, eBay HTML, Best Buy, Canadian Tire, London     */
/*     Drugs) are not touched at all. eBay is reached via its API only. */
/*   • JP Grimard: robots.txt only (product pages returned 403).       */
/* ------------------------------------------------------------------ */

export type Tos = "silent" | "restricts" | "unknown" | "sanctions_json";
export type Channel = "ucp" | "json" | "js" | "html";

export type Target = {
  id: string;
  name: string;
  host: string;
  tos: Tos;
  /** Shopify stores: which channels the policy allows us to probe. */
  shopify?: { handle: string | null; query: string; channels: Channel[] };
  /** Non-Shopify product pages (terms silent). */
  html?: { urls: string[]; repeatFirst?: number };
  sitemap?: boolean;
  robotsOnly?: boolean;
};

export const TARGETS: Target[] = [
  // ── Shopify, all channels (terms silent / unread / agents.md sanctions JSON)
  {
    id: "unluggage",
    name: "U.N. Luggage",
    host: "unluggage.com",
    tos: "unknown",
    shopify: { handle: "samsonite-outline-pro-medium-spinner", query: "Samsonite Outline Pro Medium Spinner", channels: ["ucp", "json", "js", "html"] },
  },
  {
    id: "canadaluggagedepot",
    name: "Canada Luggage Depot",
    host: "www.canadaluggagedepot.ca",
    tos: "sanctions_json",
    shopify: { handle: "samsonite-omni-3-0-large-spinner-expandable-luggage", query: "Samsonite Omni 3.0 Large Spinner", channels: ["ucp", "json", "js", "html"] },
  },
  {
    id: "delsey-ca",
    name: "Delsey Canada",
    host: "delsey.ca",
    tos: "silent",
    shopify: { handle: "40119980500us-wagram-23-inch-expandable-carry-on-suitcase-black", query: "Wagram 23 inch expandable carry-on", channels: ["ucp", "json", "js", "html"] },
  },
  {
    id: "bentley",
    name: "Bentley",
    host: "www.shopbentley.com",
    tos: "unknown",
    shopify: { handle: "air-canada-logan-20-hardside-spinner", query: "Air Canada Logan 20 Hardside Spinner", channels: ["ucp", "json", "js", "html"] },
  },

  // ── Shopify, agent channel only (terms restrict scraping)
  { id: "travelpro-ca", name: "Travelpro Canada", host: "travelpro.ca", tos: "restricts", shopify: { handle: null, query: "Platinum Elite 25 Expandable Spinner", channels: ["ucp"] } },
  { id: "briggs-riley-ca", name: "Briggs & Riley Canada", host: "briggs-riley.ca", tos: "restricts", shopify: { handle: null, query: "Essential Carry-On Expandable Spinner", channels: ["ucp"] } },
  { id: "heys-ca", name: "Heys Canada", host: "ca.heys.com", tos: "restricts", shopify: { handle: null, query: "Xtrak 26 inch", channels: ["ucp"] } },
  { id: "monos-ca", name: "Monos", host: "ca.monos.com", tos: "restricts", shopify: { handle: null, query: "Carry-On", channels: ["ucp"] } },
  { id: "away-ca", name: "Away", host: "www.awaytravel.com", tos: "restricts", shopify: { handle: null, query: "The Carry-On", channels: ["ucp"] } },
  { id: "luggagecity", name: "Luggage City", host: "www.luggagecity.ca", tos: "restricts", shopify: { handle: null, query: "Aleon 19 Spinner", channels: ["ucp"] } },

  // ── HTML structured data (terms silent)
  {
    id: "samsonite-ca",
    name: "Samsonite Canada",
    host: "www.samsonite.ca",
    tos: "silent",
    sitemap: true,
    html: {
      urls: [
        "https://www.samsonite.ca/en/luggage/checked/samsonite-outline-pro-spinner-medium/137394XXXX.html",
        "https://www.samsonite.ca/en/luggage/carry-on/samsonite-outline-pro-spinner-carry-on%E2%84%A2/137392XXXX.html",
        "https://www.samsonite.ca/en/luggage/carry-on/samsonite-upscape-spinner-carry-on%E2%84%A2/143108XXXX.html",
      ],
      // Repeated reads of one page show whether access stays open (or gets
      // challenged) and whether the price is stable between reads.
      repeatFirst: 3,
    },
  },
  { id: "tumi-ca", name: "TUMI Canada", host: "ca.tumi.com", tos: "silent", html: { urls: ["https://ca.tumi.com/en/p/expandable-carry-on-01396831041/"] } },
  {
    id: "sportinglife",
    name: "Sporting Life",
    host: "www.sportinglife.ca",
    tos: "silent",
    html: { urls: ["https://www.sportinglife.ca/en-CA/equipment/more-gear/all-bags/luggage-travel/heritage%23153--hardshell-large-carry-on-luggage/25925609-00228935.html"] },
  },
  {
    id: "simons",
    name: "Simons",
    host: "www.simons.ca",
    tos: "silent",
    html: { urls: ["https://www.simons.ca/en/men-accessories/suitcases-travel-bags/front-pocket-carry-on-luggage-onyx-collection--21720-26107540"] },
  },

  // ── robots.txt only
  { id: "jpgrimard", name: "JP Grimard", host: "jpgrimard.com", tos: "unknown", robotsOnly: true },
];

/** eBay Browse API sample: a product we also see at U.N. Luggage (Outline Pro Medium, Black). */
export const EBAY_QUERY = "Samsonite Outline Pro Medium Spinner";
export const EBAY_GTIN = "043202927614";
