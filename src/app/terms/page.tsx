import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms · LuggageTracker",
  description: "How LuggageTracker's prices should be read and used.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 text-sm leading-6 text-foreground">
      <Link href="/" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        ← LuggageTracker
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Terms of use</h1>
      <p className="mt-1 text-xs text-muted-foreground">
        A plain-language summary. Last updated 8 October 2026.
      </p>

      <h2 className="mt-8 text-base font-semibold">What the prices mean</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>
          Every price is a store&rsquo;s listed price in Canadian dollars, before GST/HST and
          shipping, with the time it was read and a link to where it was read.
        </li>
        <li>
          &ldquo;Verified live&rdquo; means we read it from the store during your search.
          &ldquo;Feed as of&rdquo;, &ldquo;Manually checked&rdquo; and &ldquo;Last seen&rdquo;
          prices are older and say so. Web research prices come from a search service and show
          when they were read.
        </li>
        <li>
          Stores change prices and stock at any time. Confirm the price on the store&rsquo;s own
          page before you buy or quote it; we can&rsquo;t guarantee it is still current.
        </li>
        <li>
          Some stores don&rsquo;t allow automated price checks. For those we show a link to
          search the store yourself, never a guessed price.
        </li>
      </ul>

      <h2 className="mt-8 text-base font-semibold">Using the app</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>The app is for Luggage Depot Inc. and the people it invites.</li>
        <li>
          Searches are rate-limited per person. Please don&rsquo;t script or automate the app;
          every search makes real, polite requests to the stores.
        </li>
        <li>
          Store names and trademarks belong to their owners. We are not affiliated with the
          stores we compare.
        </li>
      </ul>

      <p className="mt-10 text-xs text-muted-foreground">
        See also the <Link href="/privacy" className="underline underline-offset-4">privacy summary</Link>.
      </p>
    </main>
  );
}
