/* ------------------------------------------------------------------ */
/*  Evidence check: an AI value is kept only if the source text says it */
/*                                                                     */
/*  Small models invent numbers (24.7% of llama3.2:3b's attribute       */
/*  numbers on our labelled set were nowhere in the text; review 02 §3).*/
/*  So every number must appear in the text in the same unit, or in a   */
/*  declared conversion of it (inch → cm, mm → cm, lb → kg, ml / cu in → */
/*  L), within a tolerance; every quote must appear verbatim. Units are  */
/*  read from the text, so "21 x 14 x 9 in" can't evidence 21 cm.        */
/* ------------------------------------------------------------------ */

export type EvidenceUnit = "cm" | "kg" | "l" | "plain";

export type Evidence =
  { ok: true; how: "verbatim" | "converted"; from: string } | { ok: false; reason: string };

type TextUnit = "cm" | "mm" | "in" | "kg" | "lb" | "l" | "ml" | "cuin" | "none";
type Tagged = { value: number; unit: TextUnit; raw: string };

const UNIT_RE: [RegExp, TextUnit][] = [
  [/^(?:cu\.?\s*in\.?|in³|cubic inch(?:es)?)/i, "cuin"],
  [/^(?:cm|centimet(?:er|re)s?)\b/i, "cm"],
  [/^(?:mm|millimet(?:er|re)s?)\b/i, "mm"],
  [/^(?:"|''|”|″|in\b\.?|inch(?:es)?\b)/i, "in"],
  [/^(?:kgs?|kilo(?:gram)?s?)\b/i, "kg"],
  [/^(?:lbs?\b\.?|pounds?\b)/i, "lb"],
  [/^(?:ml|millilit(?:er|re)s?)\b/i, "ml"],
  [/^(?:l\b|lit(?:er|re)s?\b|-lit(?:er|re)\b)/i, "l"],
];

function unitAt(rest: string): { unit: TextUnit; len: number } {
  const s = rest.replace(/^\s+/, "");
  const skipped = rest.length - s.length;
  for (const [re, unit] of UNIT_RE) {
    const m = s.match(re);
    if (m) return { unit, len: skipped + m[0].length };
  }
  return { unit: "none", len: 0 };
}

/** "1,903" → 1903 (thousands), "16,5" → 16.5 (decimal comma). */
function normaliseNumbers(text: string): string {
  return text.replace(/(\d),(\d{3})(?!\d)/g, "$1$2").replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2");
}

/**
 * Every number in the text with the unit the text gives it. In a dimension
 * expression ("55 x 36 x 23 cm", "21.5 x 14.2 x 9 in", "37-42cm") every value
 * takes the unit written after the last one unless it carries its own.
 */
export function taggedNumbers(text: string): Tagged[] {
  const t = normaliseNumbers(text);
  const out: Tagged[] = [];
  const numRe = /\d+(?:\.\d+)?/g;
  const items: { value: number; start: number; end: number; unit: TextUnit; unitLen: number }[] =
    [];
  for (const m of t.matchAll(numRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const u = unitAt(t.slice(end, end + 24));
    items.push({ value: Number(m[0]), start, end, unit: u.unit, unitLen: u.len });
  }
  // Group values joined by x / × / by / a range dash, and share the closing unit.
  let i = 0;
  while (i < items.length) {
    const group = [items[i]];
    let j = i;
    while (j + 1 < items.length) {
      const cur = items[j];
      const between = t.slice(cur.end + cur.unitLen, items[j + 1].start);
      if (/^\s*(?:x|×|by|-|–)\s*$/i.test(between)) {
        group.push(items[j + 1]);
        j++;
      } else break;
    }
    const closing = [...group].reverse().find((g) => g.unit !== "none")?.unit ?? "none";
    for (const g of group) {
      out.push({
        value: g.value,
        unit: g.unit === "none" ? closing : g.unit,
        raw: t.slice(g.start, g.end + g.unitLen).trim(),
      });
    }
    i = j + 1;
  }
  return out;
}

const VERBATIM_TOL = 0.0051;

/** Does the text state this value (in this unit, or in a declared conversion)? */
export function numberEvidence(value: number, unit: EvidenceUnit, text: string): Evidence {
  if (!Number.isFinite(value)) return { ok: false, reason: "not a number" };
  const tags = taggedNumbers(text);
  const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
  // The same unit written in the text first, then a declared conversion.
  const same: Record<EvidenceUnit, TextUnit | null> = { plain: null, cm: "cm", kg: "kg", l: "l" };
  const verbatim = tags.find(
    (t) => (same[unit] === null || t.unit === same[unit]) && near(t.value, value, VERBATIM_TOL),
  );
  if (verbatim) return { ok: true, how: "verbatim", from: verbatim.raw };
  const converted = tags.find((t) => {
    switch (unit) {
      case "cm":
        return (
          (t.unit === "mm" && near(t.value / 10, value, 0.05)) ||
          (t.unit === "in" && near(t.value * 2.54, value, 0.6))
        );
      case "kg":
        return t.unit === "lb" && near(t.value / 2.2046, value, Math.max(0.06, value * 0.02));
      case "l":
        return (
          (t.unit === "ml" && near(t.value / 1000, value, 0.05)) ||
          (t.unit === "cuin" && near(t.value * 0.016387, value, Math.max(0.6, value * 0.02)))
        );
      default:
        return false;
    }
  });
  if (converted) return { ok: true, how: "converted", from: converted.raw };
  return {
    ok: false,
    reason: `${value}${unit === "plain" ? "" : ` ${unit}`} is not stated in the text`,
  };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** A quote is evidence only if it appears character for character (spacing aside). */
export function quoteEvidence(quote: string, text: string): Evidence {
  const q = squash(quote);
  if (q.length < 3) return { ok: false, reason: "quote too short" };
  return squash(text).includes(q)
    ? { ok: true, how: "verbatim", from: q }
    : { ok: false, reason: "quote not found verbatim" };
}

/** A word-level claim (e.g. "spinner" for 4 wheels) needs one of these patterns in the text. */
export function wordEvidence(patterns: RegExp[], text: string): Evidence {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return { ok: true, how: "verbatim", from: m[0] };
  }
  return { ok: false, reason: "no supporting words in the text" };
}

export type Dropped = { field: string; value: unknown; reason: string };
