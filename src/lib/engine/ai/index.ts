/* ------------------------------------------------------------------ */
/*  Local AI layer: entry point                                        */
/*  See run.ts for the rules (flags off by default, rules fallback,     */
/*  evidence on every value) and planning/v4/review/04 D1/D6/D7 for why. */
/* ------------------------------------------------------------------ */

import { engineConfig, type EngineConfig } from "../config";
import { OllamaClient } from "./ollama";

export * from "./cache";
export * from "./evidence";
export * from "./guard";
export * from "./ollama";
export * from "./run";
export * from "./tasks";

/** null when OLLAMA_URL isn't set: every task then answers with its rules. */
export function createAiClient(cfg: EngineConfig = engineConfig()): OllamaClient | null {
  if (!cfg.ai.url) return null;
  return new OllamaClient({
    url: cfg.ai.url,
    model: cfg.ai.model,
    timeoutMs: cfg.ai.timeoutMs,
    allowedHosts: cfg.ai.allowedHosts,
    keepAlive: cfg.ai.keepAlive,
  });
}

/** pg-boss options for an AI lane job: one job per task and input, short-lived on the always-on lane. */
export function aiJobOptions(
  lane: "ai.small" | "ai.large",
  key: string,
): { singletonKey: string; retryLimit: number; expireInSeconds: number } {
  return { singletonKey: key, retryLimit: 1, expireInSeconds: lane === "ai.small" ? 900 : 86_400 };
}
