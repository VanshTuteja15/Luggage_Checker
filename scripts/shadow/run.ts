/* ------------------------------------------------------------------ */
/*  npm run shadow:run -- [--engine-only] [--only=id,id] [--max-credits=160]
/*                                                                     */
/*  P8 shadow comparison. For every product in testset.json:            */
/*   1. a real engine research session (local index, PoliteFetcher);    */
/*   2. the old Tavily path (src/lib/search `search()`), metered through */
/*      the app's own provider_usage counter and its monthly cap, with   */
/*      a per-run credit ceiling on top;                                 */
/*   3. ground truth: each shown offer on a store we may read is re-read */
/*      from the product page's own structured data (html_structured,   */
/*      a different endpoint and extractor than the engine's product    */
/*      JSON), so "price correct" means "what the store shows now".     */
/*  Writes docs/shadow/results.json; docs/SHADOW_REPORT.md is written   */
/*  from it. Local dev database only (DATABASE_URL on 127.0.0.1).       */
/* ------------------------------------------------------------------ */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADAPTERS } from "../../src/lib/engine/adapters";
import { canonicalUrl } from "../../src/lib/engine/adapters/base";
import { engineConfig } from "../../src/lib/engine/config";
import { luggagePack } from "../../src/lib/engine/packs/luggage";
import { createRuntime, type EngineRuntime } from "../../src/lib/engine/recorder";
import { sourceForUrl, SOURCE_SEED } from "../../src/lib/engine/registry";
import { createSession } from "../../src/lib/engine/research/api";
import { ResearchManager } from "../../src/lib/engine/research/manager";
import { PgEngineStore } from "../../src/lib/engine/store/pg";
import type { ResearchAnswer } from "../../src/lib/engine/types";

/* ── inputs ─────────────────────────────────────────────────────────── */

type Expect = { brand: string; size: string; line: string[]; notLine?: string[]; inches?: number };
type TestProduct = {
  id: string;
  query: string;
  expect: Expect;
  sources: string[];
  evidence?: string;
  unreadable?: boolean;
  note?: string;
};

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Read .env.local into process.env (values never printed). */
function loadEnvLocal(): void {
  const file = resolve(".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

/* ── identity and truth ─────────────────────────────────────────────── */

const READABLE = new Set(["canadaluggagedepot", "delsey-ca"]);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[’`]/g, "'")
      .split(/[^a-z0-9.']+/)
      .map((w) => w.replace(/^[.']+|[.']+$/g, ""))
      .filter(Boolean),
  );

/** Does a shown title belong to the expected product? (brand, size class, line, inches) */
function identityCheck(title: string, url: string, exp: Expect): string | null {
  const src = safeSource(url);
  const brand = luggagePack.brandOf(title) ?? src?.identityQuality.houseBrand ?? null;
  if (brand !== exp.brand) return `brand ${brand ?? "unknown"}`;
  const size = luggagePack.sizeClassOf(title);
  if (size !== exp.size) return `size ${size ?? "unknown"}`;
  const w = words(title);
  const missing = exp.line.filter((x) => !w.has(x));
  if (missing.length) return `missing "${missing.join(" ")}"`;
  const extra = (exp.notLine ?? []).filter((x) => w.has(x));
  if (extra.length) return `has "${extra.join(" ")}"`;
  const inches = luggagePack.inchesOf(title);
  if (exp.inches && inches && inches !== exp.inches) return `${inches} in, not ${exp.inches}`;
  return null;
}

function safeSource(url: string) {
  try {
    return sourceForUrl(url);
  } catch {
    return null;
  }
}

type Truth = { price: number | null; how: string };

class TruthReader {
  private pages = new Map<
    string,
    Promise<{ status: string; offers: { url: string; price: number | null }[] }>
  >();
  reads = 0;
  constructor(private rt: EngineRuntime) {}

  async truth(url: string): Promise<Truth> {
    const source = safeSource(url);
    if (!source || !READABLE.has(source.id)) return { price: null, how: "store not readable" };
    const page = canonicalUrl(url);
    const variant = new URL(url).searchParams.get("variant");
    let p = this.pages.get(page);
    if (!p) {
      this.reads++;
      p = ADAPTERS.html_structured
        .verify(
          {
            source,
            fetcher: this.rt.fetcher,
            config: this.rt.config,
            pack: luggagePack,
            now: Date.now,
          },
          { url: page, externalId: null, identifiers: [], title: "", brand: null },
        )
        .then((r) => ({
          status: r.status,
          offers: r.offers.map((o) => ({ url: o.url, price: o.price })),
        }));
      this.pages.set(page, p);
    }
    const r = await p;
    if (r.status !== "ok") return { price: null, how: `page ${r.status}` };
    if (variant) {
      const o = r.offers.find((x) => {
        try {
          return new URL(x.url).searchParams.get("variant") === variant;
        } catch {
          return false;
        }
      });
      if (o?.price != null) return { price: o.price, how: "variant on page" };
    }
    const prices = [
      ...new Set(r.offers.map((o) => o.price).filter((x): x is number => x !== null)),
    ];
    if (prices.length === 1) return { price: prices[0], how: "page price" };
    return { price: null, how: prices.length ? "several prices on page" : "no price on page" };
  }
}

/* ── one shown offer, evaluated ─────────────────────────────────────── */

type ShownOffer = {
  card: number;
  store: string;
  url: string;
  title: string;
  price: number;
  label: string;
  identity: string | null; // null = correct
  truth: number | null;
  truthHow: string;
  priceOk: boolean | null; // null = no truth available
  readAgoMs: number | null; // engine live offers: read this long before the session began
};

async function evaluate(
  cards: {
    offers: {
      url: string;
      title: string;
      price: number;
      label: string;
      store: string;
      readAgoMs?: number | null;
    }[];
  }[],
  exp: Expect,
  truth: TruthReader,
  maxPages: number,
): Promise<ShownOffer[]> {
  const out: ShownOffer[] = [];
  for (const [i, c] of cards.entries()) {
    for (const o of c.offers) {
      const readable = READABLE.has(safeSource(o.url)?.id ?? "");
      const t: Truth =
        readable && truth.reads < maxPages
          ? await truth.truth(o.url)
          : { price: null, how: readable ? "read budget" : "store not readable" };
      out.push({
        card: i,
        store: o.store,
        url: o.url,
        title: o.title,
        price: o.price,
        label: o.label,
        identity: identityCheck(o.title, o.url, exp),
        truth: t.price,
        truthHow: t.how,
        priceOk: t.price === null ? null : Math.abs(t.price - o.price) < 0.005,
        readAgoMs: o.readAgoMs ?? null,
      });
    }
  }
  return out;
}

/* ── main ───────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url || !/@(localhost|127\.0\.0\.1)[:/]/.test(url))
    throw new Error("set DATABASE_URL to the local dev database (npm run db:dev -- up)");
  const set = JSON.parse(readFileSync(resolve("scripts/shadow/testset.json"), "utf8")) as {
    version: string;
    products: TestProduct[];
  };
  const only = arg("only")?.split(",");
  const products = set.products.filter((p) => !only || only.includes(p.id));
  const engineOnly = flag("engine-only");
  const maxCredits = Number(arg("max-credits") ?? 160);

  const store = new PgEngineStore(url, 4);
  await store.warm(4);
  const { rows } = await store.pool.query<{ id: string }>(
    `INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-0000005ad0c0', 'shadow-run@localhost.test')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
  );
  const userId = rows[0].id;
  const rt = createRuntime(store);
  rt.recorder.start();
  const manager = new ResearchManager(rt, luggagePack, { maxConcurrent: 1 });
  const truth = new TruthReader(rt);

  // Old path: the app's own search(), metered against provider_usage.
  let db: SupabaseClient | undefined;
  let search: typeof import("../../src/lib/search").search | null = null;
  let budgetNote = "not run (--engine-only)";
  if (!engineOnly) {
    const lib = await import("../../src/lib/search");
    if (!lib.providerConfigured("tavily")) budgetNote = "not run: TAVILY_API_KEY not set";
    else {
      if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
        db = createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL,
          process.env.SUPABASE_SERVICE_ROLE_KEY,
          {
            auth: { persistSession: false },
          },
        );
      const budget = db ? await lib.getBudget(db, "tavily") : null;
      const need = Math.min(maxCredits, products.length * 5);
      if (budget && budget.remaining < need + 20)
        budgetNote = `not run: only ${budget.remaining} Tavily credits left under the app's cap (needs ~${need})`;
      else {
        search = lib.search;
        budgetNote = budget
          ? `Tavily ${budget.used}/${budget.limit} credits used this month before the run`
          : "Tavily budget unknown (no provider_usage table); per-run ceiling applies";
      }
    }
  }
  console.log(`shadow run · ${products.length} products · engine UA ${rt.fetcher.userAgent}`);
  console.log(`old path: ${budgetNote}\n`);

  const results = [];
  let creditsUsed = 0;
  for (const p of products) {
    /* engine */
    const created = await createSession(
      store,
      userId,
      { query: p.query },
      engineConfig(),
      "inline",
    );
    if (!created.ok) throw new Error(created.error);
    const answer: ResearchAnswer | null = await manager.start(created.session.id);
    if (!answer) throw new Error(`no answer for ${p.id}`);
    const sessionStart = Date.parse(answer.startedAt);
    const engineCards = answer.products.map((c) => ({
      name: c.name,
      offers: c.offers.map((o) => ({
        url: o.url,
        title: o.title,
        price: o.price,
        store: o.sourceId,
        label: o.freshness.kind,
        // "Verified live" must be a read made for this request, or shared from
        // another request inside the single-flight window (MASTER_PROMPT §2).
        readAgoMs:
          o.freshness.kind === "live" ? sessionStart - Date.parse(o.freshness.fetchedAt) : null,
        staleUnlabelled:
          o.freshness.kind === "live" &&
          Date.parse(o.freshness.fetchedAt) < sessionStart - rt.config.singleFlightMs,
      })),
    }));
    const engineShown = await evaluate(engineCards, p.expect, truth, truth.reads + 15);
    const engineRank = engineCards.findIndex((c) =>
      c.offers.some((o) => identityCheck(o.title, o.url, p.expect) === null),
    );

    /* old path */
    let old: Record<string, unknown> = { ran: false, reason: budgetNote };
    if (search && creditsUsed < maxCredits) {
      const t0 = Date.now();
      let firstMs: number | null = null;
      try {
        const resp = await search(p.query, {
          db,
          bypassCache: true,
          onPartial: () => {
            firstMs ??= Date.now() - t0;
          },
        });
        const totalMs = Date.now() - t0;
        creditsUsed += resp.creditsUsed ?? 0;
        const oldCards = resp.products.map((c) => ({
          name: c.name,
          offers: c.offers.map((o) => ({
            url: o.url,
            title: o.title,
            price: o.price,
            store: safeSource(o.url)?.id ?? o.retailer,
            label: "web research",
          })),
        }));
        const oldShown = await evaluate(oldCards, p.expect, truth, truth.reads + 15);
        old = {
          ran: true,
          firstMs: firstMs ?? totalMs,
          totalMs,
          credits: resp.creditsUsed ?? 0,
          cards: oldCards.map((c) => c.name),
          expectedRank: oldCards.findIndex((c) =>
            c.offers.some((o) => identityCheck(o.title, o.url, p.expect) === null),
          ),
          shown: oldShown,
          alsoCheck: (resp.alsoCheck ?? []).length,
          warnings: resp.warnings,
        };
      } catch (err) {
        old = {
          ran: true,
          error: err instanceof Error ? err.message : String(err),
          totalMs: Date.now() - t0,
        };
      }
    } else if (search)
      old = { ran: false, reason: `per-run ceiling of ${maxCredits} credits reached` };

    const r = {
      id: p.id,
      query: p.query,
      unreadable: !!p.unreadable,
      expectedSources: p.sources,
      engine: {
        firstPriceMs: answer.firstPriceMs,
        totalMs: answer.totalMs,
        deadlineHit: answer.deadlineHit,
        cards: engineCards.map((c) => c.name),
        expectedRank: engineRank,
        staleUnlabelled: engineCards.flatMap((c) => c.offers).filter((o) => o.staleUnlabelled)
          .length,
        stores: Object.fromEntries(answer.stores.map((s) => [s.sourceId, s.state])),
        shown: engineShown,
      },
      old,
    };
    results.push(r);
    const eOk = engineShown.filter((o) => o.identity === null && o.priceOk === true).length;
    const oShown = (old.shown as ShownOffer[] | undefined) ?? [];
    console.log(
      `${p.id.padEnd(30)} engine ${String(answer.firstPriceMs ?? "—").padStart(5)} / ${String(answer.totalMs).padStart(5)} ms, ${eOk}/${engineShown.length} correct` +
        (old.ran
          ? ` · old ${String(old.totalMs).padStart(5)} ms, ${oShown.length} offers, ${old.credits ?? 0} cr${old.error ? `, error: ${old.error}` : ""}`
          : ""),
    );
  }

  await rt.recorder.stop();
  await store.close();
  mkdirSync(resolve("docs/shadow"), { recursive: true });
  const out = {
    ranAt: new Date().toISOString(),
    testset: set.version,
    seedSources: SOURCE_SEED.length,
    oldPath: budgetNote,
    tavilyCreditsUsed: creditsUsed,
    truthPagesRead: truth.reads,
    results,
  };
  writeFileSync(resolve("docs/shadow/results.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(
    `\nwrote docs/shadow/results.json · Tavily credits used ${creditsUsed} · truth pages read ${truth.reads}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
