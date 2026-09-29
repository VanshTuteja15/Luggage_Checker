/* ------------------------------------------------------------------ */
/*  Colour vocabulary                                                 */
/*                                                                     */
/*  Shared by page reading (which colours a store lists) and grouping */
/*  (which colour a listing is). Only words in this list are ever     */
/*  reported as a colour — nothing is guessed.                         */
/* ------------------------------------------------------------------ */

/** Colour words that appear in luggage titles and variant pickers. */
export const COLOUR_WORDS =
  /\b(black|white|grey|gray|silver|navy|blue|red|green|teal|purple|pink|burgundy|maroon|brown|tan|beige|gold|rose gold|rose|charcoal|graphite|champagne|olive|khaki|orange|yellow|ivory|cream|bronze|copper|coral|lilac|lavender|mint|turquoise|aqua|sage|taupe|mocha|cognac|indigo)\b/i;

/** Words stores put in front of a colour: "Ice Blue", "Jet Black". */
export const COLOUR_MODIFIERS = new Set([
  "ice", "stone", "jet", "midnight", "deep", "light", "dark", "sky", "forest", "ocean",
  "electric", "pearl", "matte", "bright", "pale", "royal", "baby", "dusty", "sand",
  "steel", "space", "slate", "true", "classic", "cool", "warm", "soft", "blush", "moss",
  "sea", "storm", "graphite", "arctic", "cobalt", "emerald", "ruby", "sapphire", "brushed",
]);

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The colour a listing title names, or "" when it names none. */
export function extractColour(title: string): string {
  const m = title.match(COLOUR_WORDS);
  if (!m || m.index === undefined) return "";
  const before = title.slice(0, m.index).match(/([A-Za-z]+)\s+$/);
  const mod = before && COLOUR_MODIFIERS.has(before[1].toLowerCase()) ? `${before[1]} ` : "";
  return titleCase(`${mod}${m[1]}`);
}

const COLOUR_WORDS_GLOBAL = new RegExp(COLOUR_WORDS.source, "gi");

/**
 * Colours a product page offers, read from right after its "Colour" label
 * (the variant picker). Empty when the page has no such label — a colour
 * mentioned in a description or a review is not a variant.
 */
export function findColourOptions(text: string): string[] {
  const label = text.search(/\b(?:colou?rs?|couleurs?)\b\s*(?::|\(|available|options?)/i);
  if (label < 0) return [];

  const windowText = text.slice(label, label + 400);
  const found = new Map<string, string>();
  for (const m of windowText.matchAll(COLOUR_WORDS_GLOBAL)) {
    const i = m.index ?? 0;
    const before = windowText.slice(0, i).match(/([A-Za-z]+)\s+$/);
    const mod = before && COLOUR_MODIFIERS.has(before[1].toLowerCase()) ? `${before[1]} ` : "";
    const name = titleCase(`${mod}${m[1]}`);
    found.set(name.toLowerCase(), name);
    if (found.size >= 12) break;
  }
  return [...found.values()];
}
