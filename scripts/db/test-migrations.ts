/* ------------------------------------------------------------------ */
/*  npm run test:db                                                    */
/*                                                                     */
/*  Proves the migrations apply cleanly to a FRESH Postgres, twice     */
/*  (idempotent), on both install paths (000 and 001+002), then checks  */
/*  RLS, the full-text index, append-only evidence and price-range      */
/*  collapsing, and runs the EngineStore contract tests against it.     */
/*                                                                     */
/*  Needs Docker. Uses a throwaway postgres:17-alpine container that is */
/*  removed at the end (pass --keep to leave it running for dev; it is  */
/*  then reachable at postgres://postgres:test@localhost:54329/fresh).  */
/* ------------------------------------------------------------------ */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { registrySeedSql } from "../../src/lib/engine/registry/sql";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";

const CONTAINER = "lt-migrate-test";
const PORT = 54329;
const PASSWORD = "test";
const KEEP = process.argv.includes("--keep");
const G = "\x1b[32m",
  R = "\x1b[31m",
  B = "\x1b[1m",
  X = "\x1b[0m";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? `${G}✓` : `${R}✗`}${X} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

const sql = (file: string) => readFileSync(resolve(file), "utf8");
const url = (db: string) => `postgres://postgres:${PASSWORD}@localhost:${PORT}/${db}`;

function docker(args: string[], quiet = false): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: quiet ? ["ignore", "pipe", "ignore"] : ["ignore", "pipe", "pipe"],
  });
}

async function connect(db: string): Promise<Client> {
  const started = Date.now();
  for (;;) {
    const c = new Client({ connectionString: url(db) });
    try {
      await c.connect();
      return c;
    } catch (err) {
      await c.end().catch(() => undefined);
      if (Date.now() - started > 60_000) throw err;
      await new Promise((r) => setTimeout(r, 750));
    }
  }
}

let inTx = false;

async function expectError(
  c: Client,
  text: string,
  params: unknown[] = [],
): Promise<string | null> {
  if (!inTx) {
    // Outside asRole(): run in a transaction of its own and roll it back.
    await c.query("BEGIN");
    try {
      await c.query(text, params);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      await c.query("ROLLBACK");
    }
  }
  await c.query("SAVEPOINT expect_error");
  try {
    await c.query(text, params);
    await c.query("RELEASE SAVEPOINT expect_error");
    return null;
  } catch (err) {
    await c.query("ROLLBACK TO SAVEPOINT expect_error");
    return err instanceof Error ? err.message : String(err);
  }
}

/** Run `fn` as the given Supabase role / user inside a rolled-back transaction. */
async function asRole<T>(
  c: Client,
  role: "anon" | "authenticated",
  userId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await c.query("BEGIN");
  inTx = true;
  try {
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(userId ? { sub: userId, role } : { role }),
    ]);
    return await fn();
  } finally {
    inTx = false;
    await c.query("ROLLBACK");
  }
}

async function main(): Promise<void> {
  console.log(`\n${B}Migration test${X} (throwaway postgres:17-alpine on :${PORT})`);
  try {
    docker(["rm", "-f", CONTAINER], true);
  } catch {
    /* not running */
  }
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${PASSWORD}`,
    "-p",
    `${PORT}:5432`,
    "postgres:17-alpine",
  ]);

  try {
    const admin = await connect("postgres");
    await admin.query("CREATE DATABASE fresh");
    await admin.query("CREATE DATABASE legacy");
    await admin.end();

    /* ── Path A: fresh install (000 → 003 → 004), applied twice ────── */
    console.log(`\n${B}Fresh install: shim → 000 → 003 → 004 (twice) → seed${X}`);
    const c = await connect("fresh");
    await c.query(sql("supabase/tests/shim.sql"));
    for (const round of [1, 2]) {
      for (const f of [
        "000_complete_setup.sql",
        "003_search_cache_and_quota.sql",
        "004_price_engine.sql",
        "005_scheduler_alerts.sql",
        "006_client_ready.sql",
      ]) {
        try {
          await c.query(sql(`supabase/migrations/${f}`));
          check(`round ${round}: ${f} applies`, true);
        } catch (err) {
          check(
            `round ${round}: ${f} applies`,
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
    await c.query(registrySeedSql(SOURCE_SEED));
    await c.query(registrySeedSql(SOURCE_SEED));
    const { rows: srcCount } = await c.query("SELECT count(*)::int AS n FROM sources");
    check(
      `seed loads ${SOURCE_SEED.length} sources (and re-seeding is idempotent)`,
      srcCount[0].n === SOURCE_SEED.length,
      `got ${srcCount[0].n}`,
    );
    const { rows: flagCount } = await c.query("SELECT count(*)::int AS n FROM feature_flags");
    check("default feature flags seeded", flagCount[0].n >= 10, `got ${flagCount[0].n}`);

    console.log(`\n${B}Schema${X}`);
    const tables = [
      "app_admins",
      "feature_flags",
      "sources",
      "catalog_products",
      "catalog_variants",
      "catalog_identifiers",
      "listings",
      "research_sessions",
      "session_events",
      "fetch_attempts",
      "observations",
      "price_ranges",
      "identity_review",
      "feed_imports",
    ];
    const { rows: rls } = await c.query(
      "SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r' AND relname = ANY($1)",
      [tables],
    );
    check(
      `all ${tables.length} engine tables exist`,
      rls.length === tables.length,
      `found ${rls.length}`,
    );
    check(
      "RLS enabled on every engine table",
      rls.every((r) => r.relrowsecurity),
      rls
        .filter((r) => !r.relrowsecurity)
        .map((r) => r.relname)
        .join(", "),
    );
    const { rows: oldRls } = await c.query(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relkind = 'r' AND NOT relrowsecurity",
    );
    check(
      "no public table without RLS (old and new)",
      oldRls.length === 0,
      oldRls.map((r) => r.relname).join(", "),
    );
    const { rows: gin } = await c.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_listings_search'",
    );
    check(
      "full-text GIN index on listings",
      /USING gin \(search_tsv\)/i.test(gin[0]?.indexdef ?? ""),
    );
    const { rows: pub } = await c.query(
      "SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'session_events'",
    );
    check("session_events published to Realtime", pub.length === 1);

    console.log(`\n${B}Behaviour${X}`);
    const { rows: users } = await c.query(
      "INSERT INTO auth.users (email) VALUES ('a@example.test'), ('b@example.test'), ('admin@example.test') RETURNING id",
    );
    const [userA, userB, adminUser] = users.map((u) => u.id as string);
    await c.query("INSERT INTO app_admins (user_id) VALUES ($1)", [adminUser]);

    const { rows: lst } = await c.query(
      `INSERT INTO listings (source_id, url, title, brand, size_class, identifiers, discovered_via) VALUES
        ('canadaluggagedepot', 'https://www.canadaluggagedepot.ca/products/outline-pro-medium', 'Samsonite Outline Pro Medium Spinner', 'Samsonite', 'medium', '[{"kind":"gtin","value":"00043202927614"}]', 'sitemap'),
        ('canadaluggagedepot', 'https://www.canadaluggagedepot.ca/products/omni-large', 'Samsonite Omni 3.0 Large Spinner', 'Samsonite', 'large', '[]', 'sitemap')
       RETURNING id`,
    );
    const listingId = lst[0].id as string;
    const { rows: fts } = await c.query(
      "SELECT title FROM listings WHERE search_tsv @@ to_tsquery('simple', 'samsonite & outline & pro')",
    );
    check(
      "full-text search finds the listing by brand + line",
      fts.length === 1 && /Outline Pro/.test(fts[0].title),
    );
    const { rows: ftsGtin } = await c.query(
      "SELECT 1 FROM listings WHERE search_tsv @@ to_tsquery('simple', '00043202927614')",
    );
    check("full-text search finds the listing by GTIN", ftsGtin.length === 1);
    const { rows: ftsVer } = await c.query(
      "SELECT 1 FROM listings WHERE search_tsv @@ to_tsquery('simple', 'omni & 3.0')",
    );
    check("version numbers are searchable (Omni 3.0)", ftsVer.length === 1);

    const obs = (price: number | null, at: string, outcome = "accepted", currency = "CAD") =>
      c.query(
        `INSERT INTO observations (listing_id, source_id, adapter, price, currency, availability, outcome, confidence, extractor_version, validator_version, fetched_at)
         VALUES ($1, 'canadaluggagedepot', 'shopify_product_json', $2, $3, 'in_stock', $4, 0.95, 'x', 'y', $5) RETURNING id`,
        [listingId, price, currency, outcome, at],
      );
    await obs(324.95, "2026-10-01T10:00:00Z");
    await obs(324.95, "2026-10-02T10:00:00Z");
    await obs(324.95, "2026-10-03T10:00:00Z");
    await obs(299.95, "2026-10-04T10:00:00Z");
    await obs(324.95, "2026-09-30T10:00:00Z"); // late, older reading
    const { rows: ranges } = await c.query(
      "SELECT price, observation_count FROM price_ranges WHERE listing_id = $1 ORDER BY first_seen_at",
      [listingId],
    );
    check(
      "unchanged prices collapse into one range; a change opens another; late readings don't reopen history",
      ranges.length === 2 &&
        Number(ranges[0].price) === 324.95 &&
        ranges[0].observation_count === 3 &&
        Number(ranges[1].price) === 299.95,
      JSON.stringify(ranges),
    );

    check(
      "observations are append-only (UPDATE refused)",
      (await expectError(c, "UPDATE observations SET price = 1")) !== null,
    );
    check(
      "fetch_attempts are append-only",
      (await (async () => {
        await c.query(
          "INSERT INTO fetch_attempts (source_id, adapter, url, outcome) VALUES ('samsonite-ca', 'html_structured', 'https://www.samsonite.ca/x', 'challenge')",
        );
        return expectError(c, "UPDATE fetch_attempts SET outcome = 'ok'");
      })()) !== null,
    );
    check(
      "a shown (accepted) price must be CAD",
      (await expectError(
        c,
        "INSERT INTO observations (listing_id, source_id, adapter, price, currency, outcome, confidence, extractor_version, validator_version, fetched_at) VALUES ($1, 'canadaluggagedepot', 'x', 10, 'USD', 'accepted', 0.9, 'x', 'y', now())",
        [listingId],
      )) !== null,
    );
    check(
      "a rejected USD reading is kept as evidence",
      (await expectError(
        c,
        "INSERT INTO observations (listing_id, source_id, adapter, price, currency, outcome, confidence, extractor_version, validator_version, fetched_at) VALUES ($1, 'canadaluggagedepot', 'x', 10, 'USD', 'rejected', 0.1, 'x', 'y', now())",
        [listingId],
      )) === null,
    );
    check(
      "an unknown source can't be referenced",
      (await expectError(
        c,
        "INSERT INTO listings (source_id, url, title, discovered_via) VALUES ('nope', 'https://x.ca/p', 't', 'seed')",
      )) !== null,
    );
    check(
      "listing URLs must be https (or feed:/manual:)",
      (await expectError(
        c,
        "INSERT INTO listings (source_id, url, title, discovered_via) VALUES ('delsey-ca', 'http://delsey.ca/p', 't', 'seed')",
      )) !== null,
    );

    const { rows: sess } = await c.query(
      "INSERT INTO research_sessions (user_id, query) VALUES ($1, 'outline pro'), ($2, 'omni') RETURNING id, user_id",
      [userA, userB],
    );
    const sessA = sess.find((s) => s.user_id === userA)!.id as string;
    await c.query(
      "INSERT INTO session_events (session_id, seq, type) VALUES ($1, 1, 'session_started')",
      [sessA],
    );

    console.log(`\n${B}Row Level Security${X}`);
    await asRole(c, "authenticated", userA, async () => {
      const { rows } = await c.query("SELECT user_id FROM research_sessions");
      check(
        "a user sees only their own research sessions",
        rows.length === 1 && rows[0].user_id === userA,
        JSON.stringify(rows),
      );
      const { rows: ev } = await c.query("SELECT 1 FROM session_events");
      check("a user sees their own session events (Realtime check)", ev.length === 1);
      check(
        "a user can start their own session",
        (await expectError(c, "INSERT INTO research_sessions (user_id, query) VALUES ($1, 'x')", [
          userA,
        ])) === null,
      );
      check(
        "a user can't start a session as someone else",
        (await expectError(c, "INSERT INTO research_sessions (user_id, query) VALUES ($1, 'x')", [
          userB,
        ])) !== null,
      );
      check(
        "a user can't change a session's status",
        (await c.query("UPDATE research_sessions SET status = 'done'")).rowCount === 0,
      );
      const { rows: s } = await c.query("SELECT count(*)::int AS n FROM sources");
      check("signed-in users can read the registry", s[0].n === SOURCE_SEED.length);
      check(
        "non-admins can't edit the registry",
        (await expectError(
          c,
          "INSERT INTO sources (id, name, retailer_label, category, live_class, permission) VALUES ('evil', 'e', 'e', 'marketplace', 'none', 'forbidden')",
        )) !== null,
      );
      check(
        "non-admins can't flip feature flags",
        (await c.query("UPDATE feature_flags SET enabled = true")).rowCount === 0,
      );
      const { rows: fa } = await c.query("SELECT 1 FROM fetch_attempts");
      check("non-admins can't read fetch attempts", fa.length === 0);
      check(
        "non-admins can't write observations",
        (await expectError(
          c,
          "INSERT INTO observations (listing_id, source_id, adapter, price, currency, outcome, confidence, extractor_version, validator_version, fetched_at) VALUES ($1, 'canadaluggagedepot', 'x', 1, 'CAD', 'accepted', 1, 'x', 'y', now())",
          [listingId],
        )) !== null,
      );
      check(
        "non-admins can't read source_health",
        (await expectError(c, "SELECT 1 FROM source_health")) !== null,
      );
    });
    await asRole(c, "authenticated", userB, async () => {
      const { rows } = await c.query("SELECT 1 FROM session_events");
      check("another user can't see those events", rows.length === 0);
    });
    await asRole(c, "authenticated", adminUser, async () => {
      check(
        "admins can flip feature flags",
        (await c.query("UPDATE feature_flags SET enabled = true WHERE key = 'discovery.tavily'"))
          .rowCount === 1,
      );
      const { rows } = await c.query("SELECT 1 FROM fetch_attempts");
      check("admins can read fetch attempts", rows.length >= 1);
    });
    await asRole(c, "anon", null, async () => {
      check(
        "the anon key can't read engine data",
        (await expectError(c, "SELECT 1 FROM sources")) !== null,
      );
    });

    console.log(`\n${B}Client-ready (006)${X}`);
    {
      const { rows: pr } = await c.query(
        "INSERT INTO products (slug, name, brand) VALUES ('t006-bag', 'Test bag', 'Test') RETURNING id",
      );
      const productId = pr[0].id as string;
      await c.query(
        "INSERT INTO retailer_offers (product_id, retailer, price, availability) VALUES ($1, 'Store A', 100, 'out_of_stock')",
        [productId],
      );
      check(
        "retailer_offers.availability accepts in_stock / out_of_stock / unknown / NULL",
        (await expectError(
          c,
          "INSERT INTO retailer_offers (product_id, retailer, price, availability) VALUES ($1, 'Store B', 100, NULL)",
          [productId],
        )) === null,
      );
      check(
        "retailer_offers.availability refuses anything else",
        (await expectError(
          c,
          "INSERT INTO retailer_offers (product_id, retailer, price, availability) VALUES ($1, 'Store C', 100, 'maybe')",
          [productId],
        )) !== null,
      );
    }

    console.log(`\n${B}Retention${X}`);
    check(
      "retention refuses to keep under 30 days",
      (await expectError(c, "SELECT engine_retention(7)")) !== null,
    );
    const { rows: ret } = await c.query("SELECT engine_retention(180) AS r");
    check("retention runs", typeof ret[0].r === "object");
    await c.end();

    /* ── Path B: legacy install (001 → 002 → 003 → 004) ───────────── */
    console.log(`\n${B}Legacy install: shim → 001 → 002 → 003 → 004${X}`);
    const l = await connect("legacy");
    await l.query(sql("supabase/tests/shim.sql"));
    for (const f of [
      "001_initial_schema.sql",
      "002_live_search_and_alerts.sql",
      "003_search_cache_and_quota.sql",
      "004_price_engine.sql",
      "005_scheduler_alerts.sql",
      "006_client_ready.sql",
    ]) {
      try {
        await l.query(sql(`supabase/migrations/${f}`));
        check(`${f} applies`, true);
      } catch (err) {
        check(`${f} applies`, false, err instanceof Error ? err.message : String(err));
      }
    }
    await l.end();

    /* ── EngineStore contract against real Postgres ────────────────── */
    console.log(`\n${B}EngineStore contract (PgEngineStore)${X}`);
    const vitest = spawnSync("npx", ["vitest", "run", "tests/engine/store.test.ts"], {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ENGINE_TEST_DATABASE_URL: url("fresh") },
    });
    check("store contract tests pass on Postgres", vitest.status === 0);
  } finally {
    if (KEEP) console.log(`\nContainer left running: ${url("fresh")}`);
    else {
      try {
        docker(["rm", "-f", CONTAINER], true);
      } catch {
        /* already gone */
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  try {
    if (!KEEP) execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  process.exit(1);
});
