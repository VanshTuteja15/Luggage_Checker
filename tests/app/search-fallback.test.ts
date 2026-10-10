/* ------------------------------------------------------------------ */
/*  A2.3: a forced engine error shows saved prices or a friendly       */
/*  message, never an exception. Production without the engine         */
/*  database: research answers 503 in plain words; last-known serves   */
/*  the tracked products' prices with their own dates.                 */
/* ------------------------------------------------------------------ */

import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", async (orig) => {
  const real = await orig<typeof import("@/lib/supabase/server")>();
  // Settings reads return nothing (every store); no network.
  const supabase = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
  };
  return { ...real, requireUser: async () => ({ supabase, userId: "u-1", email: null }) };
});

vi.mock("@/lib/db/products", () => ({
  getTrackedProducts: async () => [
    {
      id: "p1",
      name: "Paralux Spinner Medium",
      brand: "Samsonite",
      model: "Paralux",
      color: "Black",
      upc: null,
      imageUrl: null,
      offers: [
        {
          retailer: "Canada Luggage Depot",
          price: 434.95,
          inStock: true,
          url: "https://www.canadaluggagedepot.ca/products/samsonite-paralux-medium",
          title: null,
          lastCheckedAt: "2026-10-09T15:00:00.000Z",
        },
      ],
    },
  ],
}));

describe("search when the engine can't run (A2.3)", () => {
  beforeAll(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "");
  });
  afterAll(() => vi.unstubAllEnvs());

  it("refuses to start a live check with a plain sentence, not a crash", async () => {
    const { POST } = await import("@/app/api/research/route");
    const res = await POST(
      new NextRequest("http://localhost/api/research", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer t" },
        body: JSON.stringify({ query: "Samsonite Paralux Medium" }),
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/aren't set up on this server yet/);
    expect(body.error).not.toMatch(/DATABASE_URL|engine\.|_URL/);
  });

  it("serves saved prices with their dates instead", async () => {
    const { GET } = await import("@/app/api/research/last-known/route");
    const res = await GET(
      new NextRequest("http://localhost/api/research/last-known?q=Samsonite%20Paralux%20Medium", {
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      from: string;
      products: { offers: { price: number; freshness: { kind: string; lastSeenAt: string } }[] }[];
    };
    expect(body.from).toBe("tracked");
    expect(body.products[0].offers[0]).toMatchObject({
      price: 434.95,
      freshness: { kind: "stale", lastSeenAt: "2026-10-09T15:00:00.000Z" },
    });
  });
});
