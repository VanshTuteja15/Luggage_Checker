/* ------------------------------------------------------------------ */
/*  Search intelligence (v5 F2): parser, vocabulary, typos, suggest    */
/* ------------------------------------------------------------------ */

export {
  bagTypeOf,
  BRAND_INCH_CLASS,
  parseQueryWith,
  shellOf,
  type QueryPrimitives,
} from "./parse";
export { allowedEdits, correctWord, editDistance } from "./typo";
export {
  currentVocabulary,
  EMPTY_VOCABULARY,
  setVocabulary,
  vocabularyFromRows,
  vocabularyIndex,
  type Vocabulary,
  type VocabularyBrand,
  type VocabularyLine,
  type VocabularyRow,
} from "./vocabulary";
