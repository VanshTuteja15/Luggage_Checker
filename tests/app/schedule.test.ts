/* ------------------------------------------------------------------ */
/*  Morning email scheduler (A1.1, R1.4–R1.7)                          */
/*                                                                     */
/*  A fake clock ticks the scheduler minute by minute across whole      */
/*  local days, including both 2026–27 DST days in Calgary, with a      */
/*  capturing mailer: exactly one send per local day at 09:00, none at  */
/*  08:59, catch-up until 11:59, "missed" from 12:00, and the banner    */
/*  and next-day note after a partial failure.                         */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { planFor } from "@/lib/digest/schedule";
import { bannerFor } from "@/lib/digest/status";
import { MemoryDigestStore } from "@/lib/digest/store";
import { runTick, type PrepareFn, type TickDeps } from "@/lib/digest/tick";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { CaptureMailer } from "@/lib/mailer";
import { addDays, localParts, zonedTimeToUtc } from "@/lib/time/local";

const TZ = "America/Edmonton";
const USER = "00000000-0000-4000-8000-0000000000aa";
const PRODUCT = "11111111-1111-4111-8111-111111111111";

const at = (date: string, hhmm: string) => zonedTimeToUtc(date, hhmm, TZ);

function world(opts: { mailer?: CaptureMailer | null; recipients?: string[] } = {}) {
  let now = new Date("2026-10-10T06:00:00.000Z");
  const store = new MemoryDigestStore(
    [
      {
        userId: USER,
        productId: PRODUCT,
        trackedProductId: "t-1",
        name: "Samsonite Paralux Hardside Spinner Medium",
        brand: "Samsonite",
        model: "Paralux",
        color: "",
        upc: null,
        imageUrl: null,
        targetPrice: null,
        knownUrls: [],
        lastCheckedAt: null,
      },
    ],
    () => now,
  );
  const mailer = opts.mailer === undefined ? new CaptureMailer() : opts.mailer;
  const prepares: { at: Date; budgetMs: number }[] = [];
  const prepare: PrepareFn = async (_u, _chosen, ctx) => {
    prepares.push({ at: ctx.now, budgetMs: ctx.deadlineAt - Date.now() });
    return { done: true, verified: 1, estimated: 0 };
  };
  const daily: Date[] = [];
  const deps: TickDeps = {
    store,
    engine: new MemoryEngineStore(SOURCE_SEED),
    pack: luggagePack,
    sources: async () => SOURCE_SEED,
    mailer,
    appUrl: "https://luggage.example.test",
    now: () => now,
    sleep: async () => undefined,
    dailyLimit: 90,
    prepare,
    dailyJobs: async (d) => {
      daily.push(d);
      return null;
    },
  };
  const setNow = (d: Date) => {
    now = d;
  };
  return {
    deps,
    store,
    mailer,
    prepares,
    daily,
    setNow,
    recipients: opts.recipients ?? ["a@example.test"],
  };
}

async function setup(w: ReturnType<typeof world>) {
  await w.store.updateSettings(USER, { recipients: w.recipients });
  await w.store.setChosen(USER, [PRODUCT]);
}

/** Tick every `step` minutes from local midnight of `date` to the next local midnight. */
async function tickDay(w: ReturnType<typeof world>, date: string, step = 1) {
  const start = at(date, "00:00").getTime();
  const end = at(addDays(date, 1), "00:00").getTime();
  let ticks = 0;
  for (let t = start; t < end; t += step * 60_000, ticks++) {
    w.setNow(new Date(t));
    await runTick(w.deps);
  }
  return ticks;
}

const localClock = (d: Date) => {
  const p = localParts(d, TZ);
  return `${p.date} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
};

describe("when the email is due (R1.4)", () => {
  it("puts 09:00 Calgary time on the right UTC instant on both DST days", () => {
    expect(at("2026-10-10", "09:00").toISOString()).toBe("2026-10-10T15:00:00.000Z"); // MDT
    expect(at("2026-11-01", "09:00").toISOString()).toBe("2026-11-01T16:00:00.000Z"); // back to MST
    expect(at("2027-03-14", "09:00").toISOString()).toBe("2027-03-14T15:00:00.000Z"); // forward to MDT
    expect(planFor(new Date("2026-11-01T16:00:00.000Z"), "09:00", TZ)).toMatchObject({
      localDate: "2026-11-01",
      phase: "send",
      late: false,
    });
    expect(planFor(new Date("2026-11-01T15:59:00.000Z"), "09:00", TZ).phase).toBe("prepare");
    expect(planFor(new Date("2027-03-14T14:59:00.000Z"), "09:00", TZ).phase).toBe("prepare");
  });

  it("names the phases: prepare from 8:00, send until noon, then missed", () => {
    const p = (hhmm: string) => planFor(at("2026-10-10", hhmm), "09:00", TZ);
    expect(p("07:59").phase).toBe("early");
    expect(p("08:00").phase).toBe("prepare");
    expect(p("08:59").phase).toBe("prepare");
    expect(p("09:00").phase).toBe("send");
    expect(p("09:29").late).toBe(false);
    expect(p("09:30").late).toBe(true);
    expect(p("11:59").phase).toBe("send");
    expect(p("12:00").phase).toBe("after");
    // A send time after 11:45 keeps a full 15-minute window.
    expect(planFor(at("2026-10-10", "13:10"), "13:00", TZ).phase).toBe("send");
    expect(planFor(at("2026-10-10", "13:15"), "13:00", TZ).phase).toBe("after");
  });
});

describe("exactly one email per local day (A1.1)", () => {
  for (const date of ["2026-10-10", "2026-11-01", "2027-03-14"]) {
    it(`ticking every minute on ${date} sends once, at 09:00 local`, async () => {
      const w = world();
      await setup(w);
      const ticks = await tickDay(w, date);
      // The local day is 25 hours on Nov 1 and 23 hours on Mar 14.
      expect(ticks).toBe(date === "2026-11-01" ? 1500 : date === "2027-03-14" ? 1380 : 1440);
      expect(w.mailer!.sent).toHaveLength(1);
      const run = await w.store.getDailyRun(USER, date);
      expect(run).toMatchObject({ status: "sent", notes: [] });
      expect(localClock(new Date(run!.sentAt!))).toBe(`${date} 09:00`);
      // Fresh prices once, at 08:00 local; not repeated once done.
      expect(w.prepares.map((p) => localClock(p.at))).toEqual([`${date} 08:00`]);
      expect(w.daily).toHaveLength(ticks); // asked every tick; it claims its own once-a-day run
    });
  }

  it("sends nothing at 08:59, once from 09:00, and repeated or parallel ticks never send again", async () => {
    const w = world();
    await setup(w);
    w.setNow(at("2026-10-10", "08:59"));
    await runTick(w.deps);
    expect(w.mailer!.sent).toHaveLength(0);
    w.setNow(at("2026-10-10", "09:00"));
    await Promise.all([runTick(w.deps), runTick(w.deps), runTick(w.deps)]);
    for (const hhmm of ["09:01", "09:05", "09:14", "10:00", "11:59", "12:00", "18:00"]) {
      w.setNow(at("2026-10-10", hhmm));
      await runTick(w.deps);
    }
    expect(w.mailer!.sent).toHaveLength(1);
    expect(w.mailer!.sent[0].subject).toMatch(/^Luggage prices · Sat Oct 10/);
  });

  it("catches up a missed window until 11:59 with a late-scheduler note, and does a quick re-check first", async () => {
    const w = world();
    await setup(w);
    w.setNow(at("2026-10-10", "11:59"));
    await runTick(w.deps);
    expect(w.mailer!.sent).toHaveLength(1);
    const run = await w.store.getDailyRun(USER, "2026-10-10");
    expect(run?.notes).toEqual([
      "The scheduler was late: nothing ran at 9:00 a.m., so the email went out at 11:59 a.m. instead.",
    ]);
    expect(w.prepares).toHaveLength(1);
    expect(w.prepares[0].budgetMs).toBeLessThanOrEqual(40_000);
  });

  it("logs a window missed until noon as missed, never sends it, and says so the next day", async () => {
    const w = world();
    await setup(w);
    w.setNow(at("2026-10-10", "12:00"));
    await runTick(w.deps);
    w.setNow(at("2026-10-10", "16:30"));
    await runTick(w.deps);
    expect(w.mailer!.sent).toHaveLength(0);
    const run = await w.store.getDailyRun(USER, "2026-10-10");
    expect(run).toMatchObject({ status: "missed" });
    expect(run?.error).toBe(
      "The app wasn't running between 9:00 a.m. and 12:00 p.m., so today's email wasn't sent.",
    );
    expect(bannerFor(run, (await w.store.getSettings(USER))!)).toMatch(/was missed/);
    w.setNow(at("2026-10-11", "09:00"));
    await runTick(w.deps);
    expect(w.mailer!.sent).toHaveLength(1);
    expect(w.mailer!.sent[0].text).toContain(
      "Note: Yesterday's email wasn't sent: the app wasn't running in time.",
    );
  });
});

describe("failures are visible (R1.7)", () => {
  it("records a partial failure per address, shows the banner, and notes it in the next email", async () => {
    const mailer = new CaptureMailer({
      "b@example.test": "That address was refused by the email service. Check it for typos.",
    });
    const w = world({ mailer, recipients: ["a@example.test", "b@example.test"] });
    await setup(w);
    w.setNow(at("2026-10-10", "09:00"));
    await runTick(w.deps);
    const run = await w.store.getDailyRun(USER, "2026-10-10");
    expect(run?.status).toBe("partial");
    expect(run?.recipients.map((r) => [r.address, r.status])).toEqual([
      ["a@example.test", "sent"],
      ["b@example.test", "failed"],
    ]);
    expect(bannerFor(run, (await w.store.getSettings(USER))!)).toBe(
      "Today's 9:00 a.m. email didn't reach 1 of 2 people: That address was refused by the email service. Check it for typos.",
    );
    w.setNow(at("2026-10-11", "09:00"));
    await runTick(w.deps);
    expect(mailer.sent.at(-1)!.html).toContain(
      "Yesterday&#39;s email didn&#39;t reach 1 of 2 people".replace(/&#39;/g, "'"),
    );
  });

  it("fails loudly when email isn't set up, and skips quietly with nobody to send to", async () => {
    const off = world({ mailer: null });
    await setup(off);
    off.setNow(at("2026-10-10", "09:00"));
    await runTick(off.deps);
    expect(await off.store.getDailyRun(USER, "2026-10-10")).toMatchObject({
      status: "failed",
      error: "Email isn't set up yet. The person who set up LuggageTracker can connect it.",
    });

    const nobody = world({ recipients: [] });
    await setup(nobody);
    nobody.setNow(at("2026-10-10", "09:00"));
    await runTick(nobody.deps);
    expect(await nobody.store.getDailyRun(USER, "2026-10-10")).toMatchObject({ status: "skipped" });
    expect(nobody.mailer!.sent).toHaveLength(0);
  });

  it("does nothing for an account that switched the email off", async () => {
    const w = world();
    await setup(w);
    await w.store.updateSettings(USER, { enabled: false });
    await tickDay(w, "2026-10-10", 15);
    expect(w.mailer!.sent).toHaveLength(0);
    expect(await w.store.getDailyRun(USER, "2026-10-10")).toBeNull();
  });
});

describe("the old daily report moves over (R1.14)", () => {
  it("gives an old report account its address as recipient and every tracked product, then sends", async () => {
    const w = world();
    w.store.legacy.set(USER, "Reports@Example.test");
    w.setNow(at("2026-10-10", "09:00"));
    const result = await runTick(w.deps, { emailOnly: true });
    expect(w.daily).toHaveLength(0); // the delegated report doesn't run the engine jobs
    expect(result.accounts[0]).toMatchObject({ status: "sent" });
    expect((await w.store.getSettings(USER))?.recipients).toEqual(["reports@example.test"]);
    expect(w.mailer!.sent.map((m) => m.to)).toEqual(["reports@example.test"]);
    expect(w.mailer!.sent[0].text).toContain("SAMSONITE PARALUX HARDSIDE SPINNER MEDIUM");
  });
});

describe("the tick endpoint (R1.15, §10)", () => {
  it("is POST only, refuses a missing or wrong secret, and says plainly when there's no database", async () => {
    const route = await import("@/app/api/cron/tick/route");
    expect("GET" in route).toBe(false);
    const { NextRequest } = await import("next/server");
    const req = (secret?: string) =>
      new NextRequest("https://app.example.test/api/cron/tick", {
        method: "POST",
        headers: secret ? { "x-cron-secret": secret } : {},
      });
    const before = { secret: process.env.CRON_SECRET, db: process.env.DATABASE_URL };
    process.env.CRON_SECRET = "s".repeat(40);
    delete process.env.DATABASE_URL;
    try {
      expect((await route.POST(req())).status).toBe(401);
      expect((await route.POST(req("wrong"))).status).toBe(401);
      const res = await route.POST(req("s".repeat(40)));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toMatch(/price database/);
    } finally {
      if (before.secret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = before.secret;
      if (before.db !== undefined) process.env.DATABASE_URL = before.db;
    }
  });
});
