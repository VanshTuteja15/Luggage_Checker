/* ------------------------------------------------------------------ */
/*  robots.txt — parse once per host, then ask "may we fetch this?"    */
/*                                                                     */
/*  Group selection: the most specific User-agent group naming our     */
/*  token, else "*". Rule matching: longest pattern wins, Allow wins   */
/*  a tie; "*" wildcards and "$" end anchors supported (RFC 9309).      */
/* ------------------------------------------------------------------ */

export type RobotsRules = {
  fetched: boolean;
  status: number | null;
  group: "named" | "*" | "none";
  rules: { allow: boolean; pattern: string }[];
  crawlDelaySec: number | null;
  sitemaps: string[];
  /** Raw names of user-agents that have a group, for the report. */
  agents: string[];
};

export function parseRobots(text: string, token: string, status: number | null = 200): RobotsRules {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[]; delay: number | null };
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const line of lines) {
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
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") {
      // An empty Disallow means "allow everything" — no rule needed.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) current.delay = n;
    }
  }

  const t = token.toLowerCase();
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const star = groups.filter((g) => g.agents.includes("*"));
  const chosen = named.length ? named : star;

  return {
    fetched: true,
    status,
    group: named.length ? "named" : star.length ? "*" : "none",
    rules: chosen.flatMap((g) => g.rules),
    crawlDelaySec: chosen.map((g) => g.delay).find((d) => d !== null) ?? null,
    sitemaps,
    agents: [...new Set(groups.flatMap((g) => g.agents))],
  };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** true = allowed. Unreachable robots (4xx) means allowed; 5xx means disallowed (RFC 9309). */
export function isAllowed(robots: RobotsRules, url: string): boolean {
  if (!robots.fetched) return robots.status !== null && robots.status >= 400 && robots.status < 500;
  const u = new URL(url);
  const path = `${u.pathname}${u.search}`;
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of robots.rules) {
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      /* keep raw */
    }
    if (!patternToRegex(rule.pattern).test(path) && !patternToRegex(rule.pattern).test(decoded)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) best = { allow: rule.allow, length };
  }
  return best ? best.allow : true;
}

export function unreachableRobots(status: number | null): RobotsRules {
  return { fetched: false, status, group: "none", rules: [], crawlDelaySec: null, sitemaps: [], agents: [] };
}
