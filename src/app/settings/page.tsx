"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { ErrorState, SectionTitle } from "@/components/Bits";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  errorMessage,
  useSearchProvider,
  useSettings,
  useTrackedProducts,
  useUntrackProducts,
  useUpdateSettings,
} from "@/lib/queries";
import { RETAILER_INFO, RETAILER_NAMES, type RetailerCategory } from "@/lib/retailers";
import { useStore } from "@/lib/store";
import type { UserSettings } from "@/lib/types";

const TIMEZONES = [
  "America/Edmonton",
  "America/Vancouver",
  "America/Winnipeg",
  "America/Toronto",
  "America/Halifax",
  "America/St_Johns",
];

const CATEGORY_LABEL: Record<RetailerCategory, string> = {
  major: "Major Canadian retailers",
  specialty: "Brand direct & specialty",
  other: "Marketplaces",
};

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <SectionTitle title={title} description={description} />
      <div className="card-surface space-y-5 p-6">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const { authed, ready, email } = useStore();

  const { data: saved, isLoading, isError, error, refetch } = useSettings(ready && authed);
  const updateSettings = useUpdateSettings();
  const provider = useSearchProvider(ready && authed);
  const { data: tracked } = useTrackedProducts(30, ready && authed);
  const untrack = useUntrackProducts();

  const [draft, setDraft] = useState<UserSettings | null>(null);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (saved) setDraft(saved);
  }, [saved]);

  const dirty = useMemo(
    () => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  function patch(next: Partial<UserSettings>) {
    setDraft((d) => (d ? { ...d, ...next } : d));
  }

  function save() {
    if (!draft) return;
    updateSettings.mutate(draft, {
      onSuccess: () => toast.success("Settings saved"),
    });
  }

  if (isLoading || !draft) {
    return (
      <AppLayout title="Settings" subtitle="Loading…">
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-surface h-40 animate-pulse" />
          ))}
        </div>
      </AppLayout>
    );
  }

  if (isError) {
    return (
      <AppLayout title="Settings" subtitle="">
        <ErrorState message={errorMessage(error, "Couldn't load settings.")} onRetry={refetch} />
      </AppLayout>
    );
  }

  const retailersByCategory = (["major", "specialty", "other"] as const).map((cat) => ({
    cat,
    names: RETAILER_NAMES.filter((n) => RETAILER_INFO[n]?.category === cat),
  }));

  return (
    <AppLayout
      title="Settings"
      subtitle="Report delivery, retailer coverage and data sources"
      actions={
        <Button onClick={save} disabled={!dirty || updateSettings.isPending} className="gap-2">
          {updateSettings.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          {dirty ? "Save changes" : "Saved"}
        </Button>
      }
    >
      {/* ── General ─────────────────────────────────────────── */}
      <Section title="General" description="Account and locale">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="adminEmail">Account email</Label>
            <Input
              id="adminEmail"
              type="email"
              value={draft.adminEmail}
              onChange={(e) => patch({ adminEmail: e.target.value })}
              placeholder={email || "you@example.com"}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Select value={draft.timezone} onValueChange={(v) => patch({ timezone: v })}>
              <SelectTrigger id="timezone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace("America/", "")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Section>

      {/* ── Daily report ────────────────────────────────────── */}
      <Section title="Daily Report" description="A summary email of overnight price movement">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Send a daily report</p>
            <p className="text-sm text-muted-foreground">
              Delivered each morning in your timezone.
            </p>
          </div>
          <Switch
            checked={draft.dailyReport}
            onCheckedChange={(v) => patch({ dailyReport: v })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="reportEmail">Send reports to</Label>
          <Input
            id="reportEmail"
            type="email"
            value={draft.reportEmail}
            onChange={(e) => patch({ reportEmail: e.target.value })}
            disabled={!draft.dailyReport}
            placeholder="reports@example.com"
          />
        </div>

        <fieldset className="space-y-3" disabled={!draft.dailyReport}>
          <legend className="mb-1 text-sm font-medium">Include in the report</legend>
          {(
            [
              ["drops", "Price drops"],
              ["increases", "Price increases"],
              ["oos", "Out-of-stock alerts"],
              ["summary", "Best-deal summary"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-3 text-sm">
              <Checkbox
                checked={draft.include[key]}
                onCheckedChange={(v) =>
                  patch({ include: { ...draft.include, [key]: v === true } })
                }
              />
              {label}
            </label>
          ))}
        </fieldset>
      </Section>

      {/* ── Retailers ───────────────────────────────────────── */}
      <Section
        title="Retailers"
        description="Search results and price checks are limited to the retailers you enable here"
      >
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {draft.retailers.length} of {RETAILER_NAMES.length} enabled. Disabling a retailer hides
          its offers from search and stops recording its prices.
        </div>

        {retailersByCategory.map(({ cat, names }) => (
          <div key={cat}>
            <p className="mb-2 text-sm font-medium">{CATEGORY_LABEL[cat]}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {names.map((name) => (
                <label key={name} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={draft.retailers.includes(name)}
                    onCheckedChange={(v) =>
                      patch({
                        retailers:
                          v === true
                            ? [...draft.retailers, name]
                            : draft.retailers.filter((x) => x !== name),
                      })
                    }
                  />
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: RETAILER_INFO[name].color }}
                    />
                    {name}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}

        <div className="flex gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => patch({ retailers: [...RETAILER_NAMES] })}
          >
            Enable all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              patch({
                retailers: RETAILER_NAMES.filter((n) => RETAILER_INFO[n].category === "major"),
              })
            }
          >
            Majors only
          </Button>
        </div>
      </Section>

      {/* ── Data sources ────────────────────────────────────── */}
      <Section
        title="Data Sources"
        description="Where live prices come from. Configured server-side for security."
      >
        <div className="flex items-start gap-3 rounded-lg border border-border p-4">
          {provider.data?.configured ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          )}
          <div className="text-sm">
            <p className="font-medium">
              {provider.data?.configured
                ? `Active source: ${provider.data.providerLabel}`
                : "No price source configured"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {provider.data?.configured ? (
                provider.data.provider === "gemini-grounded" ? (
                  "Gemini with Google Search grounding. Results are restricted to recognised retailer domains, but confirm prices on the retailer's page before acting on them."
                ) : (
                  "Real Google Shopping merchant listings. Every price links back to the listing it came from."
                )
              ) : (
                <>
                  Set <code className="rounded bg-muted px-1">SERPER_API_KEY</code> (2,500 free
                  searches) or <code className="rounded bg-muted px-1">SERPAPI_KEY</code> (250 free
                  per month) in your environment, then restart. Both are free and neither needs a
                  card. API keys are never stored in the browser.
                </>
              )}
            </p>
          </div>
        </div>

        {/* ── Free-allowance usage ─────────────────────────── */}
        {(provider.data?.budgets ?? []).length > 0 && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Search allowance</p>
            {(provider.data?.budgets ?? []).map((b) => {
              const pct = b.limit > 0 ? Math.min(100, (b.used / b.limit) * 100) : 0;
              const tone =
                b.exhausted || pct >= 90
                  ? "bg-danger"
                  : pct >= 70
                    ? "bg-warning"
                    : "bg-primary";
              return (
                <div key={b.provider} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{b.label}</span>
                    <span
                      className={`text-sm tabular-nums ${b.exhausted ? "text-danger" : "text-muted-foreground"}`}
                    >
                      {b.used} / {b.limit} used
                      {!b.exhausted && ` · ${b.remaining} left`}
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">{b.note}</p>
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground">
              Repeating a search you&apos;ve already run is free — results are cached, so only new
              queries and price refreshes count against this.
            </p>
          </div>
        )}

        <div className="flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Scheduled price checks run on the schedule in{" "}
            <code className="rounded bg-background px-1">vercel.json</code> (or the GitHub Actions
            workflows), and stop early if the allowance above is nearly spent. Use{" "}
            <strong>Refresh prices</strong> on the dashboard to check immediately.
          </span>
        </div>
      </Section>

      {/* ── Danger zone ─────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-1 text-lg font-semibold tracking-tight text-danger">Danger Zone</h2>
        <p className="mb-4 text-sm text-muted-foreground">This cannot be undone.</p>

        <div className="card-surface border-danger/30 p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">Stop tracking everything</p>
              <p className="text-sm text-muted-foreground">
                Removes all {tracked?.length ?? 0} products from your tracked list. Recorded price
                history is kept, so re-tracking a product restores its chart.
              </p>
            </div>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="text-danger" disabled={!tracked?.length}>
                  Remove all
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Stop tracking all products?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes {tracked?.length ?? 0} products from your dashboard. Type{" "}
                    <strong>REMOVE</strong> to confirm.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="REMOVE"
                />
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setConfirmText("")}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={confirmText !== "REMOVE"}
                    onClick={() => {
                      untrack.mutate((tracked ?? []).map((p) => p.id));
                      setConfirmText("");
                    }}
                  >
                    Remove all
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </section>
    </AppLayout>
  );
}
