/* ------------------------------------------------------------------ */
/*  Suggestions under the answer (v5 F2.5; V3 S3.4)                    */
/*                                                                     */
/*  "Other sizes in this line", "Cheaper alternatives" (same size      */
/*  class and type, a real lower price we stand behind), colours, and  */
/*  "Did you mean". From our own index only: nothing is fetched, no    */
/*  estimate is ever a suggestion's price, and every price keeps its   */
/*  label ("Last seen · Nov 20" when it wasn't read today). A          */
/*  suggestion never breaks a hard constraint of the search (brand,     */
/*  type, shell, stated inches).                                       */
/* ------------------------------------------------------------------ */

import { bagTypeOf, shellOf } from "../query/parse";
import type { EngineStore, PricedProduct } from "../store/port";
import type {
  AnswerProduct,
  AnswerSuggestions,
  CategoryPack,
  Freshness,
  ParsedQuery,
  SuggestedProduct,
} from "../types";
import { freshnessLabel } from "./answer";
import { productViews } from "./rows";
import { answerFocus } from "./summary";

const WINDOW_MS = 30 * 86_400_000;
const MAX_OTHER_SIZES = 4;
const MAX_CHEAPER = 3;

function freshnessOf(p: PricedProduct): Freshness {
  if (p.adapter === "feed_import") return { kind: "feed", asOf: p.asOf ?? p.seenAt };
  if (p.adapter === "manual_entry") return { kind: "manual", checkedAt: p.asOf ?? p.seenAt };
  // A live reading from the index: freshnessLabel says "Last seen · date" unless it's today's.
  return { kind: "live", fetchedAt: p.seenAt };
}

function suggested(
  p: PricedProduct,
  retailerOf: (sourceId: string) => string,
  now: Date,
  saving: number | null,
): SuggestedProduct {
  return {
    productId: p.productId,
    name: p.name,
    sizeClass: p.sizeClass,
    price: p.price,
    retailer: retailerOf(p.sourceId),
    url: p.url,
    label: freshnessLabel(freshnessOf(p), now),
    saving,
  };
}

/** Does a suggested product keep the search's hard constraints? (Unknown attributes pass.) */
function keeps(p: PricedProduct, q: ParsedQuery, pack: CategoryPack): boolean {
  if (q.brand && p.brand && p.brand.toLowerCase() !== q.brand.toLowerCase()) return false;
  if (pack.isAccessory(p.name)) return false;
  const text = `${p.name} ${p.title}`;
  if (q.type) {
    const t = bagTypeOf(text);
    if (t && t !== q.type) return false;
  }
  if (q.shell && q.shell !== "hybrid") {
    const s = shellOf(text);
    if (s && s !== q.shell) return false;
  }
  return true;
}

export async function buildSuggestions(
  store: EngineStore,
  pack: CategoryPack,
  products: AnswerProduct[],
  q: ParsedQuery,
  opts: { now?: Date; retailerOf: (sourceId: string) => string },
): Promise<AnswerSuggestions> {
  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString();
  const didYouMean = q.didYouMean ?? null;
  const views = productViews(products, { wantsAccessory: q.sizeClass === "accessory" });
  const focus = answerFocus(views);
  if (!focus) return { otherSizes: [], cheaper: [], colours: [], didYouMean };

  const colours = [
    ...new Set(
      focus.product.offers.map((o) => o.colour?.trim()).filter((c): c is string => !!c),
    ),
  ];
  const productId = focus.product.productId;
  const catalog = productId ? await store.getProduct(productId) : null;
  if (productId) {
    for (const v of await store.variantsForProduct(productId).catch(() => []))
      if (v.colour && !colours.some((c) => c.toLowerCase() === v.colour!.toLowerCase()))
        colours.push(v.colour);
  }
  const exclude = productId ? [productId] : [];
  const sizeClass = focus.product.sizeClass;
  const type = bagTypeOf(
    [focus.product.name, ...focus.product.offers.map((o) => o.title)].join(" "),
  );

  /* other sizes of the same line */
  let otherSizes: SuggestedProduct[] = [];
  if (catalog?.brand && catalog.line) {
    const rows = await store.pricedProducts({
      brand: catalog.brand,
      line: catalog.line,
      sinceIso,
      excludeProductIds: exclude,
      limit: 20,
    });
    const bySize = new Map<string, PricedProduct>();
    for (const r of rows) {
      if (!r.sizeClass || r.sizeClass === sizeClass || pack.isAccessory(r.name)) continue;
      if (!bySize.has(r.sizeClass)) bySize.set(r.sizeClass, r); // rows come cheapest first
    }
    otherSizes = [...bySize.values()]
      .slice(0, MAX_OTHER_SIZES)
      .map((r) => suggested(r, opts.retailerOf, now, null));
  }

  /* cheaper alternatives: same size and type, a real lower price */
  let cheaper: SuggestedProduct[] = [];
  const lowest = focus.headline?.row.price ?? null;
  if (sizeClass && lowest !== null) {
    const rows = await store.pricedProducts({
      sizeClass,
      brand: q.brand,
      below: lowest,
      sinceIso,
      excludeProductIds: exclude,
      limit: 40,
    });
    cheaper = rows
      .filter((r) => keeps(r, q, pack))
      .filter((r) => {
        const t = bagTypeOf(`${r.name} ${r.title}`);
        return !type || !t || t === type;
      })
      .filter((r) => {
        const n = pack.inchesOf(r.title);
        return !q.inches || !n || n === q.inches;
      })
      .sort((a, b) => b.price - a.price) // the closest cheaper options first
      .slice(0, MAX_CHEAPER)
      .map((r) => suggested(r, opts.retailerOf, now, Math.round((lowest - r.price) * 100) / 100));
  }

  return { otherSizes, cheaper, colours: colours.slice(0, 12), didYouMean };
}
