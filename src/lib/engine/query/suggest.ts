/* ------------------------------------------------------------------ */
/*  Autocomplete (v5 F2.5; V3 S3.3)                                    */
/*                                                                     */
/*  Brands, a brand's lines and popular searches that start with what  */
/*  the person has typed, from our own vocabulary (in memory) and our  */
/*  own search history: keystrokes never leave the app. A brand typed  */
/*  with a typo still finds the brand (one edit on the typed part).    */
/*  Pure: the route passes the popular searches in.                    */
/* ------------------------------------------------------------------ */

import { editDistance } from "./typo";
import { currentVocabulary, vocabularyIndex } from "./vocabulary";

export type Suggestion = { text: string; kind: "brand" | "line" | "search" };

export type PopularQuery = { query: string; count: number };

const titleWord = (w: string) =>
  /^\d/.test(w) || w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1);
const titleCase = (s: string) => s.split(" ").map(titleWord).join(" ");

function clean(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trimStart();
}

/** Up to `limit` suggestions for what has been typed so far (2+ letters). */
export function suggestFor(typed: string, popular: PopularQuery[] = [], limit = 8): Suggestion[] {
  const p = clean(typed).slice(0, 80);
  if (p.trim().length < 2) return [];
  const vocab = currentVocabulary();
  const idx = vocabularyIndex();
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (text: string, kind: Suggestion["kind"]) => {
    const key = text.toLowerCase();
    if (seen.has(key) || key === p.trim() || out.length >= limit) return;
    seen.add(key);
    out.push({ text, kind });
  };

  // A brand already typed in full: offer its lines that start with the rest.
  const brand = idx.brandAliases.find((b) => p.startsWith(`${b.alias} `));
  if (brand) {
    const rest = p.slice(brand.alias.length + 1);
    for (const l of idx.linesByBrand.get(brand.brand) ?? [])
      if (l.phrase.startsWith(rest)) add(`${brand.brand} ${titleCase(l.phrase)}`, "line");
  } else {
    const q = p.trim();
    for (const b of vocab.brands)
      if (b.aliases.some((a) => a.startsWith(q) || a.split(" ").some((w) => w.startsWith(q))))
        add(b.name, "brand");
    // A typo in the brand ("samsni"): one edit on the part typed so far.
    if (out.length === 0 && q.length >= 4)
      for (const b of vocab.brands)
        if (b.aliases.some((a) => editDistance(a.slice(0, q.length), q, 1) <= 1))
          add(b.name, "brand");
    // Lines of any brand that start with it ("paralux" → Samsonite Paralux), most listed first.
    vocab.lines
      .filter((l) => l.phrase.startsWith(q) && l.listings >= 2)
      .sort((a, b) => b.listings - a.listings)
      .forEach((l) => add(`${l.brand} ${titleCase(l.phrase)}`, "line"));
  }
  for (const s of popular) add(s.query, "search");
  return out;
}
