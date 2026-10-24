/* ------------------------------------------------------------------ */
/*  Q6 history as tables (R4.2–R4.4): changes, biggest drops, daily    */
/*  lowest, by store, and the plain-sentence summary.                  */
/* ------------------------------------------------------------------ */

import { describe, expect, it } from "vitest";
import {
  biggestDrops,
  byStore,
  changeText,
  dailyLowest,
  priceChanges,
  productSummary,
} from "@/lib/history/tables";

const TODAY = "2026-10-24";

const paralux = {
  id: "p1",
  name: "Samsonite Paralux Medium",
  brand: "Samsonite",
  lowestPrice: 434.95,
  historyByRetailer: {
    "Canada Luggage Depot": [
      { date: "2026-10-10", price: 469.95 },
      { date: "2026-10-16", price: 469.95 },
      { date: "2026-10-23", price: 449.95 },
      { date: "2026-10-24", price: 434.95 },
    ],
    "Delsey.ca": [
      { date: "2026-10-20", price: 440 },
      { date: "2026-10-22", price: 455 },
    ],
  },
  history: [
    { date: "2026-10-10", price: 469.95 },
    { date: "2026-10-16", price: 469.95 },
    { date: "2026-10-20", price: 440 },
    { date: "2026-10-22", price: 455 },
    { date: "2026-10-23", price: 449.95 },
    { date: "2026-10-24", price: 434.95 },
  ],
};

const omni = {
  id: "p2",
  name: "Samsonite Omni 3.0 Large",
  brand: "Samsonite",
  lowestPrice: 330,
  historyByRetailer: {
    "Canada Luggage Depot": [
      { date: "2026-10-17", price: 300 },
      { date: "2026-10-24", price: 330 },
    ],
  },
  history: [
    { date: "2026-10-17", price: 300 },
    { date: "2026-10-24", price: 330 },
  ],
};

describe("changes and biggest drops (R4.2)", () => {
  it("lists every change per product and store, newest first, with arrows and percent", () => {
    const c = priceChanges([paralux, omni], { from: "2026-09-25" });
    expect(c.map((x) => [x.date, x.productName, x.retailer, x.oldPrice, x.newPrice, x.text])).toEqual([
      ["2026-10-24", "Samsonite Omni 3.0 Large", "Canada Luggage Depot", 300, 330, "▲ $30.00 (+10%)"],
      ["2026-10-24", "Samsonite Paralux Medium", "Canada Luggage Depot", 449.95, 434.95, "▼ $15.00 (−3.3%)"],
      ["2026-10-23", "Samsonite Paralux Medium", "Canada Luggage Depot", 469.95, 449.95, "▼ $20.00 (−4.3%)"],
      ["2026-10-22", "Samsonite Paralux Medium", "Delsey.ca", 440, 455, "▲ $15.00 (+3.4%)"],
    ]);
  });

  it("filters by period, product and store", () => {
    expect(priceChanges([paralux, omni], { from: "2026-10-24" })).toHaveLength(2);
    expect(priceChanges([paralux, omni], { from: "2026-09-25", productId: "p2" })).toHaveLength(1);
    expect(
      priceChanges([paralux, omni], { from: "2026-09-25", retailer: "Delsey.ca" }).map((x) => x.kind),
    ).toEqual(["up"]);
  });

  it("ranks this week's drops by dollars", () => {
    const c = priceChanges([paralux, omni], { from: "2026-09-25" });
    expect(biggestDrops(c, "2026-10-18").map((x) => x.diff)).toEqual([-20, -15]);
    expect(biggestDrops(c, "2026-10-24").map((x) => x.diff)).toEqual([-15]);
  });
});

describe("product page tables (R4.3) and summary (R4.4)", () => {
  it("shows the daily lowest price with its store and the change from the day before", () => {
    const rows = dailyLowest(paralux, TODAY, 30);
    expect(rows.map((r) => [r.date, r.price, r.retailers.join(","), r.change])).toEqual([
      ["2026-10-24", 434.95, "Canada Luggage Depot", "▼ $15.00 (−3.3%)"],
      ["2026-10-23", 449.95, "Canada Luggage Depot", "▼ $5.05 (−1.1%)"],
      ["2026-10-22", 455, "Delsey.ca", "▲ $15.00 (+3.4%)"],
      ["2026-10-20", 440, "Delsey.ca", "▼ $29.95 (−6.4%)"],
      ["2026-10-16", 469.95, "Canada Luggage Depot", "No change"],
      ["2026-10-10", 469.95, "Canada Luggage Depot", null],
    ]);
    expect(dailyLowest(paralux, TODAY, 7).map((r) => r.date)).toEqual([
      "2026-10-24",
      "2026-10-23",
      "2026-10-22",
      "2026-10-20",
    ]);
  });

  it("shows each store's today, yesterday, a week ago and its 30-day range; never carries a price into today", () => {
    expect(byStore(paralux, TODAY)).toEqual([
      { retailer: "Canada Luggage Depot", today: 434.95, yesterday: 449.95, weekAgo: 469.95, low30: 434.95, high30: 469.95 },
      { retailer: "Delsey.ca", today: null, yesterday: null, weekAgo: null, low30: 440, high30: 455 },
    ]);
  });

  it("writes the plain sentence and the 30-day badge", () => {
    expect(productSummary(paralux, TODAY)).toEqual({
      sentence: "Down $35.00 (7.4%) since last week. Lowest price in 30 days.",
      badge: "Lowest in 30 days",
    });
    expect(productSummary(omni, TODAY)).toEqual({
      sentence: "Up $30.00 (10%) since last week. Highest price in 30 days.",
      badge: "Highest in 30 days",
    });
    expect(productSummary({ ...omni, history: [{ date: TODAY, price: 330 }] }, TODAY).sentence).toBe(
      "No price from a week ago to compare.",
    );
    expect(productSummary({ ...omni, lowestPrice: null }, TODAY).sentence).toBe("No current price yet.");
    expect(changeText(100, 100)).toBe("No change");
  });
});
