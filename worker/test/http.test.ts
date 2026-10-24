import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, signRequest } from "@/lib/engine/signing";
import { createWorkerServer } from "../src/http";
import { MemoryQueue } from "../src/queue";

const SECRET = "test-secret-that-is-long-enough-0123456789";

describe("worker HTTP API", () => {
  let server: Server;
  let base: string;
  const queue = new MemoryQueue();
  const started: string[] = [];

  beforeAll(async () => {
    await queue.start();
    server = createWorkerServer({ secret: SECRET, queue, version: "test", storeKind: "memory", runResearch: (id) => started.push(id) });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const post = (path: string, body: unknown, sign: boolean | string = true) => {
    const text = JSON.stringify(body);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (sign === true) headers[SIGNATURE_HEADER] = signRequest(SECRET, "POST", path, text);
    else if (typeof sign === "string") headers[SIGNATURE_HEADER] = sign;
    return fetch(`${base}${path}`, { method: "POST", headers, body: text });
  };

  it("reports health without secrets", async () => {
    const res = await fetch(`${base}/health`);
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(JSON.stringify(json)).not.toContain(SECRET);
  });

  it("rejects unsigned, tampered, stale and replayed requests", async () => {
    expect((await post("/v1/jobs", { name: "sources.health" }, false)).status).toBe(401);
    const good = signRequest(SECRET, "POST", "/v1/jobs", JSON.stringify({ name: "sources.health" }));
    expect((await post("/v1/jobs", { name: "sources.health", data: { evil: 1 } }, good)).status).toBe(401);
    const wrongPath = signRequest(SECRET, "POST", "/v1/research", JSON.stringify({ name: "sources.health" }));
    expect((await post("/v1/jobs", { name: "sources.health" }, wrongPath)).status).toBe(401);
    const stale = signRequest(SECRET, "POST", "/v1/jobs", JSON.stringify({ name: "sources.health" }), Date.now() - 10 * 60_000);
    expect((await post("/v1/jobs", { name: "sources.health" }, stale)).status).toBe(401);
    const other = signRequest("another-secret-which-is-also-long-enough-xx", "POST", "/v1/jobs", JSON.stringify({ name: "sources.health" }));
    expect((await post("/v1/jobs", { name: "sources.health" }, other)).status).toBe(401);
    const once = signRequest(SECRET, "POST", "/v1/jobs", JSON.stringify({ name: "discover.refresh" }));
    expect((await post("/v1/jobs", { name: "discover.refresh" }, once)).status).toBe(202);
    expect((await post("/v1/jobs", { name: "discover.refresh" }, once)).status).toBe(401);
  });

  it("enqueues known jobs once and refuses unknown ones", async () => {
    const a = await post("/v1/jobs", { name: "discover.source", data: { sourceId: "delsey-ca" } });
    expect(a.status).toBe(202);
    const b = await post("/v1/jobs", { name: "discover.source", data: { sourceId: "delsey-ca" } });
    expect(((await b.json()) as { deduplicated: boolean }).deduplicated).toBe(true);
    expect((await post("/v1/jobs", { name: "rm -rf" })).status).toBe(400);
    expect((await post("/v1/jobs", { name: "research.run" })).status).toBe(400);
  });

  it("starts research sessions by id only", async () => {
    const id = "6f1d2c1e-8a8b-4c3e-9e0f-1a2b3c4d5e6f";
    expect((await post("/v1/research", { sessionId: id })).status).toBe(202);
    expect(started).toContain(id);
    expect((await post("/v1/research", { sessionId: "../../etc/passwd" })).status).toBe(400);
  });

  it("refuses oversized bodies and unknown routes", async () => {
    expect((await post("/v1/jobs", { name: "sources.health", pad: "x".repeat(70_000) })).status).toBe(413);
    expect((await fetch(`${base}/admin`)).status).toBe(404);
  });
});

describe("MemoryQueue", () => {
  it("runs handlers, retries failures, de-duplicates singletons", async () => {
    const q = new MemoryQueue();
    await q.start();
    let attempts = 0;
    await q.work("verify.tracked", async () => {
      attempts++;
      if (attempts < 2) throw new Error("flaky");
      return "ok";
    });
    expect(await q.send("verify.tracked", {}, { singletonKey: "k", retryLimit: 2 })).not.toBeNull();
    expect(await q.send("verify.tracked", {}, { singletonKey: "k" })).toBeNull();
    await q.idle();
    expect(attempts).toBe(2);
    expect(q.completed.map((c) => c.result)).toEqual(["ok"]);
  });
});

describe("morning email fallback trigger (R1.17a)", () => {
  it("posts to the app's tick with the cron secret, and does nothing without its settings", async () => {
    const { callTick } = await import("../src/jobs");
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await callTick({} as NodeJS.ProcessEnv, fake)).toMatchObject({ status: null });
    expect(calls).toHaveLength(0);
    const r = await callTick({ APP_URL: "https://app.example.test/", CRON_SECRET: "s".repeat(40), NODE_ENV: "test" } as NodeJS.ProcessEnv, fake);
    expect(r).toEqual({ status: 200 });
    expect(calls[0].url).toBe("https://app.example.test/api/cron/tick");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["x-cron-secret"]).toBe("s".repeat(40));
  });

  it("schedules the tick every 15 minutes in Calgary time", async () => {
    const q = new MemoryQueue();
    await q.schedule("digest.tick", "*/15 * * * *", { tz: "America/Edmonton" });
    expect(q.schedules).toEqual([{ name: "digest.tick", cron: "*/15 * * * *", tz: "America/Edmonton" }]);
  });
});
