/* ------------------------------------------------------------------ */
/*  Typo tolerance (v5 F2.2, V3 S1.3)                                  */
/*                                                                     */
/*  Damerau-Levenshtein (optimal string alignment: insert, delete,     */
/*  substitute, swap two neighbours) with an early cut-off, and a      */
/*  one-word correction against a weighted dictionary. Only words of   */
/*  5+ letters are corrected: 1 edit for 5 letters, 2 for 6 or more.   */
/*  A tie between two different candidates corrects nothing.           */
/* ------------------------------------------------------------------ */

/** Edit distance, or `max + 1` as soon as it must exceed `max`. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const cols = b.length + 1;
  let prev2 = new Array<number>(cols).fill(0);
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(cols).fill(0);
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[cols - 1];
}

/** How many edits a word of this length may need to be corrected. */
export function allowedEdits(word: string): number {
  if (word.length < 5) return 0;
  return word.length >= 6 ? 2 : 1;
}

/**
 * The dictionary word this one most likely is, or null: the closest within
 * the allowed edits (same first letter: people rarely mistype that one),
 * the heavier on a tie, nothing when two different words are equally close
 * and equally heavy.
 */
export function correctWord(word: string, dictionary: Map<string, number>): string | null {
  const max = allowedEdits(word);
  if (max === 0 || dictionary.has(word) || /\d/.test(word)) return null;
  let best: { w: string; d: number; weight: number } | null = null;
  let tied = false;
  for (const [w, weight] of dictionary) {
    if (Math.abs(w.length - word.length) > max || w[0] !== word[0]) continue;
    const d = editDistance(word, w, max);
    if (d > max) continue;
    if (!best || d < best.d || (d === best.d && weight > best.weight)) {
      tied = false;
      best = { w, d, weight };
    } else if (d === best.d && weight === best.weight && w !== best.w) tied = true;
  }
  return best && !tied ? best.w : null;
}
