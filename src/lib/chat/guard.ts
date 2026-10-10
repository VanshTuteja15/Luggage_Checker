/* ------------------------------------------------------------------ */
/*  AI assistant guard (R5.4)                                         */
/*                                                                     */
/*  The assistant may only repeat prices we have stored, each with its */
/*  store and the time it was read. With nothing stored it answers     */
/*  "I don't know; run a search." without asking the model at all. A    */
/*  reply that states an amount we don't hold is replaced by that same */
/*  sentence: an invented price never reaches the screen.              */
/* ------------------------------------------------------------------ */

import { DEFAULT_TIME_ZONE, formatDay, formatTime } from "@/lib/time/local";
import type { TrackedProduct } from "@/lib/types";

export const NO_DATA_REPLY = "I don't know; run a search.";

export type PriceFact = {
  product: string;
  retailer: string;
  price: number;
  checkedAt: string | null;
  inStock: boolean;
};

/** One fact per stored store price of a tracked product. */
export function chatFacts(products: TrackedProduct[]): PriceFact[] {
  const out: PriceFact[] = [];
  for (const p of products) {
    for (const o of p.offers) {
      if (!(o.price > 0)) continue;
      out.push({
        product: [p.brand, p.name].filter(Boolean).join(" ").trim() || p.name,
        retailer: o.retailer,
        price: o.price,
        checkedAt: o.lastCheckedAt,
        inStock: o.inStock,
      });
    }
  }
  return out;
}

/** "checked Oct 9, 9:02 a.m." or "check time unknown". */
export function checkedLabel(iso: string | null, tz: string = DEFAULT_TIME_ZONE): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "check time unknown";
  return `checked ${formatDay(iso, tz)}, ${formatTime(iso, tz)}`;
}

const cad = (n: number) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(n);

export function factsContext(facts: PriceFact[], tz: string = DEFAULT_TIME_ZONE): string {
  return [
    "STORED PRICES (CAD, before tax). Each line: product | store | price | when it was read | stock.",
    ...facts.map(
      (f) =>
        `- ${f.product} | ${f.retailer} | ${cad(f.price)} | ${checkedLabel(f.checkedAt, tz)} | ${f.inStock ? "in stock" : "out of stock"}`,
    ),
  ].join("\n");
}

export const CHAT_SYSTEM_PROMPT = `You answer questions for a Canadian luggage store's staff, using ONLY the STORED PRICES list you are given.

Rules that override everything else:
- State a price only if it appears in STORED PRICES, exactly as written there.
- Every price you state must be followed by its own line "Source: <store> · <when it was read>".
- Never calculate differences, averages or estimates, and never mention a price from memory.
- If the answer is not in STORED PRICES, reply exactly: ${NO_DATA_REPLY}
- Plain, short sentences.`;

/** Dollar amounts written in a reply: "$1,234.95", "CAD 99", "C$ 450". */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:C\$|CAD\s*\$?|\$)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/gi;
  for (const m of text.matchAll(re)) {
    const whole = m[1].replace(/,/g, "");
    const cents = m[2] ? `.${m[2].padEnd(2, "0")}` : "";
    const n = Number(`${whole}${cents}`);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * Keep a reply only if every amount in it is a stored price; make sure each
 * stated price carries a "Source:" line. Otherwise return NO_DATA_REPLY.
 */
export function guardReply(
  reply: string,
  facts: PriceFact[],
  tz: string = DEFAULT_TIME_ZONE,
): string {
  const text = reply.trim();
  if (!text) return NO_DATA_REPLY;
  const amounts = amountsIn(text);
  if (amounts.length === 0) return text;
  if (facts.length === 0) return NO_DATA_REPLY;

  const cited: PriceFact[] = [];
  for (const a of amounts) {
    const fact = facts.find((f) => Math.abs(f.price - a) < 0.005);
    if (!fact) return NO_DATA_REPLY;
    if (!cited.includes(fact)) cited.push(fact);
  }
  const missing = cited.filter(
    (f) =>
      !text
        .split("\n")
        .some(
          (line) =>
            /^\s*source:/i.test(line) && line.toLowerCase().includes(f.retailer.toLowerCase()),
        ),
  );
  if (missing.length === 0) return text;
  return [
    text,
    "",
    ...missing.map((f) => `Source: ${f.retailer} · ${checkedLabel(f.checkedAt, tz)}`),
  ].join("\n");
}

export type ModelCall = (system: string) => Promise<string>;

/** The whole answer path, free of HTTP and of any particular model. */
export async function answerFromStoredPrices(
  facts: PriceFact[],
  callModel: ModelCall,
  tz: string = DEFAULT_TIME_ZONE,
): Promise<string> {
  if (facts.length === 0) return NO_DATA_REPLY;
  const reply = await callModel(`${CHAT_SYSTEM_PROMPT}\n\n${factsContext(facts, tz)}`);
  return guardReply(reply, facts, tz);
}
