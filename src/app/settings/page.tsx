"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { ErrorState, SectionTitle } from "@/components/Bits";
import { ThemePicker } from "@/components/ThemeToggle";
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
import { retailerColor } from "@/lib/retailers";
import { useStore } from "@/lib/store";
import { STORE_GROUPS, STORES } from "@/lib/stores";
import type { UserSettings } from "@/lib/types";

const TIMEZONES = [
  "America/Edmonton",
  "America/Vancouver",
  "America/Winnipeg",
  "America/Toronto",
  "America/Halifax",
  "America/St_Johns",
];

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

  const storesByGroup = STORE_GROUPS.map((g) => ({
    ...g,
    stores: STORES.filter((s) => s.group === g.id),
  })).filter((g) => g.stores.length > 0);
  const allLabels = STORES.map((s) => s.label);

  return (
    <AppLayout
      title="Settings"
      subtitle="Stores, web estimates and your account"
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
      {/* ── Appearance ──────────────────────────────────────── */}
      <Section title="Appearance" description="How LuggageTracker looks on this device">
        <ThemePicker />
      </Section>

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

      {/* ── Stores ──────────────────────────────────────────── */}
      <Section
        title="Stores"
        description="Searches and the morning email show only the stores ticked here"
      >
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          {draft.retailers.length} of {STORES.length} stores chosen. Store status explains which
          stores give verified prices, web estimates or links only.
        </div>

        {storesByGroup.map((group) => (
          <fieldset key={group.id}>
            <legend className="mb-2 text-sm font-medium">{group.label}</legend>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {group.stores.map((s) => (
                <label key={s.id} className="flex items-center gap-3 text-sm">
                  <Checkbox
                    checked={draft.retailers.includes(s.label)}
                    onCheckedChange={(v) =>
                      patch({
                        retailers:
                          v === true
                            ? [...draft.retailers, s.label]
                            : draft.retailers.filter((x) => x !== s.label),
                      })
                    }
                  />
                  <span className="inline-flex items-center gap-2">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: retailerColor(s.label) }}
                      aria-hidden
                    />
                    {s.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}

        <div className="flex gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => patch({ retailers: allLabels })}>
            Choose all
          </Button>
        </div>
      </Section>

      {/* ── Web estimates ───────────────────────────────────── */}
      <Section
        title="Web estimates"
        description="Prices found in web search results for stores we can't check directly"
      >
        <div className="flex items-start gap-3 rounded-lg border border-border p-4">
          {provider.data?.configured ? (
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
          ) : (
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
          )}
          <div className="text-sm">
            <p className="font-medium">
              {provider.data?.configured ? "Web estimates are on" : "Web estimates are off"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {provider.data?.configured
                ? "They use a free monthly allowance and stop before it runs out. Every estimate is labelled so you can confirm it on the store's site."
                : "The app still shows verified prices, staff-checked prices and dealer lists. The person who set up LuggageTracker can switch estimates on."}
            </p>
          </div>
        </div>

        {(provider.data?.budgets ?? []).map((b) => (
          <p key={b.provider} className="text-sm">
            Web estimates left this month:{" "}
            <strong className="tabular-nums">{b.exhausted ? 0 : b.remaining}</strong>
            <span className="text-muted-foreground"> of {b.limit}</span>
          </p>
        ))}
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
                history is kept, so re-tracking a product brings its history back.
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
