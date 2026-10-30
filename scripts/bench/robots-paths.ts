/* ------------------------------------------------------------------ */
/*  v4 review: which bulk-catalogue paths does each store's robots.txt  */
/*  allow for our token? Offline: evaluates the rules the P0 probe      */
/*  recorded (docs/probe-results.json, 2026-10-07) with the engine's     */
/*  own parser and matcher. Zero network requests.                       */
/*                                                                     */
/*  node scripts/run-ts.mjs scripts/bench/robots-paths.ts                */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { BOT_TOKEN } from "../../src/lib/engine/config";
import { isAllowed, parseRobots } from "../../src/lib/engine/politeness/robots";

type ProbeStore = {
  id: string;
  host: string;
  robots?: {
    fetched?: boolean;
    status?: number | null;
    group?: string | null;
    crawlDelay?: number | null;
    rules?: { allow: boolean; pattern: string }[];
  };
};

const PATHS = [
  "/products.json?limit=250&page=1",
  "/collections/all/products.json?limit=250&page=1",
  "/products/example-handle.json",
  "/products/example-handle.js",
  "/wp-json/wc/store/v1/products?per_page=100&page=1",
  "/sitemap.xml",
  "/search?q=luggage",
  "/policies/terms-of-service",
];

const probe = JSON.parse(readFileSync("docs/probe-results.json", "utf8")) as {
  probe: Record<string, unknown>;
  stores: ProbeStore[];
};

console.log(`probe run: ${JSON.stringify(probe.probe).slice(0, 160)}`);
console.log(`token: ${BOT_TOKEN}\n`);
console.log(["store", "robots", ...PATHS.map((p) => p.split("?")[0])].join(" | "));
for (const s of probe.stores) {
  const r = s.robots;
  if (!r?.fetched || !r.rules) {
    console.log(
      `${s.id} | not read (status ${r?.status ?? "-"}) | ${PATHS.map(() => "?").join(" | ")}`,
    );
    continue;
  }
  // Rebuild the group the probe chose and let the engine parse and match it.
  const text = [
    `User-agent: ${r.group ?? "*"}`,
    ...(r.crawlDelay ? [`Crawl-delay: ${r.crawlDelay}`] : []),
    ...r.rules.map((x) => `${x.allow ? "Allow" : "Disallow"}: ${x.pattern}`),
  ].join("\n");
  const rules = parseRobots(text, r.group && r.group !== "*" ? r.group : BOT_TOKEN);
  const cells = PATHS.map((p) =>
    isAllowed(rules, `https://${s.host}${p}`) ? "allow" : "DISALLOW",
  );
  console.log([s.id, `${r.status} group ${r.group}`, ...cells].join(" | "));
}
