/* ------------------------------------------------------------------ */
/*  Morning email (Q4): content, labels and delivery                   */
/*                                                                     */
/*  A1.2: with a capturing mail provider, the email holds the chosen   */
/*  products only, in order, with every store row lowest first, the    */
/*  right labels and dates, stale prices marked, a plain-text part,    */
/*  and no <script> or chart. Plus the test send's guards, retries,    */
/*  the daily limit, the old report address migration, the note about */
/*  yesterday and the red banner (R1.7).                               */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import { buildDigest, type DigestProductInput } from "@/lib/digest/build";
import { renderDigestHtml } from "@/lib/digest/html";
import {
  DigestError,
  composeDigest,
  deliver,
  previousNote,
  sendTest,
  settingsFor,
  type DigestDeps,
} from "@/lib/digest/run";
import { bannerFor, logRows, recipientStatus } from "@/lib/digest/status";
import { MemoryDigestStore, type MemoryTracked } from "@/lib/digest/store";
import { renderDigestText } from "@/lib/digest/text";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { SOURCE_SEED } from "@/lib/engine/registry";
import { MemoryEngineStore } from "@/lib/engine/store/memory";
import type { AdapterId, Availability, PriceMethod } from "@/lib/engine/types";
import { CaptureMailer } from "@/lib/mailer";

const NOW = new Date("2026-10-10T15:30:00.000Z"); // Sat Oct 10, 9:30 a.m. in Calgary
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

const PARALUX = "11111111-1111-4111-8111-111111111111";
const CHATELET = "22222222-2222-4222-8222-222222222222";
const ALPHA = "33333333-3333-4333-8333-333333333333";

function tracked(over: Partial<MemoryTracked> & Pick<MemoryTracked, "productId" | "name" | "brand">): MemoryTracked {
  return {
    userId: USER,
    trackedProductId: `t-${over.productId}`,
    model: "",
    color: "",
    upc: null,
    imageUrl: null,
    targetPrice: null,
    knownUrls: [],
    lastCheckedAt: null,
    ...over,
  };
}

async function seedEngine(): Promise<MemoryEngineStore> {
  const engine = new MemoryEngineStore(SOURCE_SEED);
  const add = async (
    sourceId: string,
    url: string,
    title: string,
    brand: string,
    readings: { price: number; at: string; adapter?: PriceMethod; availability?: Availability; asOf?: string }[],
    colour: string | null = null,
  ) => {
    const l = await engine.upsertListing({
      sourceId,
      url,
      externalId: null,
      title,
      brand,
      sizeClass: luggagePack.sizeClassOf(title),
      colour,
      identifiers: [],
      imageUrl: null,
      discoveredVia: "sitemap",
      lastmod: null,
      active: true,
    });
    for (const r of readings)
      await engine.insertObservation({
        listingId: l.id,
        sourceId,
        adapter: (r.adapter ?? "shopify_product_json") as AdapterId,
        price: r.price,
        listPrice: null,
        currency: "CAD",
        availability: r.availability ?? "in_stock",
        seller: null,
        condition: null,
        validation: { outcome: "accepted", confidence: 0.95, reasons: [] },
        evidence: r.adapter === "web_estimate" ? { foundAt: r.at } : {},
        extractorVersion: "t",
        validatorVersion: "t",
        fetchedAt: r.at,
        asOf: r.asOf ?? null,
        sessionId: null,
      });
  };
  // Paralux Medium: CLD dropped $35 overnight; Amazon has a lower web estimate;
  // Bentley has a staff-checked price; U.N. Luggage wasn't checked today.
  await add(
    "canadaluggagedepot",
    "https://www.canadaluggagedepot.ca/products/samsonite-paralux-medium",
    "Samsonite Paralux Hardside Expandable Spinner Medium Luggage",
    "Samsonite",
    [
      { price: 469.95, at: "2026-10-09T15:02:00.000Z" },
      { price: 434.95, at: "2026-10-10T15:02:00.000Z" },
    ],
    "Black",
  );
  await add(
    "amazon-ca",
    "https://www.amazon.ca/Samsonite-Paralux-Hardside-Spinner-Medium/dp/B0FQ7BKSXH",
    "Samsonite Paralux Hardside Spinner Medium",
    "Samsonite",
    [{ price: 419.99, at: "2026-10-10T15:01:00.000Z", adapter: "web_estimate", availability: "unknown" }],
  );
  await add(
    "bentley",
    "https://www.bentley.ca/en/samsonite-paralux-medium",
    "Samsonite Paralux Spinner Medium",
    "Samsonite",
    [
      {
        price: 449.99,
        at: "2026-10-09T18:00:00.000Z",
        adapter: "manual_entry",
        asOf: "2026-10-09T00:00:00.000Z",
      },
    ],
  );
  await add(
    "unluggage",
    "https://www.unluggage.com/products/samsonite-paralux-medium",
    "Samsonite Paralux Spinner Medium",
    "Samsonite",
    [{ price: 399.0, at: "2026-10-08T16:00:00.000Z" }],
  );
  // Paralux Large must never appear under the Medium (size wall).
  await add(
    "canadaluggagedepot",
    "https://www.canadaluggagedepot.ca/products/samsonite-paralux-large",
    "Samsonite Paralux Hardside Expandable Spinner Large Luggage",
    "Samsonite",
    [{ price: 150, at: "2026-10-10T15:02:00.000Z" }],
  );
  // Chatelet: out of stock at Delsey today.
  await add(
    "delsey-ca",
    "https://www.delsey.ca/products/chatelet-air-2-0-medium",
    "Delsey Chatelet Air 2.0 Medium Spinner",
    "Delsey",
    [{ price: 300, at: "2026-10-10T15:05:00.000Z", availability: "out_of_stock" }],
  );
  // Alpha is tracked but not chosen.
  await add(
    "canadaluggagedepot",
    "https://www.canadaluggagedepot.ca/products/tumi-alpha-carry-on",
    "TUMI Alpha International Carry-On",
    "TUMI",
    [{ price: 1095, at: "2026-10-10T15:02:00.000Z" }],
  );
  return engine;
}

async function setup(opts: { mailer?: CaptureMailer | null; dailyLimit?: number } = {}) {
  const engine = await seedEngine();
  const store = new MemoryDigestStore(
    [
      tracked({
        productId: PARALUX,
        name: "Samsonite Paralux Hardside Spinner Medium",
        brand: "Samsonite",
        model: "Paralux",
        color: "Black",
        targetPrice: 420,
        knownUrls: ["https://www.canadaluggagedepot.ca/products/samsonite-paralux-medium"],
      }),
      tracked({
        productId: CHATELET,
        name: "Delsey Chatelet Air 2.0 Medium",
        brand: "Delsey",
        model: "Chatelet Air 2.0",
      }),
      tracked({ productId: ALPHA, name: "TUMI Alpha International Carry-On", brand: "TUMI", model: "Alpha" }),
      tracked({ userId: OTHER, productId: ALPHA, name: "TUMI Alpha", brand: "TUMI" }),
    ],
    () => NOW,
  );
  await store.updateSettings(USER, { recipients: ["owner@example.test", "staff@example.test"] });
  await store.setChosen(USER, [CHATELET, PARALUX]);
  const mailer = opts.mailer === undefined ? new CaptureMailer() : opts.mailer;
  const deps: DigestDeps = {
    store,
    engine,
    pack: luggagePack,
    sources: async () => SOURCE_SEED,
    mailer,
    appUrl: "https://luggage.example.test/",
    now: () => NOW,
    sleep: async () => undefined,
    dailyLimit: opts.dailyLimit ?? 90,
  };
  return { deps, store, mailer };
}

describe("morning email content (A1.2)", () => {
  it("holds the chosen products only, in order, with every store row lowest first", async () => {
    const { deps } = await setup();
    const { view, html, text } = await composeDigest(deps, USER);
    expect(view.products.map((p) => p.name)).toEqual([
      "Delsey Chatelet Air 2.0 Medium",
      "Samsonite Paralux Hardside Spinner Medium",
    ]);
    expect(html).not.toContain("TUMI");
    const paralux = view.products[1];
    // Today's prices lowest first; the store not checked today last.
    expect(paralux.rows.map((r) => [r.retailer, r.price])).toEqual([
      ["Amazon.ca", 419.99],
      ["Canada Luggage Depot", 434.95],
      ["Bentley", 449.99],
      ["U.N. Luggage", 399],
    ]);
    expect(paralux.rows.some((r) => r.price === 150)).toBe(false); // the Large never joins
    expect(text).toContain("Canada Luggage Depot: $434.95");
  });

  it("labels every price with its source and time; stale prices say Last seen", async () => {
    const { deps } = await setup();
    const { view } = await composeDigest(deps, USER);
    const rows = Object.fromEntries(view.products[1].rows.map((r) => [r.retailer, r]));
    expect(rows["Canada Luggage Depot"].label).toBe("Verified live · 9:02 a.m.");
    expect(rows["Amazon.ca"].label).toBe("Web estimate · found 9:01 a.m. · confirm on site");
    expect(rows["Bentley"].label).toBe("Staff-checked · Oct 9");
    expect(rows["U.N. Luggage"].label).toBe("Last seen · Oct 8");
    expect(rows["U.N. Luggage"].current).toBe(false);
    expect(rows["U.N. Luggage"].change.text).toBe("—");
  });

  it("shows the lowest price, the change since yesterday, the 30-day low and the target", async () => {
    const { deps } = await setup();
    const { view } = await composeDigest(deps, USER);
    const p = view.products[1];
    expect(p.lowest).toMatchObject({ retailer: "Amazon.ca", priceText: "$419.99", estimate: true });
    expect(p.lowestVerified).toMatchObject({ retailer: "Canada Luggage Depot", price: 434.95 });
    const cld = p.rows.find((r) => r.retailer === "Canada Luggage Depot")!;
    expect(cld.change).toMatchObject({ kind: "down", text: "▼ $35.00 (−7.4%)", since: null });
    expect(p.low30).toBe("Lowest in 30 days: $399.00 at U.N. Luggage (Oct 8)");
    expect(p.target).toBe("Target $420.00 reached at Amazon.ca (web estimate, confirm on site)");
    expect(p.size).toBe("Medium");
    expect(view.products[0].allOutOfStock).toBe(true);
  });

  it("writes the subject and summary from the data", async () => {
    const { deps } = await setup();
    const { view } = await composeDigest(deps, USER);
    expect(view.subject).toBe("Luggage prices · Sat Oct 10 · 1 drop · 1 target hit");
    expect(view.summary).toEqual([
      "1 price dropped since yesterday (biggest: ▼ $35.00 on Samsonite Paralux Hardside Spinner Medium at Canada Luggage Depot).",
      "No prices went up.",
      "1 target hit. Couldn't check today: U.N. Luggage.",
    ]);
    expect(view.footer.emailUrl).toBe("https://luggage.example.test/email");
    expect(view.footer.schedule).toBe("Sent every day at 9:00 a.m., Mountain (Calgary, Edmonton) time.");
  });

  it("sends HTML and plain text, with no script, image, pixel or chart", async () => {
    const { deps, mailer } = await setup();
    const { run } = await sendTest(deps, USER, "Owner@Example.test");
    expect(run.status).toBe("sent");
    const m = mailer!.sent[0];
    expect(m.to).toBe("owner@example.test");
    expect(m.subject).toBe("[Test] Luggage prices · Sat Oct 10 · 1 drop · 1 target hit");
    expect(m.text).toContain("SAMSONITE PARALUX HARDSIDE SPINNER MEDIUM");
    expect(m.text).toContain("Prices are each store's listed price in CAD before GST/HST and shipping");
    expect(m.html).toContain("Out of stock everywhere we checked");
    expect(m.html).toContain("Change products or recipients");
    for (const bad of [/<script/i, /<img/i, /<svg/i, /<canvas/i, /recharts/i, /sparkline/i])
      expect(m.html).not.toMatch(bad);
  });

  it("escapes every piece of text and links only https store pages", () => {
    const product: DigestProductInput = {
      trackedProductId: "t1",
      productId: "p1",
      name: `Bag <script>alert("x")</script>`,
      brand: "Brand & Co",
      sizeClass: "carry_on",
      colour: "",
      targetPrice: null,
      offers: [
        {
          sourceId: "canadaluggagedepot",
          retailer: "Canada Luggage Depot",
          price: 100,
          url: 'javascript:alert("x")',
          title: "t",
          colour: null,
          availability: "in_stock",
          freshness: { kind: "live", fetchedAt: "2026-10-10T15:02:00.000Z" },
          method: "shopify_product_json",
        },
      ],
      history: [],
    };
    const view = buildDigest({
      now: NOW,
      timeZone: "America/Edmonton",
      sendTime: "09:00",
      appUrl: "https://app.example.test",
      products: [product],
      note: null,
    });
    const html = renderDigestHtml(view);
    expect(html).not.toContain("<script>");
    expect(html).toContain("Bag &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain("Brand &amp; Co");
    expect(html).not.toContain("javascript:");
    const text = renderDigestText(view);
    expect(text).toContain(`BAG <SCRIPT>`); // plain text is not HTML
    expect(text).not.toContain("javascript:");
  });
});

describe("test send guards (R1.1, §6, R1.13)", () => {
  it("refuses an address that isn't on the list (no open relay)", async () => {
    const { deps, mailer } = await setup();
    await expect(sendTest(deps, USER, "stranger@example.test")).rejects.toMatchObject({ status: 400 });
    expect(mailer!.sent).toHaveLength(0);
  });

  it("allows five test sends an hour", async () => {
    const { deps } = await setup();
    for (let i = 0; i < 5; i++) await sendTest(deps, USER, "owner@example.test");
    await expect(sendTest(deps, USER, "owner@example.test")).rejects.toMatchObject({ status: 429 });
  });

  it("refuses a send that would pass the daily email limit", async () => {
    const { deps, mailer } = await setup({ dailyLimit: 2 });
    await sendTest(deps, USER, "owner@example.test");
    await sendTest(deps, USER, "owner@example.test");
    const err = await sendTest(deps, USER, "owner@example.test").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DigestError);
    expect((err as DigestError).message).toMatch(/daily email limit \(2\)/);
    expect(mailer!.sent).toHaveLength(2);
  });

  it("says plainly when email isn't set up", async () => {
    const { deps } = await setup({ mailer: null });
    await expect(sendTest(deps, USER, "owner@example.test")).rejects.toMatchObject({ status: 503 });
  });

  it("records a failure in plain words and doesn't retry a refused address", async () => {
    const mailer = new CaptureMailer({
      "owner@example.test": "That address was refused by the email service. Check it for typos.",
    });
    const { deps, store } = await setup({ mailer });
    const { run } = await sendTest(deps, USER, "owner@example.test");
    expect(run.status).toBe("failed");
    expect(run.recipients[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(logRows(store.runs)[0]).toMatchObject({ statusText: "Not sent", failed: 1 });
  });

  it("retries a temporary failure twice", async () => {
    let calls = 0;
    const flaky = {
      provider: "capture" as const,
      send: async () => {
        calls++;
        if (calls < 3) throw new Error("The email service couldn't be reached. It will be tried again.");
        return { id: "ok-3" };
      },
    };
    const out = await deliver({ mailer: flaky, now: () => NOW, sleep: async () => undefined }, { subject: "s", html: "h", text: "t" }, [
      "a@example.test",
    ]);
    expect(out[0]).toMatchObject({ status: "sent", attempts: 3, providerId: "ok-3" });
  });
});

describe("settings, note and banner (R1.14, R1.7)", () => {
  it("moves the old daily report address into the recipients on first load", async () => {
    const store = new MemoryDigestStore([], () => NOW);
    store.legacy.set(USER, "Reports@Example.test");
    const s = await settingsFor(store, USER);
    expect(s).toMatchObject({ enabled: true, sendTime: "09:00", timeZone: "America/Edmonton" });
    expect(s.recipients).toEqual(["reports@example.test"]);
    store.legacy.set(USER, "changed@example.test");
    expect((await settingsFor(store, USER)).recipients).toEqual(["reports@example.test"]);
  });

  it("starts the next email with a note and shows a banner when yesterday's partly failed", async () => {
    const store = new MemoryDigestStore([], () => NOW);
    const settings = await store.ensureSettings(USER, ["a@example.test", "b@example.test", "c@example.test"]);
    const run = await store.insertRun({
      userId: USER,
      localDate: "2026-10-09",
      kind: "daily",
      status: "partial",
      claimedAt: "2026-10-09T15:00:00.000Z",
      preparedAt: "2026-10-09T14:00:00.000Z",
      sentAt: "2026-10-09T15:01:00.000Z",
      recipients: [
        { address: "a@example.test", status: "sent", providerId: "1", error: null, attempts: 1, at: "2026-10-09T15:01:00.000Z" },
        { address: "b@example.test", status: "sent", providerId: "2", error: null, attempts: 1, at: "2026-10-09T15:01:00.000Z" },
        {
          address: "c@example.test",
          status: "failed",
          providerId: null,
          error: "That address was refused by the email service. Check it for typos.",
          attempts: 1,
          at: "2026-10-09T15:01:00.000Z",
        },
      ],
      productCount: 2,
      snapshot: null,
      error: null,
      notes: [],
    });
    expect(await previousNote(store, USER, "2026-10-10")).toBe(
      "Yesterday's email didn't reach 1 of 3 people: That address was refused by the email service. Check it for typos.",
    );
    expect(bannerFor({ ...run, localDate: "2026-10-10" }, settings)).toBe(
      "Today's 9:00 a.m. email didn't reach 1 of 3 people: That address was refused by the email service. Check it for typos.",
    );
    const status = recipientStatus(store.runs, settings.recipients);
    expect(status.map((s) => [s.address, !!s.lastDeliveredAt, s.lastError !== null])).toEqual([
      ["a@example.test", true, false],
      ["b@example.test", true, false],
      ["c@example.test", false, true],
    ]);
  });

  it("removes an untracked product from the email (R1.3)", async () => {
    const { deps, store } = await setup();
    store.untrack(USER, PARALUX);
    const { view } = await composeDigest(deps, USER);
    expect(view.products.map((p) => p.name)).toEqual(["Delsey Chatelet Air 2.0 Medium"]);
  });

  it("only lets an account choose its own tracked products", async () => {
    const { store } = await setup();
    expect(await store.addChosen(OTHER, PARALUX)).toBe(false);
    expect(await store.setChosen(USER, [PARALUX, "44444444-4444-4444-8444-444444444444"])).toBe(1);
  });
});

describe("mailer (R1.13)", () => {
  it("warns when the sender is the shared resend.dev address", async () => {
    const { mailerStatus } = await import("@/lib/mailer");
    const s = mailerStatus({ RESEND_API_KEY: "x", NODE_ENV: "test" } as NodeJS.ProcessEnv);
    expect(s).toMatchObject({ provider: "resend", configured: true, dailyLimit: 90 });
    expect(s.warning).toBe("Only the Resend account owner will receive this; verify your domain.");
    const verified = mailerStatus({
      RESEND_API_KEY: "x",
      REPORT_FROM_EMAIL: "LuggageTracker <prices@luggagedepot.ca>",
      EMAIL_DAILY_LIMIT: "50",
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);
    expect(verified).toMatchObject({ warning: null, dailyLimit: 50 });
  });

  it("says SMTP isn't set up until every field is there, without naming variables", async () => {
    const { getMailer, mailerStatus } = await import("@/lib/mailer");
    const env = { EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.gmail.com", NODE_ENV: "test" } as NodeJS.ProcessEnv;
    const s = mailerStatus(env);
    expect(s).toMatchObject({ provider: "smtp", configured: false });
    expect(s.missing).not.toMatch(/SMTP_|_PASS|_USER/);
    expect(getMailer(env)).toBeNull();
    expect(
      mailerStatus({ ...env, SMTP_USER: "u", SMTP_PASS: "p", SMTP_FROM: "a@b.ca" } as NodeJS.ProcessEnv)
        .configured,
    ).toBe(true);
  });

  it("masks addresses for logs and turns provider errors into plain sentences", async () => {
    const { maskEmail, plainProviderError } = await import("@/lib/mailer");
    expect(maskEmail("vansh@gmail.com")).toBe("v***@gmail.com");
    expect(plainProviderError("You can only send testing emails to your own email address")).toMatch(
      /domain isn't verified/,
    );
    expect(plainProviderError("535 5.7.8 Username and Password not accepted")).toMatch(/sign-in/);
    expect(plainProviderError("getaddrinfo ENOTFOUND smtp.example")).toMatch(/couldn't be reached/);
  });
});

describe("summary wording (R1.9)", () => {
  it("names a store as not checked only when none of its prices was read today", () => {
    const offer = (price: number, at: string) => ({
      sourceId: "canadaluggagedepot",
      retailer: "Canada Luggage Depot",
      price,
      url: "https://www.canadaluggagedepot.ca/products/x",
      title: "t",
      colour: null,
      availability: "in_stock" as const,
      freshness: { kind: "live" as const, fetchedAt: at },
      method: "shopify_product_json" as const,
    });
    const product = (name: string, at: string): DigestProductInput => ({
      trackedProductId: name,
      productId: name,
      name,
      brand: "Samsonite",
      sizeClass: "medium",
      colour: "",
      targetPrice: null,
      offers: [offer(400, at)],
      history: [],
    });
    const view = (products: DigestProductInput[]) =>
      buildDigest({ now: NOW, timeZone: "America/Edmonton", sendTime: "09:00", appUrl: "", products, note: null });
    expect(
      view([product("A", "2026-10-10T15:02:00.000Z"), product("B", "2026-10-08T15:02:00.000Z")]).counts.unchecked,
    ).toEqual([]);
    expect(view([product("B", "2026-10-08T15:02:00.000Z")]).summary[2]).toBe(
      "No targets hit. Couldn't check today: Canada Luggage Depot.",
    );
  });
});
