/* ------------------------------------------------------------------ */
/*  Eval scoring helpers (shared by every task in scripts/eval/run.ts)  */
/*                                                                     */
/*  The labelled sets in scripts/bench/sets/ say how each field was     */
/*  labelled (`labelRules`); these normalisers apply the same rules to  */
/*  whatever a pipeline returns, so rules and models are scored alike.  */
/* ------------------------------------------------------------------ */

/** Type, size, feature and material words: never product-family words. */
const NEUTRAL = new Set(
  "luggage suitcase suitcases spinner spinners bag bags expandable expansion hardside softside hard soft hardshell side the collection series and with of by for 4 8 wheeled wheel wheels edition new leather aluminum aluminium nylon polycarbonate polypropylene ballistic backpack backpacks laptop duffel duffels duffle duffles trunk weekender pack tote underseater underseat garment check in on inch inches".split(
    " ",
  ),
);

export function normLine(v: unknown): string[] | null {
  if (v === null || v === undefined) return null;
  const words = (Array.isArray(v) ? v.join(" ") : String(v))
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""));
  return [...new Set(words.filter((w) => w && !NEUTRAL.has(w) && !/^\d+l$/.test(w)))].sort();
}

export const normBrand = (v: unknown): string | null =>
  typeof v === "string" && v.trim()
    ? v
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .replace(/^delseyparis$/, "delsey")
    : null;

const COLOURS = [
  "black",
  "grey",
  "blue",
  "navy",
  "red",
  "green",
  "white",
  "silver",
  "brown",
  "pink",
  "purple",
  "orange",
  "yellow",
  "beige",
  "teal",
  "gold",
];

export function baseColour(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = v.toLowerCase().replace(/gray/g, "grey");
  return COLOURS.find((c) => t.includes(c)) ?? t.trim();
}

export const sameSet = (a: string[] | null, b: string[] | null): boolean =>
  a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);

export const numEq = (a: unknown, b: unknown, tol = 0.001): boolean =>
  a === null || a === undefined
    ? b === null || b === undefined
    : typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= tol;

export type FieldScores = Record<string, boolean | null>;

/** Per-field accuracy (null = not scored for that item) and the share of items with every field right. */
export function summarise(rows: FieldScores[]): {
  metrics: Record<string, number>;
  counts: Record<string, string>;
  allRight: number;
} {
  const fields = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const metrics: Record<string, number> = {};
  const counts: Record<string, string> = {};
  for (const f of fields) {
    const vals = rows.map((r) => r[f]).filter((v): v is boolean => v === true || v === false);
    const right = vals.filter(Boolean).length;
    metrics[f] = vals.length ? Math.round((right / vals.length) * 1000) / 10 : 0;
    counts[f] = `${right}/${vals.length}`;
  }
  const all = rows.filter((r) => Object.values(r).every((v) => v !== false)).length;
  return {
    metrics,
    counts,
    allRight: rows.length ? Math.round((all / rows.length) * 1000) / 10 : 0,
  };
}
