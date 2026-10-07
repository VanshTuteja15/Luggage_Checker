/* ------------------------------------------------------------------ */
/*  End to end on real Postgres: signed HTTP → pg-boss → job →         */
/*  PoliteFetcher → fetch_attempts + circuit state in the database.    */
/*  Runs under `npm run test:worker:e2e` (root), which provides a       */
/*  freshly migrated database in WORKER_TEST_DATABASE_URL. The network  */
/*  is stubbed: the job's behaviour is real, the stores are not hit.    */
/* ------------------------------------------------------------------ */

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type EngineRuntime } from "@/lib/engine/recorder";
import { SIGNATURE_HEADER, signRequest } from "@/lib/engine/signing";
import { PgEngineStore } from "@/lib/engine/store/pg";
import { createWorkerServer } from "../src/http";
import { registerJobs } from "../src/jobs";
import { PgBossQueue } from "../src/queue";

const DB = process.env.WORKER_TEST_DATABASE_URL;
const SECRET = "e2e-secret-that-is-long-enough-0123456789";

describe.skipIf(!DB)("worker end to end (Postgres + pg-boss)", () => {
  let store: PgEngineStore;
  let queue: PgBossQueue;
  let rt: EngineRuntime;
  let server: Server;
  let base: string;
  const contacted: string[] = [];

  beforeAll(async () => {
    store = new PgEngineStore(DB!, 4);
    queue = new PgBossQueue(DB!);
    const stubFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      contacted.push(url);
      if (url === "https://delsey.ca/robots.txt") return new Response("User-agent: *\nDisallow: /search\n");
      if (url === "https://delsey.ca/.well-known/ucp") return new Response('{"ucp":{"services":{}}}', { headers: { "content-type": "application/json" } });
      if (url === "https://www.canadaluggagedepot.ca/robots.txt") return new Response("blocked", { status: 403 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    rt = createRuntime(store, { fetchImpl: stubFetch, resolve: async () => ["23.227.38.65"] });
    await queue.start();
    await registerJobs(queue, rt);
    server = createWorkerServer({ secret: SECRET, queue, version: "e2e", storeKind: store.kind });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await queue.stop();
    await rt.recorder.stop();
    await store.close();
  });

  it("a signed job request runs the health job and records evidence in Postgres", async () => {
    const body = JSON.stringify({ name: "sources.health", data: { sourceIds: ["delsey-ca", "canadaluggagedepot"] } });
    const res = await fetch(`${base}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signRequest(SECRET, "POST", "/v1/jobs", body) },
      body,
    });
    expect(res.status).toBe(202);

    // pg-boss polls; wait for the job's evidence to land.
    const deadline = Date.now() + 25_000;
    let rows: { source_id: string; adapter: string; outcome: string }[] = [];
    while (Date.now() < deadline) {
      const r = await store.pool.query("SELECT source_id, adapter, outcome FROM fetch_attempts WHERE source_id IN ('delsey-ca', 'canadaluggagedepot') ORDER BY id");
      rows = r.rows;
      if (rows.length >= 3) break;
      await new Promise((x) => setTimeout(x, 500));
    }
    expect(rows).toEqual(
      expect.arrayContaining([
        { source_id: "delsey-ca", adapter: "robots", outcome: "ok" },
        { source_id: "delsey-ca", adapter: "shopify_ucp", outcome: "ok" },
        { source_id: "canadaluggagedepot", adapter: "robots", outcome: "blocked" },
      ]),
    );
    // Only registry hosts were contacted, robots.txt first.
    expect(contacted.every((u) => /^https:\/\/(delsey\.ca|www\.canadaluggagedepot\.ca)\//.test(u))).toBe(true);
  });
});
