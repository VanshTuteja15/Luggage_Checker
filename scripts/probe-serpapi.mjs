#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  npm run probe -- "samsonite"                                       */
/*                                                                     */
/*  Calls SerpAPI directly from your machine and times it. This takes  */
/*  the whole app out of the picture: if the probe is fast and the app */
/*  times out, the bug is ours. If the probe is slow, it's SerpAPI or  */
/*  your network, and the fix is SERPAPI_TIMEOUT_MS.                    */
/*                                                                     */
/*  Costs one search from your allowance.                              */
/* ------------------------------------------------------------------ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

const envPath = resolve(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.log(`${R}✗${X} .env.local not found.`);
  process.exit(1);
}

const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const key = env.SERPAPI_KEY;
if (!key || key.length < 10) {
  console.log(`${R}✗${X} SERPAPI_KEY is not set in .env.local`);
  process.exit(1);
}

const query = process.argv.slice(2).join(" ") || "samsonite luggage";
const timeout = Number(env.SERPAPI_TIMEOUT_MS) || 25_000;

const params = new URLSearchParams({
  engine: "google_shopping",
  q: query,
  gl: "ca",
  hl: "en",
  google_domain: "google.ca",
  num: "20",
  api_key: key,
});

console.log(`\n${B}SerpAPI probe${X}`);
console.log(`${D}query:   ${query}${X}`);
console.log(`${D}timeout: ${timeout}ms${X}\n`);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeout);
const started = Date.now();

let res;
try {
  res = await fetch(`https://serpapi.com/search.json?${params}`, {
    signal: controller.signal,
  });
} catch (err) {
  const ms = Date.now() - started;
  clearTimeout(timer);
  if (err?.name === "AbortError") {
    console.log(`${R}✗ TIMED OUT${X} after ${ms}ms\n`);
    console.log("SerpAPI is genuinely slower than your timeout. Fix:");
    console.log(`  ${B}SERPAPI_TIMEOUT_MS=45000${X} in .env.local, then restart.`);
    console.log(`  ${D}Also raise SEARCH_BUDGET_MS=90000 if running locally.${X}\n`);
  } else {
    console.log(`${R}✗ NETWORK ERROR${X} after ${ms}ms: ${err?.message}\n`);
  }
  process.exit(1);
}
clearTimeout(timer);

const ms = Date.now() - started;
const body = await res.json().catch(() => null);

if (!res.ok || body?.error) {
  console.log(`${R}✗ HTTP ${res.status}${X} in ${ms}ms`);
  console.log(`  ${body?.error ?? "(no detail)"}\n`);
  if (res.status === 401 || /key/i.test(body?.error ?? "")) {
    console.log("Your key was rejected. Confirm your email at serpapi.com —");
    console.log("a new key stays inactive until the address is verified.\n");
  }
  process.exit(1);
}

const results = body.shopping_results ?? [];

// Same rule the app applies: a listing is only usable if it has a price AND
// a real merchant URL. Google's own aggregate pages (a "Various sellers" row
// with no `link`) are dropped, because you can't send a buyer there and
// can't re-check the price there tomorrow.
const NON_MERCHANT = /(^|\.)(google\.(com|ca)|gstatic\.com|googleusercontent\.com)$/i;
const merchantUrl = (r) => {
  const u = r.link || r.product_link || "";
  if (!/^https?:\/\//i.test(u)) return "";
  try {
    return NON_MERCHANT.test(new URL(u).hostname.replace(/^www\./, "")) ? "" : u;
  } catch {
    return "";
  }
};

const usable = results.filter((r) => merchantUrl(r) && r.extracted_price > 0);
const googleOnly = results.filter(
  (r) => !merchantUrl(r) && r.extracted_price > 0 && (r.link || r.product_link),
).length;

const verdict = ms < 8000 ? G : ms < 20000 ? Y : R;
console.log(`${verdict}✓ ${res.status}${X} in ${B}${ms}ms${X}`);
console.log(`  listings returned: ${results.length}`);
console.log(`  usable (merchant url + price): ${B}${usable.length}${X}`);
if (googleOnly > 0) {
  console.log(`  ${D}dropped ${googleOnly} priced row(s) that only link back to Google${X}`);
}
console.log("");

for (const r of usable.slice(0, 8)) {
  const src = (r.source ?? "?").padEnd(22).slice(0, 22);
  const price = String(r.extracted_price).padStart(8);
  console.log(`  ${src} $${price}  ${D}${(r.title ?? "").slice(0, 46)}${X}`);
}

console.log("");
if (usable.length === 0) {
  console.log(`${Y}!${X} No usable listings — try a broader query.\n`);
} else if (ms > 20000) {
  console.log(`${Y}!${X} That was slow. Set ${B}SERPAPI_TIMEOUT_MS=45000${X} in .env.local.\n`);
} else {
  console.log(`${G}SerpAPI is healthy.${X} If the app still fails, the bug is in the app.\n`);
}
