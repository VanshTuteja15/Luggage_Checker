/* ------------------------------------------------------------------ */
/*  npm run e2e:auth                                                   */
/*                                                                     */
/*  A stand-in for Supabase Auth on 127.0.0.1, for checking the app in */
/*  a real browser against the LOCAL dev database only (MASTER_PROMPT  */
/*  V2 §11). It answers the four auth calls the app makes (password    */
/*  sign-in, refresh, "who is this token", sign-out) for one local     */
/*  test user, and seeds that user in the local database with a few    */
/*  tracked products the engine already has prices for.                */
/*                                                                     */
/*  Run the app against it:                                            */
/*    NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54398                  */
/*    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=local-e2e                   */
/*    DATABASE_URL=postgres://postgres:dev@127.0.0.1:54331/postgres    */
/*    EMAIL_PROVIDER=smtp  (unset SMTP_*: nothing can be sent)         */
/*  and sign in as e2e-owner@localhost.test / local-e2e-password.      */
/*                                                                     */
/*  Never a production tool: it refuses any database but 127.0.0.1.    */
/*  Pages that read through Supabase's REST API (not the engine        */
/*  database) show their "couldn't load" state under this stand-in.    */
/* ------------------------------------------------------------------ */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Pool, types as pgTypes } from "pg";

const PORT = Number(process.env.E2E_AUTH_PORT ?? 54398);
const USER_ID = "00000000-0000-4000-8000-0000000e2e01";
const EMAIL = "e2e-owner@localhost.test";
const PASSWORD = "local-e2e-password";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");

function token(): { access_token: string; expires_at: number } {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = { sub: USER_ID, email: EMAIL, role: "authenticated", aud: "authenticated", exp };
  return {
    access_token: `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.local`,
    expires_at: exp,
  };
}

const user = {
  id: USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: EMAIL,
  email_confirmed_at: "2026-10-01T00:00:00Z",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-10-01T00:00:00Z",
};

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function session() {
  const t = token();
  return { ...t, token_type: "bearer", expires_in: 3600, refresh_token: "local-refresh", user };
}

async function seed(url: string): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    await pool.query(
      "INSERT INTO auth.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email",
      [USER_ID, EMAIL],
    );
    await pool.query(
      "INSERT INTO app_admins (user_id, note) VALUES ($1, 'local e2e owner') ON CONFLICT (user_id) DO NOTHING",
      [USER_ID],
    );
    // Products the local engine has real readings for (from engine:research runs).
    const bags = [
      [
        "e2e-paralux-medium",
        "Samsonite Paralux Hardside Spinner Medium",
        "Samsonite",
        "Paralux",
        "Black",
        440,
        "https://www.canadaluggagedepot.ca/products/samsonite-paralux-hardside-expandable-spinner-medium-luggage",
      ],
      [
        "e2e-alur-carry-on",
        "Delsey ALU'R 19-Inch Aluminum Carry-On",
        "Delsey",
        "ALU'R",
        "",
        null,
        null,
      ],
      [
        "e2e-tumi-19-degree",
        "TUMI 19 Degree Aluminum International Carry-On",
        "TUMI",
        "19 Degree Aluminum",
        "",
        null,
        null,
      ],
    ] as const;
    for (const [slug, name, brand, model, color, target, url] of bags) {
      const { rows } = await pool.query(
        `INSERT INTO products (slug, name, brand, model, color) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [slug, name, brand, model, color],
      );
      if (url)
        await pool.query(
          `INSERT INTO retailer_offers (product_id, retailer, price, url) VALUES ($1, 'Canada Luggage Depot', 434.95, $2)
           ON CONFLICT (product_id, retailer) DO NOTHING`,
          [rows[0].id, url],
        );
      await pool.query(
        `INSERT INTO tracked_products (user_id, product_id, target_price) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, product_id) DO NOTHING`,
        [USER_ID, rows[0].id, target],
      );
    }
  } finally {
    await pool.end();
  }
}

/* ── A read-only subset of Supabase's REST API (PostgREST) ─────────── */
/* Enough for the pages that read tracked products and settings:        */
/* select=, col=eq|neq|in|gt|gte|lt|lte|is.value, order=, limit=. Each   */
/* query runs as the signed-in user (role authenticated + JWT claims),   */
/* so the database's row-level security decides what is visible.        */

const IDENT = /^[a-z_][a-z0-9_]*$/;
const OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
let restPool: Pool | null = null;

function userFrom(req: IncomingMessage): string | null {
  const [, payload] = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").split(".");
  try {
    const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
    return claims.sub === USER_ID && claims.exp * 1000 > Date.now() ? USER_ID : null;
  } catch {
    return null;
  }
}

async function restGet(req: IncomingMessage, res: ServerResponse, dbUrl: string): Promise<void> {
  const u = new URL(req.url ?? "/", "http://x");
  const table = u.pathname.slice("/rest/v1/".length);
  if (!IDENT.test(table)) return send(res, 400, { message: "bad table" });
  const select = (u.searchParams.get("select") ?? "*").split(",").map((c) => c.trim());
  if (!select.every((c) => c === "*" || IDENT.test(c)))
    return send(res, 400, { message: "unsupported select" });
  const where: string[] = [];
  const params: unknown[] = [];
  let order = "";
  let limit = "";
  for (const [key, raw] of u.searchParams) {
    if (key === "select") continue;
    if (key === "order") {
      const parts = raw.split(",").map((p) => p.split("."));
      if (!parts.every(([c, d]) => IDENT.test(c) && (!d || d === "asc" || d === "desc")))
        return send(res, 400, { message: "bad order" });
      order = ` ORDER BY ${parts.map(([c, d]) => `${c} ${d === "desc" ? "DESC" : "ASC"}`).join(", ")}`;
      continue;
    }
    if (key === "limit") {
      limit = ` LIMIT ${Math.min(1000, Number.parseInt(raw, 10) || 1000)}`;
      continue;
    }
    if (!IDENT.test(key)) return send(res, 400, { message: "bad filter" });
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const value = raw.slice(dot + 1);
    if (op === "in") {
      const list = value
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((v) => v.replace(/^"|"$/g, ""));
      params.push(list);
      where.push(`${key}::text = ANY($${params.length}::text[])`);
    } else if (op === "is") {
      where.push(`${key} IS ${value === "null" ? "NULL" : value === "true" ? "TRUE" : "FALSE"}`);
    } else if (OPS[op]) {
      params.push(value);
      where.push(`${key}::text ${OPS[op]} $${params.length}`);
    } else return send(res, 400, { message: `unsupported operator ${op}` });
  }
  const user = userFrom(req);
  restPool ??= new Pool({
    connectionString: dbUrl,
    max: 2,
    // PostgREST returns dates as YYYY-MM-DD; the app compares them as strings.
    types: {
      getTypeParser: (oid: number, format?: string) =>
        oid === 1082
          ? (v: string) => v
          : (pgTypes.getTypeParser as (o: number, f?: string) => (v: string) => unknown)(
              oid,
              format,
            ),
    },
  });
  const client = await restPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${user ? "authenticated" : "anon"}`);
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(user ? { sub: user, role: "authenticated" } : { role: "anon" }),
    ]);
    const cols = select.includes("*") ? "*" : select.join(", ");
    const sql = `SELECT ${cols} FROM public.${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${order}${limit}`;
    const { rows } = await client.query(sql, params);
    await client.query("COMMIT");
    const numeric = rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [
          k,
          typeof v === "string" && /^-?\d+\.\d+$/.test(v) ? Number(v) : v,
        ]),
      ),
    );
    if ((req.headers.accept ?? "").includes("vnd.pgrst.object")) {
      if (numeric.length !== 1)
        return send(res, 406, {
          code: "PGRST116",
          message: "JSON object requested, multiple (or no) rows returned",
          details: `The result contains ${numeric.length} rows`,
        });
      return send(res, 200, numeric[0]);
    }
    return send(res, 200, numeric);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    return send(res, 400, { message: err instanceof Error ? err.message : "query failed" });
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!/@127\.0\.0\.1:/.test(url))
    throw new Error("set DATABASE_URL to the local dev database (npm run db:dev -- up)");
  await seed(url);

  createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "OPTIONS") return send(res, 204);
      if (path === "/auth/v1/token" && req.method === "POST") {
        const grant = new URL(req.url ?? "/", "http://x").searchParams.get("grant_type");
        const body = await readJson(req);
        if (grant === "refresh_token") return send(res, 200, session());
        if (body.email === EMAIL && body.password === PASSWORD) return send(res, 200, session());
        return send(res, 400, {
          error: "invalid_grant",
          error_description: "Invalid login credentials",
        });
      }
      if (path === "/auth/v1/user" && req.method === "GET") {
        const auth = req.headers.authorization ?? "";
        const [, payload] = auth.replace(/^Bearer\s+/i, "").split(".");
        try {
          const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
          if (claims.sub === USER_ID && claims.exp * 1000 > Date.now()) return send(res, 200, user);
        } catch {
          /* fall through */
        }
        return send(res, 401, { message: "invalid token" });
      }
      if (path === "/auth/v1/logout") return send(res, 204);
      if (path.startsWith("/rest/v1/") && req.method === "GET") return restGet(req, res, url);
      return send(res, 501, { message: "not part of the local stand-in" });
    })();
  }).listen(PORT, "127.0.0.1", () => {
    console.log(
      `local auth stand-in on http://127.0.0.1:${PORT} · sign in as ${EMAIL} / ${PASSWORD}`,
    );
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
