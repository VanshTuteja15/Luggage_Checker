/* ------------------------------------------------------------------ */
/*  Luggage category pack                                             */
/*                                                                     */
/*  Everything the engine knows about luggage specifically: brands,    */
/*  size classes, product-line words, manufacturer model numbers and   */
/*  colour codes. The core engine is category-agnostic and only talks  */
/*  to this through the CategoryPack interface.                        */
/*                                                                     */
/*  Size classes are the hard boundary of identity: a Carry-On, a      */
/*  Medium and a Large of the same line are different products and are */
/*  never merged, whatever else matches.                               */
/* ------------------------------------------------------------------ */

import { COLOUR_MODIFIERS, COLOUR_WORDS, extractColour } from "@/lib/search/colours";
import type { CategoryPack, ParsedQuery } from "../types";

export const SIZE_CLASSES = [
  "underseat",
  "carry_on",
  "medium",
  "large",
  "extra_large",
  "set",
  "backpack",
  "duffel",
  "garment",
  "tote",
  "briefcase",
  "accessory",
] as const;

export type SizeClass = (typeof SIZE_CLASSES)[number];

export const SIZE_LABELS: Record<SizeClass, string> = {
  underseat: "Underseat",
  carry_on: "Carry-On",
  medium: "Medium",
  large: "Large",
  extra_large: "Extra Large",
  set: "Set",
  backpack: "Backpack",
  duffel: "Duffel",
  garment: "Garment Bag",
  tote: "Tote",
  briefcase: "Briefcase",
  accessory: "Accessory",
};

/* ── Brands ─────────────────────────────────────────────────────────── */

/** Canonical brand → the ways stores write it. Longest alias wins. */
const BRANDS: Record<string, string[]> = {
  Samsonite: ["samsonite"],
  "American Tourister": ["american tourister"],
  TUMI: ["tumi"],
  Travelpro: ["travelpro", "travel pro"],
  Delsey: ["delsey paris", "delsey"],
  "Briggs & Riley": ["briggs & riley", "briggs and riley", "briggs-riley", "briggs riley"],
  Heys: ["heys"],
  Monos: ["monos"],
  Away: ["away"],
  SwissGear: ["swissgear", "swiss gear"],
  Victorinox: ["victorinox"],
  Wenger: ["wenger"],
  "Ricardo Beverly Hills": ["ricardo beverly hills", "ricardo"],
  RIMOWA: ["rimowa"],
  CALPAK: ["calpak"],
  Herschel: ["herschel supply", "herschel"],
  "Air Canada": ["air canada"],
  Roots: ["roots"],
  Nautica: ["nautica"],
  "Kenneth Cole": ["kenneth cole reaction", "kenneth cole"],
  "Traveler's Choice": ["traveler's choice", "travelers choice"],
  "IT Luggage": ["it luggage"],
  Lojel: ["lojel"],
  Béis: ["béis", "beis"],
  Antler: ["antler"],
  Osprey: ["osprey"],
  "Eagle Creek": ["eagle creek"],
  Thule: ["thule"],
  Hartmann: ["hartmann"],
  Lipault: ["lipault"],
  Kipling: ["kipling"],
  "High Sierra": ["high sierra"],
  Hedgren: ["hedgren"],
  Pacsafe: ["pacsafe"],
  "Bric's": ["bric's", "brics"],
  Atlantic: ["atlantic"],
  Gregory: ["gregory"],
  "Tommy Hilfiger": ["tommy hilfiger"],
  "Steve Madden": ["steve madden"],
  "Kate Spade": ["kate spade"],
  "Ted Baker": ["ted baker"],
  "Vera Bradley": ["vera bradley"],
  Bugatti: ["bugatti"],
  "Mandarina Duck": ["mandarina duck"],
  "Porsche Design": ["porsche design"],
  Jump: ["jump"],
};

const BRAND_ALIASES: { alias: string; brand: string; re: RegExp }[] = Object.entries(BRANDS)
  .flatMap(([brand, aliases]) => aliases.map((alias) => ({ alias, brand })))
  .sort((a, b) => b.alias.length - a.alias.length)
  .map(({ alias, brand }) => ({
    alias,
    brand,
    re: new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i"),
  }));

/** Brands whose single-word names are also ordinary words: need extra context. */
const AMBIGUOUS_BRANDS = new Set(["away", "roots", "atlantic", "jump", "ricardo", "gregory"]);

function brandOf(text: string): string | null {
  const t = text.toLowerCase();
  for (const { alias, brand, re } of BRAND_ALIASES) {
    if (!re.test(t)) continue;
    // "carry-on for getting away" is not the Away brand. Ambiguous names
    // only count at the very start of a title / query.
    if (AMBIGUOUS_BRANDS.has(alias) && !new RegExp(`^\\s*(the\\s+)?${alias}\\b`, "i").test(t)) continue;
    return brand;
  }
  return null;
}

/** Remove the given brand's own spellings from a lower-cased title, as phrases. */
function stripBrand(lower: string, brand: string | null): string {
  if (!brand) return lower;
  const aliases = [...(BRANDS[brand] ?? []), brand.toLowerCase()].sort((a, b) => b.length - a.length);
  let out = lower;
  for (const a of aliases) {
    out = out.replace(new RegExp(`(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`, "gi"), "$1 ");
  }
  return out;
}

/* ── Size classes ───────────────────────────────────────────────────── */

const ACCESSORY_RE =
  /\b(?:cover|covers|luggage tag|tags?|strap|straps|organi[sz]er|packing cubes?|cubes? set|toiletry|toiletries|pouch|scale|adapter|pillow|wallet|passport holder|replacement|wheel kit|handle kit|garment sleeve|lock|locks|charger|power bank|neck pillow|laundry bag|shoe bag|insert|beauty case|cosmetic case|vanity case|toiletry kit|adapter plug|grounded adapter|converter|umbrella)\b/i;

function isAccessory(title: string): boolean {
  // "TSA lock" is a suitcase feature, not an accessory.
  return ACCESSORY_RE.test(title.replace(/\bTSA[- ]?(?:approved |accepted )?(?:combination )?locks?\b/gi, ""));
}

/** Inches → size class. Luggage sizes are quoted in whole inches 18–32. */
function classFromInches(n: number): SizeClass | null {
  if (n < 14 || n > 34) return null;
  if (n <= 17) return "underseat";
  if (n <= 22) return "carry_on";
  if (n <= 26) return "medium";
  if (n <= 29) return "large";
  return "extra_large";
}

/** Height in cm (Samsonite "Spinner 55/68/75") → size class. */
function classFromCm(n: number): SizeClass | null {
  if (n < 35 || n > 90) return null;
  if (n <= 45) return "underseat";
  if (n <= 57) return "carry_on";
  if (n <= 70) return "medium";
  if (n <= 78) return "large";
  return "extra_large";
}

function sizeClassOf(text: string): SizeClass | null {
  const t = ` ${text.toLowerCase().replace(/[’`]/g, "'")} `;

  if (isAccessory(text)) return "accessory";
  if (/\b(?:\d\s*-?\s*(?:pc|pcs|piece|pieces)\b|luggage set|set of \d|two-piece|three-piece)/.test(t)) return "set";
  if (/\bunder[-\s]?seat(?:er)?\b|\bpersonal item\b/.test(t)) return "underseat";
  // (é isn't a regex word character, so no \b after "attaché")
  if (/\battach[eé](?![a-z])|\bbriefcase\b|\blaptop (?:bag|case|sleeve|brief)\b|\bmessenger\b|\bportfolio\b/.test(t)) return "briefcase";
  if (/\bbackpack\b|\bsac à dos\b/.test(t)) return "backpack";
  if (/\bduffel\b|\bduffle\b/.test(t)) return "duffel";
  if (/\bgarment bag\b|\bgarment\b/.test(t)) return "garment";
  if (/\btote\b/.test(t)) return "tote";

  // The store's own size word wins over a measurement: Delsey sells a
  // "23-Inch Expandable Carry-On".
  if (/\bcarry[-\s]?on\b|\bcarryon\b|\bcabin\b|\bonboard\b|\bbagage à main\b|\bcabine\b/.test(t)) return "carry_on";
  if (/\bextra[-\s]?large\b|\bx-?large\b|\bxl\b|\btrunk\b/.test(t)) return "extra_large";
  if (/\blarge\b|\bgrand(?:e)?\b/.test(t)) return "large";
  if (/\bmedium\b|\bmoyen(?:ne)?\b/.test(t)) return "medium";

  const inch = t.match(/\b(\d{2})(?:\.\d)?\s*(?:"|''|”|-?\s?inch(?:es)?\b|-?\s?in\b)/);
  if (inch) {
    const c = classFromInches(Number(inch[1]));
    if (c) return c;
  }
  const spinner = t.match(/\bspinner\s+(\d{2})\b|\b(\d{2})\s*cm\b/);
  if (spinner) {
    const c = classFromCm(Number(spinner[1] ?? spinner[2]));
    if (c) return c;
  }
  // "Check-in" without a size word: we know it's checked luggage, not which size.
  return null;
}

/* ── Colours ────────────────────────────────────────────────────────── */

function colourOf(text: string): string | null {
  const c = extractColour(text);
  return c || null;
}

/* ── Model numbers ──────────────────────────────────────────────────── */

/** Samsonite Group brands share the model + 4-digit colour code scheme (1041 = Black). */
const SAMSONITE_GROUP = new Set(["Samsonite", "American Tourister", "TUMI", "Lipault", "Gregory", "Hartmann"]);

function modelOf(text: string, brand: string | null): { model: string; colourCode: string | null } | null {
  const t = text.trim();
  const group = brand ? SAMSONITE_GROUP.has(brand) : false;

  if (group || brand === null) {
    // 137394-1041, 137394 1041
    let m = t.match(/\b(\d{5,6})[-\s](\d{4})\b/);
    if (m) return { model: m[1], colourCode: m[2] };
    // TUMI 0139683 + 1041
    m = t.match(/\b(0\d{6})(\d{4})\b/);
    if (m && (brand === "TUMI" || brand === null)) return { model: m[1], colourCode: m[2] };
    if (group) {
      // SFCC concatenated SKU 1373941041, or master id 137394XXXX
      m = t.match(/\b(\d{6})(\d{4}|XXXX)\b/i);
      if (m) return { model: m[1], colourCode: /x/i.test(m[2]) ? null : m[2] };
      // U.N. Luggage writes 137394-Black: model + colour name
      m = t.match(/\b(\d{5,6})-([A-Za-z][A-Za-z ]*)$/);
      if (m) return { model: m[1], colourCode: null };
    }
  }
  if (brand === "Delsey") {
    // 40119980500US / 40119980502US: 9-digit model + 2-digit colour
    const m = t.match(/\b0{0,2}(\d{9})(\d{2})(?:US|CA)?\b/i);
    if (m) return { model: m[1], colourCode: m[2] };
  }
  return null;
}

/* ── Product-line words ─────────────────────────────────────────────── */

const FILLER = new Set([
  "luggage", "suitcase", "suitcases", "valise", "spinner", "spinners", "wheeled", "wheels", "wheel",
  "upright", "trolley", "bag", "bags", "travel", "hardside", "hard", "side", "softside", "soft",
  "hardshell", "expandable", "expansion", "lightweight", "with", "and", "the", "by", "for", "of", "in",
  "collection", "series", "new", "sale", "carry", "on", "carryon", "cabin", "checked", "check",
  "medium", "large", "small", "extra", "xl", "inch", "inches", "cm", "piece", "pieces", "pc",
  "set", "tsa", "lock", "locks", "usb", "port", "two", "four", "eight", "x", "underseat",
  "underseater", "international", "domestic", "global", "case", "edition",
]);

/**
 * Drop a short trailing variant segment: "…Suitcase, Black", "…Luggage - Blue",
 * "…Backpack, Hazelnut". Stores that list each colour as its own product put
 * the colour there, and it is not part of the product line.
 */
function stripVariantSuffix(text: string): string {
  const m = text.match(/^(.*\S)\s*(?:,|\s[-–]\s)\s*([^,–]{2,30})$/);
  if (!m) return text;
  const tail = m[2].trim().split(/\s+/);
  return tail.length <= 3 && m[1].trim().split(/\s+/).length >= 2 ? m[1] : text;
}

function lineOf(text: string, brand: string | null): string[] {
  const lower = stripBrand(stripVariantSuffix(text).toLowerCase().replace(/[’`]/g, "'"), brand)
    // drop measurements: 21", 22 x 14 x 9 in, 55 cm, 20-inch
    .replace(/\b\d{2}(?:\.\d)?\s*(?:"|''|”|-?\s?inch(?:es)?\b|-?\s?in\b|\s?cm\b)/g, " ")
    .replace(/\b\d{2}\s*x\s*\d{1,2}(?:\s*x\s*\d{1,2})?\b/g, " ")
    // drop model numbers and colour codes
    .replace(/\b\d{5,}[-\s]?\w*\b/g, " ")
    .replace(/[^a-z0-9.'& ]/g, " ");

  const words = lower.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i].replace(/^\.+|\.+$/g, "");
    if (!w || w === "&" || w === "'") continue;
    if (FILLER.has(w)) continue;
    if (COLOUR_MODIFIERS.has(w) && words[i + 1] && COLOUR_WORDS.test(words[i + 1])) continue;
    if (COLOUR_WORDS.test(w) && w.length > 2) continue;
    // Wheel counts and bare two-digit sizes are not product-line words.
    if (w === "4" || w === "8") continue;
    if (/^\d{2}$/.test(w) && Number(w) >= 14 && Number(w) <= 34) continue;
    out.push(w);
  }
  return [...new Set(out)];
}

/* ── Queries ────────────────────────────────────────────────────────── */

const QUERY_FILLER = new Set([
  "price", "prices", "cheap", "cheapest", "best", "buy", "a", "an", "or", "under", "over", "below",
  "above", "canada", "canadian", "deal", "deals", "online", "shop", "store", "lowest", "compare",
  "less", "than", "around", "about",
]);

function normaliseGtin(digits: string): string | null {
  const d = digits.replace(/\D/g, "");
  if (d.length < 8 || d.length > 14) return null;
  return d.padStart(14, "0");
}

function parseQuery(raw: string): ParsedQuery {
  const text = raw.trim().slice(0, 200);
  const priceMatch = text.match(/\b(?:under|below|less than|max|<)\s*\$?\s*(\d{2,5})\b/i);
  const maxPrice = priceMatch ? Number(priceMatch[1]) : null;
  const withoutPrice = priceMatch ? text.replace(priceMatch[0], " ") : text;

  const gtinMatch = withoutPrice.match(/\b(\d{12,14})\b/);
  const gtin = gtinMatch ? normaliseGtin(gtinMatch[1]) : null;

  const brand = brandOf(withoutPrice);
  const modelHit = gtin ? null : modelOf(withoutPrice, brand);
  const model = modelHit ? modelHit.model : null;
  const sizeClass = sizeClassOf(withoutPrice);
  const colour = colourOf(withoutPrice);
  const line = lineOf(withoutPrice, brand).filter((w) => !QUERY_FILLER.has(w) && !/^\d{12,14}$/.test(w));

  const tokens = [
    ...new Set(
      withoutPrice
        .toLowerCase()
        .replace(/[^a-z0-9.\s-]/g, " ")
        .split(/\s+/)
        .map((w) => w.replace(/^[-.]+|[-.]+$/g, ""))
        .filter((w) => w && !QUERY_FILLER.has(w) && !FILLER.has(w)),
    ),
  ];

  return { raw: text, tokens, brand, line, sizeClass, colour, gtin, model, maxPrice };
}

export const luggagePack: CategoryPack = {
  id: "luggage",
  // Single items; sets are allowed up to the top of the band.
  priceBand: { min: 15, max: 6000 },
  parseQuery,
  sizeClassOf,
  colourOf,
  brandOf,
  lineOf,
  modelOf,
  isAccessory,
};

export { normaliseGtin };
