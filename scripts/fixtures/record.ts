/* ------------------------------------------------------------------ */
/*  npm run fixtures:record                                            */
/*                                                                     */
/*  Records REAL responses for the adapter fixture tests, through the  */
/*  engine's own PoliteFetcher (honest UA, robots.txt, crawl delays),  */
/*  from channels the registry permits today only: Canada Luggage       */
/*  Depot (product JSON sanctioned by its agents.md) and Delsey.ca     */
/*  (terms silent). ~12 requests in total.                              */
/*                                                                     */
/*  HTML pages are stored REDUCED to what the extractor reads: the     */
/*  <head> meta tags and every application/ld+json block. Bodies are    */
/*  otherwise byte-for-byte what the store sent.                        */
/* ------------------------------------------------------------------ */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PoliteFetcher } from "../../src/lib/engine/politeness/fetcher";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";

type Target = { sourceId: string; handle: string };

const TARGETS: Target[] = [
  { sourceId: "canadaluggagedepot", handle: "samsonite-omni-3-0-large-spinner-expandable-luggage" },
  { sourceId: "delsey-ca", handle: "40119980500us-wagram-23-inch-expandable-carry-on-suitcase-black" },
];

const OUT = resolve("scripts/fixtures");

function reduceHtml(html: string): string {
  const head = html.match(/<head[\s\S]*?<\/head>/i)?.[0] ?? "";
  const metas = head.match(/<meta\s[^>]*>/gi) ?? [];
  const title = head.match(/<title[\s\S]*?<\/title>/i)?.[0] ?? "";
  const lds = html.match(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  return [
    "<!doctype html>",
    "<!-- Reduced recording: <head> meta + JSON-LD only. See scripts/fixtures/README.md -->",
    "<html><head>",
    title,
    ...metas,
    "</head><body>",
    ...lds,
    "</body></html>",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const fetcher = new PoliteFetcher();
  console.log(`Recording with UA: ${fetcher.userAgent}`);
  const manifest: { file: string; url: string; status: number | null; outcome: string; recordedAt: string }[] = [];

  const save = (dir: string, name: string, body: string, url: string, status: number | null, outcome: string) => {
    mkdirSync(resolve(OUT, dir), { recursive: true });
    const file = `${dir}/${name}`;
    writeFileSync(resolve(OUT, file), body);
    manifest.push({ file, url, status, outcome, recordedAt: new Date().toISOString() });
    console.log(`  ${outcome.padEnd(10)} ${status ?? "-"} ${file}`);
  };

  for (const t of TARGETS) {
    const source = SOURCE_SEED.find((s) => s.id === t.sourceId);
    if (!source?.marketHost) throw new Error(`unknown source ${t.sourceId}`);
    const base = `https://${source.marketHost}/products/${t.handle}`;
    const key = `${t.sourceId}__${t.handle.slice(0, 60)}`;

    for (const ext of ["json", "js"] as const) {
      const r = await fetcher.fetch({ source, url: `${base}.${ext}`, adapter: "shopify_product_json" });
      save("shopify", `${key}.${ext === "json" ? "product.json" : "product.js.json"}`, r.body, `${base}.${ext}`, r.status, r.outcome);
    }
    const page = await fetcher.fetch({ source, url: base, adapter: "html_structured" });
    save("html", `${key}.html`, reduceHtml(page.body), base, page.status, page.outcome);

    const wk = await fetcher.fetch({ source, url: `https://${source.marketHost}/.well-known/ucp`, adapter: "shopify_ucp" });
    save("ucp", `${t.sourceId}__well-known.json`, wk.body, `https://${source.marketHost}/.well-known/ucp`, wk.status, wk.outcome);
  }

  // A real miss: a handle that doesn't exist.
  const cld = SOURCE_SEED.find((s) => s.id === "canadaluggagedepot")!;
  const missing = `https://${cld.marketHost}/products/luggagetracker-fixture-no-such-product.json`;
  const miss = await fetcher.fetch({ source: cld, url: missing, adapter: "shopify_product_json" });
  save("shopify", "canadaluggagedepot__missing.product.json", miss.body, missing, miss.status, miss.outcome);

  writeFileSync(resolve(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${manifest.length} recordings written to scripts/fixtures/ (manifest.json)`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
