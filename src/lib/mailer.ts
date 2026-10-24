/* ------------------------------------------------------------------ */
/*  Mailer: one way to send email, two free providers (R1.13)          */
/*                                                                     */
/*  EMAIL_PROVIDER=resend (default) uses the Resend SDK and            */
/*  REPORT_FROM_EMAIL, which must be on a domain verified in Resend:   */
/*  the shared resend.dev sender only reaches the Resend account owner. */
/*  EMAIL_PROVIDER=smtp uses nodemailer with SMTP_HOST/PORT/USER/PASS/ */
/*  FROM (for example a Gmail account with an app password).           */
/*                                                                     */
/*  The free-plan limit is enforced by the callers with                */
/*  emailDailyLimit() (EMAIL_DAILY_LIMIT, default 90 of Resend's 100). */
/*  Addresses are masked in every log line (maskEmail).                */
/* ------------------------------------------------------------------ */

import { Resend } from "resend";

export type EmailProvider = "resend" | "smtp";

export type MailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export interface Mailer {
  readonly provider: EmailProvider | "capture";
  /** Resolves with the provider's message id; throws with a plain reason on failure. */
  send(message: MailMessage): Promise<{ id: string | null }>;
}

export type MailerStatus = {
  provider: EmailProvider;
  configured: boolean;
  /** The sender address (no secrets), when one is set. */
  from: string | null;
  /** A plain warning the owner should act on, or null. */
  warning: string | null;
  /** What's missing, in plain words, when not configured. */
  missing: string | null;
  dailyLimit: number;
};

const DEFAULT_FROM = "LuggageTracker <onboarding@resend.dev>";
export const DEFAULT_EMAIL_DAILY_LIMIT = 90;

export function emailProvider(env: NodeJS.ProcessEnv = process.env): EmailProvider {
  return env.EMAIL_PROVIDER?.trim().toLowerCase() === "smtp" ? "smtp" : "resend";
}

/** Emails the app may send per day; a send that would pass it is refused. */
export function emailDailyLimit(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.EMAIL_DAILY_LIMIT ?? "", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : DEFAULT_EMAIL_DAILY_LIMIT;
}

/** The address inside "Name <a@b.c>", lower-cased. */
function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

export function mailerStatus(env: NodeJS.ProcessEnv = process.env): MailerStatus {
  const provider = emailProvider(env);
  const dailyLimit = emailDailyLimit(env);
  if (provider === "smtp") {
    const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"].filter(
      (k) => !env[k]?.trim(),
    );
    return {
      provider,
      configured: missing.length === 0,
      from: env.SMTP_FROM?.trim() || null,
      warning: null,
      missing: missing.length ? "The email account details aren't filled in yet." : null,
      dailyLimit,
    };
  }
  const from = env.REPORT_FROM_EMAIL?.trim() || DEFAULT_FROM;
  return {
    provider,
    configured: !!env.RESEND_API_KEY?.trim(),
    from,
    warning: addressOf(from).endsWith("@resend.dev")
      ? "Only the Resend account owner will receive this; verify your domain."
      : null,
    missing: env.RESEND_API_KEY?.trim() ? null : "The email service isn't connected yet.",
    dailyLimit,
  };
}

/** "vansh@gmail.com" → "v***@gmail.com". For logs: never a full address. */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

class ResendMailer implements Mailer {
  readonly provider = "resend" as const;
  private readonly client: Resend;
  constructor(
    key: string,
    private readonly from: string,
  ) {
    this.client = new Resend(key);
  }
  async send(m: MailMessage): Promise<{ id: string | null }> {
    const { data, error } = await this.client.emails.send({
      from: this.from,
      to: m.to,
      subject: m.subject,
      html: m.html,
      text: m.text,
    });
    if (error) throw new Error(plainProviderError(error.message));
    return { id: data?.id ?? null };
  }
}

class SmtpMailer implements Mailer {
  readonly provider = "smtp" as const;
  constructor(private readonly env: NodeJS.ProcessEnv) {}
  async send(m: MailMessage): Promise<{ id: string | null }> {
    // Loaded on first use so the Resend path never pulls it in.
    const nodemailer = await import("nodemailer");
    const port = Number.parseInt(this.env.SMTP_PORT ?? "", 10) || 587;
    const transport = nodemailer.createTransport({
      host: this.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: this.env.SMTP_USER, pass: this.env.SMTP_PASS },
    });
    try {
      const info = await transport.sendMail({
        from: this.env.SMTP_FROM,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
      });
      return { id: info.messageId ?? null };
    } catch (err) {
      throw new Error(plainProviderError(err instanceof Error ? err.message : String(err)));
    }
  }
}

/** Provider messages are technical; the log shows a sentence a person can act on. */
export function plainProviderError(message: string): string {
  if (/domain.*(not verified|verify)|testing emails|own email address/i.test(message))
    return "The sending domain isn't verified yet, so only the account owner can receive email.";
  if (/rate|too many|limit|quota/i.test(message))
    return "The email service's sending limit was reached. It will try again tomorrow.";
  if (/invalid.*(to|recipient|address)|recipient.*(rejected|invalid)|mailbox/i.test(message))
    return "That address was refused by the email service. Check it for typos.";
  if (/auth|credential|password|api key|unauthor|forbidden|535|534/i.test(message))
    return "The email service refused the sign-in. The person who set up LuggageTracker should check the email settings.";
  if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(message))
    return "The email service couldn't be reached. It will be tried again.";
  return "The email service couldn't send this message.";
}

/** The configured mailer, or null when email isn't set up. */
export function getMailer(env: NodeJS.ProcessEnv = process.env): Mailer | null {
  const status = mailerStatus(env);
  if (!status.configured) return null;
  if (status.provider === "smtp") return new SmtpMailer(env);
  return new ResendMailer(env.RESEND_API_KEY!.trim(), status.from ?? DEFAULT_FROM);
}

/** Records messages instead of sending them (tests and local checks). */
export class CaptureMailer implements Mailer {
  readonly provider = "capture" as const;
  readonly sent: (MailMessage & { id: string })[] = [];
  /** Addresses that fail (with this message), to test partial failures. */
  constructor(private readonly failFor: Record<string, string> = {}) {}
  async send(m: MailMessage): Promise<{ id: string | null }> {
    const fail = this.failFor[m.to.toLowerCase()];
    if (fail) throw new Error(fail);
    const id = `capture-${this.sent.length + 1}`;
    this.sent.push({ ...m, id });
    return { id };
  }
}
