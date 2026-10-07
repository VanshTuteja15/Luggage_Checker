/* ------------------------------------------------------------------ */
/*  robots.txt (RFC 9309)                                             */
/*                                                                     */
/*  Group selection: the group naming our token, else "*". Matching:   */
/*  longest pattern wins, Allow wins a tie; "*" and "$" supported.      */
/*  Availability rules: 4xx = no restrictions; 5xx, timeouts and       */
/*  challenge pages = assume full disallow (we can't read the rules,    */
/*  so we don't crawl).                                                 */
/* ------------------------------------------------------------------ */

export type RobotsRules = {
  /** "ok" parsed rules; "unavailable" 4xx; "unreachable" 5xx/blocked/timeout. */
  state: "ok" | "unavailable" | "unreachable";
  rules: { allow: boolean; pattern: string; re: RegExp }[];
  crawlDelaySec: number | null;
  sitemaps: string[];
  fetchedAt: number;
};

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function parseRobots(text: string, token: string, fetchedAt = Date.now()): RobotsRules {
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  const t = token.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  return {
    state: "ok",
    rules: chosen.flatMap((g) => g.rules).map((r) => ({ ...r, re: patternToRegex(r.pattern) })),
    crawlDelaySec: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
    sitemaps: [...new Set(sitemaps)],
    fetchedAt,
  };
}

export function unavailableRobots(fetchedAt = Date.now()): RobotsRules {
  return { state: "unavailable", rules: [], crawlDelaySec: null, sitemaps: [], fetchedAt };
}

export function unreachableRobots(fetchedAt = Date.now()): RobotsRules {
  return { state: "unreachable", rules: [], crawlDelaySec: null, sitemaps: [], fetchedAt };
}

export function isAllowed(robots: RobotsRules, url: string): boolean {
  if (robots.state === "unavailable") return true;
  if (robots.state === "unreachable") return false;
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* keep raw */
  }
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    if (!rule.re.test(path) && !rule.re.test(decoded)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

/** Cache of parsed robots.txt per origin. Successes live 24 h, failures 1 h. */
export class RobotsCache {
  private entries = new Map<string, RobotsRules>();
  private inflight = new Map<string, Promise<RobotsRules>>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(url: string, load: (origin: string) => Promise<RobotsRules>): Promise<RobotsRules> {
    const origin = new URL(url).origin;
    const hit = this.entries.get(origin);
    const ttl = hit?.state === "ok" || hit?.state === "unavailable" ? 24 * 3_600_000 : 3_600_000;
    if (hit && this.now() - hit.fetchedAt < ttl) return hit;
    const pending = this.inflight.get(origin);
    if (pending) return pending;
    const p = load(origin)
      .then((r) => {
        this.entries.set(origin, r);
        return r;
      })
      .finally(() => this.inflight.delete(origin));
    this.inflight.set(origin, p);
    return p;
  }

  /** Test / ops hook. */
  set(origin: string, rules: RobotsRules): void {
    this.entries.set(origin, rules);
  }
}
