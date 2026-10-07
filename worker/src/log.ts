/* ------------------------------------------------------------------ */
/*  Structured logs: one JSON object per line on stdout.               */
/*  Anything that looks like a secret is redacted before it's written. */
/* ------------------------------------------------------------------ */

export type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEY = /secret|password|token|apikey|api_key|authorization|database_url|connectionstring|signature/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

const MIN: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = MIN[(process.env.LOG_LEVEL as Level) ?? "info"] ?? MIN.info;

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (MIN[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as Record<string, unknown>) });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}
