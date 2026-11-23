import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { suggestFor } from "@/lib/engine/query/suggest";
import { getEngine } from "@/lib/engine/server";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const typed = z.string().trim().min(2).max(80);

/** Signed-in callers seen in the last minute (by token hash), so typing doesn't re-check each key. */
const seen = new Map<string, number>();
const SEEN_MS = 60_000;

async function signedIn(req: NextRequest): Promise<void> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const key = token ? createHash("sha256").update(token).digest("hex") : "";
  const until = key ? seen.get(key) : undefined;
  if (until && until > Date.now()) return;
  await requireUser(req);
  if (seen.size > 500) seen.clear();
  if (key) seen.set(key, Date.now() + SEEN_MS);
}

/**
 * GET /api/search/suggest?q=… — autocomplete (v5 F2.5): brands, lines and
 * popular searches from our own index and search history. Keystrokes never
 * go to a third party; nothing is fetched from a store.
 */
export async function GET(req: NextRequest) {
  try {
    await signedIn(req);
    const q = typed.safeParse(req.nextUrl.searchParams.get("q") ?? "");
    if (!q.success) return badRequest("Type at least two letters.");
    const t0 = performance.now();
    const { rt } = getEngine();
    const popular = await rt.store
      .popularQueries(q.data, {
        sinceIso: new Date(Date.now() - 90 * 86_400_000).toISOString(),
        limit: 4,
      })
      .catch(() => []);
    const suggestions = suggestFor(q.data, popular);
    return NextResponse.json(
      { suggestions, ms: Math.round(performance.now() - t0) },
      { headers: { "cache-control": "private, max-age=60" } },
    );
  } catch (err) {
    return errorResponse(err, "GET /api/search/suggest");
  }
}
