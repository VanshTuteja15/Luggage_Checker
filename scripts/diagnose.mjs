#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  npm run diagnose          — check every moving part, in order      */
/*  npm run diagnose -- --live "<query>"  — also run ONE real research */
/*                              call (1 Tavily credit) via the app    */
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
    // `await` FIRST, then measure. Array literals evaluate left to right,
    // so `[Date.now() - t0, await fn()]` timed nothing at all and reported
    // 0ms for every call in this script.
    const result = await fn();
    return [Date.now() - t0, result, null];
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
console.log(`${D}${LIVE ? "live mode — this WILL spend about 3–4 Tavily credits" : "dry run — no billable calls"}${X}\n`);

/* ── 1. Keys present ───────────────────────────────────────────── */

console.log(`${B}1. Configuration${X}`);
const keys = [
  ["NEXT_PUBLIC_SUPABASE_URL", true],
  ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", false],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", false],
  ["TAVILY_API_KEY", true],
  ["GEMINI_API_KEY", false],
  ["SUPABASE_SERVICE_ROLE_KEY", false],
];
for (const [name, required] of keys) {
  const v = env[name];
  const mark = v ? `${G}✓${X}` : required ? `${R}✗${X}` : `${Y}–${X}`;
  console.log(`  ${mark} ${name.padEnd(38)} ${v ? `${D}set (${v.length} chars)${X}` : `${D}not set${X}`}`);
}

const hasShopping = !!env.TAVILY_API_KEY;
if (!hasShopping) {
  note("error", "TAVILY_API_KEY is not set. Research can't run without it (free: 1,000 credits/month, no card).");
}
if (env.SERPAPI_KEY || env.SERPER_API_KEY) {
  console.log(`  ${D}(SERPAPI_KEY / SERPER_API_KEY are no longer used for product research and can be removed)${X}`);
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

/* ── 4. Tavily ─────────────────────────────────────────────────── */

console.log(`\n${B}4. Tavily research credits${X}`);
if (!env.TAVILY_API_KEY) {
  console.log(`  ${R}✗${X} TAVILY_API_KEY not set.`);
} else {
  // /usage costs no credits (rate-limited to 10 calls per 10 minutes).
  const [ms, res, err] = await timed(() =>
    fetchWithTimeout("https://api.tavily.com/usage", {
      headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    }, 15_000),
  );

  if (err) {
    console.log(`  ${R}✗${X} couldn't reach api.tavily.com after ${ms}ms — ${err.message}`);
    note("error", `Can't reach api.tavily.com from this machine (${err.message}). Check your connection, VPN or firewall.`);
  } else if (res.status === 401) {
    console.log(`  ${R}✗${X} HTTP 401 — key rejected`);
    note("error", "Tavily rejected TAVILY_API_KEY. Copy it again from app.tavily.com and restart the dev server.");
  } else if (res.status === 403) {
    const body = await res.text().catch(() => "");
    console.log(`  ${R}✗${X} HTTP 403 — ${body.slice(0, 120)}`);
    note("error", "Access to api.tavily.com was blocked (403). A firewall, proxy or VPN is likely in the way — this is not a key problem.");
  } else if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`  ${Y}!${X} HTTP ${res.status} in ${ms}ms — ${body.slice(0, 120)}`);
    note("warn", `Tavily /usage answered ${res.status}. The app will fall back to counting credits itself.`);
  } else {
    const u = await res.json().catch(() => ({}));
    const acct = u.account ?? {};
    const key = u.key ?? {};
    const used = Math.max(Number(acct.plan_usage) || 0, Number(key.usage) || 0);
    const limit = Number(acct.plan_limit) || null;
    const cap = Number(env.TAVILY_MONTHLY_CREDIT_CAP) || 950;
    const effectiveCap = Math.min(cap, limit ?? Infinity, Number(key.limit) || Infinity);
    const left = Math.max(0, effectiveCap - used);

    console.log(`  ${verdict(ms, 1500, 4000)}✓${X} reachable in ${ms}ms${acct.current_plan ? `  ${D}plan: ${acct.current_plan}${X}` : ""}`);
    console.log(`  credits used: ${B}${used}${X}${limit ? ` of ${limit}` : ""}`);
    console.log(`  app stops at: ${B}${effectiveCap}${X}  →  ${B}${left} research calls left${X} ${D}(1 credit each at basic depth)${X}`);

    const paygo = (Number(acct.paygo_limit) || 0) > 0 || (Number(acct.paygo_usage) || 0) > 0;
    console.log(`  ${D}pay-as-you-go fields: paygo_limit=${JSON.stringify(acct.paygo_limit ?? null)} paygo_usage=${JSON.stringify(acct.paygo_usage ?? null)}${X}`);
    if (paygo) {
      note("error", "Pay-as-you-go is ENABLED on the Tavily account. To guarantee $0 the app refuses ALL research while it's on. Turn pay-as-you-go off in the Tavily dashboard and research resumes automatically.");
    } else {
      console.log(`  ${G}✓${X} pay-as-you-go not active ${D}(over the limit Tavily refuses with 432 — nothing is billed)${X}`);
    }
    if (left <= 0) note("error", "The monthly research credit cap is reached. Research resumes when the allowance resets.");
    else if (left < 50) note("warn", `Only ${left} research calls left this month.`);
    else note("ok", `Tavily is ready: ${left} research calls left this month, $0 spend guaranteed by the cap.`);
  }
}

/* ── 5. Live research (optional) ──────────────────────────────── */

if (LIVE && env.TAVILY_API_KEY) {
  const query = process.argv.slice(2).filter((a) => a !== "--live").join(" ") || "samsonite freeform 21";
  console.log(`\n${B}5. Live research — through the app's own code${X}`);
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["scripts/run-ts.mjs", "scripts/research-live.ts", query], {
    stdio: "inherit",
  });
  if (run.status !== 0) note("error", "The live research call failed — see the output above.");
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
  console.log(`\n${D}This was a dry run. To prove the real research path end to end:${X}`);
  console.log(`  ${B}npm run diagnose -- --live "samsonite freeform 21"${X}   ${D}(costs ~3–4 credits)${X}`);
}
console.log("");
process.exit(errors.length > 0 ? 1 : 0);
