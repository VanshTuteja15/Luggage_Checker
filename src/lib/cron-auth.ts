/* ------------------------------------------------------------------ */
/*  Scheduler authentication (§10)                                    */
/*                                                                     */
/*  Cron callers (Supabase pg_cron, the worker, Vercel Cron) send      */
/*  CRON_SECRET in `x-cron-secret` or as a Bearer token. Compared in   */
/*  constant time so response timing can't leak the secret; no secret  */
/*  set means every call is refused. Neither value is ever logged.     */
/* ------------------------------------------------------------------ */

import { createHash, timingSafeEqual } from "node:crypto";

function digest(s: string): Buffer {
  // Fixed-length digests: timingSafeEqual needs equal lengths, and hashing
  // first means the comparison doesn't reveal the secret's length either.
  return createHash("sha256").update(s, "utf8").digest();
}

export function secretMatches(
  given: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !given) return false;
  return timingSafeEqual(digest(given), digest(secret));
}

export function cronAuthorized(
  req: { headers: { get(name: string): string | null } },
  secret: string | undefined = process.env.CRON_SECRET,
): boolean {
  const given =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;
  return secretMatches(given, secret);
}
