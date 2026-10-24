/* ------------------------------------------------------------------ */
/*  Morning email: the scheduler tick (R1.4–R1.7, R1.15)               */
/*                                                                     */
/*  Safe to call every minute from any number of triggers (Supabase    */
/*  pg_cron, the worker, Vercel Cron). For each account it decides     */
/*  what is due now and does it once:                                  */
/*    prepare  claim today's run, re-check the chosen products         */
/*    send     lock the run ("sending"), build, send per recipient,    */
/*             record each address's outcome                           */
/*    missed   after the cutoff, log it; never send late in the day    */
/*  Two locks make duplicates impossible: the unique daily row         */
/*  (INSERT … ON CONFLICT DO NOTHING) and the claimed → sending update. */
/* ------------------------------------------------------------------ */

import { maskEmail } from "@/lib/mailer";
import { allStoresChosen, enabledStoreIds } from "@/lib/stores";
import { formatClock, formatTime } from "@/lib/time/local";
import { clockText } from "./build";
import {
  DigestError,
  checkDailyLimit,
  composeDigest,
  deliver,
  runStatusOf,
  settingsFor,
  snapshotOf,
  type DigestDeps,
} from "./run";
import { planFor, type Phase, type SchedulePlan } from "./schedule";
import type { DigestRun, DigestSettings, RunPatch, RunStatus, TrackedChoice } from "./store";

export type PrepareResult = {
  /** Every chosen product was re-checked (or tried) this window. */
  done: boolean;
  verified: number;
  estimated: number;
};

export type PrepareFn = (
  userId: string,
  chosen: TrackedChoice[],
  ctx: {
    now: Date;
    since: Date;
    deadlineAt: number;
    storeIds: ReadonlySet<string> | null;
    timeZone: string;
  },
) => Promise<PrepareResult>;

export type TickDeps = DigestDeps & {
  /** Fresh prices before the send (engine, then web estimates). Absent: skip. */
  prepare?: PrepareFn;
  /** The daily engine jobs and retention; does its own once-a-day claim. */
  dailyJobs?: (now: Date) => Promise<Record<string, unknown> | null>;
  /** Time this tick may spend on prepare work (ms). */
  budgetMs?: number;
};

export type AccountTick = {
  account: string;
  localDate: string;
  phase: Phase;
  actions: string[];
  status: RunStatus | null;
};

export type TickResult = {
  at: string;
  daily: Record<string, unknown> | null;
  accounts: AccountTick[];
};

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "sent",
  "partial",
  "failed",
  "missed",
  "skipped",
]);

/** The send lock was taken but nothing finished after this long: the send was cut off. */
const STALE_SENDING_MS = 30 * 60_000;

async function chosenFor(deps: TickDeps, userId: string): Promise<TrackedChoice[]> {
  return (await deps.store.listTracked(userId))
    .filter((t) => t.chosen)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

async function storeIdsFor(deps: TickDeps, userId: string): Promise<ReadonlySet<string> | null> {
  const saved = await deps.store.savedStores(userId).catch(() => null);
  return allStoresChosen(saved) ? null : new Set(enabledStoreIds(saved));
}

async function claim(
  deps: TickDeps,
  s: DigestSettings,
  plan: SchedulePlan,
  notes: string[],
): Promise<DigestRun | null> {
  const now = deps.now().toISOString();
  return (
    (await deps.store.claimDaily(s.userId, plan.localDate, now, notes)) ??
    (await deps.store.getDailyRun(s.userId, plan.localDate))
  );
}

async function runPrepare(
  deps: TickDeps,
  s: DigestSettings,
  plan: SchedulePlan,
  budgetMs: number,
): Promise<PrepareResult | null> {
  if (!deps.prepare) return null;
  const chosen = await chosenFor(deps, s.userId);
  if (chosen.length === 0) return { done: true, verified: 0, estimated: 0 };
  return deps.prepare(s.userId, chosen, {
    now: deps.now(),
    since: plan.prepareStart,
    deadlineAt: Date.now() + budgetMs,
    storeIds: await storeIdsFor(deps, s.userId),
    timeZone: s.timeZone,
  });
}

async function send(
  deps: TickDeps,
  s: DigestSettings,
  run: DigestRun,
  notes: string[],
): Promise<RunStatus> {
  const finish = async (patch: RunPatch & { status: RunStatus }) => {
    await deps.store.updateRun(run.id, { ...patch, notes });
    return patch.status;
  };
  if (s.recipients.length === 0)
    return finish({ status: "skipped", error: "Nobody is on the recipient list." });
  const composed = await composeDigest(deps, s.userId);
  if (composed.productCount === 0)
    return finish({ status: "skipped", error: "No products are chosen for the email." });
  if (!deps.mailer)
    return finish({
      status: "failed",
      productCount: composed.productCount,
      snapshot: snapshotOf(composed.view),
      error: "Email isn't set up yet. The person who set up LuggageTracker can connect it.",
    });
  try {
    await checkDailyLimit(deps, s.recipients.length);
  } catch (err) {
    if (!(err instanceof DigestError)) throw err;
    return finish({ status: "failed", productCount: composed.productCount, error: err.message });
  }
  const recipients = await deliver(
    deps,
    { subject: composed.view.subject, html: composed.html, text: composed.text },
    s.recipients,
  );
  const status = runStatusOf(recipients);
  const failed = recipients.filter((r) => r.status === "failed");
  if (failed.length)
    console.error(
      `digest: ${failed.length} of ${recipients.length} not delivered (${failed.map((r) => maskEmail(r.address)).join(", ")})`,
    );
  return finish({
    status,
    sentAt: status === "failed" ? null : deps.now().toISOString(),
    recipients,
    productCount: composed.productCount,
    snapshot: snapshotOf(composed.view),
    error: status === "failed" ? (failed[0]?.error ?? "The email couldn't be sent.") : null,
  });
}

async function tickAccount(
  deps: TickDeps,
  s: DigestSettings,
  budgetMs: number,
): Promise<AccountTick> {
  const now = deps.now();
  const plan = planFor(now, s.sendTime, s.timeZone);
  const out: AccountTick = {
    account: s.userId.slice(0, 8),
    localDate: plan.localDate,
    phase: plan.phase,
    actions: [],
    status: null,
  };
  let run = await deps.store.getDailyRun(s.userId, plan.localDate);
  out.status = run?.status ?? null;
  if (run && TERMINAL.has(run.status)) return out;

  const at = clockText(formatClock(plan.sendMinutes));
  const until = clockText(formatClock(plan.cutoff));

  if (plan.phase === "after") {
    if (run?.status === "sending") {
      if (now.getTime() - Date.parse(run.claimedAt) < STALE_SENDING_MS) return out;
      await deps.store.updateRun(run.id, {
        status: "failed",
        error: "Sending was interrupted. Some people may not have received today's email.",
      });
      out.status = "failed";
      out.actions.push("interrupted");
      return out;
    }
    run = run ?? (await claim(deps, s, plan, []));
    if (!run || TERMINAL.has(run.status) || run.status === "sending") return out;
    await deps.store.updateRun(run.id, {
      status: "missed",
      error: `The app wasn't running between ${at} and ${until}, so today's email wasn't sent.`,
    });
    out.status = "missed";
    out.actions.push("missed");
    return out;
  }

  if (plan.phase === "prepare") {
    run = run ?? (await claim(deps, s, plan, []));
    if (!run || run.preparedAt || run.status === "sending") return out;
    if (run.status === "claimed") await deps.store.updateRun(run.id, { status: "preparing" });
    const res = await runPrepare(deps, s, plan, budgetMs);
    out.actions.push(
      res ? `prepare: ${res.verified} re-checked, ${res.estimated} estimated` : "prepare skipped",
    );
    if (!res || res.done)
      await deps.store.updateRun(run.id, { preparedAt: now.toISOString(), status: "claimed" });
    out.status = "claimed";
    return out;
  }

  if (plan.phase === "send") {
    const notes = [...(run?.notes ?? [])];
    if (plan.late && !notes.some((n) => n.startsWith("The scheduler was late")))
      notes.push(
        `The scheduler was late: nothing ran at ${at}, so the email went out at ${formatTime(now, s.timeZone)} instead.`,
      );
    run = run ?? (await claim(deps, s, plan, notes));
    if (!run || !(await deps.store.lockForSending(run.id))) return out;
    out.actions.push("locked");
    if (!run.preparedAt) {
      // The prepare window was missed (app down at send − 60): a short re-check first.
      const res = await runPrepare(deps, s, plan, Math.min(budgetMs, 40_000)).catch(() => null);
      if (res)
        out.actions.push(`quick prepare: ${res.verified} re-checked, ${res.estimated} estimated`);
      await deps.store.updateRun(run.id, { preparedAt: deps.now().toISOString() });
    }
    try {
      out.status = await send(deps, s, run, notes);
    } catch (err) {
      console.error(`digest: send for ${out.account} failed`, err);
      await deps.store.updateRun(run.id, {
        status: "failed",
        notes,
        error: "Something went wrong building today's email. It will try again tomorrow.",
      });
      out.status = "failed";
    }
    out.actions.push(`send: ${out.status}`);
  }
  return out;
}

/** One tick for every account with the email switched on. Never throws for one account's problem. */
export async function runTick(
  deps: TickDeps,
  opts: { emailOnly?: boolean } = {},
): Promise<TickResult> {
  const now = deps.now();
  const budgetMs = deps.budgetMs ?? 150_000;
  let daily: Record<string, unknown> | null = null;
  if (!opts.emailOnly && deps.dailyJobs)
    daily = await deps.dailyJobs(now).catch((err: unknown) => {
      console.error("tick: daily engine jobs failed", err);
      return { error: "The daily price check couldn't run." };
    });

  // Accounts still on the old daily report get their settings on the first tick (R1.14).
  for (const userId of await deps.store.accountsToMigrate().catch(() => []))
    await settingsFor(deps.store, userId).catch(() => undefined);

  const accounts: AccountTick[] = [];
  for (const s of await deps.store.enabledAccounts()) {
    try {
      accounts.push(await tickAccount(deps, s, budgetMs));
    } catch (err) {
      console.error(`tick: account ${s.userId.slice(0, 8)} failed`, err);
      accounts.push({
        account: s.userId.slice(0, 8),
        localDate: "",
        phase: "early",
        actions: ["error"],
        status: null,
      });
    }
  }
  return { at: now.toISOString(), daily, accounts };
}
