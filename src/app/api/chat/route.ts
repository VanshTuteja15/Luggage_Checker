import { NextRequest, NextResponse } from "next/server";
import { getGemini, SYSTEM_PROMPT } from "@/lib/gemini";
import { CATALOG, lowestOffer, priceChange, priceSpread, retailerCount, stats } from "@/lib/data";

/**
 * Build a context string with current product data so the AI knows
 * real prices, retailers, and trends.
 */
function buildProductContext(): string {
  const lines: string[] = ["CURRENT PRODUCT DATA (all prices in CAD):\n"];

  for (const p of CATALOG) {
    const low = lowestOffer(p);
    const change = priceChange(p);
    const spread = priceSpread(p);
    const count = retailerCount(p);
    const s = stats(p);

    lines.push(`## ${p.name}`);
    lines.push(`   Brand: ${p.brand} | Model: ${p.model} | Color: ${p.color} | UPC: ${p.upc}`);
    lines.push(`   Lowest price: $${low.price.toFixed(2)} at ${low.retailer} (${low.inStock ? "In Stock" : "Out of Stock"})`);
    lines.push(`   Price change today: ${change > 0 ? "+" : ""}$${change.toFixed(2)}`);
    lines.push(`   Available at ${count} retailers | Price spread: $${spread.toFixed(2)}`);
    lines.push(`   30-day stats: Low $${s.lowest.price.toFixed(2)} (${s.lowest.date}) | High $${s.highest.price.toFixed(2)} (${s.highest.date}) | Avg $${s.average.toFixed(2)}`);
    lines.push(`   All offers:`);

    for (const o of [...p.offers].sort((a, b) => a.price - b.price)) {
      lines.push(`     - ${o.retailer}: $${o.price.toFixed(2)} ${o.inStock ? "✓" : "✗ OOS"}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array required" }, { status: 400 });
    }

    // Check if Gemini is configured
    if (!process.env.GEMINI_API_KEY) {
      // Demo mode: return a canned response
      return NextResponse.json({
        reply: demoReply(messages[messages.length - 1]?.content ?? ""),
      });
    }

    const genAI = getGemini();
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const productContext = buildProductContext();

    // Build chat history for Gemini
    const chat = model.startChat({
      history: messages.slice(0, -1).map((m: { role: string; content: string }) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      systemInstruction: {
        role: "user",
        parts: [{ text: `${SYSTEM_PROMPT}\n\n${productContext}` }],
      },
    });

    const lastMessage = messages[messages.length - 1].content;
    const result = await chat.sendMessage(lastMessage);
    const reply = result.response.text();

    return NextResponse.json({ reply });
  } catch (err) {
    console.error("Chat API error:", err);

    const message = err instanceof Error ? err.message : "AI service error";
    if (message.includes("API_KEY")) {
      return NextResponse.json({
        reply: "I'm not connected yet — add your Gemini API key in Settings to activate me! Get a free key at aistudio.google.com/apikey",
      });
    }

    return NextResponse.json(
      { error: message },
      { status: 500 },
    );
  }
}

/** Provide helpful responses even without the API key */
function demoReply(input: string): string {
  const q = input.toLowerCase();

  if (q.includes("cheapest") || q.includes("lowest") || q.includes("best deal")) {
    const sorted = CATALOG
      .map((p) => ({ name: p.name, price: lowestOffer(p).price, retailer: lowestOffer(p).retailer }))
      .sort((a, b) => a.price - b.price);
    const top3 = sorted.slice(0, 3);
    return `Here are the best deals right now:\n\n${top3.map((p, i) => `${i + 1}. **${p.name}** — $${p.price.toFixed(2)} at ${p.retailer}`).join("\n")}\n\n_Connect your Gemini API key for smarter recommendations!_`;
  }

  if (q.includes("samsonite")) {
    const sams = CATALOG.filter((p) => p.brand.toLowerCase() === "samsonite");
    if (sams.length > 0) {
      return sams.map((p) => `**${p.name}** — lowest $${lowestOffer(p).price.toFixed(2)} at ${lowestOffer(p).retailer} (across ${retailerCount(p)} stores)`).join("\n\n");
    }
  }

  if (q.includes("drop") || q.includes("went down")) {
    const drops = CATALOG.filter((p) => priceChange(p) < 0);
    if (drops.length > 0) {
      return `${drops.length} product${drops.length > 1 ? "s" : ""} dropped today:\n\n${drops.map((p) => `**${p.name}** dropped $${Math.abs(priceChange(p)).toFixed(2)} — now $${lowestOffer(p).price.toFixed(2)} at ${lowestOffer(p).retailer}`).join("\n")}`;
    }
    return "No price drops today. I'll keep watching!";
  }

  if (q.includes("help") || q.includes("what can you do")) {
    return "I can help you with:\n\n- **Find deals**: \"What's the cheapest luggage right now?\"\n- **Compare prices**: \"Compare Samsonite vs Travelpro\"\n- **Track drops**: \"Any price drops today?\"\n- **Brand search**: \"Show me all TUMI products\"\n- **Buy advice**: \"Should I buy this Samsonite now or wait?\"\n\n_Add your Gemini API key for full AI-powered conversations!_";
  }

  return `I found **${CATALOG.length} products** across **15 Canadian retailers** in the system. Try asking me:\n\n- "What's the cheapest Samsonite?"\n- "Any price drops today?"\n- "Best deal under $200"\n\n_For smarter AI answers, add your free Gemini API key in the .env.local file!_`;
}
