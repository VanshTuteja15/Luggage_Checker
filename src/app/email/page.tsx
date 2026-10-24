"use client";

/* ------------------------------------------------------------------ */
/*  Morning Email (R1.1): schedule, recipients, products, preview,     */
/*  test send and the send log. Everything here is real data: the      */
/*  preview is the exact email that would go out now.                  */
/* ------------------------------------------------------------------ */

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Eye,
  Loader2,
  Mail,
  Plus,
  Save,
  Send,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { AppLayout } from "@/components/AppLayout";
import { ErrorState, SectionTitle } from "@/components/Bits";
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
  useEmailOverview,
  useEmailPreview,
  useSaveEmailProducts,
  useSaveEmailSettings,
  useSendTestEmail,
  type EmailOverview,
  type EmailProduct,
} from "@/lib/queries";
import { useStore } from "@/lib/store";
import { formatTime, formatWeekdayDate, formatYmdWeekday } from "@/lib/time/local";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8" aria-labelledby={id}>
      <div id={id}>
        <SectionTitle title={title} description={description} />
      </div>
      <div className="card-surface space-y-5 p-4 sm:p-6">{children}</div>
    </section>
  );
}

/* ── Schedule ──────────────────────────────────────────────────────── */

function ScheduleSection({ data }: { data: EmailOverview }) {
  const save = useSaveEmailSettings();
  const [enabled, setEnabled] = useState(data.settings.enabled);
  const [sendTime, setSendTime] = useState(data.settings.sendTime);
  const [timeZone, setTimeZone] = useState(data.settings.timeZone);
  useEffect(() => {
    setEnabled(data.settings.enabled);
    setSendTime(data.settings.sendTime);
    setTimeZone(data.settings.timeZone);
  }, [data.settings.enabled, data.settings.sendTime, data.settings.timeZone]);

  const dirty =
    enabled !== data.settings.enabled ||
    sendTime !== data.settings.sendTime ||
    timeZone !== data.settings.timeZone;

  return (
    <Section id="email-schedule" title="Schedule" description="One email a day, at the time you pick">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="email-enabled" className="text-sm font-medium">
            Send the morning email
          </Label>
          <p className="text-sm text-muted-foreground">
            {enabled ? "On. It goes out every day." : "Off. Nothing is sent until you turn it on."}
          </p>
        </div>
        <Switch id="email-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="email-time">Send time</Label>
          <Input
            id="email-time"
            type="time"
            value={sendTime}
            onChange={(e) => setSendTime(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email-tz">Time zone</Label>
          <Select value={timeZone} onValueChange={setTimeZone}>
            <SelectTrigger id="email-tz">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {data.timeZones.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          onClick={() =>
            save.mutate(
              { enabled, sendTime, timeZone },
              {
                onSuccess: () => toast.success("Schedule saved"),
                onError: (err) => toast.error(errorMessage(err, "Couldn't save the schedule")),
              },
            )
          }
          disabled={!dirty || save.isPending || !/^\d{2}:\d{2}$/.test(sendTime)}
          className="gap-2"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
          {dirty ? "Save schedule" : "Saved"}
        </Button>
      </div>
    </Section>
  );
}

/* ── Recipients ────────────────────────────────────────────────────── */

function RecipientsSection({ data }: { data: EmailOverview }) {
  const save = useSaveEmailSettings();
  const test = useSendTestEmail();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const recipients = data.settings.recipients;
  const [testTo, setTestTo] = useState<string>(recipients[0]?.address ?? "");
  useEffect(() => {
    if (!recipients.some((r) => r.address === testTo)) setTestTo(recipients[0]?.address ?? "");
  }, [recipients, testTo]);
  const tz = data.settings.timeZone;

  function add() {
    const address = draft.trim().toLowerCase();
    if (!EMAIL_RE.test(address)) return setProblem("That doesn't look like an email address.");
    if (recipients.some((r) => r.address === address))
      return setProblem("That address is already on the list.");
    if (recipients.length >= 10) return setProblem("You can add up to 10 addresses.");
    setProblem(null);
    save.mutate(
      { recipients: [...recipients.map((r) => r.address), address] },
      {
        onSuccess: () => {
          setDraft("");
          toast.success(`Added ${address}`);
        },
        onError: (err) => setProblem(errorMessage(err, "Couldn't add that address")),
      },
    );
  }

  function remove(address: string) {
    save.mutate(
      { recipients: recipients.map((r) => r.address).filter((a) => a !== address) },
      {
        onSuccess: () => toast.success(`Removed ${address}`),
        onError: (err) => toast.error(errorMessage(err, "Couldn't remove that address")),
      },
    );
  }

  return (
    <Section
      id="email-recipients"
      title="Recipients"
      description="Up to 10 addresses. Each person gets their own copy."
    >
      {recipients.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No addresses yet. Add at least one, or nobody will get the email.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {recipients.map((r) => (
            <li key={r.address} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.address}</p>
                <p className="text-xs text-muted-foreground">
                  {r.lastError ? (
                    <span className="text-danger">
                      Last error {r.lastErrorAt ? formatWeekdayDate(r.lastErrorAt, tz) : ""}: {r.lastError}
                    </span>
                  ) : r.lastDeliveredAt ? (
                    `Last delivered ${formatWeekdayDate(r.lastDeliveredAt, tz)} at ${formatTime(r.lastDeliveredAt, tz)}`
                  ) : (
                    "Not sent yet"
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 self-start text-xs sm:self-auto"
                onClick={() => remove(r.address)}
                disabled={save.isPending}
                aria-label={`Remove ${r.address}`}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="flex-1 space-y-1">
          <Label htmlFor="email-add" className="sr-only">
            Email address to add
          </Label>
          <Input
            id="email-add"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={!!problem}
            aria-describedby={problem ? "email-add-problem" : undefined}
          />
        </div>
        <Button type="submit" disabled={!draft.trim() || save.isPending || recipients.length >= 10} className="gap-2">
          <Plus className="h-4 w-4" aria-hidden /> Add address
        </Button>
      </form>
      {problem && (
        <p id="email-add-problem" role="alert" className="text-sm text-danger">
          {problem}
        </p>
      )}

      <div className="border-t border-border pt-4">
        <p className="mb-2 text-sm font-medium">Send a test now</p>
        <p className="mb-3 text-sm text-muted-foreground">
          A real email with today&rsquo;s prices. It doesn&rsquo;t count as the daily email. Up to 5 an hour.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <Label htmlFor="email-test-to" className="sr-only">
              Send the test to
            </Label>
            <Select value={testTo} onValueChange={setTestTo} disabled={recipients.length === 0}>
              <SelectTrigger id="email-test-to">
                <SelectValue placeholder="Add an address first" />
              </SelectTrigger>
              <SelectContent>
                {recipients.map((r) => (
                  <SelectItem key={r.address} value={r.address}>
                    {r.address}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            className="gap-2"
            disabled={!testTo || test.isPending || !data.provider.configured}
            onClick={() =>
              test.mutate(testTo, {
                onSuccess: () => toast.success(`Test email sent to ${testTo}`),
                onError: (err) => toast.error(errorMessage(err, "The test email couldn't be sent")),
              })
            }
          >
            {test.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
            Send test now
          </Button>
        </div>
      </div>
    </Section>
  );
}

/* ── Products ──────────────────────────────────────────────────────── */

function chosenOrder(products: EmailProduct[]): string[] {
  return products
    .filter((p) => p.chosen)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((p) => p.productId);
}

function ProductsSection({ data }: { data: EmailOverview }) {
  const save = useSaveEmailProducts();
  const saved = useMemo(() => chosenOrder(data.products), [data.products]);
  const [order, setOrder] = useState<string[]>(saved);
  const [filter, setFilter] = useState("");
  useEffect(() => setOrder(saved), [saved]);

  const byId = useMemo(() => new Map(data.products.map((p) => [p.productId, p])), [data.products]);
  const dirty = order.join() !== saved.join();
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = data.products
    .filter((p) => {
      const hay = `${p.brand} ${p.name} ${p.color}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggle = (id: string, on: boolean) =>
    setOrder((o) => (on ? (o.includes(id) ? o : [...o, id]) : o.filter((x) => x !== id)));
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const j = i + d;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  if (data.products.length === 0)
    return (
      <Section id="email-products" title="Products" description="Which products the email shows">
        <p className="text-sm text-muted-foreground">
          No tracked products yet. Track products from Search, then choose them here.
        </p>
      </Section>
    );

  return (
    <Section id="email-products" title="Products" description="Which products the email shows, in this order">
      <p className="text-sm font-medium" aria-live="polite">
        {order.length === 1 ? "1 product chosen" : `${order.length} products chosen`}
      </p>

      {order.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No products chosen yet. Tick products below or use &lsquo;Add to morning email&rsquo; on search results.
        </p>
      ) : (
        <ol className="divide-y divide-border rounded-lg border border-border" aria-label="Email order">
          {order.map((id, i) => {
            const p = byId.get(id);
            if (!p) return null;
            return (
              <li key={id} className="flex items-center gap-2 px-3 py-2">
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {p.brand ? `${p.brand} · ` : ""}
                  {p.name}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  aria-label={`Move ${p.name} up`}
                >
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => move(i, 1)}
                  disabled={i === order.length - 1}
                  aria-label={`Move ${p.name} down`}
                >
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ol>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1">
          <Label htmlFor="email-filter">Find a product</Label>
          <Input
            id="email-filter"
            type="search"
            placeholder="Brand, name or colour"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={() => setOrder((o) => [...o, ...shown.map((p) => p.productId).filter((id) => !o.includes(id))])}
          >
            Select all{words.length ? " shown" : ""}
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setOrder([])} disabled={order.length === 0}>
            Clear
          </Button>
        </div>
      </div>

      <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {shown.map((p) => {
          const id = `pick-${p.productId}`;
          return (
            <li key={p.productId} className="flex items-center gap-3 px-3 py-2">
              <Checkbox
                id={id}
                checked={order.includes(p.productId)}
                onCheckedChange={(v) => toggle(p.productId, v === true)}
              />
              <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
                <span className="block truncate">{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[p.brand, p.color].filter(Boolean).join(" · ")}
                  {p.targetPrice !== null ? ` · target $${p.targetPrice.toFixed(2)}` : ""}
                </span>
              </label>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="px-3 py-4 text-sm text-muted-foreground">No tracked product matches &ldquo;{filter}&rdquo;.</li>
        )}
      </ul>

      <div className="flex justify-end">
        <Button
          onClick={() =>
            save.mutate(order, {
              onSuccess: () => toast.success("Products saved"),
              onError: (err) => toast.error(errorMessage(err, "Couldn't save the products")),
            })
          }
          disabled={!dirty || save.isPending}
          className="gap-2"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Save className="h-4 w-4" aria-hidden />}
          {dirty ? "Save products" : "Saved"}
        </Button>
      </div>
    </Section>
  );
}

/* ── Preview ───────────────────────────────────────────────────────── */

function PreviewSection() {
  const preview = useEmailPreview();
  const [asText, setAsText] = useState(false);
  return (
    <Section
      id="email-preview"
      title="Preview"
      description="The exact email that would be sent now, with today's prices"
    >
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => preview.mutate()} disabled={preview.isPending} className="gap-2">
          {preview.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
          {preview.data ? "Refresh preview" : "Show preview"}
        </Button>
        {preview.data && (
          <Button variant="outline" onClick={() => setAsText((v) => !v)}>
            {asText ? "Show as email" : "Show plain text"}
          </Button>
        )}
      </div>
      {preview.isError && (
        <ErrorState message={errorMessage(preview.error, "The preview couldn't be made.")} onRetry={() => preview.mutate()} />
      )}
      {preview.data && (
        <div className="space-y-2">
          <p className="text-sm">
            <span className="text-muted-foreground">Subject:</span> {preview.data.subject}
          </p>
          {asText ? (
            <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs">
              {preview.data.text}
            </pre>
          ) : (
            <iframe
              title="Email preview"
              sandbox=""
              srcDoc={preview.data.html}
              className="h-[640px] w-full rounded-lg border border-border bg-white"
            />
          )}
        </div>
      )}
    </Section>
  );
}

/* ── Send log ──────────────────────────────────────────────────────── */

function LogSection({ data }: { data: EmailOverview }) {
  const tz = data.settings.timeZone;
  return (
    <Section id="email-log" title="Send log" description="The last 30 days">
      {data.log.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing sent yet. The first email goes out at the next send time.</p>
      ) : (
        <>
          <table className="hidden w-full text-sm sm:table">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Email</th>
                <th className="py-2 pr-3 font-medium">Sent at</th>
                <th className="py-2 pr-3 text-right font-medium">Products</th>
                <th className="py-2 pr-3 text-right font-medium">Delivered</th>
                <th className="py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {data.log.map((r) => (
                <tr key={r.id} className="border-b border-border align-top last:border-0">
                  <td className="py-2 pr-3 whitespace-nowrap">{formatYmdWeekday(r.localDate)}</td>
                  <td className="py-2 pr-3">{r.kind === "test" ? "Test" : "Daily"}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{r.sentAt ? formatTime(r.sentAt, tz) : "—"}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.products}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {r.delivered}
                    {r.failed ? ` of ${r.delivered + r.failed}` : ""}
                  </td>
                  <td className="py-2">
                    <span className={r.failed || r.status === "missed" ? "font-medium text-danger" : ""}>{r.statusText}</span>
                    {r.details.map((d) => (
                      <span key={d} className="block text-xs text-muted-foreground">
                        {d}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="space-y-2 sm:hidden">
            {data.log.map((r) => (
              <li key={r.id} className="rounded-lg border border-border p-3 text-sm">
                <p className="font-medium">
                  {formatYmdWeekday(r.localDate)} · {r.kind === "test" ? "Test" : "Daily"}
                </p>
                <p className={r.failed || r.status === "missed" ? "text-danger" : "text-muted-foreground"}>
                  {r.statusText}
                  {r.sentAt ? ` at ${formatTime(r.sentAt, tz)}` : ""} · {r.products} products · {r.delivered} delivered
                  {r.failed ? `, ${r.failed} failed` : ""}
                </p>
                {r.details.map((d) => (
                  <p key={d} className="text-xs text-muted-foreground">
                    {d}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/* ── Page ──────────────────────────────────────────────────────────── */

export default function EmailPage() {
  const { authed, ready } = useStore();
  const overview = useEmailOverview(ready && authed);
  const data = overview.data;

  return (
    <AppLayout title="Morning Email" subtitle="Today's prices for the products you choose, every morning">
      {overview.isLoading || !ready ? (
        <div className="space-y-4" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card-surface h-40 animate-pulse" />
          ))}
        </div>
      ) : overview.isError || !data ? (
        <ErrorState
          message={errorMessage(overview.error, "The morning email settings couldn't be loaded.")}
          onRetry={() => void overview.refetch()}
        />
      ) : (
        <>
          {data.banner && (
            <div role="alert" className="mb-6 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              <span>{data.banner}</span>
            </div>
          )}

          <div className="mb-6 flex items-start gap-3 rounded-xl border border-border p-4 text-sm">
            {data.provider.configured ? (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
            ) : (
              <Mail className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
            )}
            <div className="space-y-1">
              <p className="font-medium">
                {data.provider.configured
                  ? `Email is set up${data.provider.from ? `. It's sent from ${data.provider.from}.` : "."}`
                  : "Email isn't set up yet"}
              </p>
              {!data.provider.configured && (
                <p className="text-muted-foreground">
                  {data.provider.missing ?? "The email service isn't connected."} You can still choose products and
                  preview the email. The person who set up LuggageTracker can connect it.
                </p>
              )}
              {data.provider.warning && <p className="font-medium text-warning">{data.provider.warning}</p>}
              <p className="text-muted-foreground">
                {data.provider.sentLast24h} of {data.provider.dailyLimit} emails used in the last 24 hours.
              </p>
            </div>
          </div>

          <ScheduleSection data={data} />
          <RecipientsSection data={data} />
          <ProductsSection data={data} />
          <PreviewSection />
          <LogSection data={data} />
        </>
      )}
    </AppLayout>
  );
}
