import { NextRequest, NextResponse } from "next/server";
import { badRequest, errorResponse } from "@/lib/api/respond";
import { getTrackedProducts } from "@/lib/db/products";
import { callGemini, geminiConfigured, SYSTEM_PROMPT, type GeminiMessage } from "@/lib/gemini";
import { requireUser } from "@/lib/supabase/server";
import { priceStats, type TrackedProduct } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

/**
 * Build the assistant's context from the user's REAL tracked products.
 *
 * The previous version built this from a hardcoded mock catalogue, so the
 * assistant confidently quoted prices that didn't exist anywhere.
 */
function buildProductContext(products: TrackedProduct[]): string {
  if (products.length === 0) {
    return "CONTEXT: The user is not tracking any products yet. Their tracked list is empty.";
  }

  const lines: string[] = [
    `CONTEXT — ${products.length} tracked product(s). All prices CAD, fetched from real retailer listings.`,
    "",
  ];

  for (const p of products) {
    const stats = priceStats(p.history);

    lines.push(`## ${p.name}`);
    lines.push(
      `   Brand: ${p.brand}${p.model ? ` | Model: ${p.model}` : ""}${p.color ? ` | Colour: ${p.color}` : ""}${p.upc ? ` | UPC: ${p.upc}` : ""}`,
    );

    if (p.lowestPrice === null) {
      lines.push("   No current offers recorded.");
      lines.push("");
      continue;
    }

    lines.push(
      `   Best price: $${p.lowestPrice.toFixed(2)} at ${p.lowestRetailer} (${p.inStock ? "in stock" : "out of stock"})`,
    );
    lines.push(
      `   Change since last check: ${p.change > 0 ? "+" : ""}$${p.change.toFixed(2)}${
        p.previousLowest !== null ? ` (was $${p.previousLowest.toFixed(2)})` : ""
      }`,
    );
    lines.push(
      `   Available at ${p.retailerCount} retailer(s) | Spread: $${p.spread.toFixed(2)}`,
    );

    if (stats.lowest && stats.highest && stats.average !== null) {
      lines.push(
        `   Recorded history (${stats.days} day(s)): low $${stats.lowest.price.toFixed(2)} on ${stats.lowest.date}, high $${stats.highest.price.toFixed(2)} on ${stats.highest.date}, average $${stats.average.toFixed(2)}`,
      );
    } else {
      lines.push("   Not enough history recorded yet to describe a trend.");
    }

    if (p.targetPrice !== null) {
      lines.push(
        `   Price alert set at $${p.targetPrice.toFixed(2)} (${p.lowestPrice <= p.targetPrice ? "REACHED" : "not yet reached"})`,
      );
    }

    lines.push(`   Last checked: ${p.lastCheckedAt ?? "never"}`);
    lines.push("   All current offers:");
    for (const o of p.offers) {
      lines.push(
        `     - ${o.retailer}: $${o.price.toFixed(2)} ${o.inStock ? "(in stock)" : "(OUT OF STOCK)"}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const { supabase, userId } = await requireUser(req);

    const body = (await req.json().catch(() => ({}))) as { messages?: unknown };
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];

    if (rawMessages.length === 0) return badRequest("A messages array is required.");

    if (!geminiConfigured()) {
      return NextResponse.json({
        reply:
          "I'm not connected yet — add a GEMINI_API_KEY to the app environment and restart, and I'll be able to answer questions about your tracked products.",
      });
    }

    const products = await getTrackedProducts(supabase, userId, { days: 30 });

    const geminiMessages: GeminiMessage[] = rawMessages
      .filter(
        (m): m is { role: string; content: string } =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as { content?: unknown }).content === "string",
      )
      .slice(-12)
      .map((m) => ({
        role: m.role === "assistant" ? ("model" as const) : ("user" as const),
        parts: [{ text: m.content }],
      }));

    if (geminiMessages.length === 0) return badRequest("No usable messages.");

    const reply = await callGemini(
      geminiMessages,
      `${SYSTEM_PROMPT}\n\n${buildProductContext(products)}`,
      { temperature: 0.4, maxOutputTokens: 1024 },
    );

    return NextResponse.json({ reply });
  } catch (err) {
    return errorResponse(err, "POST /api/chat");
  }
}
