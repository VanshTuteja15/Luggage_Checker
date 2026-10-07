/* ------------------------------------------------------------------ */
/*  npm run db:seed            — write supabase/seed/sources.sql       */
/*  npm run db:seed -- --apply — also run it against DATABASE_URL      */
/*                                                                     */
/*  The SQL is idempotent: re-seeding updates registry facts but keeps */
/*  what admins control (enabled flags, circuit breakers, flag values). */
/* ------------------------------------------------------------------ */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { registrySeedSql } from "../../src/lib/engine/registry/sql";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";
import { poolConfig } from "../../src/lib/engine/store/pg";

function loadEnv(): void {
  const p = resolve(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    if (!(k in process.env)) process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const sql = registrySeedSql(SOURCE_SEED);
  const out = resolve("supabase/seed/sources.sql");
  mkdirSync(resolve("supabase/seed"), { recursive: true });
  writeFileSync(out, sql);
  console.log(`Wrote ${out} (${SOURCE_SEED.length} sources).`);

  if (!process.argv.includes("--apply")) {
    console.log("Paste it into the Supabase SQL Editor after migration 004, or re-run with --apply and DATABASE_URL set.");
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set: nothing applied.");
    process.exit(1);
  }
  const pool = new Pool(poolConfig(url, 1));
  try {
    await pool.query(sql);
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM sources");
    console.log(`Applied. sources table now has ${rows[0].n} rows.`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
