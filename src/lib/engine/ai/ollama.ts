/* ------------------------------------------------------------------ */
/*  Ollama client (local models only)                                  */
/*                                                                     */
/*  /api/chat with a JSON-schema `format` built from the task's zod     */
/*  schema, temperature 0 and a fixed seed, so answers are structured   */
/*  and repeatable. Every failure is a typed reason the caller turns    */
/*  into the rules result: AI is an optional helper, never a dependency. */
/*  The URL must be loopback or explicitly allow-listed: a server that  */
/*  posts store text to an arbitrary host would be an SSRF and a leak.  */
/* ------------------------------------------------------------------ */

import { z } from "zod/v4";

export type AiFailure = "off" | "refused_url" | "invalid" | "timeout" | "busy" | "unavailable";

export type AiMeta = {
  model: string;
  totalMs: number;
  loadMs: number;
  promptTokens: number;
  outputTokens: number;
};

export type AiResult<T> =
  { ok: true; value: T; meta: AiMeta } | { ok: false; reason: AiFailure; detail: string | null };

export type OllamaOptions = {
  url: string;
  model: string;
  timeoutMs: number;
  /** Extra hosts besides loopback (e.g. a LAN box); exact names only. */
  allowedHosts?: string[];
  keepAlive?: string | number;
  numCtx?: number;
  fetchImpl?: typeof fetch;
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Loopback, or a host the operator listed in OLLAMA_ALLOWED_HOSTS. http(s) only, no credentials. */
export function ollamaUrlAllowed(url: string, allowedHosts: string[] = []): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return LOOPBACK.has(host) || allowedHosts.some((h) => h.trim().toLowerCase() === host);
}

/** JSON schema for Ollama's `format` (draft 2020-12, without the `$schema` key). */
export function toOllamaFormat(schema: z.ZodType): Record<string, unknown> {
  const s = z.toJSONSchema(schema) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export class OllamaClient {
  readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly keepAlive: string | number;
  private readonly numCtx: number;
  private readonly fetchImpl: typeof fetch;
  private readonly allowed: boolean;

  constructor(opts: OllamaOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs;
    this.keepAlive = opts.keepAlive ?? "5m";
    this.numCtx = opts.numCtx ?? 4096;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.allowed = ollamaUrlAllowed(this.url, opts.allowedHosts);
  }

  async chat<T>(req: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
    /** Hybrid "thinking" models: false keeps answers short (measured faster, review 02). */
    think?: boolean;
    numPredict?: number;
    signal?: AbortSignal;
  }): Promise<AiResult<T>> {
    if (!this.allowed)
      return {
        ok: false,
        reason: "refused_url",
        detail: "OLLAMA_URL must be loopback or in OLLAMA_ALLOWED_HOSTS",
      };
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      format: toOllamaFormat(req.schema),
      stream: false,
      keep_alive: this.keepAlive,
      options: {
        temperature: 0,
        seed: 7,
        num_ctx: this.numCtx,
        num_predict: req.numPredict ?? 400,
      },
    };
    if (req.think !== undefined) body.think = req.think;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([timeout, req.signal]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const aborted =
        timeout.aborted ||
        (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"));
      return {
        ok: false,
        reason: aborted ? "timeout" : "unavailable",
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      };
    }
    // Ollama answers 503 when its queue is full (OLLAMA_MAX_QUEUE).
    if (res.status === 503) return { ok: false, reason: "busy", detail: "HTTP 503" };
    if (!res.ok) return { ok: false, reason: "unavailable", detail: `HTTP ${res.status}` };

    let payload: {
      message?: { content?: unknown };
      total_duration?: number;
      load_duration?: number;
      prompt_eval_count?: number;
      eval_count?: number;
    };
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      return { ok: false, reason: "invalid", detail: "response was not JSON" };
    }
    const content = typeof payload.message?.content === "string" ? payload.message.content : "";
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      return { ok: false, reason: "invalid", detail: "model output was not JSON" };
    }
    const parsed = req.schema.safeParse(parsedJson);
    if (!parsed.success)
      return { ok: false, reason: "invalid", detail: "model output failed the schema" };
    const ms = (v: unknown) => (typeof v === "number" ? Math.round(v / 1e6) : 0);
    return {
      ok: true,
      value: parsed.data,
      meta: {
        model: this.model,
        totalMs: ms(payload.total_duration),
        loadMs: ms(payload.load_duration),
        promptTokens: Number(payload.prompt_eval_count ?? 0),
        outputTokens: Number(payload.eval_count ?? 0),
      },
    };
  }

  /** Cheap reachability check (no model load). */
  async ping(timeoutMs = 1500): Promise<boolean> {
    if (!this.allowed) return false;
    try {
      const res = await this.fetchImpl(`${this.url}/api/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
