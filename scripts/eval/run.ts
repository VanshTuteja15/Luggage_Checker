/* ------------------------------------------------------------------ */
/*  npm run eval [-- --ai]                                             */
/*                                                                     */
/*  Runs the labelled sets (scripts/bench/sets/, real data) through the */
/*  PRODUCTION functions and writes docs/EVAL_REPORT.md + latest.json.  */
/*  Rules always; the local model only with --ai (so routine gates      */
/*  never load a model on the 7 GB laptop). Fails (exit 1) when a       */
/*  must-not-drop number fell > 1 point (or wrong merges rose) without  */
/*  a line under "## Accepted drops" in docs/EVAL_REPORT.md.            */
/* ------------------------------------------------------------------ */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  MemoryAiCache,
  createAiClient,
  matchJudgeTask,
  prescreenTerms,
  quoteEvidence,
  runAiTask,
} from "@/lib/engine/ai";
import { extractAttributes } from "@/lib/engine/extract/attributes";
import { extractPromotion } from "@/lib/engine/extract/promotions";
import { resolveFlags } from "@/lib/engine/flags";
import { matchVerdict, type MatchVerdict } from "@/lib/engine/identity/match";
import { luggagePack as pack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry/seed";
import {
  baseColour,
  normBrand,
  normLine,
  numEq,
  sameSet,
  summarise,
  type FieldScores,
} from "./score";

type Json = Record<string, unknown>;
type Task = {
  n: number;
  metrics: Record<string, number>;
  counts: Record<string, string>;
  allRight: number;
  extra: Json;
  note?: string;
};

const AI = process.argv.includes("--ai");
const REPORT = "docs/EVAL_REPORT.md";
const LATEST = "docs/eval/latest.json";
const items = (name: string) =>
  (JSON.parse(readFileSync(`scripts/bench/sets/${name}.json`, "utf8")) as { items: Json[] }).items;
const houseBrand = (sourceId: unknown) =>
  SOURCE_SEED.find((s) => s.id === sourceId)?.identityQuality.houseBrand ?? null;
const task = (rows: FieldScores[], extra: Json = {}, note?: string): Task => ({
  n: rows.length,
  ...summarise(rows),
  extra,
  ...(note ? { note } : {}),
});

function queries(): Task {
  const rows = items("queries").map((it) => {
    const e = it.expected as Json;
    const p = pack.parseQuery(String(it.query));
    return {
      brand: normBrand(p.brand) === normBrand(e.brand),
      line: e.line === null ? null : sameSet(normLine(p.line), normLine(e.line)),
      sizeClass: (p.sizeClass ?? null) === (e.sizeClass ?? null),
      inches: (p.inches ?? null) === (e.inches ?? null),
      colour: baseColour(p.colour) === baseColour(e.colour),
      maxPrice: numEq(p.maxPrice, e.maxPrice ?? null, 0.5),
      model: String(p.model ?? "") === String(e.model ?? ""),
    };
  });
  return task(
    rows,
    {},
    "type (spinner/duffel/…) isn't produced by the parser yet, so it isn't scored",
  );
}

function titles(): Task {
  const rows = items("titles").map((it) => {
    const e = it.expected as Json;
    const title = String(it.title);
    const brand = pack.brandOf(title) ?? houseBrand(it.source);
    return {
      brand: normBrand(brand) === normBrand(e.brand),
      line:
        e.line === null
          ? null
          : sameSet(
              normLine(pack.lineOf(title, brand).filter((w) => !pack.optionalLineWords.has(w))),
              normLine(e.line),
            ),
      sizeClass: (pack.sizeClassOf(title) ?? null) === (e.sizeClass ?? null),
      inches: (pack.inchesOf(title) ?? null) === (e.inches ?? null),
    };
  });
  return task(rows, {}, "version isn't a parser field yet, so it isn't scored");
}

function attributes(): Task {
  const sorted = (d: number[]) => [...d].sort((a, b) => a - b);
  const rows = items("attributes").map((it) => {
    const e = it.expected as Json;
    const { fields } = extractAttributes(String(it.title), String(it.text));
    const wants = [e.dimsCm, ...((e.dimsAlt as unknown[]) ?? [])].filter(
      Array.isArray,
    ) as number[][];
    const caps = [e.capacityL, ...((e.capacityAlt as number[]) ?? [])].filter(
      (c): c is number => typeof c === "number",
    );
    const w = e.weightKg as number | null;
    return {
      dimsCm:
        fields.dimsCm === null
          ? e.dimsCm === null
          : wants.some((x) =>
              sorted(x).every((v, i) => Math.abs(v - sorted(fields.dimsCm!)[i]) <= 1),
            ),
      capacityL:
        fields.capacityL === null
          ? e.capacityL === null
          : caps.some((c) => Math.abs(c - fields.capacityL!) <= 1),
      weightKg:
        fields.weightKg === null
          ? w === null
          : w !== null && Math.abs(w - fields.weightKg) <= Math.max(0.05, w * 0.03),
      wheels: fields.wheels === (e.wheels ?? null),
      expandable: fields.expandable === (e.expandable ?? null),
    };
  });
  return task(rows);
}

/** Production pair rules (v4 A5, identity/match.ts): SKU, vetoes, key, near match → a person decides. */
function rulesPair(it: Json): MatchVerdict {
  const st = (it.stores as string[]) ?? [];
  const side = (t: string, s: string | undefined) => ({
    title: t,
    sourceId: s ?? null,
    brand: pack.brandOf(t) ?? houseBrand(s),
  });
  return matchVerdict(pack, side(String(it.a), st[0]), side(String(it.b), st[1]));
}

async function pairs(): Promise<Task> {
  const set = items("pairs");
  const client = AI ? createAiClient() : null;
  const flags = { ...resolveFlags(), "ai.enabled": true, "ai.match_judge": true };
  const cache = new MemoryAiCache();
  let wrongMerges = 0;
  let review = 0;
  let aiAgree = 0;
  let aiGrey = 0;
  const rows: FieldScores[] = [];
  for (const it of set) {
    const r = rulesPair(it);
    if ((r.verdict === "same" || r.verdict === "variant") && it.expected === "different")
      wrongMerges++;
    if (r.verdict === "review") {
      review++;
      if (client) {
        const out = await runAiTask(
          matchJudgeTask,
          {
            a: String(it.a),
            b: String(it.b),
            storeA: String((it.stores as string[])[0]),
            storeB: String((it.stores as string[])[1]),
          },
          { flags, client, cache },
        );
        if (out.source === "ai") {
          aiGrey++;
          if (out.value?.verdict === it.expected) aiAgree++;
        }
      }
    }
    rows.push({
      verdict: r.verdict === it.expected,
      sameRecall: it.expected === "same" ? r.verdict === "same" : null,
    });
  }
  return task(
    rows,
    {
      wrongMerges,
      sentToReview: review,
      ...(AI
        ? { aiGreyAnswered: aiGrey, aiGreyAgreesWithLabel: aiAgree, aiModel: client?.model ?? null }
        : {}),
    },
    "a near match goes to the review queue (counted as not right, never merged); the AI judge, when measured, only advises on those",
  );
}

function promos(): Task {
  let predicted = 0;
  let fake = 0;
  const rows = items("promos").map((it) => {
    const e = it.expected as Json;
    const p = extractPromotion(String(it.text));
    if (p.isPromotion) predicted++;
    if (p.isPromotion && e.isPromotion !== true) fake++;
    const k = (v: unknown) =>
      [...new Set(((v as string[]) ?? []).filter((x) => x !== "sale_price"))].sort().join(",");
    const nums = ["percentOff", "amountOff", "salePrice", "wasPrice", "threshold"].every((f) =>
      numEq((p as unknown as Json)[f] ?? null, e[f] ?? null, 0.011),
    );
    return {
      isPromotion: p.isPromotion === e.isPromotion,
      kinds: k(p.kinds) === k(e.kinds),
      numbers: nums,
    };
  });
  return task(rows, {
    predictedPromotions: predicted,
    fakePromotions: fake,
    precision: predicted ? Math.round(((predicted - fake) / predicted) * 1000) / 10 : null,
  });
}

function terms(): Task {
  const rows = items("terms").map((it) => {
    const e = it.expected as Json;
    const r = prescreenTerms(String(it.text));
    return {
      category: r.category === e.category,
      quoteVerbatim: r.quote
        ? quoteEvidence(r.quote, String(it.text)).ok
        : r.category === "none"
          ? null
          : false,
    };
  });
  return task(rows);
}

function commit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  const tasks: Record<string, Task> = {
    queries: queries(),
    titles: titles(),
    attributes: attributes(),
    pairs: await pairs(),
    terms: terms(),
    promos: promos(),
  };
  const result = { runAt: new Date().toISOString(), commit: commit(), ai: AI, tasks };

  const prev = existsSync(LATEST)
    ? (JSON.parse(readFileSync(LATEST, "utf8")) as typeof result)
    : null;
  const oldReport = existsSync(REPORT) ? readFileSync(REPORT, "utf8") : "";
  const accepted = (oldReport.split("## Accepted drops")[1] ?? "")
    .split("\n")
    .map((l) => l.match(/^- `([^`]+)`/)?.[1])
    .filter(Boolean) as string[];
  const drops: string[] = [];
  if (prev) {
    for (const [name, t] of Object.entries(tasks)) {
      const p = prev.tasks[name];
      if (!p) continue;
      const check = (key: string, now: number, before: number) => {
        if (now < before - 1 && !accepted.includes(key)) drops.push(`${key}: ${before} → ${now}`);
      };
      check(`${name}.allRight`, t.allRight, p.allRight);
      for (const [f, v] of Object.entries(t.metrics))
        if (typeof p.metrics[f] === "number") check(`${name}.${f}`, v, p.metrics[f]);
    }
    const wm = Number(tasks.pairs.extra.wrongMerges);
    const pwm = Number(prev.tasks.pairs?.extra?.wrongMerges ?? wm);
    if (wm > pwm && !accepted.includes("pairs.wrongMerges"))
      drops.push(`pairs.wrongMerges: ${pwm} → ${wm}`);
  }

  mkdirSync("docs/eval", { recursive: true });
  writeFileSync(LATEST, JSON.stringify(result, null, 2));
  const lines = [
    "# Eval report",
    "",
    `Run ${result.runAt} at commit \`${result.commit}\`${AI ? " (with the local model)" : " (rules only)"}. Sets: \`scripts/bench/sets/\` (real data, labelled by hand). Command: \`npm run eval${AI ? " -- --ai" : ""}\`.`,
    "",
    "| Task | Items | All fields right | Per field | Notes |",
    "|---|---|---|---|---|",
    ...Object.entries(tasks).map(
      ([name, t]) =>
        `| ${name} | ${t.n} | ${t.n ? `${t.allRight}%` : "—"} | ${
          Object.entries(t.metrics)
            .map(([f, v]) => `${f} ${v}% (${t.counts[f]})`)
            .join(", ") || "—"
        } | ${[t.note, Object.keys(t.extra).length ? JSON.stringify(t.extra) : ""].filter(Boolean).join("; ")} |`,
    ),
    "",
    prev
      ? `Compared with the previous run (${prev.runAt}, \`${prev.commit}\`): ${drops.length ? `**${drops.length} unexplained drop(s)**: ${drops.join("; ")}` : "no metric dropped by more than 1 point."}`
      : "First run: this is the baseline.",
    "",
    "## Accepted drops",
    "",
    "One line per accepted drop: `- \\`task.metric\\`: reason` (kept from the previous report).",
    ...accepted.map(
      (k) => `- \`${k}\`: ${(oldReport.split(`\`${k}\`:`)[1] ?? "").split("\n")[0].trim()}`,
    ),
    "",
  ];
  writeFileSync(REPORT, lines.join("\n"));
  console.log(lines.slice(4, 4 + 2 + Object.keys(tasks).length).join("\n"));
  if (drops.length) {
    console.error(`\nUnexplained drops: ${drops.join("; ")}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
