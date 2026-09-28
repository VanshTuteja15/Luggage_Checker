/* ------------------------------------------------------------------ */
/*  Provider error classification                                     */
/*                                                                     */
/*  When a provider call fails we need to know one thing that isn't    */
/*  obvious from the message: did it consume the account's quota?      */
/*                                                                     */
/*  A rejected API key costs nothing. A request that reached the       */
/*  provider and then timed out on our side probably did get billed.   */
/*  Getting this wrong in either direction is bad — refunding a call   */
/*  that was billed lets us overshoot the real limit, and charging for */
/*  one that wasn't burns an allowance the user still has.             */
/* ------------------------------------------------------------------ */

export type FailureKind =
  /** Never reached the provider — DNS, connection refused, offline. */
  | "network"
  /** Provider rejected the credentials. No search ran. */
  | "auth"
  /** Provider says the allowance is gone. */
  | "quota"
  /** We gave up waiting. The provider may or may not have run the search. */
  | "timeout"
  /** Provider returned 5xx. */
  | "server"
  /** Too many requests per minute (429). Not a spent allowance — wait and retry. */
  | "rate_limit"
  /** The provider refused the request as malformed (400/422). Nothing ran. */
  | "bad_request"
  /** We never sent the request — the search budget was already spent. */
  | "budget"
  /** The app refused on principle (e.g. the $0 rule). Message says why. */
  | "policy"
  /** Anything else — malformed response, unexpected shape. */
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: FailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /**
   * Whether this failure most likely consumed a search from the account's
   * allowance.
   *
   * Conservative on purpose: when it's genuinely ambiguous (timeout, 5xx)
   * we assume it counted. Overcounting means we stop a little early, which
   * is recoverable. Undercounting means we sail past the real limit and get
   * hard-failed by the provider, which isn't.
   */
  get consumedQuota(): boolean {
    switch (this.kind) {
      case "network":
      case "auth":
      case "budget":
      case "policy":
      case "rate_limit":
      case "bad_request":
        // Refused before any search ran, so nothing was billed.
        return false;
      case "quota":
      case "timeout":
      case "server":
      case "unknown":
        return true;
    }
  }

  /** Whether retrying the same call has a reasonable chance of working. */
  get retryable(): boolean {
    return (
      this.kind === "timeout" ||
      this.kind === "server" ||
      this.kind === "network" ||
      this.kind === "rate_limit"
    );
  }

  /** A short, user-facing sentence. No stack traces, no raw JSON. */
  get userMessage(): string {
    switch (this.kind) {
      case "network":
        return "Couldn't reach the research service — check your internet connection, or whether a firewall, proxy or VPN is blocking api.tavily.com.";
      case "auth":
        return "The research service rejected the API key. Check TAVILY_API_KEY in .env.local and restart.";
      case "quota":
        return "This month's free research credits are used up. Searches resume when the allowance resets — nothing is charged.";
      case "timeout":
        return "The research service took too long to respond. This is usually temporary — try again.";
      case "server":
        return "The research service is having problems right now. Try again shortly.";
      case "rate_limit":
        return "Too many searches in the last minute. Wait a few seconds and try again.";
      case "bad_request":
        return "The research service rejected the request. Try rephrasing the search.";
      case "budget":
        return "The search ran out of time before it could reach the research service. Try again — it's usually quick.";
      default:
        return this.message;
    }
  }
}

/** Classify a fetch/HTTP failure into a FailureKind. */
export function classifyHttp(status: number, body = ""): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  // Tavily: 432 = key or plan limit reached, 433 = pay-as-you-go limit
  // reached. Both mean "no more credits" — and neither is ever retried.
  if (status === 432 || status === 433) return "quota";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "server";
  if (/quota|credit|limit|exhaust/i.test(body)) return "quota";
  return "unknown";
}
