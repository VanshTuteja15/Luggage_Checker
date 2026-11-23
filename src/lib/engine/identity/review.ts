/* ------------------------------------------------------------------ */
/*  Admin decisions on uncertain matches (the identity review queue)   */
/*                                                                     */
/*  approve → the listing IS the candidate product: it is linked to it, */
/*            and the provisional product it was given is merged in     */
/*  reject  → it is not; the listing keeps a product of its own          */
/*  Merges never cross size classes (the store refuses them).            */
/* ------------------------------------------------------------------ */

import type { EngineStore, ReviewItem } from "../store/port";
import type { CategoryPack } from "../types";
import { productWords } from "./match";
import { judgeCandidate } from "./resolve";

/** The kind of a reason, without its details: "sizes differ (L vs M)" → "sizes differ". */
const kindOf = (why: string) => why.replace(/\s*\(.*$/, "").replace(/^\d+ /, "n ");

/**
 * v4 A5.3: re-check the pending queue against the current rules (owner
 * 2026-10-30: the queue holds only real near matches). A near match the rules
 * no longer send to a person, and an item with no candidate product, become
 * `superseded` with the reason appended; identifier conflicts and same-name
 * clashes stay. Nothing is merged or deleted. A dry run unless `apply`.
 */
export async function recheckReviews(
  store: EngineStore,
  pack: CategoryPack,
  opts: { apply: boolean; limit?: number },
): Promise<{ checked: number; kept: number; superseded: number; why: Record<string, number> }> {
  const pending = await store.listReviews("pending", opts.limit ?? 5000);
  const out = {
    checked: pending.length,
    kept: 0,
    superseded: 0,
    why: {} as Record<string, number>,
  };
  for (const r of pending) {
    let why: string | null = null;
    if (!r.candidateProductId) {
      why = "no candidate product";
    } else if (r.reasons[0]?.startsWith("similar line:")) {
      const listing = await store.getListing(r.listingId);
      const product = await store.getProduct(r.candidateProductId);
      if (listing && product) {
        const j = await judgeCandidate(store, pack, listing, product);
        if (!j.near) why = j.why;
      }
    }
    if (!why) {
      out.kept++;
      continue;
    }
    out.why[kindOf(why)] = (out.why[kindOf(why)] ?? 0) + 1;
    if (
      !opts.apply ||
      (await store.supersedeReview(r.id, `not a real near match (rules of 2026-10-30): ${why}`))
    )
      out.superseded++;
  }
  return out;
}

/** Most decisions one batch request may carry (the batch review screen, T-501). */
export const MAX_BATCH_DECISIONS = 100;

/**
 * v4 A5.3: the same decision on several items (the batch review screen), one
 * at a time in the order given, each exactly as a single click would do it.
 * One failure doesn't stop the rest; every id gets its own result.
 */
export async function decideReviews(
  store: EngineStore,
  reviewIds: string[],
  decision: "approved" | "rejected",
  userId: string | null,
): Promise<{ id: string; ok: boolean; error?: string }[]> {
  const pending = await store.listReviews("pending", 5000);
  const out: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of [...new Set(reviewIds)].slice(0, MAX_BATCH_DECISIONS)) {
    const r = await decideReview(store, id, decision, userId, pending);
    out.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.error });
  }
  return out;
}

/** Words only one side's product name has: what a person compares (T-501). */
export function wordsApart(
  pack: CategoryPack,
  item: Pick<ReviewItem, "listingTitle" | "candidateName">,
): { onlyListing: string[]; onlyCandidate: string[] } {
  const a = productWords(pack, item.listingTitle, null);
  const b = item.candidateName ? productWords(pack, item.candidateName, null) : [];
  return {
    onlyListing: item.candidateName ? a.filter((w) => !b.includes(w)) : [],
    onlyCandidate: b.filter((w) => !a.includes(w)),
  };
}

export async function decideReview(
  store: EngineStore,
  reviewId: string,
  decision: "approved" | "rejected",
  userId: string | null,
  pendingNow?: ReviewItem[],
): Promise<{ ok: true; item: ReviewItem } | { ok: false; error: string }> {
  const pending = (pendingNow ?? (await store.listReviews("pending", 1000))).find(
    (r) => r.id === reviewId,
  );
  if (!pending) return { ok: false, error: "That review item is not pending." };

  if (decision === "approved") {
    if (!pending.candidateProductId)
      return { ok: false, error: "No candidate product to approve; split or leave it instead." };
    const listing = await store.getListing(pending.listingId);
    if (!listing) return { ok: false, error: "The listing no longer exists." };
    try {
      if (listing.productId && listing.productId !== pending.candidateProductId) {
        await store.mergeProducts(listing.productId, pending.candidateProductId);
      } else if (!listing.productId) {
        await store.linkListing(listing.id, pending.candidateProductId, null);
      }
    } catch (err) {
      console.error("decideReview: merge failed", err);
      return { ok: false, error: "Couldn't join the two products. Please try again." };
    }
  }

  const item = await store.decideReview(reviewId, decision, userId);
  return item ? { ok: true, item } : { ok: false, error: "That review item was already decided." };
}
