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
  /** We never sent the request — the search budget was already spent. */
  | "budget"
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
        // No HTTP request left this process, so nothing was billed.
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
    return this.kind === "timeout" || this.kind === "server" || this.kind === "network";
  }

  /** A short, user-facing sentence. No stack traces, no raw JSON. */
  get userMessage(): string {
    switch (this.kind) {
      case "network":
        return "Couldn't reach the price service — check your internet connection.";
      case "auth":
        return "The price service rejected the API key. Check it in .env.local and restart.";
      case "quota":
        return "The price service says its free allowance is used up.";
      case "timeout":
        return "The price service took too long to respond. This is usually temporary — try again.";
      case "server":
        return "The price service is having problems right now. Try again shortly.";
      case "budget":
        return "The search used up its time before it could reach Google. The AI step was slow — try again, it should be quick now.";
      default:
        return this.message;
    }
  }
}

/** Classify a fetch/HTTP failure into a FailureKind. */
export function classifyHttp(status: number, body = ""): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status >= 500) return "server";
  if (/quota|credit|limit|exhaust/i.test(body)) return "quota";
  return "unknown";
}
