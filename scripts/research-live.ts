/* ------------------------------------------------------------------ */
/*  npm run research:live -- "samsonite freeform 21"                  */
/*                                                                     */
/*  One REAL research call through the app's exact code path — the    */
/*  same request builder, the same page analysis, the same grouping.   */
/*  What this prints is what the Search page will show.                */
/*                                                                     */
/*  Costs 1 Tavily credit (basic depth). Checks the monthly cap first, */
/*  like the app does, and saves the raw response to                   */
/*  tavily-response.json so problems can be diagnosed without paying   */
/*  for a second call.                                                 */
/* ------------------------------------------------------------------ */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { TavilySearchRequest, TavilySearchResponse } from "../src/lib/tavily";

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
  // Assigned inside a callback, so hold it in an object TypeScript can track.
  const captured: { value: { request: TavilySearchRequest; response: TavilySearchResponse } | null } = {
    value: null,
  };

  const started = Date.now();
  let result;
  try {
    result = await search(query, {
      onResearch: (info) => {
        captured.value = info;
      },
    });
  } catch (err) {
    console.log(`${R}✗ ${err instanceof Error ? err.message : String(err)}${X}\n`);
    process.exit(1);
  }
  const elapsed = Date.now() - started;

  if (captured.value) {
    const c = captured.value;
    writeFileSync("tavily-response.json", JSON.stringify(c, null, 2));
    console.log(`  ${G}✓${X} Tavily answered: ${c.response.results.length} pages · ${B}${c.response.creditsUsed} credit(s)${X} · ${c.response.responseTimeMs ?? "?"}ms server time`);
    console.log(`  ${D}raw response saved to tavily-response.json (request id ${c.response.requestId ?? "n/a"})${X}\n`);

    console.log(`  ${B}Page by page${X}`);
    for (const a of analyzeResults(c.response.results)) {
      if (a.offer) {
        console.log(`    ${G}✓${X} ${a.retailer.padEnd(22).slice(0, 22)} $${a.offer.price.toFixed(2).padStart(8)}  ${D}${a.offer.title.slice(0, 50)}${X}`);
        console.log(`      ${D}evidence: ${(a.offer.evidence ?? "").slice(0, 110)}${X}`);
      } else {
        console.log(`    ${Y}–${X} ${a.host.padEnd(22).slice(0, 22)} ${D}${a.reason}${X}`);
      }
    }
  }

  /* ── What the Search page will show ───────────────────────── */
  console.log(`\n  ${B}What the Search page shows${X}  ${D}(${elapsed}ms end to end)${X}`);
  if (result.products.length === 0) {
    console.log(`    ${Y}no products${X}`);
  }
  for (const p of result.products) {
    console.log(`\n    ${B}${p.name}${X}  ${D}${p.retailerCount} retailer(s), from $${p.lowestPrice.toFixed(2)}${X}`);
    for (const o of p.offers) {
      console.log(`      ${o.retailer.padEnd(22).slice(0, 22)} $${o.price.toFixed(2).padStart(8)}${o.inStock ? "" : `  ${Y}out of stock${X}`}  ${D}${o.url.slice(0, 60)}${X}`);
    }
    if (p.details) console.log(`      ${D}specs: ${JSON.stringify(p.details)}${X}`);
  }
  for (const w of result.warnings) console.log(`\n  ${Y}!${X} ${w}`);

  const after = tavilyCreditStatus();
  console.log(`\n  remaining under cap: ${B}${after.remaining}${X}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
