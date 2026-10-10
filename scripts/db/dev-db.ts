/* ------------------------------------------------------------------ */
/*  npm run db:dev -- up     start a local Postgres for development     */
/*  npm run db:dev -- down   remove it                                  */
/*                                                                     */
/*  A persistent Docker container (lt-dev-db, port 54331) with the       */
/*  Supabase shim, the migrations and the registry seed. Point the app   */
/*  or the worker at it with                                            */
/*    DATABASE_URL=postgres://postgres:dev@127.0.0.1:54331/postgres      */
/*  Never used in production; the real database is Supabase.            */
/* ------------------------------------------------------------------ */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { registrySeedSql } from "../../src/lib/engine/registry/sql";
import { SOURCE_SEED } from "../../src/lib/engine/registry/seed";

const CONTAINER = "lt-dev-db";
const PORT = 54331;
// 127.0.0.1, not localhost: on Windows "localhost" tries IPv6 first and each
// new connection paid ~1 s for it in the P4 measurement.
const URL_ = `postgres://postgres:dev@127.0.0.1:${PORT}/postgres`;

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

async function up(): Promise<void> {
  const running = execFileSync("docker", ["ps", "-q", "-f", `name=^${CONTAINER}$`], {
    encoding: "utf8",
  }).trim();
  const exists = execFileSync("docker", ["ps", "-aq", "-f", `name=^${CONTAINER}$`], {
    encoding: "utf8",
  }).trim();
  if (!running && exists) {
    // Left stopped by an earlier session (e.g. Docker Desktop restarted): reuse it.
    execFileSync("docker", ["start", CONTAINER], { stdio: ["ignore", "ignore", "inherit"] });
  } else if (!running) {
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        CONTAINER,
        "-e",
        "POSTGRES_PASSWORD=dev",
        "-p",
        `${PORT}:5432`,
        "postgres:17-alpine",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  const c = await connect();
  await c.query(readFileSync(resolve("supabase/tests/shim.sql"), "utf8"));
  const migrations = readdirSync(resolve("supabase/migrations"))
    .filter((f) => /^\d{3}_.*\.sql$/.test(f) && (f.startsWith("000") || Number(f.slice(0, 3)) >= 3))
    .sort();
  for (const f of migrations)
    await c.query(readFileSync(resolve("supabase/migrations", f), "utf8"));
  await c.query(registrySeedSql(SOURCE_SEED));
  await c.end();
  console.log(`dev database ready: DATABASE_URL=${URL_}`);
}

function down(): void {
  try {
    execFileSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
    console.log("dev database removed");
  } catch {
    console.log("no dev database running");
  }
}

const cmd = process.argv[2] ?? "up";
(cmd === "down" ? Promise.resolve(down()) : up()).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
