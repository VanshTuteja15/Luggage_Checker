/* ------------------------------------------------------------------ */
/*  Morning email inside the Next.js server (API routes only)          */
/*                                                                     */
/*  The email reads the engine's database (prices) and the tracking    */
/*  tables, which live in the same Postgres, through the engine's      */
/*  server-side connection. Without that database there is nothing    */
/*  honest to send, so the routes say so in a plain sentence.         */
/* ------------------------------------------------------------------ */

import { NextResponse, type NextRequest } from "next/server";
import { getEngine } from "@/lib/engine/server";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { pgPoolOf } from "@/lib/engine/store/pg";
import { getMailer, type Mailer } from "@/lib/mailer";
import { ApiError } from "@/lib/supabase/server";
import { serverDailyJobs, serverPrepare } from "./prepare";
import { DigestError, type DigestDeps } from "./run";
import { PgDigestStore } from "./store";
import type { TickDeps } from "./tick";

export const NO_DATABASE =
  "The morning email needs the price database, which isn't connected yet. The person who set up LuggageTracker can connect it.";

/** The app's public address for links in the email. */
export function appUrlFor(req?: NextRequest): string {
  const configured = process.env.APP_URL?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return req ? req.nextUrl.origin : "";
}

/** Everything the email needs, or null when the price database isn't connected. */
export function digestDeps(
  opts: { req?: NextRequest; mailer?: Mailer | null; now?: () => Date } = {},
): DigestDeps | null {
  const { rt } = getEngine();
  const pool = pgPoolOf(rt.store);
  if (!pool) return null;
  return {
    store: new PgDigestStore(pool),
    engine: rt.store,
    pack: luggagePack,
    sources: () => rt.sources(),
    mailer: opts.mailer !== undefined ? opts.mailer : getMailer(),
    appUrl: appUrlFor(opts.req),
    now: opts.now ?? (() => new Date()),
  };
}

/** The scheduler's dependencies: the email's, plus fresh prices and the daily engine jobs. */
export function tickDeps(req?: NextRequest): TickDeps | null {
  const base = digestDeps({ req });
  if (!base) return null;
  const { rt } = getEngine();
  return {
    ...base,
    prepare: serverPrepare(rt, luggagePack),
    dailyJobs: serverDailyJobs(rt),
  };
}

/** Plain sentences for people; the technical detail stays in the server log (R5.5). */
export function emailRouteError(err: unknown, context: string, fallback: string): NextResponse {
  if (err instanceof DigestError || err instanceof ApiError)
    return NextResponse.json({ error: err.message }, { status: err.status });
  const requestId = crypto.randomUUID().slice(0, 8);
  console.error(`${context} [${requestId}]:`, err);
  return NextResponse.json({ error: `${fallback} (ref ${requestId})` }, { status: 500 });
}
