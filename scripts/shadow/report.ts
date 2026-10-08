/* ------------------------------------------------------------------ */
/*  npm run shadow:report                                               */
/*                                                                     */
/*  Metrics for docs/SHADOW_REPORT.md from docs/shadow/results.json     */
/*  (written by npm run shadow:run). Prints Markdown tables.            */
/*                                                                     */
/*  Definitions                                                         */
/*  - found: some card holds an offer with the expected identity         */
/*    (brand, size class, line words, stated inches) and, for the        */
/*    engine, a price that matches the store's page.                    */
/*  - expected card: the first card holding the expected product; its   */
/*    offers are what a person reads as "this product's prices".         */
/*  - consistent card: every offer in it has the same brand, size class, */
/*    stated inches and line words (colour aside): no mixed products.   */
/*  - price correct: equal to the store page's own structured data read */
/*    seconds later (stores we may read); others are "unverifiable".     */
/* ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { sourceForUrl } from "../../src/lib/engine/registry";

type Shown = {
  card: number;
  store: string;
  url: string;
  title: string;
  price: number;
  identity: string | null;
  truth: number | null;
  priceOk: boolean | null;
};
type PathResult = {
  ran?: boolean;
  error?: string;
  firstPriceMs?: number | null;
  firstMs?: number;
  totalMs?: number;
  credits?: number;
  expectedRank?: number;
  staleUnlabelled?: number;
  stores?: Record<string, string>;
  shown?: Shown[];
};
type Result = {
  id: string;
  query: string;
  unreadable: boolean;
  expectedSources: string[];
  engine: PathResult;
  old: PathResult;
};

const data = JSON.parse(readFileSync(resolve("docs/shadow/results.json"), "utf8")) as {
  ranAt: string;
  oldPath: string;
  tavilyCreditsUsed: number;
  truthPagesRead: number;
  results: Result[];
};

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const ms = (x: number | null) =>
  x === null ? "—" : x >= 1000 ? `${(x / 1000).toFixed(1)} s` : `${x} ms`;

function signature(o: Shown): string {
  let houseBrand: string | undefined;
  try {
    houseBrand = sourceForUrl(o.url)?.identityQuality.houseBrand;
  } catch {
    houseBrand = undefined;
  }
  const brand = luggagePack.brandOf(o.title) ?? houseBrand ?? "?";
  // The variant segment after " - " is the colourway ("Limited Edition: Jade Green").
  const line = luggagePack
    .lineOf(o.title.replace(/\s+-\s+[^-]+$/, ""), brand)
    .sort()
    .join(" ");
  return `${brand}|${luggagePack.sizeClassOf(o.title) ?? "?"}|${luggagePack.inchesOf(o.title) ?? ""}|${line}`;
}

function cards(shown: Shown[]): Shown[][] {
  const out: Shown[][] = [];
  for (const o of shown) (out[o.card] ??= []).push(o);
  return out.filter(Boolean);
}

type Stats = {
  tests: number;
  ran: number;
  found: number;
  topIsExpected: number;
  expectedCardOffers: number;
  expectedCardWrongIdentity: number;
  shownOffers: number;
  verifiable: number;
  priceCorrect: number;
  priceWrong: { id: string; title: string; price: number; truth: number | null }[];
  inconsistentCards: number;
  mixed: { id: string; titles: string[] }[];
  cardsTotal: number;
  first: number[];
  total: number[];
  withinFirst: number;
  withinTotal: number;
  staleUnlabelled: number;
};

function stats(results: Result[], pick: (r: Result) => PathResult, engine: boolean): Stats {
  const s: Stats = {
    tests: results.length,
    ran: 0,
    found: 0,
    topIsExpected: 0,
    expectedCardOffers: 0,
    expectedCardWrongIdentity: 0,
    shownOffers: 0,
    verifiable: 0,
    priceCorrect: 0,
    priceWrong: [],
    inconsistentCards: 0,
    mixed: [],
    cardsTotal: 0,
    first: [],
    total: [],
    withinFirst: 0,
    withinTotal: 0,
    staleUnlabelled: 0,
  };
  for (const r of results) {
    const p = pick(r);
    if (engine ? false : !p.ran || p.error) continue;
    s.ran++;
    const shown = p.shown ?? [];
    const cs = cards(shown);
    const rank = cs.findIndex((c) => c.some((o) => o.identity === null));
    const expected = rank >= 0 ? cs[rank] : [];
    const foundOk = engine
      ? expected.some((o) => o.identity === null && o.priceOk === true)
      : expected.some((o) => o.identity === null);
    if (foundOk) s.found++;
    if (rank === 0) s.topIsExpected++;
    s.expectedCardOffers += expected.length;
    s.expectedCardWrongIdentity += expected.filter((o) => o.identity !== null).length;
    s.shownOffers += shown.length;
    for (const o of shown) {
      if (o.priceOk === null) continue;
      s.verifiable++;
      if (o.priceOk) s.priceCorrect++;
      else s.priceWrong.push({ id: r.id, title: o.title, price: o.price, truth: o.truth });
    }
    s.cardsTotal += cs.length;
    for (const c of cs.filter((c) => new Set(c.map(signature)).size > 1)) {
      s.inconsistentCards++;
      s.mixed.push({ id: r.id, titles: [...new Set(c.map((o) => o.title))] });
    }
    const first = engine ? p.firstPriceMs : p.firstMs;
    if (typeof first === "number") {
      s.first.push(first);
      if (first <= 3000) s.withinFirst++;
    }
    if (typeof p.totalMs === "number") {
      s.total.push(p.totalMs);
      if (p.totalMs <= 12000) s.withinTotal++;
    }
    s.staleUnlabelled += p.staleUnlabelled ?? 0;
  }
  return s;
}

const readable = data.results.filter((r) => !r.unreadable);
const unreadable = data.results.filter((r) => r.unreadable);
const E = stats(readable, (r) => r.engine, true);
const O = stats(readable, (r) => r.old, false);

console.log(
  `Run ${data.ranAt} · ${data.results.length} products (${readable.length} readable today, ${unreadable.length} unreadable) · Tavily credits ${data.tavilyCreditsUsed} · truth pages ${data.truthPagesRead}\n`,
);
console.log("| Measure (31 products sold by a store we may read) | New engine | Old Tavily path |");
console.log("|---|---|---|");
const row = (label: string, e: string, o: string) => console.log(`| ${label} | ${e} | ${o} |`);
row("Ran", `${E.ran}/${E.tests}`, `${O.ran}/${O.tests}`);
row(
  "Expected product found (engine: with a page-matching price)",
  `${E.found}/${E.ran} (${pct(E.found, E.ran)})`,
  `${O.found}/${O.ran} (${pct(O.found, O.ran)})`,
);
row(
  "Expected product is the first card",
  `${E.topIsExpected}/${E.ran}`,
  `${O.topIsExpected}/${O.ran}`,
);
row(
  "Offers in the expected card with the wrong identity",
  `${E.expectedCardWrongIdentity}/${E.expectedCardOffers}`,
  `${O.expectedCardWrongIdentity}/${O.expectedCardOffers}`,
);
row(
  "Cards mixing different products",
  `${E.inconsistentCards}/${E.cardsTotal}`,
  `${O.inconsistentCards}/${O.cardsTotal}`,
);
row(
  "Shown offers whose price could be checked against the store page",
  `${E.verifiable}/${E.shownOffers}`,
  `${O.verifiable}/${O.shownOffers}`,
);
row(
  "…of those, price equals the store page now",
  `${E.priceCorrect}/${E.verifiable} (${pct(E.priceCorrect, E.verifiable)})`,
  `${O.priceCorrect}/${O.verifiable} (${pct(O.priceCorrect, O.verifiable)})`,
);
row(
  "Unlabelled stale prices",
  String(E.staleUnlabelled),
  'n/a (all labelled "Web research · read <time>")',
);
row(
  "First price p50 / p95 / max",
  `${ms(quantile(E.first, 0.5))} / ${ms(quantile(E.first, 0.95))} / ${ms(quantile(E.first, 1))}`,
  `${ms(quantile(O.first, 0.5))} / ${ms(quantile(O.first, 0.95))} / ${ms(quantile(O.first, 1))}`,
);
row(
  "Complete p50 / p95 / max",
  `${ms(quantile(E.total, 0.5))} / ${ms(quantile(E.total, 0.95))} / ${ms(quantile(E.total, 1))}`,
  `${ms(quantile(O.total, 0.5))} / ${ms(quantile(O.total, 0.95))} / ${ms(quantile(O.total, 1))}`,
);
row(
  "First price ≤ 3 s",
  `${E.withinFirst}/${E.first.length}`,
  `${O.withinFirst}/${O.first.length}`,
);
row("Complete ≤ 12 s", `${E.withinTotal}/${E.total.length}`, `${O.withinTotal}/${O.total.length}`);

if (E.priceWrong.length || O.priceWrong.length) {
  console.log("\nPrices that differ from the store page:");
  for (const w of E.priceWrong)
    console.log(`- engine · ${w.id}: ${w.title} $${w.price} vs page $${w.truth}`);
  for (const w of O.priceWrong)
    console.log(`- old · ${w.id}: ${w.title} $${w.price} vs page $${w.truth}`);
}

for (const m of E.mixed)
  console.log(
    `\nEngine card mixing products (${m.id}):\n${m.titles.map((t) => `- ${t}`).join("\n")}`,
  );

console.log("\nUnreadable-only products (no store we may read sells them):\n");
console.log("| Product | Engine | Old Tavily path |");
console.log("|---|---|---|");
for (const r of unreadable) {
  const rows = r.engine.stores ?? {};
  const states = Object.entries(rows)
    .filter(([, st]) => st !== "verified")
    .reduce<Record<string, number>>((a, [, st]) => ({ ...a, [st]: (a[st] ?? 0) + 1 }), {});
  const e = `${(r.engine.shown ?? []).length} prices shown; rows: ${Object.entries(states)
    .map(([k, v]) => `${v} ${k.replace("_", " ")}`)
    .join(", ")}`;
  const oShown = r.old.shown ?? [];
  const oMatch = oShown.filter((o) => o.identity === null);
  const o = r.old.ran
    ? `${oShown.length} prices shown, ${oMatch.length} of the expected product (${[...new Set(oMatch.map((x) => x.store))].join(", ") || "none"}); none verifiable`
    : "not run";
  console.log(`| ${r.query} | ${e} | ${o} |`);
}

console.log("\nPer product:\n");
console.log(
  "| Product | Engine first / complete | Engine prices (correct) | Old first / complete | Old prices (verifiable, correct) |",
);
console.log("|---|---|---|---|---|");
for (const r of readable) {
  const es = r.engine.shown ?? [];
  const os = r.old.shown ?? [];
  console.log(
    `| ${r.query} | ${ms(r.engine.firstPriceMs ?? null)} / ${ms(r.engine.totalMs ?? null)} | ${es.length} (${es.filter((o) => o.identity === null && o.priceOk).length} right product + price) | ${r.old.ran ? `${ms(r.old.firstMs ?? null)} / ${ms(r.old.totalMs ?? null)}` : "—"} | ${os.length} (${os.filter((o) => o.priceOk !== null).length}, ${os.filter((o) => o.priceOk).length}) |`,
  );
}
