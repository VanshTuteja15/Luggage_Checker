/* ------------------------------------------------------------------ */
/*  Morning email: compose and deliver (R1.6, R1.7, R1.13)             */
/*                                                                     */
/*  composeDigest gathers one account's chosen products and their       */
/*  engine prices and builds the view model; the preview, the test     */
/*  send and the daily send all go through it. deliver sends one       */
/*  message per recipient (nobody sees the other addresses), retries   */
/*  a temporary failure twice with a pause, and records each address's */
/*  outcome in plain words. Sends that would pass the daily limit are  */
/*  refused before anything goes out.                                  */
/* ------------------------------------------------------------------ */

import type { EngineStore } from "@/lib/engine/store/port";
import type { CategoryPack, SourceRecord } from "@/lib/engine/types";
import {
  emailDailyLimit,
  emailMonthlyLimit,
  maskEmail,
  monthStartUtc,
  type Mailer,
  type MailMessage,
} from "@/lib/mailer";
import { allStoresChosen, enabledStoreIds } from "@/lib/stores";
import { addDays, localDate } from "@/lib/time/local";
import { buildDigest, type DigestProductInput, type DigestView } from "./build";
import { renderDigestHtml } from "./html";
import { pricesFor } from "./prices";
import type { DigestRun, DigestSettings, DigestStore, RunRecipient, RunSnapshot } from "./store";
import { renderDigestText } from "./text";

export type DigestDeps = {
  store: DigestStore;
  engine: EngineStore;
  pack: CategoryPack;
  sources: () => Promise<SourceRecord[]>;
  /** null when no email provider is configured. */
  mailer: Mailer | null;
  appUrl: string;
  now: () => Date;
  /** Waits between retries (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** EMAIL_DAILY_LIMIT; read from the environment when omitted. */
  dailyLimit?: number;
  /** EMAIL_MONTHLY_LIMIT; read from the environment when omitted. */
  monthlyLimit?: number;
};

/** A refusal with a plain sentence for the person and an HTTP status for the route. */
export class DigestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DigestError";
  }
}

export const TEST_SENDS_PER_HOUR = 5;
const RETRY_DELAYS_MS = [1_000, 4_000];
/** Resend's free plan allows two requests a second. */
const GAP_MS = 600;

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The settings row, created on first use (R1.14). An account whose old daily
 * report was on keeps getting what it got: its report address becomes the
 * first recipient and every tracked product is chosen (the old report covered
 * them all). The owner can change both on Morning Email.
 */
export async function settingsFor(store: DigestStore, userId: string): Promise<DigestSettings> {
  const existing = await store.getSettings(userId);
  if (existing) return existing;
  const legacy = await store.legacyReportEmail(userId).catch(() => null);
  const settings = await store.ensureSettings(userId, legacy ? [legacy.toLowerCase()] : []);
  if (legacy) {
    const tracked = await store.listTracked(userId);
    if (!tracked.some((t) => t.chosen))
      await store.setChosen(
        userId,
        tracked.map((t) => t.productId),
      );
  }
  return settings;
}

/** R1.7: the next email starts with a short note when yesterday's had a problem. */
export async function previousNote(
  store: DigestStore,
  userId: string,
  today: string,
): Promise<string | null> {
  const run = await store.getDailyRun(userId, addDays(today, -1)).catch(() => null);
  if (!run) return null;
  if (run.status === "missed")
    return "Yesterday's email wasn't sent: the app wasn't running in time. Today's prices are below.";
  if (run.status === "failed")
    return `Yesterday's email didn't reach anyone${run.error ? `: ${run.error}` : "."}`;
  if (run.status === "partial") {
    const failed = run.recipients.filter((r) => r.status === "failed");
    const reason = failed.find((r) => r.error)?.error;
    return `Yesterday's email didn't reach ${failed.length} of ${run.recipients.length} people${reason ? `: ${reason}` : "."}`;
  }
  return null;
}

export type Composed = {
  settings: DigestSettings;
  view: DigestView;
  html: string;
  text: string;
  productCount: number;
};

export async function composeDigest(
  deps: DigestDeps,
  userId: string,
  opts: { note?: string | null } = {},
): Promise<Composed> {
  const now = deps.now();
  const settings = await settingsFor(deps.store, userId);
  const today = localDate(now, settings.timeZone);
  const chosen = (await deps.store.listTracked(userId))
    .filter((t) => t.chosen)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const saved = await deps.store.savedStores(userId).catch(() => null);
  const storeIds = allStoresChosen(saved) ? null : new Set(enabledStoreIds(saved));
  const sources = await deps.sources();

  const products: DigestProductInput[] = [];
  for (const t of chosen) {
    const { offers, history } = await pricesFor(
      deps.engine,
      deps.pack,
      sources,
      {
        name: t.name,
        brand: t.brand,
        model: t.model,
        color: t.color,
        upc: t.upc,
        knownUrls: t.knownUrls,
      },
      { now, storeIds },
    ).catch((err: unknown) => {
      console.error(`digest: prices for product ${t.productId.slice(0, 8)} failed`, err);
      return { offers: [], history: [] };
    });
    products.push({
      trackedProductId: t.trackedProductId,
      productId: t.productId,
      name: t.name,
      brand: t.brand,
      sizeClass: deps.pack.sizeClassOf(t.name),
      colour: t.color,
      targetPrice: t.targetPrice,
      offers,
      history,
    });
  }

  const note = opts.note !== undefined ? opts.note : await previousNote(deps.store, userId, today);
  const view = buildDigest({
    now,
    timeZone: settings.timeZone,
    sendTime: settings.sendTime,
    appUrl: deps.appUrl,
    products,
    note,
  });
  return {
    settings,
    view,
    html: renderDigestHtml(view),
    text: renderDigestText(view),
    productCount: products.length,
  };
}

export function snapshotOf(view: DigestView): RunSnapshot {
  return {
    subject: view.subject,
    summary: [...view.summary],
    products: view.products.map((p) => p.name),
  };
}

/** Permanent refusals (bad address, unverified domain, sign-in) aren't retried. */
function isPermanent(message: string): boolean {
  return /refused|isn't verified|sign-in/i.test(message);
}

/** Send the message to each address; never throws. */
export async function deliver(
  deps: Pick<DigestDeps, "mailer" | "now" | "sleep">,
  message: Omit<MailMessage, "to">,
  recipients: string[],
): Promise<RunRecipient[]> {
  const sleep = deps.sleep ?? sleepReal;
  const out: RunRecipient[] = [];
  for (const [i, address] of recipients.entries()) {
    if (i > 0) await sleep(GAP_MS);
    let attempts = 0;
    let error: string | null = null;
    let providerId: string | null = null;
    let sent = false;
    while (!sent && attempts <= RETRY_DELAYS_MS.length) {
      if (attempts > 0) await sleep(RETRY_DELAYS_MS[attempts - 1]);
      attempts++;
      try {
        if (!deps.mailer) throw new Error("Email isn't set up yet.");
        providerId = (await deps.mailer.send({ ...message, to: address })).id;
        sent = true;
        error = null;
      } catch (err) {
        error =
          err instanceof Error ? err.message : "The email service couldn't send this message.";
        console.error(
          `digest: send to ${maskEmail(address)} failed (attempt ${attempts}): ${error}`,
        );
        if (isPermanent(error)) break;
      }
    }
    out.push({
      address,
      status: sent ? "sent" : "failed",
      providerId,
      error,
      attempts,
      at: deps.now().toISOString(),
    });
  }
  return out;
}

/** Refuse before sending when these recipients would pass the daily or monthly limit. */
export async function checkDailyLimit(deps: DigestDeps, count: number): Promise<void> {
  const limit = deps.dailyLimit ?? emailDailyLimit();
  const since = new Date(deps.now().getTime() - 24 * 3_600_000).toISOString();
  const used = await deps.store.emailsSentSince(since);
  if (used + count > limit)
    throw new DigestError(
      429,
      `The daily email limit (${limit}) would be passed, so nothing was sent. Sending starts again within 24 hours.`,
    );
  const monthly = deps.monthlyLimit ?? emailMonthlyLimit();
  const usedThisMonth = await deps.store.emailsSentSince(monthStartUtc(deps.now()));
  if (usedThisMonth + count > monthly)
    throw new DigestError(
      429,
      `This month's email limit (${monthly.toLocaleString("en-CA")}) would be passed, so nothing was sent. Sending starts again on the 1st.`,
    );
}

export function runStatusOf(recipients: RunRecipient[]): "sent" | "partial" | "failed" {
  const ok = recipients.filter((r) => r.status === "sent").length;
  if (ok === recipients.length && ok > 0) return "sent";
  return ok === 0 ? "failed" : "partial";
}

/**
 * Send the email now to one address already on the list (R1.1). It doesn't
 * count as the daily send. At most TEST_SENDS_PER_HOUR an hour.
 */
export async function sendTest(
  deps: DigestDeps,
  userId: string,
  to: string,
): Promise<{ run: DigestRun; composed: Composed }> {
  const settings = await settingsFor(deps.store, userId);
  const address = to.trim().toLowerCase();
  if (!settings.recipients.includes(address))
    throw new DigestError(400, "Choose an address from the recipient list. Add it there first.");
  if (!deps.mailer)
    throw new DigestError(
      503,
      "Email isn't set up yet, so nothing can be sent. The person who set up LuggageTracker can connect it.",
    );
  const now = deps.now();
  const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
  if ((await deps.store.testSendsSince(userId, hourAgo)) >= TEST_SENDS_PER_HOUR)
    throw new DigestError(
      429,
      `You can send ${TEST_SENDS_PER_HOUR} test emails an hour. Try again a little later.`,
    );
  await checkDailyLimit(deps, 1);

  const composed = await composeDigest(deps, userId, { note: null });
  const run = await deps.store.insertRun({
    userId,
    localDate: localDate(now, settings.timeZone),
    kind: "test",
    status: "sending",
    claimedAt: now.toISOString(),
    preparedAt: null,
    sentAt: null,
    recipients: [],
    productCount: composed.productCount,
    snapshot: snapshotOf(composed.view),
    error: null,
    notes: [],
  });
  const recipients = await deliver(
    deps,
    {
      subject: `[Test] ${composed.view.subject}`,
      html: composed.html,
      text: composed.text,
    },
    [address],
  );
  const status = runStatusOf(recipients);
  const patch = {
    status,
    sentAt: status === "failed" ? null : deps.now().toISOString(),
    recipients,
    error: status === "failed" ? (recipients[0]?.error ?? "The email couldn't be sent.") : null,
  };
  await deps.store.updateRun(run.id, patch);
  return { run: { ...run, ...patch }, composed };
}
