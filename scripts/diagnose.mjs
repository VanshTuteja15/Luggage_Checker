#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  npm run diagnose          — check every moving part, in order      */
/*  npm run diagnose -- --live  — also spend ONE real SerpAPI search   */
/*                                                                     */
/*  Everything the search page depends on, timed, from this machine.   */
/*  Without --live it costs nothing and makes no billable call.        */
/* ------------------------------------------------------------------ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m",
      D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";

const LIVE = process.argv.includes("--live");

/* ------------------------------------------------------------------ */

const envPath = resolve(process.cwd(), ".env.local");
if (!existsSync(envPath)) {
  console.log(`${R}✗${X} .env.local not found. Run this from the project root.`);
  process.exit(1);
}

const env = {};
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}

const findings = [];
const note = (level, text) => findings.push({ level, text });

/** Time an async fn, returning [ms, result, error]. */
async function timed(fn) {
  const t0 = Date.now();
  try {
    return [Date.now() - t0, await fn(), null];
  } catch (err) {
    return [Date.now() - t0, null, err];
  }
}

function verdict(ms, good, ok) {
  return ms < good ? G : ms < ok ? Y : R;
}

async function fetchWithTimeout(url, opts = {}, ms = 30_000) {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: c.signal });
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\n${B}LuggageTracker diagnostics${X}`);
console.log(`${D}${LIVE ? "live mode — this WILL spend one SerpAPI search" : "dry run — no billable calls"}${X}\n`);

/* ── 1. Keys present ───────────────────────────────────────────── */

console.log(`${B}1. Configuration${X}`);
const keys = [
  ["NEXT_PUBLIC_SUPABASE_URL", true],
  ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", false],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", false],
  ["SERPAPI_KEY", false],
  ["SERPER_API_KEY", false],
  ["GEMINI_API_KEY", false],
  ["SUPABASE_SERVICE_ROLE_KEY", false],
];
for (const [name, required] of keys) {
  const v = env[name];
  const mark = v ? `${G}✓${X}` : required ? `${R}✗${X}` : `${Y}–${X}`;
  console.log(`  ${mark} ${name.padEnd(38)} ${v ? `${D}set (${v.length} chars)${X}` : `${D}not set${X}`}`);
}

const hasShopping = !!(env.SERPAPI_KEY || env.SERPER_API_KEY);
if (!hasShopping) {
  note("error", "No shopping provider key. Search cannot return prices without SERPAPI_KEY or SERPER_API_KEY.");
}

/* ── 2. Supabase latency ───────────────────────────────────────── */

console.log(`\n${B}2. Supabase round-trip time${X}`);
const sbUrl = env.NEXT_PUBLIC_SUPABASE_URL;
const sbKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!sbUrl || !sbKey) {
  console.log(`  ${R}✗${X} Supabase not configured — skipping.`);
} else {
  const samples = [];
  let unreachable = 0;
  for (let i = 0; i < 3; i++) {
    const [ms, res, err] = await timed(() =>
      fetchWithTimeout(`${sbUrl}/rest/v1/products?select=id&limit=1`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
      }, 20_000),
    );
    if (err) {
      // A connection that FAILS fast is not a fast connection. Never let a
      // failure be recorded as a good latency sample.
      unreachable += 1;
      const why = err.name === "AbortError" ? "timed out" : err.message;
      console.log(`  attempt ${i + 1}: ${R}unreachable${X} after ${ms}ms  ${D}${why}${X}`);
      continue;
    }
    samples.push(ms);
    console.log(`  attempt ${i + 1}: ${verdict(ms, 400, 1500)}${ms}ms${X}  ${D}HTTP ${res.status}${X}`);
  }

  if (samples.length === 0) {
    note("error", `Could not reach Supabase at all (${unreachable}/3 attempts failed). Check NEXT_PUBLIC_SUPABASE_URL and your connection — nothing in the app works without it.`);
    console.log(`  ${R}✗ Supabase unreachable${X}`);
  }

  const median = samples.length
    ? samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)]
    : Infinity;
  if (samples.length) console.log(`  ${B}median ${median}ms${X}`);

  if (unreachable > 0 && samples.length > 0) {
    note("warn", `${unreachable} of 3 Supabase requests failed outright — the connection is unreliable, not just slow.`);
  }

  if (Number.isFinite(median) && median > 3000) {
    note("error", `Supabase is taking ${median}ms per round trip. That is the app's biggest problem — every page and every search pays it several times. Usually means the project is in a distant region, or a free-tier project cold-starting after being paused.`);
  } else if (Number.isFinite(median) && median > 1200) {
    note("warn", `Supabase round trips average ${median}ms — slow but survivable.`);
  }

  // Do the search tables exist?
  const [, res] = await timed(() =>
    fetchWithTimeout(`${sbUrl}/rest/v1/search_cache?select=cache_key&limit=1`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    }, 15_000),
  );
  if (res && res.status === 404) {
    note("warn", "Migration 003 has not been run — there is no search cache, so every repeat search costs a fresh provider call.");
    console.log(`  ${Y}!${X} search_cache table missing (migration 003 not run)`);
  } else if (res && res.ok) {
    console.log(`  ${G}✓${X} search_cache table present`);
  }
}

/* ── 3. Gemini ─────────────────────────────────────────────────── */

console.log(`\n${B}3. Gemini (optional — search works without it)${X}`);
if (!env.GEMINI_API_KEY) {
  console.log(`  ${Y}–${X} Not configured. Query parsing and grouping use non-AI logic.`);
} else {
  const models = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-flash"];
  let working = null;
  for (const model of models) {
    const [ms, res, err] = await timed(() =>
      fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
            generationConfig: { maxOutputTokens: 8 },
          }),
        },
        15_000,
      ),
    );
    if (err) {
      console.log(`  ${R}✗${X} ${model.padEnd(20)} ${ms}ms  ${D}${err.message}${X}`);
      continue;
    }
    if (res.ok) {
      console.log(`  ${verdict(ms, 2000, 6000)}✓${X} ${model.padEnd(20)} ${ms}ms`);
      working = model;
      break;
    }
    const body = await res.text().catch(() => "");
    const why = res.status === 404 ? "model not available to this key"
      : res.status === 503 ? "overloaded (503)"
      : res.status === 429 ? "rate limited (429)"
      : body.slice(0, 80);
    console.log(`  ${Y}✗${X} ${model.padEnd(20)} ${ms}ms  ${D}${why}${X}`);
  }
  if (!working) {
    note("warn", "No Gemini model answered. Search still works — parsing and grouping fall back to non-AI logic — but results are grouped less cleanly.");
  }
}

/* ── 4. SerpAPI ────────────────────────────────────────────────── */

console.log(`\n${B}4. SerpAPI${X}`);
if (!env.SERPAPI_KEY) {
  console.log(`  ${Y}–${X} SERPAPI_KEY not set.`);
} else if (!LIVE) {
  // Account check costs nothing.
  const [ms, res, err] = await timed(() =>
    fetchWithTimeout(`https://serpapi.com/account?api_key=${env.SERPAPI_KEY}`, {}, 20_000),
  );
  if (err) {
    console.log(`  ${R}✗${X} couldn't reach serpapi.com after ${ms}ms — ${err.message}`);
    note("error", `Cannot reach serpapi.com from this machine (${err.message}). Check your connection, VPN, or firewall.`);
  } else if (res.ok) {
    const acct = await res.json().catch(() => ({}));
    console.log(`  ${verdict(ms, 1500, 4000)}✓${X} account reachable in ${ms}ms`);
    if (typeof acct.total_searches_left === "number") {
      const left = acct.total_searches_left;
      console.log(`  ${B}searches left this month: ${left}${X}${acct.searches_per_month ? ` ${D}of ${acct.searches_per_month}${X}` : ""}`);
      if (left <= 0) note("error", "SerpAPI allowance is used up. No search can return prices until it resets.");
      else if (left < 20) note("warn", `Only ${left} SerpAPI searches left this month.`);
    }
    console.log(`  ${D}run with --live to spend one search and test the real query path${X}`);
  } else {
    const body = await res.text().catch(() => "");
    console.log(`  ${R}✗${X} HTTP ${res.status} in ${ms}ms — ${body.slice(0, 120)}`);
    if (res.status === 401) {
      note("error", "SerpAPI rejected the key. Confirm your email at serpapi.com — a new key stays inactive until the address is verified.");
    } else {
      note("error", `SerpAPI returned HTTP ${res.status} for the account check: ${body.slice(0, 160)}`);
    }
  }
} else {
  const query = process.argv.slice(2).filter((a) => a !== "--live").join(" ") || "samsonite luggage";
  const params = new URLSearchParams({
    engine: "google_shopping",
    q: query,
    gl: "ca",
    hl: "en",
    google_domain: "google.ca",
    num: "20",
    api_key: env.SERPAPI_KEY,
  });

  console.log(`  ${D}query: ${query}${X}`);
  const [ms, res, err] = await timed(() =>
    fetchWithTimeout(`https://serpapi.com/search.json?${params}`, {}, 45_000),
  );

  if (err) {
    console.log(`  ${R}✗ ${err.name === "AbortError" ? "TIMED OUT" : "FAILED"}${X} after ${ms}ms — ${err.message}`);
    note("error", `SerpAPI did not respond within 45s from this machine. This is the search's core dependency — nothing else matters until it answers.`);
  } else {
    const body = await res.json().catch(() => null);
    console.log(`  ${verdict(ms, 8000, 20000)}HTTP ${res.status} in ${B}${ms}ms${X}`);

    if (body?.error) {
      const noResults = /hasn'?t returned any results|no results/i.test(body.error);
      console.log(`  ${noResults ? Y : R}${noResults ? "!" : "✗"}${X} ${body.error}`);
      if (noResults) {
        note("warn", `Google had no match for "${query}". This is normal for long product titles — the app now retries automatically with shorter terms.`);
      } else {
        note("error", `SerpAPI: ${body.error}`);
      }
    } else {
      const results = body?.shopping_results ?? [];
      const merchant = (r) => {
        const u = r.link || r.product_link || "";
        if (!/^https?:\/\//i.test(u)) return "";
        try {
          const h = new URL(u).hostname.replace(/^www\./, "");
          return /(^|\.)google\.(com|ca)$/i.test(h) ? "" : u;
        } catch { return ""; }
      };
      const usable = results.filter((r) => merchant(r) && r.extracted_price > 0);
      const dropped = results.length - usable.length;

      console.log(`  listings returned: ${results.length}`);
      console.log(`  usable (merchant url + price): ${B}${usable.length}${X}${dropped ? `  ${D}(${dropped} unusable)${X}` : ""}`);
      console.log("");
      for (const r of usable.slice(0, 8)) {
        console.log(`    ${(r.source ?? "?").padEnd(22).slice(0, 22)} $${String(r.extracted_price).padStart(8)}  ${D}${(r.title ?? "").slice(0, 44)}${X}`);
      }

      if (usable.length === 0) {
        note("error", "SerpAPI answered but no listing had both a price and a merchant link. The search page would show an empty result.");
      } else if (ms > 20_000) {
        note("warn", `SerpAPI took ${ms}ms. Set SERPAPI_TIMEOUT_MS=40000 and SEARCH_BUDGET_MS=55000 in .env.local.`);
      } else {
        note("ok", `SerpAPI returned ${usable.length} usable listings in ${ms}ms. The search page will show results.`);
      }
    }
  }
}

/* ── Verdict ───────────────────────────────────────────────────── */

console.log(`\n${B}Verdict${X}`);
const errors = findings.filter((f) => f.level === "error");
const warns = findings.filter((f) => f.level === "warn");
const oks = findings.filter((f) => f.level === "ok");

for (const f of oks) console.log(`  ${G}✓${X} ${f.text}`);
for (const f of warns) console.log(`  ${Y}!${X} ${f.text}`);
for (const f of errors) console.log(`  ${R}✗${X} ${f.text}`);

if (errors.length === 0 && warns.length === 0) {
  console.log(`  ${G}Everything checks out.${X}`);
}
if (!LIVE && hasShopping) {
  console.log(`\n${D}This was a dry run. To prove the real search path end to end:${X}`);
  console.log(`  ${B}npm run diagnose -- --live "samsonite luggage"${X}   ${D}(costs 1 search)${X}`);
}
console.log("");
process.exit(errors.length > 0 ? 1 : 0);
