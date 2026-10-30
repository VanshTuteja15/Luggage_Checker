/* ------------------------------------------------------------------ */
/*  v4 review: record Shopify bulk catalogue pages (/products.json)     */
/*  through the engine's own PoliteFetcher (honest UA, robots.txt,       */
/*  crawl delay, SSRF guard), only from stores whose storefront the      */
/*  registry permits today (Canada Luggage Depot: sanctioned by its      */
/*  agents.md; Delsey.ca: terms silent). One page each, plus one far     */
/*  page at CLD to check pagination. Prints which fields the endpoint    */
/*  carries (barcode? currency? inventory?).                             */
/*                                                                     */
/*  node scripts/run-ts.mjs scripts/bench/record-catalog.ts [rawDir]     */
/*  Full bodies go to rawDir (default: scripts/bench/fixtures/raw,       */
/*  git-ignored by size); a reduced copy (the first 40 products, each     */
/*  object unchanged) goes to scripts/bench/fixtures/.                   */
/* ------------------------------------------------------------------ */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PoliteFetcher } from "../../src/lib/engine/politeness/fetcher";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";
import type { FetchAttempt } from "../../src/lib/engine/types";

const TARGETS: { sourceId: string; path: string; tag: string }[] = [
  { sourceId: "canadaluggagedepot", path: "/products.json?limit=250&page=1", tag: "p1" },
  { sourceId: "canadaluggagedepot", path: "/products.json?limit=250&page=13", tag: "p13" },
  { sourceId: "delsey-ca", path: "/products.json?limit=250&page=1", tag: "p1" },
];

const OUT = resolve("scripts/bench/fixtures");
const RAW = resolve(process.argv[2] ?? "scripts/bench/fixtures/raw");

type Json = Record<string, unknown>;

function keyUnion(objs: Json[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of objs) for (const k of Object.keys(o)) out[k] = (out[k] ?? 0) + 1;
  return out;
}

async function main(): Promise<void> {
  const attempts: FetchAttempt[] = [];
  const fetcher = new PoliteFetcher({ onAttempt: (a) => attempts.push(a) });
  console.log(`UA: ${fetcher.userAgent}`);
  mkdirSync(OUT, { recursive: true });
  mkdirSync(RAW, { recursive: true });
  const manifest: Json[] = [];

  for (const t of TARGETS) {
    const source = SOURCE_SEED.find((s) => s.id === t.sourceId);
    if (!source?.marketHost) throw new Error(`unknown source ${t.sourceId}`);
    const url = `https://${source.marketHost}${t.path}`;
    const res = await fetcher.fetch({
      source,
      url,
      adapter: "shopify_product_json",
      headers: { Accept: "application/json" },
      maxBytes: 30_000_000,
    });
    console.log(
      `\n${res.outcome} ${res.status} ${url} ${res.durationMs} ms ${res.body.length} bytes`,
    );
    console.log(`headers: ${JSON.stringify(res.headers)}`);
    manifest.push({
      url,
      status: res.status,
      outcome: res.outcome,
      bytes: res.body.length,
      ms: res.durationMs,
      recordedAt: new Date().toISOString(),
    });
    if (res.outcome !== "ok") continue;

    const name = `${t.sourceId}__products_${t.tag}.json`;
    writeFileSync(resolve(RAW, name), res.body);
    const parsed = JSON.parse(res.body) as { products?: Json[] };
    const products = parsed.products ?? [];
    const variants = products.flatMap((p) =>
      Array.isArray(p.variants) ? (p.variants as Json[]) : [],
    );
    console.log(`products: ${products.length}, variants: ${variants.length}`);
    console.log(`product keys: ${JSON.stringify(keyUnion(products))}`);
    console.log(`variant keys: ${JSON.stringify(keyUnion(variants))}`);
    const filled = (k: string) =>
      variants.filter((v) => v[k] !== null && v[k] !== undefined && v[k] !== "").length;
    console.log(
      `variants with sku: ${filled("sku")}, barcode: ${filled("barcode")}, compare_at_price: ${filled("compare_at_price")}, available: ${filled("available")}, price_currency: ${filled("price_currency")}`,
    );
    const bodies = products.map((p) => String(p.body_html ?? "").length);
    console.log(
      `body_html chars: min ${Math.min(...bodies)}, median ${bodies.sort((a, b) => a - b)[Math.floor(bodies.length / 2)] ?? 0}, max ${Math.max(...bodies)}`,
    );
    if (products.length) {
      writeFileSync(
        resolve(OUT, name),
        JSON.stringify({ products: products.slice(0, 40) }, null, 1),
      );
    }
  }

  writeFileSync(
    resolve(OUT, "manifest.json"),
    JSON.stringify(
      {
        note: "Reduced: first 40 products of each page, each product object unchanged. Full bodies were kept outside git.",
        attempts: attempts.map((a) => ({
          url: a.url,
          adapter: a.adapter,
          status: a.status,
          outcome: a.outcome,
          ms: a.durationMs,
          at: a.startedAt,
        })),
        pages: manifest,
      },
      null,
      2,
    ),
  );
  console.log(`\nnetwork attempts: ${attempts.length}`);
  for (const a of attempts)
    console.log(`  ${a.startedAt} ${a.adapter} ${a.status} ${a.outcome} ${a.url}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
