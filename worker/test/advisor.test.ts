import { afterEach, describe, expect, it } from "vitest";
import { resolveFlags, type FlagSet } from "@/lib/engine/flags";
import { adviseReview, setReviewAdvisor } from "@/lib/engine/identity/match";
import type { EngineRuntime } from "@/lib/engine/recorder";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { registerJobs } from "../src/jobs";
import type { JobQueue } from "../src/queue";

/* v4 A5.3 / U-MATCH-6: a near-match review asks the AI judge on the ai.small lane only when
   ai.enabled and ai.match_judge are both on; the answer is advice beside the review. */

function fakeQueue() {
  const sent: { name: string; data: Record<string, unknown> }[] = [];
  const queue = {
    kind: "memory",
    start: async () => {},
    stop: async () => {},
    work: async () => {},
    send: async (name: string, data: Record<string, unknown>) => {
      sent.push({ name, data });
      return "job-1";
    },
  } as unknown as JobQueue;
  return { queue, sent };
}

const runtime = (flags: FlagSet) =>
  ({
    flags: async () => flags,
    config: { ai: { model: "qwen2.5:3b" } },
    store: new MemoryEngineStore(SOURCE_SEED),
  }) as unknown as EngineRuntime;

const request = {
  a: "Samsonite Outline Pro Signature Medium Spinner",
  b: "Samsonite Outline Pro Medium Spinner",
  storeA: "unluggage",
  storeB: "our catalogue",
};

describe("review advice on the AI lane (U-MATCH-6)", () => {
  afterEach(() => setReviewAdvisor(null));

  it("queues nothing while the AI flags are off (the default)", async () => {
    const { queue, sent } = fakeQueue();
    await registerJobs(queue, runtime(resolveFlags()));
    await adviseReview(request);
    expect(sent).toEqual([]);
  });

  it("ai.enabled alone isn't enough; with ai.match_judge too, one match_judge job on ai.small", async () => {
    const { queue, sent } = fakeQueue();
    await registerJobs(queue, runtime({ ...resolveFlags(), "ai.enabled": true }));
    await adviseReview(request);
    expect(sent).toEqual([]);

    setReviewAdvisor(null);
    await registerJobs(
      queue,
      runtime({ ...resolveFlags(), "ai.enabled": true, "ai.match_judge": true }),
    );
    await adviseReview(request);
    expect(sent).toEqual([{ name: "ai.small", data: { task: "match_judge", input: request } }]);
  });
});
