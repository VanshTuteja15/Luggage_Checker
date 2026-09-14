#!/usr/bin/env node
/* ------------------------------------------------------------------ */
/*  npm run doctor                                                     */
/*                                                                     */
/*  Reads .env.local and reports what is configured and what isn't,    */
/*  without ever printing a secret. Answers "why isn't search working" */
/*  in one command instead of a round trip.                            */
/* ------------------------------------------------------------------ */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ENV_PATH = resolve(process.cwd(), ".env.local");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ok = (s) => `${GREEN}✓${RESET} ${s}`;
const bad = (s) => `${RED}✗${RESET} ${s}`;
const warn = (s) => `${YELLOW}!${RESET} ${s}`;

if (!existsSync(ENV_PATH)) {
  console.log(bad(".env.local not found. Copy .env.example to .env.local first."));
  process.exit(1);
}

const env = {};
for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq === -1) continue;
  env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
}

const set = (k) => typeof env[k] === "string" && env[k].length > 2;

console.log(`\n${BOLD}LuggageTracker — configuration check${RESET}\n`);

/* ── Required to run at all ──────────────────────────────── */
console.log(`${BOLD}Database & auth${RESET}`);
const dbKeys = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
let dbOk = true;
for (const k of dbKeys) {
  if (set(k)) console.log("  " + ok(k));
  else {
    console.log("  " + bad(`${k} ${DIM}— required, the app cannot start${RESET}`));
    dbOk = false;
  }
}

/* ── Price providers ─────────────────────────────────────── */
console.log(`\n${BOLD}Price source${RESET} ${DIM}(need at least one)${RESET}`);
const hasSerper = set("SERPER_API_KEY");
const hasSerpapi = set("SERPAPI_KEY");
const hasGemini = set("GEMINI_API_KEY");

console.log(
  "  " +
    (hasSerper
      ? ok("SERPER_API_KEY " + DIM + "— 2,500 free searches" + RESET)
      : `${DIM}·${RESET} SERPER_API_KEY ${DIM}— not set (serper.dev, 2,500 free)${RESET}`),
);
console.log(
  "  " +
    (hasSerpapi
      ? ok("SERPAPI_KEY " + DIM + "— 250 free per month" + RESET)
      : `${DIM}·${RESET} SERPAPI_KEY ${DIM}— not set (serpapi.com, 250 free/month)${RESET}`),
);

let providerOk = true;
if (!hasSerper && !hasSerpapi) {
  providerOk = false;
  console.log("\n  " + bad(`${BOLD}No shopping provider configured — search will not work.${RESET}`));
  console.log(
    `    ${DIM}Gemini grounding is NOT a substitute: it needs a billing-enabled${RESET}`,
  );
  console.log(`    ${DIM}Google project, so it fails on a free key.${RESET}`);
  console.log(`    ${DIM}Fix: add one of the two keys above, then restart the dev server.${RESET}`);
} else {
  const active = hasSerper ? "Serper.dev" : "SerpAPI";
  console.log("\n  " + ok(`Search will use ${BOLD}${active}${RESET}`));
}

/* ── AI ──────────────────────────────────────────────────── */
console.log(`\n${BOLD}AI${RESET}`);
console.log(
  "  " +
    (hasGemini
      ? ok("GEMINI_API_KEY " + DIM + "— query parsing, clustering, chat" + RESET)
      : warn("GEMINI_API_KEY not set — search still works, but falls back to")),
);
if (!hasGemini) {
  console.log(`    ${DIM}keyword matching instead of natural-language understanding.${RESET}`);
}
if (set("GEMINI_MODEL")) {
  console.log("  " + warn(`GEMINI_MODEL pinned to "${env.GEMINI_MODEL}"`));
  console.log(
    `    ${DIM}Leave it unset unless you need a specific model — the app${RESET}`,
  );
  console.log(`    ${DIM}auto-selects a working one and survives retirements.${RESET}`);
}

/* ── Optional ────────────────────────────────────────────── */
console.log(`\n${BOLD}Optional${RESET}`);
console.log(
  "  " +
    (set("SUPABASE_SERVICE_ROLE_KEY")
      ? ok("SUPABASE_SERVICE_ROLE_KEY " + DIM + "— cron jobs" + RESET)
      : `${DIM}·${RESET} SUPABASE_SERVICE_ROLE_KEY ${DIM}— not set; scheduled price checks and reports won't run${RESET}`),
);
console.log(
  "  " +
    (set("CRON_SECRET")
      ? ok("CRON_SECRET")
      : `${DIM}·${RESET} CRON_SECRET ${DIM}— not set; cron endpoints reject all callers${RESET}`),
);
console.log(
  "  " +
    (set("RESEND_API_KEY")
      ? ok("RESEND_API_KEY " + DIM + "— daily report email" + RESET)
      : `${DIM}·${RESET} RESEND_API_KEY ${DIM}— not set; prices still record, no email sent${RESET}`),
);

/* ── Verdict ─────────────────────────────────────────────── */
console.log("");
if (dbOk && providerOk) {
  console.log(`${GREEN}${BOLD}Ready.${RESET} Run ${BOLD}npm run dev${RESET} and search for something.`);
  console.log(
    `${DIM}Don't forget the two SQL migrations if you haven't run them — see SETUP.md.${RESET}\n`,
  );
  process.exit(0);
}

console.log(`${RED}${BOLD}Not ready.${RESET} Fix the ${RED}✗${RESET} items above, then ${BOLD}restart the dev server${RESET}.`);
console.log(`${DIM}Next.js reads .env.local only at startup — editing it while running changes nothing.${RESET}\n`);
process.exit(1);
