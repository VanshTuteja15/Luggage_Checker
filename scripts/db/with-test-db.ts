/* ------------------------------------------------------------------ */
/*  node scripts/run-ts.mjs scripts/db/with-test-db.ts -- <command…>   */
/*                                                                     */
/*  Starts a throwaway postgres:17-alpine, applies the Supabase shim,   */
/*  the migrations and the registry seed, runs <command> with           */
/*  ENGINE_TEST_DATABASE_URL / WORKER_TEST_DATABASE_URL / DATABASE_URL  */
/*  pointing at it, then removes the container. Exit code = command's.  */
/* ------------------------------------------------------------------ */

import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { registrySeedSql } from "../../src/lib/engine/registry/sql";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";

const CONTAINER = "lt-test-db";
const PORT = 54330;
const URL_ = `postgres://postgres:test@localhost:${PORT}/postgres`;

async function connect(): Promise<Client> {
  const started = Date.now();
  for (;;) {
    const c = new Client({ connectionString: URL_ });
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

function cleanup(): void {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  } catch {
    /* not running */
  }
}

async function main(): Promise<void> {
  const sep = process.argv.indexOf("--");
  const cmd = sep >= 0 ? process.argv.slice(sep + 1) : [];
  if (cmd.length === 0) {
    console.error("usage: with-test-db.ts -- <command> [args…]");
    process.exit(2);
  }
  cleanup();
  execFileSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-e", "POSTGRES_PASSWORD=test", "-p", `${PORT}:5432`, "postgres:17-alpine"], { stdio: "ignore" });
  let status = 1;
  try {
    const c = await connect();
    await c.query(readFileSync(resolve("supabase/tests/shim.sql"), "utf8"));
    // Fresh-install path: 000, then every numbered migration from 003 up.
    const migrations = readdirSync(resolve("supabase/migrations"))
      .filter((f) => /^\d{3}_.*\.sql$/.test(f) && (f.startsWith("000") || Number(f.slice(0, 3)) >= 3))
      .sort();
    for (const f of migrations) await c.query(readFileSync(resolve("supabase/migrations", f), "utf8"));
    await c.query(registrySeedSql(SOURCE_SEED));
    await c.end();
    console.log(`test database ready on :${PORT}; running: ${cmd.join(" ")}`);
    const run = spawnSync(cmd[0], cmd.slice(1), {
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, ENGINE_TEST_DATABASE_URL: URL_, WORKER_TEST_DATABASE_URL: URL_ },
    });
    status = run.status ?? 1;
  } finally {
    cleanup();
  }
  process.exit(status);
}

main().catch((err: unknown) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
