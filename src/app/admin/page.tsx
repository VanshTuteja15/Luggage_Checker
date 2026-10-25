"use client";

/* ------------------------------------------------------------------ */
/*  /admin — Store status (R5.2). In plain words by default: what each */
/*  store gives us, products to review, data entry (staff-checked      */
/*  prices, dealer lists) and how much of the free allowances is left. */
/*  Route names, flags, failures and timings sit under a collapsed     */
/*  "Technical details". The shop's account only (app_admins); every   */
/*  action goes through /api/admin.                                    */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { ErrorState } from "@/components/Bits";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiRequestError } from "@/lib/api-client";
import { usageLines, type StoreStatusRow, type UsageSummary } from "@/lib/store-status-view";
import { errorMessage } from "@/lib/queries";
import { useStore } from "@/lib/store";
import { formatTime, formatWeekdayDate } from "@/lib/time/local";
import { cn } from "@/lib/utils";

type Overview = {
  config: Record<string, string>;
  store: string;
  stores: StoreStatusRow[];
  usage: UsageSummary;
  sources: {
    sourceId: string;
    retailerLabel: string;
    liveClass: string;
    permission: string;
    circuit: string;
    circuitReason: string | null;
    enabled: boolean;
    listings: number;
    attempts24h: number;
    blocked24h: number;
    blockRate24h: number | null;
    successRate7d: number | null;
    lastOkAt: string | null;
    lastBlockAt: string | null;
    routes: { adapter: string; usable: boolean; reason: string; crossCheckOnly: boolean }[];
  }[];
  failures: {
    sourceId: string | null;
    adapter: string;
    url: string;
    status: number | null;
    outcome: string;
    error: string | null;
    startedAt: string;
  }[];
  rejections: {
    sourceId: string;
    listingId: string;
    adapter: string;
    reasons: string[];
    fetchedAt: string;
  }[];
  estimateRejections: {
    sourceId: string | null;
    query: string;
    url: string;
    title: string;
    price: number | null;
    reasons: string[];
    foundAt: string;
  }[];
  sessions: {
    id: string;
    query: string;
    status: string;
    mode: string;
    createdAt: string;
    firstPriceMs: number | null;
    totalMs: number | null;
    deadlineHit: boolean | null;
    offers: number;
  }[];
  sessionStats: {
    count: number;
    firstPriceP50: number | null;
    firstPriceP95: number | null;
    totalP50: number | null;
    totalP95: number | null;
    deadlineHits: number;
  };
  flags: { key: string; enabled: boolean; default: boolean; description: string | null }[];
  reviews: {
    id: string;
    listingTitle: string;
    listingUrl: string;
    sourceId: string;
    candidateName: string | null;
    candidateProductId: string | null;
    score: number | null;
    reasons: string[];
  }[];
};

const TABS = ["Stores", "Products to review", "Data entry", "Usage"] as const;
type Tab = (typeof TABS)[number];
const TECH_TABS = ["Sources", "Failures", "Sessions", "Flags"] as const;
type TechTab = (typeof TECH_TABS)[number];
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ms = (x: number | null) => (x === null ? "—" : `${(x / 1000).toFixed(1)} s`);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" }) : "—";
/** "Fri, Oct 10, 9:02 a.m." */
const checkedAt = (iso: string | null) =>
  iso ? `${formatWeekdayDate(iso)}, ${formatTime(iso)}` : "Never";

export default function StoreStatusPage() {
  const { authed } = useStore();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("Stores");
  const overview = useQuery({
    queryKey: ["admin-overview"],
    enabled: authed,
    queryFn: () => apiFetch<Overview>("/api/admin/overview"),
    refetchInterval: 30_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-overview"] });
  const act = useMutation({
    mutationFn: (v: { path: string; body: unknown; done: string }) =>
      apiFetch<Record<string, unknown>>(v.path, { method: "POST", json: v.body }),
    onSuccess: (_r, v) => {
      toast.success(v.done);
      refresh();
    },
    onError: (err) =>
      toast.error(errorMessage(err, "That didn't work."), { description: "Please try again." }),
  });
  const onAct: ActFn = (path, body, done = "Saved.") => act.mutate({ path, body, done });

  const forbidden = overview.error instanceof ApiRequestError && overview.error.status === 403;
  const data = overview.data;

  return (
    <AppLayout
      title="Store status"
      subtitle="What each store gives us, products to check, and price entry"
      actions={<div />}
    >
      {forbidden ? (
        <p
          role="alert"
          className="mx-auto max-w-xl rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground"
        >
          Store status is for the shop&rsquo;s own account. Sign in with that account to see it.
        </p>
      ) : overview.isError ? (
        <ErrorState
          message={errorMessage(overview.error, "Store status couldn't load.")}
          onRetry={() => void overview.refetch()}
        />
      ) : overview.isLoading || !data ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : (
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div
              className="inline-flex flex-wrap rounded-lg border border-border bg-card p-0.5 text-xs"
              role="tablist"
              aria-label="Store status sections"
            >
              {TABS.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={cn(
                    "rounded-md px-3 py-1.5",
                    tab === t ? "bg-muted font-medium" : "text-muted-foreground",
                    FOCUS,
                  )}
                >
                  {t}
                  {t === "Products to review" && data.reviews.length > 0
                    ? ` (${data.reviews.length})`
                    : ""}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </Button>
          </div>
          <div role="tabpanel" aria-label={tab}>
            {tab === "Stores" && <Stores rows={data.stores} />}
            {tab === "Products to review" && <Reviews data={data} onAct={onAct} />}
            {tab === "Data entry" && (
              <DataEntry data={data} onAct={onAct} pending={act.isPending} />
            )}
            {tab === "Usage" && <Usage usage={data.usage} />}
          </div>
          <Technical data={data} onAct={onAct} />
        </div>
      )}
    </AppLayout>
  );
}

type ActFn = (path: string, body: unknown, done?: string) => void;

/* ── default tabs ─────────────────────────────────────────────────── */

function Stores({ rows }: { rows: StoreStatusRow[] }) {
  return (
    <>
      {/* Phones: one card per store. */}
      <ul className="space-y-2 sm:hidden">
        {rows.map((r) => (
          <li key={r.sourceId} className="rounded-xl border border-border bg-card p-3 text-sm">
            <p className="font-medium">{r.name}</p>
            <p className="mt-1 text-xs">{r.gets.join(" · ")}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Last successful check: {checkedAt(r.lastOkAt)}
            </p>
            <p className={cn("mt-1 text-xs", !r.problem && "text-muted-foreground")}>
              {r.problem ?? "No problems."}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden sm:block">
        <Table head={["Store", "What we can get there", "Last successful check", "Problems"]}>
          {rows.map((r) => (
            <tr key={r.sourceId}>
              <td className="px-3 py-2 font-medium">{r.name}</td>
              <td className="px-3 py-2">{r.gets.join(" · ")}</td>
              <td className="whitespace-nowrap px-3 py-2">{checkedAt(r.lastOkAt)}</td>
              <td className={cn("px-3 py-2", !r.problem && "text-muted-foreground")}>
                {r.problem ?? "No problems."}
              </td>
            </tr>
          ))}
        </Table>
      </div>
    </>
  );
}

function Reviews({ data, onAct }: { data: Overview; onAct: ActFn }) {
  const storeName = new Map(data.stores.map((s) => [s.sourceId, s.name]));
  if (data.reviews.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to review. When a store lists a bag we can&rsquo;t match for sure, it shows up here.
      </p>
    );
  return (
    <ul className="space-y-2">
      {data.reviews.map((r) => (
        <li key={r.id} className="rounded-xl border border-border bg-card p-3 text-sm">
          <p className="font-medium">
            <a
              href={r.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn("hover:underline", FOCUS)}
            >
              {r.listingTitle}
            </a>{" "}
            <span className="text-xs font-normal text-muted-foreground">
              at {storeName.get(r.sourceId) ?? "a store"}
            </span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {r.candidateName ? (
              <>
                This looks like <strong>{r.candidateName}</strong>. If it&rsquo;s the same bag, its
                prices join that product.
              </>
            ) : (
              "We couldn't match this to a product we know, so it's kept on its own."
            )}
          </p>
          <div className="mt-2 flex gap-2">
            {r.candidateProductId && (
              <Button
                size="sm"
                className="h-7 text-[11px]"
                onClick={() =>
                  onAct(`/api/admin/review/${r.id}`, { decision: "approved" }, "Joined.")
                }
              >
                Same product
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() =>
                onAct(`/api/admin/review/${r.id}`, { decision: "rejected" }, "Kept apart.")
              }
            >
              Different product
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Usage({ usage }: { usage: UsageSummary }) {
  return (
    <ul className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
      {usageLines(usage).map((line) => (
        <li key={line} className="tabular-nums">
          {line}
        </li>
      ))}
      <li className="pt-1 text-xs text-muted-foreground">
        Both are free allowances. When one runs out, the app keeps working with verified,
        staff-checked and dealer prices, and the morning email waits for the next day.
      </li>
    </ul>
  );
}

function DataEntry({ data, onAct, pending }: { data: Overview; onAct: ActFn; pending: boolean }) {
  const [feed, setFeed] = useState({
    sourceId: "samsonite-ca",
    asOf: new Date().toISOString().slice(0, 10),
    name: "",
    format: "csv" as "csv" | "json",
    content: "",
  });
  const [manual, setManual] = useState({
    sourceId: "costco-ca",
    title: "",
    price: "",
    checkedAt: new Date().toISOString().slice(0, 10),
    url: "",
    note: "",
  });

  const submitFeed = (e: FormEvent) => {
    e.preventDefault();
    onAct(
      "/api/admin/actions",
      { action: "feed", ...feed, name: feed.name || `feed-${feed.asOf}` },
      "Dealer list imported.",
    );
  };
  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    onAct(
      "/api/admin/actions",
      {
        action: "manual",
        sourceId: manual.sourceId,
        title: manual.title,
        price: Number(manual.price),
        checkedAt: manual.checkedAt,
        url: manual.url || null,
        note: manual.note || null,
      },
      "Staff-checked price saved.",
    );
  };
  const input = cn(
    "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm",
    FOCUS,
  );
  const storeOptions = data.stores.map((s) => (
    <option key={s.sourceId} value={s.sourceId}>
      {s.name}
    </option>
  ));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        onSubmit={submitManual}
        className="space-y-2 rounded-xl border border-border bg-card p-4"
        aria-labelledby="man-h"
      >
        <h2 id="man-h" className="text-sm font-medium">
          Staff-checked price
        </h2>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> A price someone saw in a
          store or a flyer. Shown as &ldquo;Staff-checked · Oct 9&rdquo; with the date you pick.
        </p>
        <label className="block text-xs">
          Store
          <select
            className={input}
            value={manual.sourceId}
            onChange={(e) => setManual({ ...manual, sourceId: e.target.value })}
          >
            {storeOptions}
          </select>
        </label>
        <label className="block text-xs">
          Product name
          <input
            className={input}
            value={manual.title}
            onChange={(e) => setManual({ ...manual, title: e.target.value })}
            required
            maxLength={300}
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            Price ($)
            <input
              type="number"
              step="0.01"
              min="0.01"
              className={input}
              value={manual.price}
              onChange={(e) => setManual({ ...manual, price: e.target.value })}
              required
            />
          </label>
          <label className="block text-xs">
            Checked on
            <input
              type="date"
              className={input}
              value={manual.checkedAt}
              onChange={(e) => setManual({ ...manual, checkedAt: e.target.value })}
              required
            />
          </label>
        </div>
        <label className="block text-xs">
          Link to the store&rsquo;s page (optional)
          <input
            type="url"
            className={input}
            value={manual.url}
            onChange={(e) => setManual({ ...manual, url: e.target.value })}
          />
        </label>
        <label className="block text-xs">
          Note (optional)
          <input
            className={input}
            value={manual.note}
            onChange={(e) => setManual({ ...manual, note: e.target.value })}
            maxLength={500}
          />
        </label>
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
      </form>

      <form
        onSubmit={submitFeed}
        className="space-y-2 rounded-xl border border-border bg-card p-4"
        aria-labelledby="feed-h"
      >
        <h2 id="feed-h" className="text-sm font-medium">
          Dealer list
        </h2>
        <p className="text-xs text-muted-foreground">
          A spreadsheet (CSV) or JSON file from the brand or a dealer. Columns: title, price, sku,
          upc, model, brand, list price, availability, url, as of. Prices show as &ldquo;Dealer list
          · as of Oct 1&rdquo;.
        </p>
        <label className="block text-xs">
          Store
          <select
            className={input}
            value={feed.sourceId}
            onChange={(e) => setFeed({ ...feed, sourceId: e.target.value })}
          >
            {storeOptions}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            Valid from
            <input
              type="date"
              className={input}
              value={feed.asOf}
              onChange={(e) => setFeed({ ...feed, asOf: e.target.value })}
              required
            />
          </label>
          <label className="block text-xs">
            File type
            <select
              className={input}
              value={feed.format}
              onChange={(e) => setFeed({ ...feed, format: e.target.value as "csv" | "json" })}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
            </select>
          </label>
        </div>
        <label className="block text-xs">
          File
          <input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            className={input}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f)
                setFeed({
                  ...feed,
                  name: f.name,
                  content: await f.text(),
                  format: f.name.endsWith(".json") ? "json" : "csv",
                });
            }}
          />
        </label>
        <Button type="submit" size="sm" disabled={pending || !feed.content}>
          Import
        </Button>
      </form>
    </div>
  );
}

/* ── Technical details (collapsed) ────────────────────────────────── */

function Technical({ data, onAct }: { data: Overview; onAct: ActFn }) {
  const [tab, setTab] = useState<TechTab>("Sources");
  return (
    <details className="mt-8 rounded-xl border border-border bg-card/50 p-3" data-technical="">
      <summary className={cn("cursor-pointer text-sm font-medium", FOCUS)}>
        Technical details
      </summary>
      <div className="mt-3">
        <p className="mb-3 text-xs text-muted-foreground">
          Store: {data.store} ·{" "}
          {Object.entries(data.config)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
        </p>
        <div
          className="mb-3 inline-flex flex-wrap rounded-lg border border-border bg-card p-0.5 text-xs"
          role="tablist"
          aria-label="Technical details"
        >
          {TECH_TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                "rounded-md px-3 py-1.5",
                tab === t ? "bg-muted font-medium" : "text-muted-foreground",
                FOCUS,
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <div role="tabpanel" aria-label={tab}>
          {tab === "Sources" && <Sources data={data} onAct={onAct} />}
          {tab === "Failures" && <Failures data={data} />}
          {tab === "Sessions" && <Sessions data={data} />}
          {tab === "Flags" && <Flags data={data} onAct={onAct} />}
        </div>
      </div>
    </details>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {head.map((h, i) => (
              <th key={`${h}-${i}`} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

function Sources({ data, onAct }: { data: Overview; onAct: ActFn }) {
  return (
    <Table
      head={[
        "Store",
        "Live class",
        "Permission",
        "Usable routes",
        "Listings",
        "24 h attempts",
        "Block rate 24 h",
        "Success 7 d",
        "Circuit",
        "Last OK / block",
        "",
      ]}
    >
      {data.sources.map((s) => (
        <tr key={s.sourceId} className={cn(!s.enabled && "opacity-60")}>
          <td className="px-3 py-2 font-medium">{s.retailerLabel}</td>
          <td className="px-3 py-2">{s.liveClass}</td>
          <td className="px-3 py-2">{s.permission}</td>
          <td className="px-3 py-2">
            {s.routes
              .filter((r) => r.usable)
              .map((r) => r.adapter)
              .join(", ") || (
              <span
                className="text-muted-foreground"
                title={s.routes.map((r) => `${r.adapter}: ${r.reason}`).join("\n")}
              >
                none
              </span>
            )}
          </td>
          <td className="px-3 py-2 tabular-nums">{s.listings}</td>
          <td className="px-3 py-2 tabular-nums">{s.attempts24h}</td>
          <td
            className={cn(
              "px-3 py-2 tabular-nums",
              (s.blockRate24h ?? 0) > 0.2 && "font-medium text-danger",
            )}
          >
            {pct(s.blockRate24h)}
          </td>
          <td className="px-3 py-2 tabular-nums">{pct(s.successRate7d)}</td>
          <td
            className={cn("px-3 py-2", s.circuit !== "closed" && "text-danger")}
            title={s.circuitReason ?? undefined}
          >
            {s.circuit}
          </td>
          <td className="px-3 py-2">
            {when(s.lastOkAt)} / {when(s.lastBlockAt)}
          </td>
          <td className="space-x-1 whitespace-nowrap px-3 py-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() =>
                onAct(
                  "/api/admin/actions",
                  { action: "discover", sourceId: s.sourceId },
                  "Looking for products at this store.",
                )
              }
            >
              Discover
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() =>
                onAct(
                  "/api/admin/actions",
                  { action: "source", sourceId: s.sourceId, enabled: !s.enabled },
                  s.enabled ? "Store switched off." : "Store switched on.",
                )
              }
            >
              {s.enabled ? "Disable" : "Enable"}
            </Button>
          </td>
        </tr>
      ))}
    </Table>
  );
}

function Failures({ data }: { data: Overview }) {
  return (
    <div className="space-y-6">
      <section aria-labelledby="f-h">
        <h2 id="f-h" className="mb-2 text-sm font-medium">
          Recent fetch failures and blocks
        </h2>
        <Table head={["When", "Store", "Adapter", "Outcome", "Status", "URL", "Error"]}>
          {data.failures.map((f, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap px-3 py-2">{when(f.startedAt)}</td>
              <td className="px-3 py-2">{f.sourceId}</td>
              <td className="px-3 py-2">{f.adapter}</td>
              <td
                className={cn(
                  "px-3 py-2",
                  /blocked|challenge|rate/.test(f.outcome) && "text-danger",
                )}
              >
                {f.outcome}
              </td>
              <td className="px-3 py-2">{f.status ?? "—"}</td>
              <td className="max-w-xs truncate px-3 py-2" title={f.url}>
                {f.url}
              </td>
              <td className="max-w-xs truncate px-3 py-2" title={f.error ?? ""}>
                {f.error}
              </td>
            </tr>
          ))}
        </Table>
      </section>
      <section aria-labelledby="r-h">
        <h2 id="r-h" className="mb-2 text-sm font-medium">
          Extraction / validation rejections (stored, never shown)
        </h2>
        <Table head={["When", "Store", "Adapter", "Reasons"]}>
          {data.rejections.map((r, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap px-3 py-2">{when(r.fetchedAt)}</td>
              <td className="px-3 py-2">{r.sourceId}</td>
              <td className="px-3 py-2">{r.adapter}</td>
              <td className="px-3 py-2">{r.reasons.join("; ")}</td>
            </tr>
          ))}
        </Table>
      </section>
      <section aria-labelledby="e-h">
        <h2 id="e-h" className="mb-2 text-sm font-medium">
          Rejected web estimates (stored, never shown)
        </h2>
        <Table head={["Found", "Store", "Search", "Result", "Price", "Reasons"]}>
          {data.estimateRejections.map((r, i) => (
            <tr key={i}>
              <td className="whitespace-nowrap px-3 py-2">{when(r.foundAt)}</td>
              <td className="px-3 py-2">{r.sourceId ?? "—"}</td>
              <td className="px-3 py-2">{r.query}</td>
              <td className="max-w-xs truncate px-3 py-2" title={r.url}>
                {r.title || r.url}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {r.price === null ? "—" : `$${r.price.toFixed(2)}`}
              </td>
              <td className="px-3 py-2">{r.reasons.join("; ")}</td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

function Sessions({ data }: { data: Overview }) {
  const s = data.sessionStats;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {s.count} finished · first price p50 {ms(s.firstPriceP50)}, p95 {ms(s.firstPriceP95)} ·
        complete p50 {ms(s.totalP50)}, p95 {ms(s.totalP95)} · deadline hit {s.deadlineHits}×
      </p>
      <Table
        head={["When", "Query", "Status", "Mode", "First price", "Complete", "Deadline", "Prices"]}
      >
        {data.sessions.map((x) => (
          <tr key={x.id}>
            <td className="whitespace-nowrap px-3 py-2">{when(x.createdAt)}</td>
            <td className="px-3 py-2">{x.query}</td>
            <td className="px-3 py-2">{x.status}</td>
            <td className="px-3 py-2">{x.mode}</td>
            <td className="px-3 py-2 tabular-nums">{ms(x.firstPriceMs)}</td>
            <td className="px-3 py-2 tabular-nums">{ms(x.totalMs)}</td>
            <td className="px-3 py-2">{x.deadlineHit ? "hit" : "—"}</td>
            <td className="px-3 py-2 tabular-nums">{x.offers}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

function Flags({ data, onAct }: { data: Overview; onAct: ActFn }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {data.flags.map((f) => (
        <li
          key={f.key}
          className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <p className="font-mono text-xs">{f.key}</p>
            <p className="text-xs text-muted-foreground">
              {f.description ?? ""}
              {f.enabled !== f.default ? " · changed from default" : ""}
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) =>
                onAct(
                  "/api/admin/flags",
                  { key: f.key, enabled: e.target.checked },
                  e.target.checked ? "Switched on." : "Switched off.",
                )
              }
              className={FOCUS}
            />
            {f.enabled ? "On" : "Off"}
          </label>
        </li>
      ))}
    </ul>
  );
}
