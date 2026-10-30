/* ------------------------------------------------------------------ */
/*  v4 review: read a store's published terms page through the          */
/*  PoliteFetcher (robots.txt honoured) and print the sentences about    */
/*  automated access, as input for the terms-clause eval set (f) and the */
/*  permission review. A pre-screen, never a legal decision.             */
/*                                                                     */
/*  node scripts/run-ts.mjs scripts/bench/record-terms.ts <outDir>       */
/*       <sourceId> [sourceId…]                                          */
/* ------------------------------------------------------------------ */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeHtmlText } from "../../src/lib/engine/extract/structured";
import { PoliteFetcher } from "../../src/lib/engine/politeness/fetcher";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";
import type { FetchAttempt } from "../../src/lib/engine/types";

const ACCESS =
  /\b(robot|spider|crawl|scrap|data[- ]?min|harvest|automat|bot\b|bots\b|agent|extract|framing|mirror)/i;

function textOf(html: string): string {
  const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html;
  return decodeHtmlText(
    main
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|\/p|\/li|\/h\d|\/div)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

async function main(): Promise<void> {
  const [outDir, ...ids] = process.argv.slice(2);
  if (!outDir || ids.length === 0) throw new Error("usage: record-terms.ts <outDir> <sourceId>…");
  mkdirSync(resolve(outDir), { recursive: true });
  const attempts: FetchAttempt[] = [];
  const fetcher = new PoliteFetcher({ onAttempt: (a) => attempts.push(a) });
  for (const id of ids) {
    const source = SOURCE_SEED.find((s) => s.id === id);
    if (!source?.terms.url) {
      console.log(`${id}: no terms URL on record`);
      continue;
    }
    const res = await fetcher.fetch({
      source,
      url: source.terms.url,
      adapter: "html_structured",
      maxBytes: 5_000_000,
    });
    console.log(
      `\n${id}: ${res.outcome} ${res.status} ${source.terms.url} (${res.body.length} bytes)`,
    );
    if (res.outcome !== "ok") continue;
    const text = textOf(res.body);
    writeFileSync(resolve(outDir, `${id}__terms.txt`), text);
    const sentences = text.split(/(?<=[.;:])\s+|\n/).filter((s) => ACCESS.test(s));
    for (const s of sentences.slice(0, 12)) console.log(`  > ${s.trim().slice(0, 400)}`);
  }
  console.log(`\nnetwork attempts: ${attempts.length}`);
  for (const a of attempts)
    console.log(`  ${a.startedAt} ${a.adapter} ${a.status} ${a.outcome} ${a.url}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
