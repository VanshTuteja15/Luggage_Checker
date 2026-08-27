import { NextRequest, NextResponse } from "next/server";
import { searchWeb, type WebSearchResult } from "@/lib/serpapi";
import { getGemini } from "@/lib/gemini";
import { CATALOG, lowestOffer } from "@/lib/data";

/**
 * POST /api/search
 * Search for luggage across the web.
 *
 * Priority:
 *  1. SerpAPI (Google Shopping Canada) — real-time, best results
 *  2. Gemini AI search — uses the model's knowledge + product context
 *  3. Local catalog fallback — filters hardcoded data
 */
export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json(
        { error: "query string is required" },
        { status: 400 },
      );
    }

    // ─── Try SerpAPI first ───────────────────────────────────
    if (process.env.SERPAPI_KEY) {
      try {
        const results = await searchWeb(`${query} luggage`);
        return NextResponse.json({
          source: "serpapi",
          results,
          query,
        });
      } catch (err) {
        console.warn("SerpAPI search failed, falling back:", err);
      }
    }

    // ─── Gemini AI search fallback ──────────────────────────
    if (process.env.GEMINI_API_KEY) {
      try {
        const results = await geminiSearch(query);
        return NextResponse.json({
          source: "gemini",
          results,
          query,
        });
      } catch (err) {
        console.warn("Gemini search failed, falling back:", err);
      }
    }

    // ─── Local catalog fallback ─────────────────────────────
    const needle = query.toLowerCase();
    const localResults: WebSearchResult[] = CATALOG
      .filter((p) => {
        const haystack = `${p.name} ${p.brand} ${p.model} ${p.color} ${p.upc}`.toLowerCase();
        return haystack.includes(needle);
      })
      .flatMap((p) =>
        p.offers.map((o) => ({
          title: p.name,
          source: o.retailer,
          price: o.price,
          url: o.url,
          thumbnail: undefined,
          rating: undefined,
          reviews: undefined,
          snippet: `${p.brand} ${p.model} — ${p.color}`,
          knownRetailer: o.retailer,
        })),
      )
      .sort((a, b) => a.price - b.price);

    return NextResponse.json({
      source: "local",
      results: localResults,
      query,
    });
  } catch (err) {
    console.error("POST /api/search error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Gemini-powered search                                             */
/* ------------------------------------------------------------------ */

async function geminiSearch(query: string): Promise<WebSearchResult[]> {
  const genAI = getGemini();
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // Give Gemini our product data + the user's query
  const productContext = CATALOG.map((p) => {
    const low = lowestOffer(p);
    return `${p.name} | ${p.brand} | Lowest: $${low.price} at ${low.retailer} | Offers at ${p.offers.length} retailers`;
  }).join("\n");

  const prompt = `You are a luggage search engine. The user searched for: "${query}"

Here are the products in our database:
${productContext}

Return a JSON array of matching products. Each item should have:
- "title": product name
- "source": retailer name with best price
- "price": lowest price as a number
- "url": a Google Shopping search URL for that product (format: https://www.google.ca/search?tbm=shop&q=ENCODED_PRODUCT_NAME)
- "snippet": brief description (brand, size, material, color)
- "rating": estimated rating out of 5 (number or null)
- "reviews": estimated number of reviews (number or null)

Also include 3-5 additional real luggage products that match the query but are NOT in the database. Use your knowledge of real luggage products, brands, and typical Canadian retail prices (in CAD). For these, set source to the most likely Canadian retailer.

Return ONLY the JSON array, no other text. Sort by relevance to the query, then by price ascending.`;

  const result = await model.generateContent(prompt);
  const text = result.response.text();

  // Extract JSON from the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return parsed.map((item: Record<string, unknown>) => ({
      title: String(item.title ?? ""),
      source: String(item.source ?? ""),
      price: Number(item.price) || 0,
      url: String(item.url ?? ""),
      thumbnail: undefined,
      rating: item.rating ? Number(item.rating) : undefined,
      reviews: item.reviews ? Number(item.reviews) : undefined,
      snippet: String(item.snippet ?? ""),
      knownRetailer: null, // Gemini results aren't mapped to known retailers
    }));
  } catch {
    return [];
  }
}
