/* ------------------------------------------------------------------ */
/*  SSRF guard                                                        */
/*                                                                     */
/*  The worker fetches only registry hosts. Every URL — including each  */
/*  redirect hop — must be https on port 443, name a host in the       */
/*  source's `fetchHosts` exactly, not be an IP literal, and resolve    */
/*  only to public addresses (no loopback, private, link-local, CGNAT,  */
/*  metadata or multicast ranges).                                      */
/* ------------------------------------------------------------------ */

import { isIP } from "node:net";
import type { SourceRecord } from "../types";

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const { lookup } = await import("node:dns/promises");
  const res = await lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};

export class SsrfRejected extends Error {
  constructor(readonly reason: string) {
    super(`blocked by SSRF guard: ${reason}`);
    this.name = "SsrfRejected";
  }
}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return !V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const a = ip.toLowerCase();
    if (a === "::" || a === "::1") return false;
    // IPv4-mapped / translated: judge the embedded v4 address.
    const mapped = a.match(/^(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    if (/^f[cd]/.test(a)) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(a)) return false; // link-local fe80::/10
    if (/^ff/.test(a)) return false; // multicast
    if (/^2001:db8:/.test(a)) return false; // documentation
    return true;
  }
  return false;
}

/** Throws SsrfRejected unless `rawUrl` is safe to fetch for `source`. */
export async function assertFetchable(
  rawUrl: string,
  source: Pick<SourceRecord, "fetchHosts" | "id">,
  resolve: Resolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfRejected("not a URL");
  }
  if (url.protocol !== "https:") throw new SsrfRejected("https only");
  if (url.port && url.port !== "443") throw new SsrfRejected("port must be 443");
  if (url.username || url.password) throw new SsrfRejected("credentials in URL");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new SsrfRejected("IP literal host");
  if (!source.fetchHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new SsrfRejected(`${host} is not a registry host for ${source.id}`);
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new SsrfRejected(`${host} does not resolve`);
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new SsrfRejected(`${host} resolves to a non-public address`);
  }
  return url;
}
