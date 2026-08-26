export type Retailer =
  | "Amazon"
  | "Walmart"
  | "Target"
  | "Samsonite.com"
  | "Away.com"
  | "TUMI.com"
  | "Travelpro.com";

export const RETAILERS: Retailer[] = [
  "Amazon",
  "Walmart",
  "Target",
  "Samsonite.com",
  "Away.com",
  "TUMI.com",
  "Travelpro.com",
];

export const RETAILER_COLOR: Record<Retailer, string> = {
  Amazon: "#F59E0B",
  Walmart: "#2563EB",
  Target: "#EF4444",
  "Samsonite.com": "#5B6B4A",
  "Away.com": "#0F766E",
  "TUMI.com": "#111827",
  "Travelpro.com": "#7C3AED",
};

export type RetailerOffer = {
  retailer: Retailer;
  price: number;
  inStock: boolean;
  url: string;
  lastCheckedMinutesAgo: number;
};

export type PricePoint = { date: string; price: number };

export type Product = {
  id: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string;
  offers: RetailerOffer[];
  previousLowest: number;
  history: Record<string, PricePoint[]>;
  addedDaysAgo: number;
};

type Seed = {
  id: string;
  name: string;
  brand: string;
  model: string;
  color: string;
  upc: string;
  price: number;
  retailer: Retailer;
  change: number; // negative = drop today
  others: [Retailer, number, boolean][];
  addedDaysAgo: number;
};

const SEEDS: Seed[] = [
  {
    id: "samsonite-freeform-28",
    name: 'Samsonite Freeform Hardside Expandable 28"',
    brand: "Samsonite",
    model: "Freeform 28",
    color: "Midnight Black",
    upc: "042810178423",
    price: 169.99,
    retailer: "Walmart",
    change: -10,
    others: [
      ["Amazon", 179.99, true],
      ["Target", 184.99, false],
      ["Samsonite.com", 189.99, true],
    ],
    addedDaysAgo: 62,
  },
  {
    id: "travelpro-maxlite-5-25",
    name: 'Travelpro Maxlite 5 Lightweight 25"',
    brand: "Travelpro",
    model: "Maxlite 5",
    color: "Slate Green",
    upc: "051243098231",
    price: 149.99,
    retailer: "Amazon",
    change: 0,
    others: [
      ["Walmart", 154.99, true],
      ["Travelpro.com", 159.99, true],
    ],
    addedDaysAgo: 40,
  },
  {
    id: "american-tourister-stratum-24",
    name: 'American Tourister Stratum XLT 24"',
    brand: "American Tourister",
    model: "Stratum XLT",
    color: "Jet Black",
    upc: "049845721039",
    price: 109.99,
    retailer: "Walmart",
    change: -15,
    others: [
      ["Amazon", 119.99, true],
      ["Target", 124.99, true],
    ],
    addedDaysAgo: 28,
  },
  {
    id: "tumi-alpha-3-extended",
    name: "TUMI Alpha 3 Extended Trip Packing Case",
    brand: "TUMI",
    model: "Alpha 3",
    color: "Anthracite",
    upc: "742315410238",
    price: 795,
    retailer: "Amazon",
    change: 45,
    others: [
      ["TUMI.com", 825, true],
      ["Walmart", 839.99, false],
    ],
    addedDaysAgo: 90,
  },
  {
    id: "away-the-large",
    name: "Away The Large Suitcase",
    brand: "Away",
    model: "The Large",
    color: "Coast Blue",
    upc: "860002391045",
    price: 345,
    retailer: "Away.com",
    change: 0,
    others: [["Amazon", 365, true]],
    addedDaysAgo: 51,
  },
  {
    id: "briggs-riley-baseline-27",
    name: 'Briggs & Riley Baseline 27" Expandable',
    brand: "Briggs & Riley",
    model: "Baseline",
    color: "Olive",
    upc: "764862112094",
    price: 679,
    retailer: "Amazon",
    change: -20,
    others: [
      ["Walmart", 699, true],
      ["Target", 729, false],
    ],
    addedDaysAgo: 75,
  },
  {
    id: "delsey-chatelet-air-28",
    name: 'Delsey Paris Chatelet Air 2.0 28"',
    brand: "Delsey",
    model: "Chatelet Air 2.0",
    color: "Angora",
    upc: "098376154829",
    price: 249.99,
    retailer: "Target",
    change: 0,
    others: [
      ["Amazon", 259.99, true],
      ["Walmart", 269.99, true],
    ],
    addedDaysAgo: 19,
  },
  {
    id: "travelpro-platinum-elite-29",
    name: 'Travelpro Platinum Elite 29"',
    brand: "Travelpro",
    model: "Platinum Elite",
    color: "Bordeaux",
    upc: "051243104112",
    price: 329.99,
    retailer: "Amazon",
    change: 10,
    others: [
      ["Travelpro.com", 349.99, true],
      ["Walmart", 359.99, true],
    ],
    addedDaysAgo: 33,
  },
  {
    id: "samsonite-omni-2-24",
    name: 'Samsonite Omni 2 Hardside 24"',
    brand: "Samsonite",
    model: "Omni 2",
    color: "Radiant Silver",
    upc: "042810192884",
    price: 139.99,
    retailer: "Walmart",
    change: -20,
    others: [
      ["Amazon", 149.99, true],
      ["Samsonite.com", 159.99, true],
      ["Target", 164.99, false],
    ],
    addedDaysAgo: 12,
  },
  {
    id: "victorinox-spectra-3-large",
    name: "Victorinox Spectra 3.0 Large Case",
    brand: "Victorinox",
    model: "Spectra 3.0",
    color: "Deep Lake",
    upc: "601210398214",
    price: 449.99,
    retailer: "Amazon",
    change: 0,
    others: [
      ["Walmart", 469.99, true],
      ["Target", 479.99, true],
    ],
    addedDaysAgo: 7,
  },
];

// Deterministic pseudo-random so SSR and client agree.
function rng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hash(str: string) {
  let h = 7;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 2147483647;
  return h;
}

const DAYS = 30;

function isoDaysAgo(n: number) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function buildHistory(key: string, endPrice: number, todayChange: number): PricePoint[] {
  const rand = rng(hash(key));
  const points: PricePoint[] = [];
  // walk backwards from yesterday's price
  const yesterday = Math.round((endPrice - todayChange) * 100) / 100;
  let p = yesterday;
  const back: number[] = [yesterday];
  for (let i = 1; i < DAYS; i++) {
    const r = rand();
    let delta = (rand() - 0.5) * endPrice * 0.04;
    if (r > 0.9) delta += endPrice * 0.06;
    else if (r < 0.08) delta -= endPrice * 0.05;
    p = Math.max(endPrice * 0.75, Math.min(endPrice * 1.25, p + delta));
    back.push(Math.round(p * 100) / 100);
  }
  back.reverse(); // oldest -> yesterday
  for (let i = 0; i < back.length; i++) {
    points.push({ date: isoDaysAgo(DAYS - i), price: back[i] });
  }
  points.push({ date: isoDaysAgo(0), price: endPrice });
  return points;
}

export const PRODUCTS: Product[] = SEEDS.map((s) => {
  const offers: RetailerOffer[] = [
    {
      retailer: s.retailer,
      price: s.price,
      inStock: true,
      url: `https://www.google.com/search?q=${encodeURIComponent(s.name + " " + s.retailer)}`,
      lastCheckedMinutesAgo: 122,
    },
    ...s.others.map(([r, price, inStock], i) => ({
      retailer: r,
      price,
      inStock,
      url: `https://www.google.com/search?q=${encodeURIComponent(s.name + " " + r)}`,
      lastCheckedMinutesAgo: 122 + i * 3,
    })),
  ];

  const history: Record<string, PricePoint[]> = {};
  for (const o of offers) {
    const change = o.retailer === s.retailer ? s.change : 0;
    history[o.retailer] = buildHistory(s.id + o.retailer, o.price, change);
  }

  return {
    id: s.id,
    name: s.name,
    brand: s.brand,
    model: s.model,
    color: s.color,
    upc: s.upc,
    offers,
    previousLowest: Math.round((s.price - s.change) * 100) / 100,
    history,
    addedDaysAgo: s.addedDaysAgo,
  };
});

/** Extra catalog entries that are searchable but not tracked by default. */
export const CATALOG: Product[] = [
  ...PRODUCTS,
  ...(
    [
      {
        id: "rimowa-essential-check-in",
        name: "RIMOWA Essential Check-In L",
        brand: "RIMOWA",
        model: "Essential",
        color: "Matte Black",
        upc: "409821004112",
        price: 1075,
        retailer: "Amazon" as Retailer,
        change: 0,
        others: [["Walmart", 1129, true]] as [Retailer, number, boolean][],
        addedDaysAgo: 0,
      },
      {
        id: "monos-check-in-large",
        name: "Monos Check-In Large",
        brand: "Monos",
        model: "Check-In",
        color: "Sand",
        upc: "628110483012",
        price: 355,
        retailer: "Amazon" as Retailer,
        change: 0,
        others: [["Target", 379, true]] as [Retailer, number, boolean][],
        addedDaysAgo: 0,
      },
      {
        id: "samsonite-winfield-3-28",
        name: 'Samsonite Winfield 3 DLX 28"',
        brand: "Samsonite",
        model: "Winfield 3 DLX",
        color: "Silver",
        upc: "042810145533",
        price: 199.99,
        retailer: "Walmart" as Retailer,
        change: 0,
        others: [["Samsonite.com", 219.99, true]] as [Retailer, number, boolean][],
        addedDaysAgo: 0,
      },
      {
        id: "calpak-hue-large",
        name: "CALPAK Hue Large Luggage",
        brand: "CALPAK",
        model: "Hue",
        color: "Lavender",
        upc: "810019121043",
        price: 265,
        retailer: "Target" as Retailer,
        change: 0,
        others: [["Amazon", 275, false]] as [Retailer, number, boolean][],
        addedDaysAgo: 0,
      },
    ] as Seed[]
  ).map((s) => {
    const offers: RetailerOffer[] = [
      {
        retailer: s.retailer,
        price: s.price,
        inStock: true,
        url: `https://www.google.com/search?q=${encodeURIComponent(s.name)}`,
        lastCheckedMinutesAgo: 122,
      },
      ...s.others.map(([r, price, inStock]) => ({
        retailer: r,
        price,
        inStock,
        url: `https://www.google.com/search?q=${encodeURIComponent(s.name + " " + r)}`,
        lastCheckedMinutesAgo: 130,
      })),
    ];
    const history: Record<string, PricePoint[]> = {};
    for (const o of offers) history[o.retailer] = buildHistory(s.id + o.retailer, o.price, 0);
    return {
      id: s.id,
      name: s.name,
      brand: s.brand,
      model: s.model,
      color: s.color,
      upc: s.upc,
      offers,
      previousLowest: s.price,
      history,
      addedDaysAgo: 0,
    };
  }),
];

export const DEFAULT_TRACKED_IDS = PRODUCTS.map((p) => p.id);

export function lowestOffer(p: Product): RetailerOffer {
  return [...p.offers].sort((a, b) => a.price - b.price)[0];
}

export function priceChange(p: Product) {
  return Math.round((lowestOffer(p).price - p.previousLowest) * 100) / 100;
}

export function allPoints(p: Product) {
  return Object.values(p.history).flat();
}

export function stats(p: Product) {
  const pts = allPoints(p);
  const sorted = [...pts].sort((a, b) => a.price - b.price);
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  const avg = pts.reduce((s, x) => s + x.price, 0) / pts.length;
  return {
    current: lowestOffer(p).price,
    lowest: low,
    highest: high,
    average: Math.round(avg * 100) / 100,
    checks: pts.length,
  };
}

/** Lowest price across retailers on a given ISO date. */
export function lowestOnDate(p: Product, date: string): number | null {
  let min: number | null = null;
  for (const pts of Object.values(p.history)) {
    const hit = pts.find((x) => x.date === date);
    if (hit && (min === null || hit.price < min)) min = hit.price;
  }
  return min;
}

export function seriesDates(days: number): string[] {
  const out: string[] = [];
  for (let i = days; i >= 0; i--) out.push(isoDaysAgo(i));
  return out;
}
