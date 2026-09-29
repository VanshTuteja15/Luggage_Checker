/* ------------------------------------------------------------------ */
/*  npm run research:live -- "samsonite freeform 21"                  */
/*                                                                     */
/*  One REAL research call through the app's exact code path — the    */
/*  same request builder, the same page analysis, the same grouping.   */
/*  What this prints is what the Search page will show.                */
/*                                                                     */
/*  Costs ~3–4 Tavily credits: two searches (general + major chains)   */
/*  and reading the store pages that had no price. Checks the monthly  */
/*  cap first, like the app does, and saves every raw response to      */
/*  tavily-response.json so problems can be diagnosed without paying   */
/*  for a second run.                                                  */
/* ------------------------------------------------------------------ */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TavilyExtractResponse, TavilySearchRequest, TavilySearchResponse } from "../src/lib/tavily";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

/* ── Load .env.local without printing any secret ──────────────── */
const envPath = resolve(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.log(`${R}✗${X} .env.local not found. Run this from the project root.`);
  process.exit(1);
}
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  if (!(k in process.env)) process.env[k] = v;
}

async function main() {
  if (!process.env.TAVILY_API_KEY) {
    console.log(`${R}✗${X} TAVILY_API_KEY is not set in .env.local`);
    process.exit(1);
  }

  // Import after env is loaded — modules read env lazily, but be safe.
  const { search } = await import("../src/lib/search/index");
  const { analyzeResults } = await import("../src/lib/search/providers/tavily");
  const { fetchTavilyUsage, tavilyCreditStatus } = await import("../src/lib/tavily");

  const query = process.argv.slice(2).join(" ").trim() || "samsonite freeform 21";

  console.log(`\n${B}Live research check${X}`);
  console.log(`${D}query: ${query}${X}\n`);

  /* ── Credits before (free call) ───────────────────────────── */
  const usage = await fetchTavilyUsage(true);
  if (usage) {
    console.log(`  credits used this period: ${B}${usage.used}${X}${usage.limit ? ` of ${usage.limit}` : ""}${usage.plan ? `  ${D}(${usage.plan})${X}` : ""}`);
    if (usage.paygoEnabled) {
      console.log(`  ${Y}! pay-as-you-go looks ENABLED — turn it off in the Tavily dashboard to make $0 airtight.${X}`);
    }
  } else {
    console.log(`  ${Y}!${X} couldn't read /usage — the app will count credits locally.`);
  }
  const status = tavilyCreditStatus();
  console.log(`  app cap: ${status.cap}  ·  remaining under cap: ${B}${status.remaining}${X}\n`);

  /* ── One real search, through the app ─────────────────────── */
  const searches: { request: TavilySearchRequest; response: TavilySearchResponse }[] = [];
  const reads: { urls: string[]; response: TavilyExtractResponse }[] = [];
  let partialAt: number | null = null;
  let partialOffers = 0;

  const started = Date.now();
  let result;
  try {
    result = await search(query, {
      bypassCache: true,
      onResearch: (info) => searches.push(info),
      onExtract: (info) => reads.push(info),
      onPartial: (p) => {
        partialAt = Date.now() - started;
        partialOffers = p.offersFound;
      },
    });
  } catch (err) {
    console.log(`${R}✗ ${err instanceof Error ? err.message : String(err)}${X}\n`);
    process.exit(1);
  }
  const elapsed = Date.now() - started;

  writeFileSync("tavily-response.json", JSON.stringify({ query, searches, reads }, null, 2));

  for (const [i, c] of searches.entries()) {
    const label = c.request.includeDomainsMode === "restrict" ? "major chains" : "all stores";
    console.log(`  ${G}✓${X} search ${i + 1} (${label}): ${c.response.results.length} pages · ${B}${c.response.creditsUsed} credit(s)${X} · ${c.response.responseTimeMs ?? "?"}ms`);
  }
  for (const r of reads) {
    console.log(`  ${G}✓${X} read ${r.urls.length} store page(s): ${r.response.results.length} read, ${r.response.failed.length} failed · ${B}${r.response.creditsUsed} credit(s)${X}`);
    for (const f of r.response.failed) console.log(`      ${D}✗ ${f.url.slice(0, 70)} — ${f.error}${X}`);
  }
  console.log(`  ${D}raw responses saved to tavily-response.json${X}\n`);

  console.log(`  ${B}Page by page${X}`);
  const readText = new Map(reads.flatMap((r) => r.response.results.map((x) => [x.url, x.rawContent] as const)));
  const allResults = searches.flatMap((c) => c.response.results).map((r) =>
    readText.has(r.url) ? { ...r, rawContent: readText.get(r.url) ?? null } : r,
  );
  for (const a of analyzeResults(allResults)) {
    const tag = readText.has(a.url) ? " [read]" : "";
    if (a.offer) {
      console.log(`    ${G}✓${X} ${a.retailer.padEnd(22).slice(0, 22)} $${a.offer.price.toFixed(2).padStart(8)}  ${D}${a.offer.title.slice(0, 50)}${tag}${X}`);
      console.log(`      ${D}evidence: ${(a.offer.evidence ?? "").slice(0, 110)}${X}`);
    } else {
      console.log(`    ${Y}–${X} ${a.host.padEnd(22).slice(0, 22)} ${D}${a.reason}${tag}${X}`);
    }
  }

  if (partialAt !== null) {
    console.log(`\n  first results after ${B}${partialAt}ms${X} (${partialOffers} prices), complete after ${B}${elapsed}ms${X}`);
  }

  /* ── What the Search page will show ───────────────────────── */
  console.log(`\n  ${B}What the Search page shows${X}  ${D}(${elapsed}ms end to end)${X}`);
  if (result.products.length === 0) {
    console.log(`    ${Y}no products${X}`);
  }
  for (const p of result.products) {
    console.log(`\n    ${B}${p.name}${X}  ${D}${p.retailerCount} store(s), from $${p.lowestPrice.toFixed(2)} · match ${Math.round((p.relevance ?? 1) * 100)}%${X}`);
    for (const o of p.offers) {
      console.log(`      ${o.retailer.padEnd(22).slice(0, 22)} $${o.price.toFixed(2).padStart(8)}${o.inStock ? "" : `  ${Y}out of stock${X}`}  ${D}${o.url.slice(0, 60)}${X}`);
    }
    if (p.colours?.length) console.log(`      ${D}colours: ${p.colours.join(", ")}${X}`);
    if (p.details) console.log(`      ${D}specs: ${JSON.stringify(p.details)}${X}`);
  }
  for (const a of result.alsoCheck ?? []) {
    console.log(`\n  ${Y}link only${X} ${a.retailer}: ${D}${a.url.slice(0, 80)}${X}`);
  }
  console.log(`\n  credits this search: ${B}${result.creditsUsed ?? "?"}${X}`);
  for (const w of result.warnings) console.log(`\n  ${Y}!${X} ${w}`);

  const after = tavilyCreditStatus();
  console.log(`\n  remaining under cap: ${B}${after.remaining}${X}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
