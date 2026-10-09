import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy · LuggageTracker",
  description: "What LuggageTracker stores, who processes it, and for how long.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 text-sm leading-6 text-foreground">
      <Link href="/" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
        ← LuggageTracker
      </Link>
      <h1 className="mt-4 text-2xl font-semibold">Privacy</h1>
      <p className="mt-1 text-xs text-muted-foreground">
        A plain-language summary of how this app handles data. Last updated 8 October 2026.
      </p>

      <h2 className="mt-8 text-base font-semibold">What we keep</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Your account: email address and sign-in data (Supabase Auth).</li>
        <li>What you save: tracked products, target prices, price alerts and settings.</li>
        <li>
          Your price searches: the search text, the prices found, which stores were checked and how
          long it took, stored with your account so you can reopen them.
        </li>
      </ul>
      <p className="mt-2">
        Other users can&rsquo;t see your searches or tracked products: the database only returns
        rows that belong to the signed-in account.
      </p>

      <h2 className="mt-8 text-base font-semibold">What we don&rsquo;t do</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>No advertising, no analytics or tracking scripts, no selling or sharing of data.</li>
        <li>
          Stores never receive anything about you. Our price checker reads public product pages and
          official store feeds itself, identifies itself honestly, and follows each store&rsquo;s
          robots.txt.
        </li>
        <li>
          Fonts are served from this site, so your browser doesn&rsquo;t contact Google Fonts.
        </li>
      </ul>

      <h2 className="mt-8 text-base font-semibold">Services that process data for us</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Supabase: database and sign-in.</li>
        <li>Vercel: hosting.</li>
        <li>Resend: price-alert and daily-report emails.</li>
        <li>
          Tavily and Google Gemini, only when you use <em>Web research</em> or the assistant: the
          search text (and, for the assistant, your tracked products) is sent to them to answer.
          <em> Verified prices</em> searches don&rsquo;t use them.
        </li>
      </ul>

      <h2 className="mt-8 text-base font-semibold">How long</h2>
      <p className="mt-2">
        Price-check logs and search progress events are deleted after 180 days. Prices observed at
        stores are kept as price history. Your account data stays until you delete it or ask us to.
      </p>

      <h2 className="mt-8 text-base font-semibold">Your choices</h2>
      <p className="mt-2">
        You can remove tracked products and alerts at any time. To get a copy of your data or have
        your account deleted, contact Luggage Depot Inc., which operates this app.
      </p>

      <p className="mt-10 text-xs text-muted-foreground">
        See also the{" "}
        <Link href="/terms" className="underline underline-offset-4">
          terms of use
        </Link>
        .
      </p>
    </main>
  );
}
