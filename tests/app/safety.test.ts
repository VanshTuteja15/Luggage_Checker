/* ------------------------------------------------------------------ */
/*  Q1 safety: sign-up off (A5.1), the assistant never invents a price */
/*  (R5.4), and the store list comes from the registry (R5.3).         */
/* ------------------------------------------------------------------ */

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as signupPost } from "@/app/api/auth/signup/route";
import { SIGNUP_CLOSED_MESSAGE, signupAllowed } from "@/lib/auth/signup";
import {
  amountsIn,
  answerFromStoredPrices,
  guardReply,
  NO_DATA_REPLY,
  type PriceFact,
} from "@/lib/chat/guard";
import { FLAG_DEFAULTS } from "@/lib/engine/flags";
import {
  cleanStoreLabels,
  enabledStoreIds,
  enabledStoreLabels,
  legacyRetailerFilter,
  STORES,
} from "@/lib/stores";

const signupRequest = (body: unknown) =>
  new NextRequest("http://localhost/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("public sign-up (R5.1, A5.1)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is off unless the variable is explicitly on", () => {
    expect(signupAllowed(undefined)).toBe(false);
    expect(signupAllowed("")).toBe(false);
    expect(signupAllowed("false")).toBe(false);
    expect(signupAllowed("no")).toBe(false);
    expect(signupAllowed("true")).toBe(true);
    expect(signupAllowed(" ON ")).toBe(true);
  });

  it("refuses a sign-up on the server when the flag is off, without contacting Supabase", async () => {
    vi.stubEnv("NEXT_PUBLIC_ALLOW_SIGNUP", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "public-test-key");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await signupPost(
      signupRequest({ email: "new@example.com", password: "s3cret!pass" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: SIGNUP_CLOSED_MESSAGE });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("validates input when sign-up is on (no Supabase call for bad input)", async () => {
    vi.stubEnv("NEXT_PUBLIC_ALLOW_SIGNUP", "true");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await signupPost(signupRequest({ email: "not-an-email", password: "x" }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

const FACTS: PriceFact[] = [
  {
    product: "Samsonite Paralux Medium",
    retailer: "Canada Luggage Depot",
    price: 434.95,
    checkedAt: "2026-10-10T15:02:00.000Z",
    inStock: true,
  },
];

describe("assistant (R5.4)", () => {
  it("is off by default", () => {
    expect(FLAG_DEFAULTS["chat.enabled"]).toBe(false);
  });

  it("answers a question with no stored data with no number, and never asks the model", async () => {
    const model = vi.fn(async () => "The cheapest Samsonite is $199.99 at Amazon.ca.");
    const reply = await answerFromStoredPrices([], model);
    expect(reply).toBe(NO_DATA_REPLY);
    expect(reply).not.toMatch(/\d/);
    expect(model).not.toHaveBeenCalled();
  });

  it("replaces a reply that states a price we don't hold", async () => {
    const reply = await answerFromStoredPrices(FACTS, async () => "Amazon.ca has it for $399.00.");
    expect(reply).toBe(NO_DATA_REPLY);
  });

  it("keeps a stored price and adds its source line when the model left it out", () => {
    const out = guardReply("The Paralux Medium is $434.95 at Canada Luggage Depot.", FACTS);
    expect(out).toContain("$434.95");
    expect(out).toMatch(/Source: Canada Luggage Depot · checked Oct 10, 9:02 a\.m\./);
  });

  it("does not duplicate a source line the model already wrote", () => {
    const text = "It's $434.95.\nSource: Canada Luggage Depot · checked Oct 10, 9:02 a.m.";
    expect(guardReply(text, FACTS)).toBe(text);
  });

  it("reads the usual ways of writing an amount", () => {
    expect(amountsIn("$1,234.95, CAD 99 and C$ 450.5")).toEqual([1234.95, 99, 450.5]);
    expect(amountsIn("Omni 3.0 Large, 28 inches")).toEqual([]);
  });
});

describe("store list from the registry (R5.3)", () => {
  it("lists active registry stores only: no Hudson's Bay, RIMOWA or CALPAK", () => {
    const labels = STORES.map((s) => s.label);
    expect(labels).toContain("Canada Luggage Depot");
    expect(labels).toContain("Delsey.ca");
    expect(labels).not.toContain("Hudson's Bay");
    expect(labels).not.toContain("RIMOWA");
    expect(labels).not.toContain("CALPAK");
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("treats nothing saved as every store", () => {
    expect(enabledStoreLabels(null)).toHaveLength(STORES.length);
    expect(enabledStoreLabels([])).toHaveLength(STORES.length);
    expect(legacyRetailerFilter(null)).toEqual([]);
  });

  it("translates a list saved under the old names, keeping stores the old list never had", () => {
    const legacyDefault = [
      "Amazon.ca",
      "Costco.ca",
      "Walmart.ca",
      "Hudson's Bay",
      "Canadian Tire",
      "Bentley",
      "Best Buy Canada",
      "London Drugs",
      "Samsonite.ca",
      "TUMI.ca",
      "Away",
      "Travelpro",
      "Monos",
      "Briggs & Riley",
      "RIMOWA",
      "CALPAK",
      "eBay.ca",
    ];
    expect(enabledStoreLabels(legacyDefault)).toHaveLength(STORES.length);
    const noEbay = legacyDefault.filter((n) => n !== "eBay.ca");
    const chosen = enabledStoreLabels(noEbay);
    expect(chosen).not.toContain("eBay.ca");
    expect(chosen).toContain("Canada Luggage Depot");
    expect(chosen).toContain("Travelpro.ca");
  });

  it("keeps a registry-label choice as saved and maps it to source ids", () => {
    expect(enabledStoreLabels(["Delsey.ca", "Canada Luggage Depot"])).toEqual([
      "Canada Luggage Depot",
      "Delsey.ca",
    ]);
    expect(enabledStoreIds(["Delsey.ca"])).toEqual(["delsey-ca"]);
  });

  it("accepts only registry labels from the browser", () => {
    expect(cleanStoreLabels(["Delsey.ca", "Hudson's Bay", 3, "Delsey.ca"])).toEqual(["Delsey.ca"]);
    expect(cleanStoreLabels("Delsey.ca")).toBeNull();
  });
});
