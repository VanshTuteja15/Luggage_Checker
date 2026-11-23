/* ------------------------------------------------------------------ */
/*  Keeping the search vocabulary current (server and worker only)     */
/*                                                                     */
/*  Starts from the generated snapshot (vocabulary-base.ts) and        */
/*  rebuilds it from the catalogue at most every 30 minutes, and on    */
/*  the next request after a discovery run (invalidateVocabulary).     */
/*  Never blocks a search: the rebuild runs in the background and the  */
/*  previous vocabulary keeps answering until it's done.               */
/* ------------------------------------------------------------------ */

import type { EngineStore } from "../store/port";
import { BASE_VOCABULARY } from "./vocabulary-base";
import {
  currentVocabulary,
  setVocabulary,
  takeVocabularyStale,
  vocabularyFromRows,
} from "./vocabulary";

const TTL_MS = 30 * 60_000;
let loadedAt = 0;
let loading: Promise<void> | null = null;

/** Make sure a vocabulary is in place, and refresh it from the catalogue when it's old. */
export function ensureVocabulary(store: EngineStore, now: number = Date.now()): Promise<void> {
  if (currentVocabulary().builtAt === null) setVocabulary(BASE_VOCABULARY);
  if (takeVocabularyStale()) loadedAt = 0;
  if (loading) return loading;
  if (now - loadedAt < TTL_MS) return Promise.resolve();
  loading = store
    .vocabularyRows()
    .then((rows) => {
      if (rows.length > 0) setVocabulary(vocabularyFromRows(rows, new Date(now).toISOString()));
    })
    .catch(() => undefined) // keep the vocabulary we have; try again after the TTL
    .finally(() => {
      loadedAt = now;
      loading = null;
    });
  return loading;
}
