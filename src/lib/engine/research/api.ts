/* ------------------------------------------------------------------ */
/*  Research API logic, free of HTTP so it can be tested directly.     */
/* ------------------------------------------------------------------ */

import { z } from "zod";
import type { EngineConfig } from "../config";
import type { EngineStore } from "../store/port";
import type { ResearchSessionRecord } from "../types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const researchInput = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, "A search query is required.")
      .max(200, "That search query is too long."),
    reverifyOf: z.string().regex(UUID, "reverifyOf must be a session id").optional(),
    storeIds: z
      .array(z.string().regex(/^[a-z0-9-]{2,60}$/))
      .max(30)
      .optional(),
  })
  .strict();

export type ResearchInput = z.infer<typeof researchInput>;

export function parseResearchInput(
  body: unknown,
): { ok: true; value: ResearchInput } | { ok: false; error: string } {
  const r = researchInput.safeParse(body);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues[0]?.message ?? "Invalid request." };
}

export type RateDecision = { ok: true } | { ok: false; retryAfterSec: number; reason: string };

/** Per-user limits: N sessions per window, and at most M running at once. */
export async function checkRateLimit(
  store: EngineStore,
  userId: string,
  cfg: EngineConfig,
  now = Date.now(),
): Promise<RateDecision> {
  const { perWindow, windowMs, maxConcurrent } = cfg.rateLimit;
  const [recent, active] = await Promise.all([
    store.countSessionsSince(userId, new Date(now - windowMs).toISOString()),
    store.countActiveSessions(userId),
  ]);
  if (active >= maxConcurrent)
    return {
      ok: false,
      retryAfterSec: 5,
      reason: "A search is already running. Wait for it to finish or cancel it.",
    };
  if (recent >= perWindow) {
    return {
      ok: false,
      retryAfterSec: Math.ceil(windowMs / 1000 / 4),
      reason: `Limit of ${perWindow} price checks per ${Math.round(windowMs / 60_000)} minutes reached. Try again shortly.`,
    };
  }
  return { ok: true };
}

/** The session, if this user may see it (owner or admin). */
export async function ownedSession(
  store: EngineStore,
  id: string,
  userId: string,
): Promise<ResearchSessionRecord | null> {
  if (!UUID.test(id)) return null;
  const s = await store.getSession(id);
  if (!s) return null;
  if (s.userId === userId) return s;
  return (await store.isAdmin(userId)) ? s : null;
}

/** Create a session row for the request. Re-verify inherits the parent's query. */
export async function createSession(
  store: EngineStore,
  userId: string,
  input: ResearchInput,
  cfg: EngineConfig,
  mode: "worker" | "inline",
): Promise<
  { ok: true; session: ResearchSessionRecord } | { ok: false; status: number; error: string }
> {
  let query = input.query;
  if (input.reverifyOf) {
    const parent = await ownedSession(store, input.reverifyOf, userId);
    if (!parent)
      return { ok: false, status: 404, error: "That search isn't available to re-verify." };
    query = parent.query;
  }
  const session = await store.createSession({
    userId,
    query,
    parentSessionId: input.reverifyOf ?? null,
    storeIds: input.storeIds ?? null,
    deadlineMs: cfg.sessionDeadlineMs,
    mode,
  });
  return { ok: true, session };
}
