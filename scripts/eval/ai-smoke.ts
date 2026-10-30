/* ------------------------------------------------------------------ */
/*  One live call through the production AI client (A1 acceptance):     */
/*  the terms task on a real recorded clause, model unloaded right      */
/*  after (keep_alive 0) so nothing stays in the laptop's memory.       */
/*  OLLAMA_URL=http://127.0.0.1:11434 node scripts/run-ts.mjs           */
/*    scripts/eval/ai-smoke.ts                                          */
/* ------------------------------------------------------------------ */

import { MemoryAiCache, OllamaClient, runAiTask, termsTask } from "@/lib/engine/ai";
import { engineConfig } from "@/lib/engine/config";
import { resolveFlags } from "@/lib/engine/flags";

async function main(): Promise<void> {
  const cfg = engineConfig();
  const url = cfg.ai.url ?? "http://127.0.0.1:11434";
  const client = new OllamaClient({
    url,
    model: cfg.ai.model,
    timeoutMs: 60_000,
    keepAlive: 0,
    allowedHosts: cfg.ai.allowedHosts,
  });
  if (!(await client.ping())) {
    console.log(`Ollama not reachable at ${url}: nothing to smoke-test (rules stay in charge).`);
    return;
  }
  const started = Date.now();
  const out = await runAiTask(
    termsTask,
    {
      text: "You may not use the Site or its contents to spam, phish, pharm, pretext, spider, crawl, or scrape.",
    },
    {
      flags: { ...resolveFlags(), "ai.enabled": true, "ai.terms_prescreen": true },
      client,
      cache: new MemoryAiCache(),
    },
  );
  console.log(
    JSON.stringify({
      model: client.model,
      ms: Date.now() - started,
      source: out.source,
      fallback: out.fallback,
      value: out.value,
      dropped: out.dropped,
    }),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
