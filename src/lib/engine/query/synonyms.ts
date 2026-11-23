/* ------------------------------------------------------------------ */
/*  Query words: synonyms, French, types, stores, noise (v5 F2.2)      */
/*                                                                     */
/*  Hand-kept, small and tested. The catalogue's own words come from   */
/*  the vocabulary (vocabulary.ts); this file only says how people     */
/*  write the same thing differently.                                  */
/* ------------------------------------------------------------------ */

import type { BagType } from "../types";

/**
 * Rewrites applied to the lower-cased query before anything is read, so
 * every later rule sees one spelling: "hand luggage", "bagage à main" and
 * "cabin bag" all become "carry-on"; "hard shell" becomes "hardside".
 */
export const PHRASES: [RegExp, string][] = [
  [/\bbagages?\s+(?:à|a)\s+main\b/g, " carry-on "],
  [/\b(?:bagages?|valises?)\s+cabine\b/g, " carry-on "],
  [/\bcabine\b/g, " carry-on "],
  [/\bhand\s+(?:luggage|baggage)\b/g, " carry-on "],
  [/\bcabin\s+(?:bag|bags|luggage|suitcase|size|sized)\b/g, " carry-on "],
  [/\bsac\s+(?:à|a)\s+dos\b/g, " backpack "],
  [/\bgrandes?\s+valises?\b/g, " large suitcase "],
  [/\bvalises?\s+moyennes?\b/g, " medium suitcase "],
  [/\bvalises?\b/g, " suitcase "],
  [/\bhard[\s-]?(?:shell|sided?)\b|\bhardshell\b/g, " hardside "],
  [/\bsoft[\s-]?(?:shell|sided?)\b|\bsoftshell\b/g, " softside "],
  [/\bduffles?\b/g, " duffel "],
  [/\b(?:4|four|8|eight)[\s-]?wheel(?:s|ed)?\b/g, " spinner "],
  [/\bcheck[\s-]in\b/g, " checked "],
];

/** Bag types, strongest first: "2 wheeled duffel" is a duffel, not an upright. */
export const TYPE_RULES: [BagType, RegExp][] = [
  ["set", /\b\d\s*-?\s*(?:pc|pcs|piece|pieces)\b|\bluggage sets?\b|\bset of \d\b|\bsets?\b/],
  ["duffel", /\bduffel\b/],
  ["backpack", /\bbackpacks?\b/],
  ["garment", /\bgarment\b/],
  ["spinner", /\bspinners?\b/],
  ["upright", /\buprights?\b|\brollaboard\b|\b(?:2|two)[\s-]?wheel(?:s|ed)?\b/],
];

export const SHELL_RULES: ["hard" | "soft" | "hybrid", RegExp][] = [
  ["hybrid", /\bhybrid\b/],
  ["hard", /\bhardside\b|\bhard\b|\brigide\b/],
  ["soft", /\bsoftside\b|\bsoft\b|\bsouple\b/],
];

/** Materials, by the word a person types (not "ALU'R", Delsey's line). */
export const MATERIAL_RULES: [string, RegExp][] = [
  ["aluminium", /\balumin(?:i)?um\b|\balu\b(?!')/],
  ["polycarbonate", /\bpolycarbonate\b/],
  ["polypropylene", /\bpolypropylene\b/],
  ["ballistic nylon", /\bballistic\b/],
  ["nylon", /\bnylon\b/],
  ["leather", /\bleather\b|\bcuir\b/],
  ["ABS", /\babs\b/],
];

/**
 * Stores a person can name with "at / from / on": registry ids, and the
 * brand a brand's own store sells (for "carry-on at Samsonite").
 */
export const STORE_NAMES: { re: RegExp; id: string; houseBrand: string | null }[] = [
  { re: /amazon(?:\.ca)?/, id: "amazon-ca", houseBrand: null },
  { re: /walmart(?:\.ca)?/, id: "walmart-ca", houseBrand: null },
  { re: /costco/, id: "costco-ca", houseBrand: null },
  { re: /best\s?buy/, id: "bestbuy-ca", houseBrand: null },
  { re: /canadian tire|sport\s?chek/, id: "canadiantire", houseBrand: null },
  { re: /london drugs/, id: "londondrugs", houseBrand: null },
  { re: /ebay/, id: "ebay-ca", houseBrand: null },
  { re: /luggage city/, id: "luggagecity", houseBrand: null },
  { re: /u\.?\s?n\.? luggage/, id: "unluggage", houseBrand: null },
  { re: /canada luggage depot|luggage depot|cld/, id: "canadaluggagedepot", houseBrand: null },
  { re: /bentley/, id: "bentley", houseBrand: null },
  { re: /sporting life/, id: "sportinglife", houseBrand: null },
  { re: /simons/, id: "simons", houseBrand: null },
  { re: /jp grimard|grimard/, id: "jpgrimard", houseBrand: null },
  { re: /luggage warehouse/, id: "luggagewarehouse-van", houseBrand: null },
  { re: /samsonite(?:\.ca)?/, id: "samsonite-ca", houseBrand: "Samsonite" },
  { re: /tumi(?:\.ca)?/, id: "tumi-ca", houseBrand: "TUMI" },
  { re: /delsey(?:\.ca)?/, id: "delsey-ca", houseBrand: "Delsey" },
  { re: /travelpro(?:\.ca)?/, id: "travelpro-ca", houseBrand: "Travelpro" },
  { re: /briggs (?:&|and) riley/, id: "briggs-riley-ca", houseBrand: "Briggs & Riley" },
  { re: /heys/, id: "heys-ca", houseBrand: "Heys" },
  { re: /monos/, id: "monos-ca", houseBrand: "Monos" },
];

/**
 * Words that say who or what for, never which bag: they never become product
 * line words ("carry on for getting away this weekend" names no line).
 */
export const NOISE_WORDS = new Set([
  "this",
  "that",
  "these",
  "my",
  "me",
  "i",
  "we",
  "our",
  "you",
  "your",
  "need",
  "needs",
  "want",
  "looking",
  "look",
  "find",
  "show",
  "get",
  "getting",
  "going",
  "go",
  "away",
  "trip",
  "trips",
  "weekend",
  "holiday",
  "holidays",
  "vacation",
  "flight",
  "flights",
  "airline",
  "airlines",
  "traveller",
  "travellers",
  "traveler",
  "travelers",
  "to",
  "without",
  "at",
  "kids",
  "kid",
  "children",
  "child",
  "mens",
  "men's",
  "womens",
  "women's",
  "ladies",
  "family",
  "suits",
  "suit",
  "dresses",
  "laptop",
  "dollars",
  "dollar",
  "bucks",
  "cad",
  "cost",
  "costs",
  "price",
  "prices",
  "between",
  "from",
  "more",
  "most",
  "least",
  // ("max" and "min" stay line words: Samsonite Sky Max; price phrases are read earlier)
  "minimum",
  "maximum",
  "litre",
  "litres",
  "liter",
  "liters",
  "available",
  "stock",
  "now",
  "today",
  // French
  "pour",
  "de",
  "du",
  "la",
  "le",
  "les",
  "avec",
  "sac",
  "dos",
  "bagage",
  "bagages",
  "main",
  "grande",
  "petite",
  "moyenne",
  "roulettes",
  "rigide",
  "souple",
  // types and shells: read into their own fields, not the line
  "duffel",
  "backpack",
  "backpacks",
  "garment",
  "tote",
  "briefcase",
  "hardside",
  "softside",
  "hybrid",
  "shell",
  "sided",
  "rollaboard",
  // materials: read into their own field
  "aluminum",
  "aluminium",
  "alu",
  "polycarbonate",
  "polypropylene",
  "nylon",
  "ballistic",
  "leather",
  "cuir",
  "abs",
]);

/** Brands' own colour-word lines: "Black Label" is a Samsonite line, not a colour. */
export const COLOUR_NAMED_LINES = ["black label", "red line", "blue label", "black edition"];
