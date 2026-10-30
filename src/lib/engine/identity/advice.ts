/* ------------------------------------------------------------------ */
/*  Advice beside a review (v4 A5.3)                                   */
/*                                                                     */
/*  The judge's cached verdict on a near-match pair, for the person    */
/*  deciding. It is never applied: approving or rejecting stays a      */
/*  human click. The request is rebuilt from the review row exactly as  */
/*  resolution queued it, so the cache key matches.                     */
/* ------------------------------------------------------------------ */

import { matchJudgeTask, taskCacheKey, type AiCache, type JudgeOutput } from "../ai";
import type { ReviewItem } from "../store/port";
import type { JudgeRequest } from "./match";

export type ReviewAdvice = JudgeOutput & { model: string; at: string };

export function judgeRequestFor(
  item: Pick<ReviewItem, "listingTitle" | "sourceId" | "candidateName">,
): JudgeRequest | null {
  if (!item.candidateName) return null;
  return {
    a: item.listingTitle,
    b: item.candidateName,
    storeA: item.sourceId,
    storeB: "our catalogue",
  };
}

export async function reviewAdvice(
  cache: AiCache,
  model: string,
  items: ReviewItem[],
): Promise<Record<string, ReviewAdvice | null>> {
  const out: Record<string, ReviewAdvice | null> = {};
  for (const item of items) {
    const req = judgeRequestFor(item);
    const hit = req ? await cache.get(taskCacheKey(matchJudgeTask, model, req)) : null;
    const v = hit?.value as Partial<JudgeOutput> | undefined;
    out[item.id] =
      hit && v && typeof v.verdict === "string" && typeof v.reason === "string"
        ? {
            verdict: v.verdict as JudgeOutput["verdict"],
            reason: v.reason,
            model: hit.model,
            at: hit.createdAt,
          }
        : null;
  }
  return out;
}
