/* ------------------------------------------------------------------ */
/*  Query broadening                                                  */
/*                                                                     */
/*  Google Shopping matches on the whole phrase. A retailer's full     */
/*  product name —                                                     */
/*                                                                     */
/*    "Samsonite Rhapsody 360 Spinner Expandable Medium Luggage Black" */
/*                                                                     */
/*  — is exactly the kind of string staff paste in, and exactly the    */
/*  kind Google returns nothing for: eight words, most of them         */
/*  descriptive rather than identifying. The bag is on Amazon.ca right */
/*  now, but not under that phrase.                                    */
/*                                                                     */
/*  So when a search comes back empty we don't give up — we drop the   */
/*  least identifying words and ask again, down to brand + model.      */
/*  Each rung is strictly shorter than the last, and rungs that would  */
/*  repeat a previous query are skipped so no allowance is wasted      */
/*  asking the same thing twice.                                       */
/* ------------------------------------------------------------------ */

/** Words that describe a bag but almost never help Google identify one. */
const FILLER = new Set([
  // Construction / features
  "expandable", "hardside", "softside", "hard", "soft", "shell", "hardshell",
  "lightweight", "durable", "spinner", "wheeled", "rolling", "upright",
  "double", "wheel", "wheels", "tsa", "lock", "locking", "recessed",
  // Size adjectives (the numeric size is kept — it identifies; these don't)
  "medium", "large", "small", "mini", "compact", "oversized",
  // Marketing
  "new", "sale", "best", "premium", "deluxe", "classic", "collection",
  "series", "edition", "official", "genuine", "original",
  // Category words — kept on the first rung, dropped later
  "luggage", "suitcase", "bag", "travel",
]);

/** Colour words. A colour is never why Google can't find a bag. */
const COLOURS = new Set([
  "black", "white", "grey", "gray", "silver", "navy", "blue", "red", "green",
  "teal", "purple", "pink", "burgundy", "maroon", "brown", "tan", "beige",
  "gold", "rose", "charcoal", "graphite", "champagne", "olive", "khaki",
  "orange", "yellow", "ivory", "cream", "bronze", "copper", "coral",
]);

function tokenize(query: string): string[] {
  return query
    .replace(/[^\w\s".\-/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True for a token that identifies a specific product line or size. */
function isIdentifying(token: string): boolean {
  const t = token.toLowerCase().replace(/[".]/g, "");
  if (!t) return false;
  if (COLOURS.has(t)) return false;
  if (FILLER.has(t)) return false;
  return true;
}

/**
 * Progressively broader versions of a query, most specific first.
 *
 * The first entry is always the original. Later entries drop colour, then
 * descriptive filler, then everything past the brand and model line. Every
 * entry is distinct and non-empty.
 */
export function broadenLadder(query: string): string[] {
  const original = query.trim().replace(/\s+/g, " ");
  if (!original) return [];

  const tokens = tokenize(original);
  const ladder: string[] = [original];

  const push = (terms: string[]) => {
    const candidate = terms.join(" ").trim();
    if (!candidate) return;
    // Never repeat a query we've already paid for, and never widen to
    // something so short it means nothing ("Samsonite" alone is fine;
    // a single filler word is not).
    if (ladder.some((q) => q.toLowerCase() === candidate.toLowerCase())) return;
    ladder.push(candidate);
  };

  // Rung 2 — drop colours only, keeping the rest of the description.
  //
  // Only worth a call on an already-short query. On a long retailer title,
  // removing one word out of eight almost never turns a miss into a hit,
  // and every rung costs a search from a 250/month allowance — so long
  // queries skip straight to the identifying words below.
  const SHORT_QUERY_TOKENS = 5;
  if (tokens.length <= SHORT_QUERY_TOKENS) {
    push(tokens.filter((t) => !COLOURS.has(t.toLowerCase().replace(/[".]/g, ""))));
  }

  // Rung 3 — keep only identifying words: brand, model line, numeric size.
  const identifying = tokens.filter(isIdentifying);
  push(identifying);

  // Rung 4 — brand plus the first two identifying words after it. For
  // "Samsonite Rhapsody 360 Spinner Expandable Medium Luggage Black" this
  // is "Samsonite Rhapsody 360", which Google knows well.
  push(identifying.slice(0, 3));

  // Rung 5 — brand and the category, so the client at least sees the range
  // rather than an empty page.
  if (identifying.length > 1) push([identifying[0], "luggage"]);

  return ladder;
}

/** A short, honest note for the UI when a broader query is what worked. */
export function broadenedNotice(original: string, used: string): string {
  return `No listings matched "${original}" exactly, so we searched "${used}" instead.`;
}
