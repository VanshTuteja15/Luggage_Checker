/* ------------------------------------------------------------------ */
/*  Running an AI task: rules first, model optional, evidence always   */
/*                                                                     */
/*  A task is a schema, a guarded prompt, a rules answer and an        */
/*  evidence check. The model is asked only when `ai.enabled` and the   */
/*  task's own flag are on and a client is configured; any failure      */
/*  (refused URL, timeout, busy, invalid JSON) returns the rules answer */
/*  with the reason. Whatever the model says goes through the task's    */
/*  evidence check before it is returned or cached, so an unstated      */
/*  value never leaves this module.                                     */
/* ------------------------------------------------------------------ */

import type { z } from "zod/v4";
import { flagOn, type FlagSet } from "../flags";
import { aiCacheKey, type AiCache } from "./cache";
import type { Dropped } from "./evidence";
import { PROMPT_VERSION } from "./guard";
import type { AiFailure, OllamaClient } from "./ollama";

export type AiTask<I, O> = {
  name: string;
  /** Must be on besides `ai.enabled` (all default off: src/lib/engine/flags.ts). */
  flag: string;
  schemaVersion: string;
  schema: z.ZodType<O>;
  /** Full system prompt, already guarded (guard.ts). */
  system: string;
  /** User message; any store text in it must be fenced. */
  user: (input: I) => string;
  /** The answer without a model, and what every failure falls back to. */
  rules: (input: I) => O | null;
  /** Keep only what the input states; list what was dropped and why. */
  evidence: (input: I, out: O) => { value: O; dropped: Dropped[] };
  numPredict?: number;
};

export type AiFallback = AiFailure | "flag_off" | "no_client";

export type AiOutcome<O> = {
  value: O | null;
  source: "ai" | "cache" | "rules";
  fallback: AiFallback | null;
  dropped: Dropped[];
  model: string | null;
  ms: number;
};

export type AiDeps = {
  flags: FlagSet;
  client: OllamaClient | null;
  cache: AiCache;
  /** How long an evidence-checked answer stays reusable. */
  ttlMs?: number;
  now?: () => number;
};

const DEFAULT_TTL_MS = 30 * 24 * 3_600_000;

export function aiAllowed(flags: FlagSet, task: { flag: string }): boolean {
  return flagOn(flags, "ai.enabled") && flagOn(flags, task.flag);
}

export function taskCacheKey<I, O>(task: AiTask<I, O>, model: string, input: I): string {
  return aiCacheKey({
    task: task.name,
    model,
    promptVersion: PROMPT_VERSION,
    schemaVersion: task.schemaVersion,
    input,
  });
}

export async function runAiTask<I, O>(
  task: AiTask<I, O>,
  input: I,
  deps: AiDeps,
): Promise<AiOutcome<O>> {
  const now = deps.now ?? Date.now;
  const started = now();
  const rules = (fallback: AiFallback, dropped: Dropped[] = []): AiOutcome<O> => ({
    value: task.rules(input),
    source: "rules",
    fallback,
    dropped,
    model: null,
    ms: now() - started,
  });

  if (!aiAllowed(deps.flags, task)) return rules("flag_off");
  if (!deps.client) return rules("no_client");

  const key = taskCacheKey(task, deps.client.model, input);
  const hit = await deps.cache.get(key);
  if (hit) {
    const parsed = task.schema.safeParse(hit.value);
    if (parsed.success)
      return {
        value: parsed.data,
        source: "cache",
        fallback: null,
        dropped: [],
        model: hit.model,
        ms: now() - started,
      };
  }

  const res = await deps.client.chat({
    system: task.system,
    user: task.user(input),
    schema: task.schema,
    think: false,
    numPredict: task.numPredict,
  });
  if (!res.ok) return rules(res.reason);

  const checked = task.evidence(input, res.value);
  await deps.cache.set(
    key,
    { task: task.name, model: deps.client.model, value: checked.value },
    deps.ttlMs ?? DEFAULT_TTL_MS,
  );
  return {
    value: checked.value,
    source: "ai",
    fallback: null,
    dropped: checked.dropped,
    model: deps.client.model,
    ms: now() - started,
  };
}

/**
 * For paths that must never wait on a model (discovery, search): the cached,
 * evidence-checked AI answer if there is one, otherwise the rules answer, and
 * whether a lane job should compute the AI answer for next time.
 */
export async function cachedOrRules<I, O>(
  task: AiTask<I, O>,
  input: I,
  deps: { flags: FlagSet; cache: AiCache; model: string | null },
): Promise<{ value: O | null; source: "cache" | "rules"; enqueue: boolean; key: string | null }> {
  if (!aiAllowed(deps.flags, task) || !deps.model)
    return { value: task.rules(input), source: "rules", enqueue: false, key: null };
  const key = taskCacheKey(task, deps.model, input);
  const hit = await deps.cache.get(key);
  const parsed = hit ? task.schema.safeParse(hit.value) : null;
  if (parsed?.success) return { value: parsed.data, source: "cache", enqueue: false, key };
  return { value: task.rules(input), source: "rules", enqueue: true, key };
}
