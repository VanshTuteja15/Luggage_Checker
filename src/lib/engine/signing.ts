/* ------------------------------------------------------------------ */
/*  Signed Vercel → worker requests                                   */
/*                                                                     */
/*  HMAC-SHA256 over method, path, timestamp, a one-time nonce and the  */
/*  SHA-256 of the body, with a shared secret (WORKER_SHARED_SECRET).   */
/*  The worker rejects stale (>5 min), replayed and tampered requests.  */
/* ------------------------------------------------------------------ */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-lt-signature";
export const MAX_SKEW_MS = 5 * 60_000;

function canonical(method: string, path: string, ts: number, nonce: string, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}\n${bodyHash}`;
}

export function signRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): string {
  const nonce = randomBytes(12).toString("hex");
  const mac = createHmac("sha256", secret)
    .update(canonical(method, path, now, nonce, body))
    .digest("hex");
  return `t=${now},n=${nonce},v1=${mac}`;
}

/** Remembers nonces for the skew window so a captured request can't be replayed. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = MAX_SKEW_MS * 2) {}
  /** false if the nonce was already used. */
  claim(nonce: string, now = Date.now()): boolean {
    if (this.seen.size > 10_000)
      for (const [n, at] of this.seen) if (now - at > this.ttlMs) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now);
    return true;
  }
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export function verifyRequest(
  secret: string,
  header: string | null | undefined,
  method: string,
  path: string,
  body: string,
  nonces: NonceCache,
  now = Date.now(),
): VerifyResult {
  if (!secret) return { ok: false, reason: "worker secret not configured" };
  if (!header) return { ok: false, reason: "missing signature" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  ) as Record<string, string>;
  const ts = Number(parts.t);
  const nonce = parts.n ?? "";
  const given = parts.v1 ?? "";
  if (!Number.isFinite(ts) || !/^[0-9a-f]{24}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(given))
    return { ok: false, reason: "malformed signature" };
  if (Math.abs(now - ts) > MAX_SKEW_MS) return { ok: false, reason: "signature expired" };
  const expected = createHmac("sha256", secret)
    .update(canonical(method, path, ts, nonce, body))
    .digest();
  const actual = Buffer.from(given, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return { ok: false, reason: "bad signature" };
  if (!nonces.claim(nonce, now)) return { ok: false, reason: "replayed request" };
  return { ok: true };
}
