import { after, NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { requireAdmin } from "@/lib/engine/admin";
import { importFeedAdmin, recordManualAdmin } from "@/lib/engine/admin-actions";
import { discoverSource } from "@/lib/engine/discovery";
import { luggagePack } from "@/lib/engine/packs/luggage";
import { callWorker, getEngine } from "@/lib/engine/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const sourceId = z.string().regex(/^[a-z0-9-]{2,60}$/);

const action = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("discover"),
    sourceId,
    maxFetches: z.number().int().min(0).max(500).optional(),
  }),
  z.object({ action: z.literal("source"), sourceId, enabled: z.boolean() }),
  z.object({
    action: z.literal("feed"),
    sourceId,
    format: z.enum(["csv", "json"]),
    asOf: z.string(),
    name: z.string().min(1).max(120),
    content: z.string().max(5_000_000),
  }),
  z.object({
    action: z.literal("manual"),
    sourceId,
    title: z.string().min(1).max(300),
    price: z.number().positive().max(100_000),
    checkedAt: z.string(),
    url: z.string().url().nullable().optional(),
    sku: z.string().max(120).nullable().optional(),
    gtin: z.string().max(20).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
]);

/** POST /api/admin/actions — discovery, enable/disable a store, feed import, manual price. */
export async function POST(req: NextRequest) {
  try {
    const { userId } = await requireAdmin(req);
    const parsed = action.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "invalid action");
    const a = parsed.data;
    const { rt } = getEngine();

    switch (a.action) {
      case "discover": {
        const status = await callWorker("/v1/jobs", {
          name: "discover.source",
          data: { sourceId: a.sourceId, maxFetches: a.maxFetches ?? 40 },
        });
        if (status === 202)
          return NextResponse.json({ queued: true, on: "worker" }, { status: 202 });
        // No worker: run here after responding (small budget).
        after(() =>
          discoverSource(rt, luggagePack, a.sourceId, {
            maxFetches: Math.min(a.maxFetches ?? 20, 40),
          }),
        );
        return NextResponse.json({ queued: true, on: "inline" }, { status: 202 });
      }
      case "source":
        await rt.store.setSourceEnabled(a.sourceId, a.enabled);
        rt.invalidate();
        return NextResponse.json({ sourceId: a.sourceId, enabled: a.enabled });
      case "feed": {
        const r = await importFeedAdmin(rt, luggagePack, a, userId);
        return r.ok ? NextResponse.json(r) : badRequest(r.error);
      }
      case "manual": {
        const r = await recordManualAdmin(
          rt,
          luggagePack,
          a.sourceId,
          {
            ...a,
            url: a.url ?? null,
            sku: a.sku ?? null,
            gtin: a.gtin ?? null,
            note: a.note ?? null,
          },
          userId,
        );
        return r.ok ? NextResponse.json(r) : badRequest(r.error);
      }
    }
  } catch (err) {
    return errorResponse(err, "POST /api/admin/actions");
  }
}
