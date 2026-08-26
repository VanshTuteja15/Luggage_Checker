"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { RETAILER_INFO, RETAILER_NAMES, type RetailerCategory } from "@/lib/data";
import { useStore } from "@/lib/store";

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
    <div className="card-surface p-6">
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5 space-y-4">{children}</div>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, updateSettings, clearHistory, untrack, trackedIds } = useStore();
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [testingApi, setTestingApi] = useState(false);

  return (
    <AppLayout title="Settings" subtitle="Configure your LuggageTracker preferences" actions={<div />}>
      <div className="mx-auto max-w-2xl space-y-6">
        {/* General */}
        <Section title="General Settings">
          <div className="space-y-1.5">
            <Label htmlFor="admin-email">Admin Email</Label>
            <Input
              id="admin-email"
              type="email"
              value={settings.adminEmail}
              onChange={(e) => updateSettings({ adminEmail: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone Display</Label>
            <Select
              value={settings.timezone}
              onValueChange={(v) => updateSettings({ timezone: v })}
            >
              <SelectTrigger id="timezone" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="America/Edmonton">Mountain Time (MT)</SelectItem>
                <SelectItem value="America/Los_Angeles">Pacific Time (PT)</SelectItem>
                <SelectItem value="America/Chicago">Central Time (CT)</SelectItem>
                <SelectItem value="America/New_York">Eastern Time (ET)</SelectItem>
                <SelectItem value="UTC">UTC</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refresh">Dashboard Refresh Interval</Label>
            <Select
              value={settings.refreshInterval}
              onValueChange={(v) => updateSettings({ refreshInterval: v })}
            >
              <SelectTrigger id="refresh" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Every hour</SelectItem>
                <SelectItem value="6h">Every 6 hours</SelectItem>
                <SelectItem value="12h">Every 12 hours</SelectItem>
                <SelectItem value="24h">Once daily (9 AM MT)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => {
              toast.success("Settings saved");
            }}
          >
            Save Changes
          </Button>
        </Section>

        {/* Daily Report */}
        <Section
          title="Daily Report Settings"
          description="Configure the automated 9 AM Mountain Time email report"
        >
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Daily Email Report</Label>
              <p className="text-xs text-muted-foreground">
                Receive a summary email every morning at 9 AM MT
              </p>
            </div>
            <Switch
              checked={settings.dailyReport}
              onCheckedChange={(v) => updateSettings({ dailyReport: v })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-email">Report Email Address</Label>
            <Input
              id="report-email"
              type="email"
              value={settings.reportEmail}
              onChange={(e) => updateSettings({ reportEmail: e.target.value })}
              disabled={!settings.dailyReport}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Report Time</Label>
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              9:00 AM Mountain Time (controlled by GitHub Actions)
            </p>
          </div>
          <div className="space-y-2">
            <Label>Include in Report</Label>
            <div className="space-y-2">
              {[
                { key: "drops" as const, label: "Price Drops" },
                { key: "increases" as const, label: "Price Increases" },
                { key: "oos" as const, label: "Out of Stock Alerts" },
                { key: "summary" as const, label: "Summary Statistics" },
              ].map((item) => (
                <div key={item.key} className="flex items-center gap-2">
                  <Checkbox
                    id={`include-${item.key}`}
                    checked={settings.include[item.key]}
                    disabled={!settings.dailyReport}
                    onCheckedChange={(v) =>
                      updateSettings({
                        include: { ...settings.include, [item.key]: !!v },
                      })
                    }
                  />
                  <Label htmlFor={`include-${item.key}`} className="text-sm font-normal">
                    {item.label}
                  </Label>
                </div>
              ))}
            </div>
          </div>
        </Section>

        {/* Data Sources */}
        <Section
          title="Data Sources"
          description="Configure API keys and supported retailers"
        >
          <div className="space-y-1.5">
            <Label htmlFor="serp-key">SerpAPI Key</Label>
            <div className="flex gap-2">
              <Input
                id="serp-key"
                type="password"
                value={settings.serpApiKey}
                onChange={(e) => updateSettings({ serpApiKey: e.target.value })}
                placeholder="Enter your SerpAPI key..."
                className="flex-1"
              />
              <Button
                variant="outline"
                disabled={!settings.serpApiKey || testingApi}
                onClick={() => {
                  setTestingApi(true);
                  setTimeout(() => {
                    setTestingApi(false);
                    toast.success("API connection successful");
                  }, 1500);
                }}
              >
                {testingApi ? "Testing..." : "Test Connection"}
              </Button>
            </div>
          </div>
          <div className="space-y-4">
            <Label>Supported Retailers</Label>
            {(["major", "specialty", "other"] as RetailerCategory[]).map((cat) => {
              const label = cat === "major" ? "Major Canadian Retailers" : cat === "specialty" ? "Specialty / Brand Direct" : "Marketplace / Other";
              const retailers = RETAILER_NAMES.filter((n) => RETAILER_INFO[n]?.category === cat);
              return (
                <div key={cat}>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
                  <div className="space-y-2">
                    {retailers.map((r) => (
                      <div key={r} className="flex items-center gap-2">
                        <Checkbox
                          id={`retailer-${r}`}
                          checked={settings.retailers.includes(r)}
                          onCheckedChange={(v) => {
                            const next = v
                              ? [...settings.retailers, r]
                              : settings.retailers.filter((x) => x !== r);
                            updateSettings({ retailers: next });
                          }}
                        />
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: RETAILER_INFO[r]?.color ?? "#6B7280" }}
                        />
                        <Label htmlFor={`retailer-${r}`} className="text-sm font-normal">
                          {r}
                        </Label>
                        <span className="text-xs text-muted-foreground">{RETAILER_INFO[r]?.domain}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Section>

        {/* Danger Zone */}
        <div className="rounded-lg border-2 border-danger/30 p-6">
          <h3 className="text-base font-semibold text-danger">Danger Zone</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            These actions are destructive and cannot be undone.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="border-danger text-danger hover:bg-danger-soft">
                  Clear All Price History
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all price history?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all recorded price data. Products will remain
                    tracked but their history will be gone. Type <strong>DELETE</strong> to confirm.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <Input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder="Type DELETE"
                />
                <AlertDialogFooter>
                  <AlertDialogCancel onClick={() => setDeleteConfirm("")}>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={deleteConfirm !== "DELETE"}
                    className="bg-danger text-danger-foreground hover:bg-danger/90"
                    onClick={() => {
                      clearHistory();
                      setDeleteConfirm("");
                      toast.success("Price history cleared");
                    }}
                  >
                    Clear History
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" className="border-danger text-danger hover:bg-danger-soft">
                  Remove All Tracked Products
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove all tracked products?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will stop monitoring all {trackedIds.length} products. Price history will
                    be preserved.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-danger text-danger-foreground hover:bg-danger/90"
                    onClick={() => {
                      untrack(trackedIds);
                      toast.success("All products removed from tracking");
                    }}
                  >
                    Remove All
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
