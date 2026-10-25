// @vitest-environment jsdom
/* ------------------------------------------------------------------ */
/*  A5.2: no screen outside "Technical details" shows setup words      */
/*  (adapter, UCP_, _URL, source., engine.) or snake_case identifiers.  */
/*                                                                     */
/*  Each main page is rendered in a browser-like DOM with its real     */
/*  components and realistic data (fetch answers per API path), then   */
/*  the visible text plus placeholder/aria-label/title/alt is scanned. */
/*  Store status's collapsed Technical details is the one exception.  */
/* ------------------------------------------------------------------ */

import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { adminOverview } from "@/lib/engine/admin-actions";
import { engineConfig } from "@/lib/engine/config";
import { resolveFlags } from "@/lib/engine/flags";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { createRuntime } from "@/lib/engine/recorder";
import { groupOffers } from "@/lib/engine/research/answer";
import { SOURCE_SEED, unverifiableReason } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { storeStatusRows } from "@/lib/engine/store-status";
import { ThemeProvider } from "@/lib/theme";
import type { AnswerOffer, StoreStatusRow as SearchStoreRow } from "@/lib/engine/types";
import type { ResearchView } from "@/lib/research-client";
import type { TrackedProduct } from "@/lib/types";

/* ── the rule ─────────────────────────────────────────────────────── */

const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: "adapter", re: /\badapters?\b/gi },
  { name: "UCP_", re: /UCP_\w*/g },
  { name: "_URL", re: /\w*_URL\b/g },
  { name: "source.", re: /\bsource\.[a-z][\w.-]*/gi },
  { name: "engine.", re: /\bengine\.[a-z][\w.-]*/gi },
  { name: "snake_case", re: /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g },
];

function violations(text: string): string[] {
  const out: string[] = [];
  for (const { name, re } of FORBIDDEN) {
    const m = text.match(re);
    if (m) out.push(`${name}: ${[...new Set(m)].slice(0, 5).join(", ")}`);
  }
  return out;
}

/** What a person can read or hear: text, plus placeholder, aria-label, title and alt. */
function shownText(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("[data-technical], script, style").forEach((n) => n.remove());
  const attrs = [...clone.querySelectorAll("[placeholder],[aria-label],[title],[alt]")].flatMap(
    (el) =>
      ["placeholder", "aria-label", "title", "alt"]
        .map((a) => el.getAttribute(a))
        .filter((v): v is string => !!v),
  );
  return `${clone.textContent ?? ""}\n${attrs.join("\n")}`;
}

/* ── the browser around the pages ─────────────────────────────────── */

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    prefetch: () => Promise.resolve(),
    back: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ productId: "p-paralux" }),
  redirect: () => {},
  notFound: () => {},
}));

vi.mock("@/lib/store", () => {
  const state = {
    ready: true,
    authed: true,
    email: "owner@example.test",
    userId: "u-owner",
    liveMode: true,
    signIn: () => {},
    signOut: async () => {},
    recentSearches: ["Samsonite Paralux Medium"],
    addSearch: () => {},
    removeSearch: () => {},
    clearSearches: () => {},
  };
  return {
    useStore: () => state,
    useHydrated: () => true,
    StoreProvider: ({ children }: { children: unknown }) => children,
  };
});

/* ── realistic data ───────────────────────────────────────────────── */

const NOW = new Date();
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

function history(base: number) {
  return Array.from({ length: 30 }, (_, i) => ({
    date: iso(29 - i).slice(0, 10),
    price: base + (i % 7 === 0 ? 35 : 0),
  }));
}

const PRODUCTS: TrackedProduct[] = [
  {
    id: "p-paralux",
    slug: "samsonite-paralux-medium",
    name: "Samsonite Paralux Hardside Expandable Spinner Medium",
    brand: "Samsonite",
    model: "137394",
    color: "Black",
    upc: "043202927614",
    imageUrl: null,
    productType: "Luggage",
    offers: [
      {
        retailer: "Canada Luggage Depot",
        price: 434.95,
        inStock: true,
        url: "https://www.canadaluggagedepot.ca/products/paralux-medium",
        title: "Samsonite Paralux Medium",
        lastCheckedAt: iso(0),
      },
      {
        retailer: "Amazon.ca",
        price: 449.99,
        inStock: false,
        url: "https://www.amazon.ca/dp/B0PARALUXM",
        title: "Samsonite Paralux Spinner Medium",
        lastCheckedAt: iso(1),
      },
    ],
    history: history(434.95),
    historyByRetailer: {
      "Canada Luggage Depot": history(434.95),
      "Amazon.ca": history(449.99),
    },
    lowestPrice: 434.95,
    lowestRetailer: "Canada Luggage Depot",
    previousLowest: 469.95,
    change: -35,
    retailerCount: 2,
    spread: 15.04,
    inStock: true,
    targetPrice: 399,
    alertEnabled: true,
    lastCheckedAt: iso(0),
    trackedAt: iso(40),
  },
  {
    id: "p-alpha",
    slug: "tumi-alpha-carry-on",
    name: "TUMI Alpha International Expandable Carry-On",
    brand: "TUMI",
    model: "",
    color: "Black",
    upc: null,
    imageUrl: null,
    productType: "Luggage",
    offers: [],
    history: [],
    historyByRetailer: {},
    lowestPrice: null,
    lowestRetailer: null,
    previousLowest: null,
    change: 0,
    retailerCount: 0,
    spread: 0,
    inStock: false,
    targetPrice: null,
    alertEnabled: false,
    lastCheckedAt: null,
    trackedAt: iso(3),
  },
];

const EMAIL = {
  settings: {
    enabled: true,
    sendTime: "09:00",
    timeZone: "America/Edmonton",
    recipients: [
      {
        address: "manager@example.test",
        lastDeliveredAt: iso(1),
        lastError: null,
        lastErrorAt: null,
      },
      {
        address: "sales@example.test",
        lastDeliveredAt: null,
        lastError: "That address was refused by the email service. Check it for typos.",
        lastErrorAt: iso(1),
      },
    ],
  },
  provider: {
    configured: false,
    from: null,
    warning: null,
    missing: "The email service isn't connected yet.",
    dailyLimit: 90,
    sentLast24h: 2,
  },
  products: PRODUCTS.map((p, i) => ({
    productId: p.id,
    name: p.name,
    brand: p.brand,
    color: p.color,
    imageUrl: null,
    targetPrice: p.targetPrice,
    chosen: i === 0,
    position: i === 0 ? 0 : null,
  })),
  log: [
    {
      id: "run-1",
      localDate: iso(1).slice(0, 10),
      kind: "daily",
      status: "partial",
      statusText: "Sent to 1 of 2",
      sentAt: iso(1),
      products: 1,
      delivered: 1,
      failed: 1,
      details: ["sales@example.test: That address was refused by the email service."],
    },
  ],
  banner: "Yesterday's morning email didn't reach sales@example.test.",
  timeZones: [{ id: "America/Edmonton", label: "Calgary (Mountain)" }],
};

const SETTINGS = {
  adminEmail: "owner@example.test",
  timezone: "America/Edmonton",
  dailyReport: false,
  reportEmail: "owner@example.test",
  include: { drops: true, increases: true, oos: true, summary: true },
  retailers: ["Canada Luggage Depot", "Amazon.ca", "Samsonite.ca"],
};

const PROVIDER = {
  provider: "tavily",
  providerLabel: "Tavily",
  configured: true,
  providers: ["tavily"],
  budgets: [
    {
      provider: "tavily",
      label: "Tavily",
      used: 538,
      limit: 950,
      remaining: 412,
      period: "month",
      exhausted: false,
      note: "Resets on the 1st.",
    },
  ],
};

/** Store status data from the real overview code, on a store with some history. */
async function overviewFixture() {
  const store = new MemoryEngineStore(SOURCE_SEED);
  const rt = createRuntime(store, {
    fetchImpl: (async () => new Response("", { status: 404 })) as typeof fetch,
    resolve: async () => ["23.227.38.65"],
  });
  const attempt = (sourceId: string, outcome: "ok" | "challenge", status: number) => ({
    sourceId,
    adapter: "html_structured" as const,
    url: `https://example.test/${sourceId}`,
    method: "GET",
    status,
    outcome,
    durationMs: 90,
    bytes: 5000,
    error: outcome === "ok" ? null : `HTTP ${status}`,
    startedAt: new Date().toISOString(),
    sessionId: null,
    cacheAgeSec: null,
  });
  await store.insertFetchAttempts([
    attempt("samsonite-ca", "challenge", 307),
    attempt("samsonite-ca", "challenge", 307),
    attempt("samsonite-ca", "challenge", 307),
    attempt("canadaluggagedepot", "ok", 200),
  ]);
  const overview = await adminOverview(rt, { estimatesConfigured: true });
  return {
    ...overview,
    reviews: [
      {
        id: "r-1",
        listingTitle: "Samsonite Paralux Spinner M",
        listingUrl: "https://www.luggagecity.ca/products/paralux-m",
        sourceId: "luggagecity",
        candidateName: "Samsonite Paralux Hardside Expandable Spinner Medium",
        candidateProductId: "p-1",
        score: 0.82,
        reasons: ["near match (0.82) queued for review"],
      },
    ],
    usage: {
      estimates: { configured: true, left: 412, cap: 950 },
      emails: { last24h: 2, dailyLimit: 90, thisMonth: 41, monthlyLimit: 2700 },
    },
    estimateRejections: [
      {
        sourceId: "samsonite-ca",
        query: "Samsonite Paralux Large",
        url: "https://www.samsonite.ca/en/x/1.html",
        title: "Paralux Spinner Large",
        price: 150,
        reasons: ["cheaper than the smaller size's verified price ($434.95)"],
        foundAt: iso(0),
      },
    ],
  };
}

/** A finished search, with every store row worded by the real registry code. */
function searchView(): ResearchView {
  const routeCtx = { flags: resolveFlags([]), config: engineConfig() };
  const rows: Record<string, SearchStoreRow> = {};
  for (const s of SOURCE_SEED.filter((x) => x.status === "active")) {
    const base = { sourceId: s.id, retailer: s.retailerLabel, url: null, durationMs: null };
    rows[s.id] =
      s.id === "canadaluggagedepot"
        ? { ...base, state: "verified", message: "1 price", durationMs: 1300 }
        : s.liveClass === "blocked"
          ? { ...base, state: "blocked", message: unverifiableReason(s, routeCtx) }
          : { ...base, state: "not_configured", message: unverifiableReason(s, routeCtx) };
  }
  const offer = (o: Partial<AnswerOffer>): AnswerOffer => ({
    sourceId: "canadaluggagedepot",
    retailer: "Canada Luggage Depot",
    url: "https://www.canadaluggagedepot.ca/products/paralux-medium?variant=1",
    title: "Samsonite Paralux Hardside Expandable Spinner Medium",
    brand: "Samsonite",
    sizeClass: "medium",
    identifiers: [],
    imageUrl: null,
    reasons: [],
    price: 434.95,
    listPrice: 519.95,
    currency: "CAD",
    availability: "in_stock",
    colour: "Black",
    freshness: { kind: "live", fetchedAt: NOW.toISOString() },
    confidence: 0.95,
    lowConfidence: false,
    method: "shopify_product_json",
    observationId: null,
    listingId: null,
    productId: null,
    evidence: null,
    ...o,
  });
  const offers = [
    offer({}),
    offer({
      colour: "Stone Grey",
      url: "https://www.canadaluggagedepot.ca/products/paralux-medium?variant=2",
    }),
    offer({
      sourceId: "amazon-ca",
      retailer: "Amazon.ca",
      url: "https://www.amazon.ca/dp/B0PARALUXM",
      title: "Samsonite Paralux Hardside Spinner Medium",
      price: 419.99,
      listPrice: null,
      availability: "unknown",
      colour: null,
      freshness: { kind: "estimate", foundAt: NOW.toISOString() },
      method: "web_estimate",
      reasons: ["single source"],
      confidence: 0.5,
    }),
  ];
  return {
    status: "done",
    sessionId: "s-1",
    query: "Samsonite Paralux Medium",
    rows,
    offers,
    answer: {
      query: "Samsonite Paralux Medium",
      parsed: luggagePack.parseQuery("Samsonite Paralux Medium"),
      products: groupOffers(offers, luggagePack),
      stores: Object.values(rows),
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      firstPriceMs: 1300,
      totalMs: 4400,
      deadlineHit: false,
      notes: [],
    },
    error: null,
    lastSeq: 9,
    startedAt: NOW.getTime(),
    estimating: false,
  };
}

/* ── rendering ────────────────────────────────────────────────────── */

const unknownPaths = new Set<string>();
let OVERVIEW: unknown;
/** Set by a test to make Store status answer as for someone who isn't the shop's account. */
let overviewStatus = 200;

function answer(path: string): { status: number; body: unknown } {
  if (path === "/api/products") return { status: 200, body: { products: PRODUCTS } };
  if (path.startsWith("/api/products/"))
    return {
      status: 200,
      body: { product: PRODUCTS.find((x) => path.endsWith(x.id)) ?? PRODUCTS[0] },
    };
  if (path === "/api/settings") return { status: 200, body: { settings: SETTINGS } };
  if (path === "/api/search") return { status: 200, body: PROVIDER };
  if (path === "/api/features") return { status: 200, body: { chat: false } };
  if (path === "/api/email") return { status: 200, body: EMAIL };
  if (path === "/api/admin/overview")
    return overviewStatus === 200
      ? { status: 200, body: OVERVIEW }
      : { status: overviewStatus, body: { error: "Admins only." } };
  unknownPaths.add(path);
  return { status: 404, body: { error: "That isn't available." } };
}

beforeAll(async () => {
  OVERVIEW = await overviewFixture();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { status, body } = answer(new URL(raw, "http://localhost").pathname);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(el: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(ThemeProvider, null, el)),
    );
  });
  // Let every query answer and the page settle.
  for (let i = 0; i < 40 && (client.isFetching() > 0 || i < 3); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  return container;
}

const PAGES: [string, () => Promise<{ default: ComponentType }>][] = [
  ["Dashboard", () => import("@/app/dashboard/page")],
  ["Search", () => import("@/app/search/page")],
  ["Tracked Products", () => import("@/app/tracked/page")],
  ["Morning Email", () => import("@/app/email/page")],
  ["Price History", () => import("@/app/history/page")],
  ["Product page", () => import("@/app/products/[productId]/page")],
  ["Store status", () => import("@/app/admin/page")],
  ["Settings", () => import("@/app/settings/page")],
];

describe("A5.2: plain words on every main page", () => {
  it("the scan catches what it must, and passes the app's own labels", () => {
    expect(violations("Routes: shopify_ucp, UCP_AGENT_PROFILE_URL").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(violations("switched off (source.unluggage.product_json)").join()).toMatch(/source\./);
    expect(violations("the price engine is switched off (engine.enabled)").join()).toMatch(
      /engine\./,
    );
    expect(violations("Web estimate · confirm on site · single source.")).toEqual([]);
    expect(violations("Verified live · 9:02 a.m. · Fri, Oct 10")).toEqual([]);
  });

  for (const [name, load] of PAGES) {
    it(`${name} shows no setup words or snake_case`, async () => {
      const Page = (await load()).default;
      const el = await render(createElement(Page));
      const text = shownText(el);
      expect(text.trim().length, `${name} rendered nothing`).toBeGreaterThan(40);
      expect(violations(text), `${name}:\n${text.slice(0, 3000)}`).toEqual([]);
    });
  }

  it("search results (every store row, verified and estimated prices) are plain", async () => {
    const { ResearchResults } = await import("@/components/research/ResearchResults");
    const el = await render(
      createElement(ResearchResults, {
        view: searchView(),
        sort: "price-asc",
        onSort: () => {},
        onReverify: () => {},
        onCancel: () => {},
        onTrack: () => {},
        trackedKeys: new Set<string>(),
        trackPending: false,
      }),
    );
    const text = shownText(el);
    expect(text).toContain("Canada Luggage Depot");
    expect(text).toContain("Web estimate");
    expect(violations(text), text.slice(0, 3000)).toEqual([]);
  });

  it("Store status: plain tabs by default; the technical detail stays in a collapsed Technical details", async () => {
    const Page = (await import("@/app/admin/page")).default;
    const el = await render(createElement(Page));
    const text = shownText(el);
    expect(text).toContain("What we can get there");
    expect(text).toContain("Samsonite.ca");
    const technical = el.querySelector("[data-technical]");
    expect(technical, "Technical details is there").not.toBeNull();
    expect(technical!.tagName).toBe("DETAILS");
    expect(technical!.hasAttribute("open")).toBe(false); // collapsed
    expect(violations(technical!.textContent ?? "")).not.toEqual([]); // route names live here

    // Every default tab, not only the first.
    const seen: Record<string, string> = {};
    for (const name of ["Products to review", "Data entry", "Usage"]) {
      const tab = [...el.querySelectorAll('[role="tab"]')].find((b) =>
        (b.textContent ?? "").startsWith(name),
      ) as HTMLButtonElement;
      await act(async () => tab.click());
      seen[name] = shownText(el);
      expect(
        violations(seen[name]),
        `${name}:
${seen[name].slice(0, 3000)}`,
      ).toEqual([]);
    }
    expect(seen["Products to review"]).toContain("Same product");
    expect(seen["Products to review"]).toContain("This looks like");
    expect(seen["Data entry"]).toContain("Staff-checked price");
    expect(seen["Data entry"]).toContain("Dealer list");
    expect(seen.Usage).toContain("Web estimates left this month: 412");
    expect(seen.Usage).toContain("Emails sent this month: 41 of 2,700");
  });

  it("Store status for anyone else: a plain sentence, no setup names", async () => {
    overviewStatus = 403;
    try {
      const Page = (await import("@/app/admin/page")).default;
      const text = shownText(await render(createElement(Page)));
      expect(text).toContain("Store status is for the shop");
      expect(violations(text)).toEqual([]);
    } finally {
      overviewStatus = 200;
    }
  });

  it("the default Stores tab says what each store gives, in the client's words", () => {
    const ctx = { flags: resolveFlags([]), config: engineConfig() };
    const rows = storeStatusRows(
      SOURCE_SEED,
      [
        {
          sourceId: "samsonite-ca",
          circuit: "closed",
          attempts24h: 4,
          blocked24h: 4,
          lastOkAt: null,
        },
        {
          sourceId: "canadaluggagedepot",
          circuit: "closed",
          attempts24h: 5,
          blocked24h: 0,
          lastOkAt: iso(0),
        },
      ],
      { ...ctx, estimatesOn: true, feedSources: new Set(["tumi-ca"]) },
    );
    const by = (id: string) => rows.find((r) => r.sourceId === id)!;
    expect(by("canadaluggagedepot")).toMatchObject({ gets: ["Verified live"], problem: null });
    expect(by("samsonite-ca").gets).toEqual(["Web estimate"]);
    expect(by("samsonite-ca").problem).toBe(
      "The store turned away 4 of 4 checks in the last 24 hours.",
    );
    expect(by("tumi-ca").gets).toEqual(["Web estimate", "Dealer list"]);
    expect(by("tumi-ca").problem).toBe("It blocks automated checks from our network.");
    const off = storeStatusRows(SOURCE_SEED, [], { ...ctx, estimatesOn: false });
    expect(off.find((r) => r.sourceId === "samsonite-ca")!.gets).toEqual(["Link only"]);
    for (const r of rows) expect(violations(`${r.gets.join(" ")} ${r.problem ?? ""}`)).toEqual([]);
  });

  it("every API path the pages asked for had realistic data", () => {
    // A missing fixture would scan an error state instead of the page.
    expect([...unknownPaths]).toEqual([]);
  });
});

describe("R5.5: server errors are plain sentences; the detail stays in the log", () => {
  it("never sends a database or setup message to the screen", async () => {
    const { errorResponse, NOT_SET_UP, SERVER_FAILED } = await import("@/lib/api/respond");
    const { ApiError } = await import("@/lib/supabase/server");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const crash = errorResponse(new Error('relation "email_digest_runs" does not exist'), "GET /x");
    expect(crash.status).toBe(500);
    const body = (await crash.json()) as { error: string };
    const ref = /\(ref ([0-9a-f]{8})\)$/.exec(body.error)?.[1];
    expect(body.error.startsWith(SERVER_FAILED)).toBe(true);
    expect(ref).toBeDefined();
    expect(body.error).not.toMatch(/relation|email_digest/);
    expect(violations(body.error)).toEqual([]);
    const setup = errorResponse(new Error("TAVILY_API_KEY is not configured"), "GET /y");
    expect(setup.status).toBe(503);
    expect(((await setup.json()) as { error: string }).error).toBe(NOT_SET_UP);
    // The detail is logged with the same reference.
    expect(String(log.mock.calls[0][0])).toBe(`GET /x [${ref}]:`);
    expect(log.mock.calls[0][1]).toBeInstanceOf(Error);
    const signedOut = errorResponse(new ApiError(401, "Not signed in."), "GET /z");
    expect(((await signedOut.json()) as { error: string }).error).toBe("Not signed in.");
    log.mockRestore();
  });

  it("sign-in not set up reads as a sentence, not env names", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { requireUser } = await import("@/lib/supabase/server");
    const { NextRequest } = await import("next/server");
    await expect(requireUser(new NextRequest("http://localhost/api/products"))).rejects.toThrow(
      "Sign-in isn't set up yet. The person who set up LuggageTracker can connect it.",
    );
    log.mockRestore();
    vi.unstubAllEnvs();
  });
});
