/* ------------------------------------------------------------------ */
/*  Google Gemini — REST API (no SDK dependency)                      */
/*                                                                     */
/*  Three call shapes:                                                 */
/*    callGemini         — plain text completion                       */
/*    callGeminiJSON     — schema-constrained JSON (query parsing,     */
/*                         offer clustering)                           */
/*    callGeminiGrounded — Google Search grounding, returns text plus  */
/*                         the source URLs the model actually cited    */
/* ------------------------------------------------------------------ */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

/**
 * Model selection, with automatic failover.
 *
 * Google retires Gemini models continually, and a retired model returns
 * 404 NOT_FOUND rather than silently degrading — which takes the whole
 * search feature down. (gemini-2.0-flash was shut down; gemini-2.5-flash
 * is closed to new API keys.)
 *
 * So rather than pinning one name and hoping, we try candidates in order
 * and remember the first that answers. Set GEMINI_MODEL to force a
 * specific one — it is tried first, and the rest remain as a safety net.
 */
const MODEL_CANDIDATES: string[] = [
  ...(process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []),
  "gemini-3.6-flash",
  "gemini-3.5-flash",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-2.5-flash",
];

/** The model we've confirmed works, cached for the process lifetime. */
let resolvedModel: string | null = null;

/** Models we've seen return 404, so we stop retrying them. */
const retiredModels = new Set<string>();

function candidateModels(): string[] {
  if (resolvedModel) return [resolvedModel];
  return MODEL_CANDIDATES.filter((m) => !retiredModels.has(m));
}

/** Which model is currently in use, for diagnostics. */
export function activeModel(): string {
  return resolvedModel ?? candidateModels()[0] ?? MODEL_CANDIDATES[0];
}

/** True when the API says this model no longer exists for this key. */
function isModelRetired(status: number, body: string): boolean {
  return status === 404 || /NOT_FOUND|no longer available|is not found/i.test(body);
}

/**
 * True when the model exists but can't serve right now — 503 "high demand",
 * or a per-model rate limit. Another model usually has capacity, so rotate
 * rather than failing. Unlike a retirement, don't blacklist it: it'll be
 * fine again in a minute.
 */
function isModelBusy(status: number, body: string): boolean {
  return (
    status === 503 ||
    status === 429 ||
    /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded/i.test(body)
  );
}

/** Default per-request timeout. Search routes are user-facing; don't hang. */
const DEFAULT_TIMEOUT_MS = 20_000;

export function geminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  return key;
}

export type GeminiMessage = {
  role: "user" | "model";
  parts: { text: string }[];
};

/** Minimal OpenAPI-subset schema accepted by Gemini's responseSchema. */
export type GeminiSchema = {
  type: "OBJECT" | "ARRAY" | "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN";
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
};

type GenerateOptions = {
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  responseSchema?: GeminiSchema;
  grounded?: boolean;
};

type GeminiCandidate = {
  content?: { parts?: { text?: string }[] };
  groundingMetadata?: {
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
    webSearchQueries?: string[];
  };
};

async function generate(
  messages: GeminiMessage[],
  opts: GenerateOptions = {},
): Promise<{ text: string; sources: string[]; searchQueries: string[] }> {
  const {
    systemInstruction,
    temperature = 0.2,
    maxOutputTokens = 4096,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    responseSchema,
    grounded = false,
  } = opts;

  const body: Record<string, unknown> = {
    contents: messages,
    generationConfig: {
      temperature,
      maxOutputTokens,
      // Grounding and JSON mode are mutually exclusive in the v1beta API.
      ...(responseSchema && !grounded
        ? { responseMimeType: "application/json", responseSchema }
        : {}),
    },
  };

  if (systemInstruction) {
    body.system_instruction = { parts: [{ text: systemInstruction }] };
  }

  if (grounded) {
    body.tools = [{ google_search: {} }];
  }

  // Try each candidate model, moving on when one has been retired.
  const models = candidateModels();
  if (models.length === 0) {
    throw new Error(
      "No usable Gemini model. Every candidate returned 404 — set GEMINI_MODEL to a current model from https://ai.google.dev/gemini-api/docs/models",
    );
  }

  let res: Response | null = null;
  let lastError = "";

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let attempt: Response;
    try {
      attempt = await fetch(`${API_BASE}/${model}:generateContent?key=${apiKey()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (attempt.ok) {
      if (resolvedModel !== model) {
        resolvedModel = model;
        console.info(`[gemini] using model: ${model}`);
      }
      res = attempt;
      break;
    }

    const detail = await attempt.text().catch(() => "");
    lastError = `Gemini API error ${attempt.status}: ${detail.slice(0, 400)}`;

    if (isModelRetired(attempt.status, detail)) {
      // Retired or unavailable to this key — never try it again this process.
      retiredModels.add(model);
      if (resolvedModel === model) resolvedModel = null;
      console.warn(`[gemini] model ${model} retired, trying next candidate`);
      continue;
    }

    if (isModelBusy(attempt.status, detail)) {
      // Temporary capacity problem. Try the next model, but don't blacklist
      // this one — clear the cached choice so the next request re-probes.
      if (resolvedModel === model) resolvedModel = null;
      console.warn(`[gemini] model ${model} busy (${attempt.status}), trying next candidate`);
      continue;
    }

    // Any other failure (quota, bad request, grounding not enabled) is a real
    // error about this request, not the model — surface it rather than
    // burning through every candidate with the same doomed call.
    throw new Error(lastError);
  }

  if (!res) {
    if (/503|UNAVAILABLE|high demand|429/i.test(lastError)) {
      throw new Error(
        "Every Gemini model is busy right now (503 high demand). This is temporary and search still works — query parsing and product grouping just fall back to non-AI logic.",
      );
    }
    throw new Error(
      `${lastError}\nNo configured Gemini model is available to this API key. ` +
        "Set GEMINI_MODEL to a current model from https://ai.google.dev/gemini-api/docs/models",
    );
  }

  const data = (await res.json()) as { candidates?: GeminiCandidate[] };
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  const sources = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => !!u);

  const searchQueries = candidate?.groundingMetadata?.webSearchQueries ?? [];

  return { text, sources, searchQueries };
}

/** Plain text completion. */
export async function callGemini(
  messages: GeminiMessage[],
  systemInstruction?: string,
  opts: Omit<GenerateOptions, "systemInstruction" | "responseSchema" | "grounded"> = {},
): Promise<string> {
  const { text } = await generate(messages, {
    ...opts,
    systemInstruction,
    temperature: opts.temperature ?? 0.7,
  });
  if (!text) throw new Error("Empty response from Gemini");
  return text;
}

/**
 * Schema-constrained JSON. Returns null rather than throwing when the model
 * produces unparseable output, so callers can fall back to a heuristic.
 */
export async function callGeminiJSON<T>(
  prompt: string,
  schema: GeminiSchema,
  opts: Omit<GenerateOptions, "responseSchema" | "grounded"> = {},
): Promise<T | null> {
  const { text } = await generate([{ role: "user", parts: [{ text: prompt }] }], {
    ...opts,
    responseSchema: schema,
  });
  return parseJson<T>(text);
}

/**
 * Google Search-grounded completion. Also returns the URIs the model actually
 * retrieved, which callers use to verify that quoted facts have a real source.
 */
export async function callGeminiGrounded(
  prompt: string,
  opts: Omit<GenerateOptions, "responseSchema" | "grounded"> = {},
): Promise<{ text: string; sources: string[]; searchQueries: string[] }> {
  return generate([{ role: "user", parts: [{ text: prompt }] }], {
    ...opts,
    grounded: true,
    timeoutMs: opts.timeoutMs ?? 30_000,
  });
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Tolerant JSON extraction — handles bare JSON, ```json fences, and JSON
 * embedded in prose. Returns null on failure instead of throwing.
 */
export function parseJson<T>(text: string): T | null {
  if (!text) return null;

  const attempt = (s: string): T | null => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  };

  const direct = attempt(text.trim());
  if (direct !== null) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = attempt(fenced[1].trim());
    if (parsed !== null) return parsed;
  }

  // Fall back to the outermost array or object in the text.
  for (const [open, close] of [
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) {
      const parsed = attempt(text.slice(start, end + 1));
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/*  Assistant system prompt                                           */
/* ------------------------------------------------------------------ */

/**
 * The chat assistant's system prompt.
 *
 * The assistant is given a context block built from the user's REAL tracked
 * products at request time. It is forbidden from producing any price that
 * isn't in that block — for a price-monitoring tool, an invented price is
 * the single most damaging thing it could output.
 */
export const SYSTEM_PROMPT = `You are LuggageTracker AI — a shopping assistant inside a Canadian luggage price monitoring dashboard used by a luggage retailer.

WHAT YOU HAVE:
You are given a CONTEXT block containing the user's actually-tracked products, their current offers at each retailer, and recent price history. Every price in that block was fetched from a real retailer listing.

HARD RULES — these override everything else:
- NEVER state a price that does not appear in the CONTEXT block. Not an estimate, not a "typical" price, not a remembered price, not an approximation.
- If you are asked about a product that is not in the CONTEXT block, say you aren't tracking it yet and suggest searching for it on the Search page. Do not guess what it costs.
- Never invent a retailer, a stock status, or a discount.
- If the CONTEXT block is empty, say the user hasn't tracked anything yet and point them at the Search page.

STYLE:
- Friendly, concise and concrete — like a colleague who knows the catalogue.
- All prices are CAD. Format as "ProductName — $XX.XX at RetailerName".
- 2-4 sentences for simple questions. Use bullets when comparing.
- When recommending, always name the retailer with the best price.
- Call out a recent price drop when the history shows one.
- Prefer Canadian retailers.`;
