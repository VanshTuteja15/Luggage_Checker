"use client";

/* ------------------------------------------------------------------ */
/*  /admin — source health, block rates, failures, extraction           */
/*  rejections, the identity review queue, research session timings,   */
/*  feature flags, and dealer-feed / manual price entry.                */
/*  Admins only (app_admins); every action goes through /api/admin.     */
/* ------------------------------------------------------------------ */

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { apiFetch, ApiRequestError } from "@/lib/api-client";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

type Overview = {
  config: Record<string, string>;
  store: string;
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

const TABS = ["Sources", "Failures", "Review queue", "Sessions", "Flags", "Data entry"] as const;
type Tab = (typeof TABS)[number];
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const ms = (x: number | null) => (x === null ? "—" : `${(x / 1000).toFixed(1)} s`);
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" }) : "—";

export default function AdminPage() {
  const { authed } = useStore();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("Sources");
  const overview = useQuery({
    queryKey: ["admin-overview"],
    enabled: authed,
    queryFn: () => apiFetch<Overview>("/api/admin/overview"),
    refetchInterval: 30_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-overview"] });
  const act = useMutation({
    mutationFn: (v: { path: string; body: unknown }) =>
      apiFetch<Record<string, unknown>>(v.path, { method: "POST", json: v.body }),
    onSuccess: () => {
      toast.success("Done");
      refresh();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed"),
  });

  const forbidden = overview.error instanceof ApiRequestError && overview.error.status === 403;

  return (
    <AppLayout
      title="Admin"
      subtitle="Price engine health, sources and data quality"
      actions={<div />}
    >
      {forbidden ? (
        <p
          role="alert"
          className="mx-auto max-w-xl rounded-xl border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground"
        >
          Admins only. Ask the owner to add your user id to <code>app_admins</code> (see
          docs/HUMAN_ACTIONS.md).
        </p>
      ) : overview.isLoading || !overview.data ? (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…
        </p>
      ) : (
        <div className="mx-auto max-w-6xl">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div
              className="inline-flex flex-wrap rounded-lg border border-border bg-card p-0.5 text-xs"
              role="tablist"
              aria-label="Admin sections"
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
                  {t === "Review queue" && overview.data.reviews.length > 0
                    ? ` (${overview.data.reviews.length})`
                    : ""}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={refresh}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Refresh
            </Button>
          </div>
          <p className="mb-4 text-xs text-muted-foreground">
            Store: {overview.data.store} ·{" "}
            {Object.entries(overview.data.config)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" · ")}
          </p>
          <div role="tabpanel">
            {tab === "Sources" && (
              <Sources data={overview.data} onAct={(path, body) => act.mutate({ path, body })} />
            )}
            {tab === "Failures" && <Failures data={overview.data} />}
            {tab === "Review queue" && (
              <Reviews data={overview.data} onAct={(path, body) => act.mutate({ path, body })} />
            )}
            {tab === "Sessions" && <Sessions data={overview.data} />}
            {tab === "Flags" && (
              <Flags data={overview.data} onAct={(path, body) => act.mutate({ path, body })} />
            )}
            {tab === "Data entry" && (
              <DataEntry
                data={overview.data}
                onAct={(path, body) => act.mutate({ path, body })}
                pending={act.isPending}
              />
            )}
          </div>
        </div>
      )}
    </AppLayout>
  );
}

type ActFn = (path: string, body: unknown) => void;

function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-medium">
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
                onAct("/api/admin/actions", { action: "discover", sourceId: s.sourceId })
              }
            >
              Discover
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() =>
                onAct("/api/admin/actions", {
                  action: "source",
                  sourceId: s.sourceId,
                  enabled: !s.enabled,
                })
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
              <td className="px-3 py-2 whitespace-nowrap">{when(f.startedAt)}</td>
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
              <td className="px-3 py-2 whitespace-nowrap">{when(r.fetchedAt)}</td>
              <td className="px-3 py-2">{r.sourceId}</td>
              <td className="px-3 py-2">{r.adapter}</td>
              <td className="px-3 py-2">{r.reasons.join("; ")}</td>
            </tr>
          ))}
        </Table>
      </section>
    </div>
  );
}

function Reviews({ data, onAct }: { data: Overview; onAct: ActFn }) {
  if (data.reviews.length === 0)
    return <p className="text-sm text-muted-foreground">Nothing to review.</p>;
  return (
    <ul className="space-y-2">
      {data.reviews.map((r) => (
        <li key={r.id} className="rounded-xl border border-border bg-card p-3 text-sm">
          <p className="font-medium">
            <a
              href={r.listingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {r.listingTitle}
            </a>{" "}
            <span className="text-xs text-muted-foreground">({r.sourceId})</span>
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {r.candidateName ? (
              <>
                Same product as <strong>{r.candidateName}</strong>? (score {r.score?.toFixed(2)})
              </>
            ) : (
              "No candidate"
            )}{" "}
            — {r.reasons.join("; ")}
          </p>
          <div className="mt-2 flex gap-2">
            {r.candidateProductId && (
              <Button
                size="sm"
                className="h-7 text-[11px]"
                onClick={() => onAct(`/api/admin/review/${r.id}`, { decision: "approved" })}
              >
                Same product
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => onAct(`/api/admin/review/${r.id}`, { decision: "rejected" })}
            >
              Different product
            </Button>
          </div>
        </li>
      ))}
    </ul>
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
            <td className="px-3 py-2 whitespace-nowrap">{when(x.createdAt)}</td>
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
              onChange={(e) => onAct("/api/admin/flags", { key: f.key, enabled: e.target.checked })}
              className={FOCUS}
            />
            {f.enabled ? "On" : "Off"}
          </label>
        </li>
      ))}
    </ul>
  );
}

function DataEntry({ data, onAct, pending }: { data: Overview; onAct: ActFn; pending: boolean }) {
  const stores = data.sources.filter((s) => s.enabled);
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
    onAct("/api/admin/actions", {
      action: "feed",
      ...feed,
      name: feed.name || `feed-${feed.asOf}`,
    });
  };
  const submitManual = (e: FormEvent) => {
    e.preventDefault();
    onAct("/api/admin/actions", {
      action: "manual",
      sourceId: manual.sourceId,
      title: manual.title,
      price: Number(manual.price),
      checkedAt: manual.checkedAt,
      url: manual.url || null,
      note: manual.note || null,
    });
  };
  const input = cn(
    "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm",
    FOCUS,
  );

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <form
        onSubmit={submitFeed}
        className="space-y-2 rounded-xl border border-border bg-card p-4"
        aria-labelledby="feed-h"
      >
        <h2 id="feed-h" className="text-sm font-medium">
          Import a dealer / affiliate feed
        </h2>
        <p className="text-xs text-muted-foreground">
          Columns: title, price, sku, gtin/upc, mpn/model, brand, list_price/msrp, availability,
          url, as_of. Prices show as &ldquo;Feed as of &lt;date&gt;&rdquo;.
        </p>
        <label className="block text-xs">
          Store
          <select
            className={input}
            value={feed.sourceId}
            onChange={(e) => setFeed({ ...feed, sourceId: e.target.value })}
          >
            {stores.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                {s.retailerLabel}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs">
            As of
            <input
              type="date"
              className={input}
              value={feed.asOf}
              onChange={(e) => setFeed({ ...feed, asOf: e.target.value })}
              required
            />
          </label>
          <label className="block text-xs">
            Format
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

      <form
        onSubmit={submitManual}
        className="space-y-2 rounded-xl border border-border bg-card p-4"
        aria-labelledby="man-h"
      >
        <h2 id="man-h" className="text-sm font-medium">
          Record a manually checked price
        </h2>
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> For stores no automated
          route reaches. Shown as &ldquo;Manually checked &lt;date&gt;&rdquo;.
        </p>
        <label className="block text-xs">
          Store
          <select
            className={input}
            value={manual.sourceId}
            onChange={(e) => setManual({ ...manual, sourceId: e.target.value })}
          >
            {stores.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                {s.retailerLabel}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          Product title
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
            Price (CAD)
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
          Store link (optional, store&rsquo;s own site)
          <input
            type="url"
            className={input}
            value={manual.url}
            onChange={(e) => setManual({ ...manual, url: e.target.value })}
          />
        </label>
        <label className="block text-xs">
          Note
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
    </div>
  );
}
