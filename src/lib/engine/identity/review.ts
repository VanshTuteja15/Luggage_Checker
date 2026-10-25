/* ------------------------------------------------------------------ */
/*  Admin decisions on uncertain matches (the identity review queue)   */
/*                                                                     */
/*  approve → the listing IS the candidate product: it is linked to it, */
/*            and the provisional product it was given is merged in     */
/*  reject  → it is not; the listing keeps a product of its own          */
/*  Merges never cross size classes (the store refuses them).            */
/* ------------------------------------------------------------------ */

import type { EngineStore, ReviewItem } from "../store/port";

export async function decideReview(
  store: EngineStore,
  reviewId: string,
  decision: "approved" | "rejected",
  userId: string | null,
): Promise<{ ok: true; item: ReviewItem } | { ok: false; error: string }> {
  const pending = (await store.listReviews("pending", 1000)).find((r) => r.id === reviewId);
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
