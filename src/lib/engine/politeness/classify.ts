/* ------------------------------------------------------------------ */
/*  Block classifier                                                  */
/*                                                                     */
/*  A block (403/429/challenge page) is a finding, not a bug to route   */
/*  around: it's classified, recorded, and the planner switches to      */
/*  another legitimate route or reports "couldn't verify". We never     */
/*  retry a block with a different identity.                            */
/* ------------------------------------------------------------------ */

import type { FetchOutcome } from "../types";

const CHALLENGE_MARKERS: RegExp[] = [
  /<title>\s*just a moment/i,
  /cf-chl|challenge-platform|__cf_chl/i,
  /captcha/i,
  /access denied/i,
  /access to this page has been denied/i,
  /px-captcha|perimeterx|_pxAppId/i,
  /robot or human/i,
  /request unsuccessful\. incapsula/i,
  /datadome/i,
  /akamai.{0,40}reference #/i,
];

export function looksLikeChallenge(body: string): boolean {
  const head = body.slice(0, 30_000);
  return CHALLENGE_MARKERS.some((re) => re.test(head));
}

export function classifyResponse(
  status: number,
  body: string,
  headers: Record<string, string>,
): FetchOutcome {
  const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
  if (h("cf-mitigated")) return "challenge";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 410) return "not_found";
  if ((status === 403 || status === 503 || status === 401) && looksLikeChallenge(body))
    return "challenge";
  // Redirects are followed by the fetcher; one that reaches here had no
  // usable Location. PerimeterX answers samsonite.ca like this (P0 probe).
  if (status >= 300 && status < 400) return looksLikeChallenge(body) ? "challenge" : "error";
  if (status === 401 || status === 403) return "blocked";
  if (status >= 200 && status < 300) {
    const head = body.slice(0, 20_000);
    // A 200 can still be an interstitial.
    if (
      /<title>\s*(just a moment|access denied|attention required)/i.test(head) ||
      /cf-chl|px-captcha/i.test(head)
    )
      return "challenge";
    return "ok";
  }
  return "error";
}
