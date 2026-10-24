/* ------------------------------------------------------------------ */
/*  DigestStore contract: the same behaviour from memory and Postgres  */
/*  Memory always runs; Postgres runs under `npm run test:db`, which    */
/*  sets ENGINE_TEST_DATABASE_URL to a freshly migrated database.       */
/* ------------------------------------------------------------------ */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { bannerFor } from "@/lib/digest/status";
import { MemoryDigestStore, PgDigestStore, type DigestStore } from "@/lib/digest/store";
import { runTick, type TickDeps } from "@/lib/digest/tick";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import { CaptureMailer } from "@/lib/mailer";
import { zonedTimeToUtc } from "@/lib/time/local";

const PG_URL = process.env.ENGINE_TEST_DATABASE_URL;

type World = {
  store: DigestStore;
  /** A user tracking these product names; returns { userId, productIds by name }. */
  user: (
    names: string[],
    opts?: { reportEmail?: string },
  ) => Promise<{ userId: string; ids: string[] }>;
  untrack: (userId: string, productId: string) => Promise<void>;
};

const pools: Pool[] = [];
afterAll(async () => {
  for (const p of pools) await p.end();
});

const worlds: { name: string; make: () => Promise<World> }[] = [
  {
    name: "MemoryDigestStore",
    make: async () => {
      const store = new MemoryDigestStore([], () => new Date("2026-10-10T15:30:00.000Z"));
      return {
        store,
        user: async (names, opts) => {
          const userId = randomUUID();
          const ids = names.map(() => randomUUID());
          names.forEach((name, i) =>
            store.tracked.push({
              userId,
              productId: ids[i],
              trackedProductId: randomUUID(),
              name,
              brand: "Samsonite",
              model: "",
              color: "",
              upc: null,
              imageUrl: null,
              targetPrice: null,
              knownUrls: [],
              lastCheckedAt: null,
            }),
          );
          if (opts?.reportEmail) store.legacy.set(userId, opts.reportEmail);
          return { userId, ids };
        },
        untrack: async (userId, productId) => store.untrack(userId, productId),
      };
    },
  },
];
if (PG_URL)
  worlds.push({
    name: "PgDigestStore",
    make: async () => {
      const pool = new Pool({ connectionString: PG_URL, max: 3 });
      pools.push(pool);
      return {
        store: new PgDigestStore(pool),
        user: async (names, opts) => {
          const { rows } = await pool.query(
            "INSERT INTO auth.users (email) VALUES ($1) RETURNING id",
            [`${randomUUID()}@example.test`],
          );
          const userId = rows[0].id as string;
          const ids: string[] = [];
          for (const name of names) {
            const { rows: p } = await pool.query(
              "INSERT INTO products (slug, name, brand) VALUES ($1, $2, 'Samsonite') RETURNING id",
              [`t-${randomUUID()}`, name],
            );
            await pool.query(
              "INSERT INTO retailer_offers (product_id, retailer, price, url) VALUES ($1, 'Canada Luggage Depot', 100, $2)",
              [p[0].id, `https://www.canadaluggagedepot.ca/products/${p[0].id}`],
            );
            await pool.query("INSERT INTO tracked_products (user_id, product_id) VALUES ($1, $2)", [
              userId,
              p[0].id,
            ]);
            ids.push(p[0].id as string);
          }
          if (opts?.reportEmail)
            // A sign-up trigger already made the row (000_complete_setup).
            await pool.query(
              `INSERT INTO user_settings (user_id, report_email) VALUES ($1, $2)
               ON CONFLICT (user_id) DO UPDATE SET report_email = EXCLUDED.report_email`,
              [userId, opts.reportEmail],
            );
          return { userId, ids };
        },
        untrack: async (userId, productId) => {
          await pool.query("DELETE FROM tracked_products WHERE user_id = $1 AND product_id = $2", [
            userId,
            productId,
          ]);
        },
      };
    },
  });

for (const w of worlds) {
  describe(w.name, () => {
    it("creates settings once with the seed, then saves partial changes", async () => {
      const { store, user } = await w.make();
      const { userId } = await user([], { reportEmail: "old@example.test" });
      expect(await store.legacyReportEmail(userId)).toBe("old@example.test");
      const s = await store.ensureSettings(userId, ["old@example.test"]);
      expect(s).toMatchObject({
        enabled: true,
        sendTime: "09:00",
        timeZone: "America/Edmonton",
        recipients: ["old@example.test"],
      });
      expect((await store.ensureSettings(userId, ["other@example.test"])).recipients).toEqual([
        "old@example.test",
      ]);
      const u = await store.updateSettings(userId, {
        sendTime: "08:30",
        timeZone: "America/Toronto",
      });
      expect(u).toMatchObject({ sendTime: "08:30", timeZone: "America/Toronto", enabled: true });
      expect((await store.updateSettings(userId, { enabled: false })).sendTime).toBe("08:30");
      expect((await store.enabledAccounts()).some((a) => a.userId === userId)).toBe(false);
    });

    it("keeps the chosen products in order, only the user's own, and drops untracked ones", async () => {
      const { store, user, untrack } = await w.make();
      const a = await user(["Alpha Medium", "Bravo Medium", "Charlie Medium"]);
      const b = await user(["Delta Medium"]);
      expect(await store.setChosen(a.userId, [a.ids[2], a.ids[0], b.ids[0]])).toBe(2);
      let list = await store.listTracked(a.userId);
      expect(list.filter((t) => t.chosen).map((t) => t.name)).toEqual([
        "Charlie Medium",
        "Alpha Medium",
      ]);
      expect(list).toHaveLength(3);
      expect(await store.addChosen(a.userId, a.ids[1])).toBe(true);
      expect(await store.addChosen(a.userId, a.ids[1])).toBe(true); // already there: no duplicate
      expect(await store.addChosen(a.userId, b.ids[0])).toBe(false);
      list = await store.listTracked(a.userId);
      expect(list.filter((t) => t.chosen).map((t) => t.name)).toEqual([
        "Charlie Medium",
        "Alpha Medium",
        "Bravo Medium",
      ]);
      await store.removeChosen(a.userId, a.ids[0]);
      await untrack(a.userId, a.ids[2]);
      list = await store.listTracked(a.userId);
      expect(list.filter((t) => t.chosen).map((t) => t.name)).toEqual(["Bravo Medium"]);
      if (w.name === "PgDigestStore") expect(list[0].knownUrls[0]).toMatch(/^https:\/\//);
    });

    it("claims one daily run per local date, logs tests, and counts emails", async () => {
      const { store, user } = await w.make();
      const { userId } = await user([]);
      const claimed = await store.claimDaily(userId, "2026-10-10", "2026-10-10T15:00:00.000Z", []);
      expect(claimed?.status).toBe("claimed");
      expect(
        await store.claimDaily(userId, "2026-10-10", "2026-10-10T15:01:00.000Z", []),
      ).toBeNull();
      expect(
        await store.claimDaily(userId, "2026-10-11", "2026-10-11T15:00:00.000Z", ["late"]),
      ).not.toBeNull();
      await store.updateRun(claimed!.id, {
        status: "partial",
        sentAt: "2026-10-10T15:02:00.000Z",
        recipients: [
          {
            address: "a@x.test",
            status: "sent",
            providerId: "1",
            error: null,
            attempts: 1,
            at: "2026-10-10T15:02:00.000Z",
          },
          {
            address: "b@x.test",
            status: "failed",
            providerId: null,
            error: "Refused.",
            attempts: 3,
            at: "2026-10-10T15:02:00.000Z",
          },
        ],
        productCount: 4,
        snapshot: { subject: "s", summary: ["a", "b", "c"], products: ["p"] },
      });
      await store.insertRun({
        userId,
        localDate: "2026-10-10",
        kind: "test",
        status: "sent",
        claimedAt: "2026-10-10T16:00:00.000Z",
        preparedAt: null,
        sentAt: "2026-10-10T16:00:01.000Z",
        recipients: [
          {
            address: "a@x.test",
            status: "sent",
            providerId: "2",
            error: null,
            attempts: 1,
            at: "2026-10-10T16:00:01.000Z",
          },
        ],
        productCount: 4,
        snapshot: null,
        error: null,
        notes: [],
      });
      const daily = await store.getDailyRun(userId, "2026-10-10");
      expect(daily).toMatchObject({ status: "partial", productCount: 4, localDate: "2026-10-10" });
      expect(daily!.recipients[1]).toMatchObject({ status: "failed", error: "Refused." });
      const runs = await store.listRuns(userId, "2026-10-01");
      expect(runs.map((r) => [r.localDate, r.kind])).toEqual([
        ["2026-10-11", "daily"],
        ["2026-10-10", "test"],
        ["2026-10-10", "daily"],
      ]);
      expect(runs[0].notes).toEqual(["late"]);
      expect(await store.testSendsSince(userId, "2026-10-10T15:30:00.000Z")).toBe(1);
      // 1 + 3 attempts on the daily, 1 on the test; the instant filter applies.
      expect(await store.emailsSentSince("2026-10-10T00:00:00.000Z")).toBeGreaterThanOrEqual(5);
      expect(await store.emailsSentSince("2026-10-10T15:30:00.000Z")).toBeGreaterThanOrEqual(1);
    });

    it("runs the scheduler on this store: prepare, one send under parallel ticks, partial failure, banner", async () => {
      const { store, user } = await w.make();
      const a = await user(["Echo Medium"]);
      await store.ensureSettings(a.userId, []);
      await store.updateSettings(a.userId, { recipients: ["ok@example.test", "bad@example.test"] });
      await store.setChosen(a.userId, a.ids);
      // Other accounts in a shared test database must not be ticked here (the sign-up
      // trigger gave each an old-report address, so migrate them first, then switch off).
      for (const id of await store.accountsToMigrate()) await store.ensureSettings(id, []);
      for (const other of await store.enabledAccounts())
        if (other.userId !== a.userId) await store.updateSettings(other.userId, { enabled: false });
      const mailer = new CaptureMailer({
        "bad@example.test": "That address was refused by the email service. Check it for typos.",
      });
      let now = zonedTimeToUtc("2026-10-10", "08:00", "America/Edmonton");
      let prepares = 0;
      const deps: TickDeps = {
        store,
        engine: new MemoryEngineStore(SOURCE_SEED),
        pack: luggagePack,
        sources: async () => SOURCE_SEED,
        mailer,
        appUrl: "https://luggage.example.test",
        now: () => now,
        sleep: async () => undefined,
        dailyLimit: 1000,
        prepare: async () => {
          prepares++;
          return { done: true, verified: 1, estimated: 0 };
        },
      };
      await runTick(deps);
      expect(prepares).toBe(1);
      expect((await store.getDailyRun(a.userId, "2026-10-10"))?.preparedAt).not.toBeNull();
      now = zonedTimeToUtc("2026-10-10", "09:00", "America/Edmonton");
      await Promise.all([runTick(deps), runTick(deps), runTick(deps), runTick(deps)]);
      now = zonedTimeToUtc("2026-10-10", "09:15", "America/Edmonton");
      await runTick(deps);
      expect(mailer.sent.map((m) => m.to)).toEqual(["ok@example.test"]);
      const run = await store.getDailyRun(a.userId, "2026-10-10");
      expect(run).toMatchObject({ status: "partial", productCount: 1 });
      const settings = (await store.getSettings(a.userId))!;
      expect(bannerFor(run, settings)).toBe(
        "Today's 9:00 a.m. email didn't reach 1 of 2 people: That address was refused by the email service. Check it for typos.",
      );
      expect(prepares).toBe(1);
    });
  });
}
