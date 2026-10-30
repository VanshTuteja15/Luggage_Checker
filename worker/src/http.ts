/* ------------------------------------------------------------------ */
/*  Worker HTTP API                                                   */
/*                                                                     */
/*    GET  /health        liveness + what's configured (no secrets)   */
/*    POST /v1/jobs       { name, data }   signed; enqueues a job      */
/*    POST /v1/research   { sessionId }    signed; starts a session    */
/*                                                                     */
/*  Everything except /health must carry a valid x-lt-signature from   */
/*  the Vercel app (HMAC with WORKER_SHARED_SECRET, 5-minute window,    */
/*  single-use nonce).                                                  */
/* ------------------------------------------------------------------ */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describeConfig } from "@/lib/engine/config";
import { NonceCache, SIGNATURE_HEADER, verifyRequest } from "@/lib/engine/signing";
import { log } from "./log";
import { isJobName, type JobQueue } from "./queue";

export type WorkerDeps = {
  secret: string;
  queue: JobQueue;
  version: string;
  storeKind: string;
  /** Starts a research session in the background. Absent → 501. */
  runResearch?: (sessionId: string) => void;
  activeSessions?: () => number;
};

const MAX_BODY = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY * 16) {
        // Far too big: stop listening altogether.
        req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        // Drain without buffering so the client still gets a 413.
        tooBig = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooBig) resolve(null);
    });
    req.on("end", () => {
      if (!tooBig) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

export function createWorkerServer(deps: WorkerDeps): Server {
  const nonces = new NonceCache();
  const started = Date.now();

  return createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") {
        const queue = await deps.queue.stats().catch(() => null);
        return send(res, 200, {
          ok: true,
          version: deps.version,
          uptimeSec: Math.round((Date.now() - started) / 1000),
          queue: { kind: deps.queue.kind, jobs: queue },
          store: deps.storeKind,
          activeSessions: deps.activeSessions?.() ?? 0,
          config: describeConfig(),
        });
      }

      if (req.method !== "POST" || (path !== "/v1/jobs" && path !== "/v1/research")) return send(res, 404, { error: "not found" });

      const body = await readBody(req);
      if (body === null) return send(res, 413, { error: "body too large" });
      const auth = verifyRequest(deps.secret, req.headers[SIGNATURE_HEADER] as string | undefined, "POST", path, body, nonces);
      if (!auth.ok) {
        log("warn", "rejected unsigned request", { path, reason: auth.reason });
        return send(res, 401, { error: auth.reason });
      }

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(body || "{}") as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "invalid JSON" });
      }

      if (path === "/v1/research") {
        if (!deps.runResearch) return send(res, 501, { error: "research not available on this worker" });
        if (typeof json.sessionId !== "string" || !UUID.test(json.sessionId)) return send(res, 400, { error: "sessionId must be a UUID" });
        deps.runResearch(json.sessionId);
        return send(res, 202, { accepted: true, sessionId: json.sessionId });
      }

      // AI lane jobs are queued only by engine code, never over HTTP (planning/v4/review/03 P3-03).
      if (!isJobName(json.name) || json.name === "research.run" || json.name.startsWith("ai.")) return send(res, 400, { error: "unknown job" });
      const data = json.data && typeof json.data === "object" && !Array.isArray(json.data) ? (json.data as Record<string, unknown>) : {};
      const key = typeof data.sourceId === "string" ? `${json.name}:${data.sourceId}` : String(json.name);
      const id = await deps.queue.send(json.name, data, { singletonKey: key });
      log("info", "job enqueued", { name: json.name, id, deduplicated: id === null });
      return send(res, 202, { accepted: true, jobId: id, deduplicated: id === null });
    } catch (err) {
      log("error", "request failed", { path, err });
      return send(res, 500, { error: "internal error" });
    }
  });
}
