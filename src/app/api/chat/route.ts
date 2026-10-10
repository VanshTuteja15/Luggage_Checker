import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { answerFromStoredPrices, chatFacts } from "@/lib/chat/guard";
import { getTrackedProducts } from "@/lib/db/products";
import { flagOn } from "@/lib/engine/flags";
import { getEngine } from "@/lib/engine/server";
import { callGemini, geminiConfigured, type GeminiMessage } from "@/lib/gemini";
import { requireUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

const body = z.object({
  messages: z
    .array(z.object({ role: z.string(), content: z.string().max(2000) }))
    .min(1, "A messages array is required.")
    .max(50),
});

/**
 * POST /api/chat — the assistant, answering only from stored, dated prices.
 *
 * Off unless the chat.enabled flag is on (R5.4). Prices come from the
 * user's tracked products with their store and check time; the guard
 * replaces any reply that states an amount we don't hold.
 */
export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);
    if (!flagOn(await getEngine().rt.flags(), "chat.enabled")) {
      return NextResponse.json({ error: "The assistant is turned off." }, { status: 404 });
    }

    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Invalid request.");

    if (!geminiConfigured()) {
      return NextResponse.json({ reply: "The assistant isn't connected yet." });
    }

    const geminiMessages: GeminiMessage[] = parsed.data.messages.slice(-12).map((m) => ({
      role: m.role === "assistant" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    }));

    const facts = chatFacts(await getTrackedProducts(supabase, userId, { days: 30 }));
    const reply = await answerFromStoredPrices(facts, (system) =>
      callGemini(geminiMessages, system, { temperature: 0.1, maxOutputTokens: 1024 }),
    );
    return NextResponse.json({ reply });
  } catch (err) {
    return errorResponse(err, "POST /api/chat");
  }
}
