/* ------------------------------------------------------------------ */
/*  Search vocabulary: brands and product lines from OUR catalogue     */
/*                                                                     */
/*  v5 F2.2. The parser knows the brands the luggage pack lists; the   */
/*  vocabulary adds every brand and line our own index sells (Dakine,  */
/*  Peak Design, "19 Degree", "Black Label"…), so a query can name     */
/*  them, typos can be corrected towards them, and autocomplete can    */
/*  offer them. Built from catalogue rows after discovery (the store's */
/*  `vocabularyRows`), cached in memory, and swapped in with           */
/*  `setVocabulary`. Pure and browser-safe: no data is bundled here;   */
/*  the server and the eval load a snapshot (vocabulary-base.ts).      */
/* ------------------------------------------------------------------ */

export type VocabularyBrand = {
  /** As the stores write it ("Peak Design"). */
  name: string;
  /** Lower-cased spellings, longest first ("peak design"). */
  aliases: string[];
  /** Active listings carrying it: a weight for typo fixes and suggestions. */
  listings: number;
};

export type VocabularyLine = {
  brand: string;
  /** The line's words as titles carry them ("19 degree", "black label"). */
  phrase: string;
  listings: number;
};

export type Vocabulary = {
  brands: VocabularyBrand[];
  lines: VocabularyLine[];
  /** When it was built (ISO), null for the empty default. */
  builtAt: string | null;
};

/** One catalogue row: a product family at our stores. */
export type VocabularyRow = { brand: string | null; line: string | null; listings: number };

export const EMPTY_VOCABULARY: Vocabulary = { brands: [], lines: [], builtAt: null };

/**
 * Brand names that are also everyday words or our own store: they never
 * become a brand on their own ("canada", "explorer", "premier"), so a query
 * with the word isn't read as that brand. Pack brands keep their own rules.
 */
const GENERIC_BRANDS = new Set([
  "canada",
  "canada luggage depot",
  "explorer",
  "champs",
  "titan",
  "premier",
  "bench",
  "db",
  "ciao",
  "go travel",
  "nhl",
  "hockey canada",
  "skyway",
  "jetstream",
  "airstream",
  "bag boy",
  "austin house",
  "bond street",
  "pacific pillows",
]);

const MIN_BRAND_LISTINGS = 3;
const MAX_LINE_WORDS = 4;

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a vocabulary from catalogue rows (deterministic: sorted, deduplicated). */
export function vocabularyFromRows(rows: VocabularyRow[], builtAt: string): Vocabulary {
  const brands = new Map<string, VocabularyBrand>();
  const lines = new Map<string, VocabularyLine>();
  for (const r of rows) {
    const brand = r.brand?.trim();
    if (!brand) continue;
    const key = normalise(brand);
    if (GENERIC_BRANDS.has(key) || key.length < 3) continue;
    const b = brands.get(key) ?? { name: brand, aliases: [key], listings: 0 };
    b.listings += r.listings;
    brands.set(key, b);
    const phrase = r.line ? normalise(r.line) : "";
    const words = phrase.split(" ").filter(Boolean);
    if (!phrase || words.length > MAX_LINE_WORDS) continue;
    const lk = `${key}|${phrase}`;
    const l = lines.get(lk) ?? { brand: b.name, phrase, listings: 0 };
    l.listings += r.listings;
    lines.set(lk, l);
  }
  const keptBrands = [...brands.values()]
    .filter((b) => b.listings >= MIN_BRAND_LISTINGS)
    .sort((a, b) => b.listings - a.listings || a.name.localeCompare(b.name));
  const kept = new Set(keptBrands.map((b) => b.name));
  return {
    brands: keptBrands,
    lines: [...lines.values()]
      .filter((l) => kept.has(l.brand))
      .sort(
        (a, b) =>
          a.brand.localeCompare(b.brand) ||
          b.listings - a.listings ||
          a.phrase.localeCompare(b.phrase),
      ),
    builtAt,
  };
}

/* ── the vocabulary in use ─────────────────────────────────────────── */

let current: Vocabulary = EMPTY_VOCABULARY;
let index: VocabularyIndex | null = null;
let stale = false;

/** Discovery changed the catalogue: the next refresh check rebuilds the vocabulary. */
export function markVocabularyStale(): void {
  stale = true;
}

/** True once after markVocabularyStale (the loader's cue to rebuild). */
export function takeVocabularyStale(): boolean {
  const was = stale;
  stale = false;
  return was;
}

/** Swap in a newer vocabulary (server start, after discovery, tests). */
export function setVocabulary(v: Vocabulary): void {
  current = v;
  index = null;
}

export function currentVocabulary(): Vocabulary {
  return current;
}

export type VocabularyIndex = {
  /** Every vocabulary brand alias → brand name, longest alias first. */
  brandAliases: { alias: string; brand: string; re: RegExp }[];
  /** Line phrases by brand name, most listings first. */
  linesByBrand: Map<string, VocabularyLine[]>;
  /** Every word a line or brand contains, with its weight (for typo fixes). */
  words: Map<string, number>;
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lookup tables for the current vocabulary, built once per swap. */
export function vocabularyIndex(): VocabularyIndex {
  if (index) return index;
  const brandAliases = current.brands
    .flatMap((b) => b.aliases.map((alias) => ({ alias, brand: b.name })))
    .sort((a, b) => b.alias.length - a.alias.length)
    .map(({ alias, brand }) => ({
      alias,
      brand,
      re: new RegExp(`(^|[^a-z0-9])${escape(alias)}($|[^a-z0-9])`, "i"),
    }));
  const linesByBrand = new Map<string, VocabularyLine[]>();
  const words = new Map<string, number>();
  const addWords = (text: string, weight: number) => {
    for (const w of text.split(/[^a-z0-9'.]+/).filter((x) => x.length >= 3))
      words.set(w, (words.get(w) ?? 0) + weight);
  };
  for (const b of current.brands) addWords(b.aliases.join(" "), b.listings);
  for (const l of current.lines) {
    const list = linesByBrand.get(l.brand) ?? [];
    list.push(l);
    linesByBrand.set(l.brand, list);
    addWords(l.phrase, l.listings);
  }
  index = { brandAliases, linesByBrand, words };
  return index;
}
