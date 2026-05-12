/**
 * Resend-backed email client with a stdout fallback for dev.
 *
 * Why we keep the fallback: during beta a lot of internal flows (password
 * reset, invite issuance) need to surface a link to a human. The owner
 * runs the platform on his own machine before paying for a transactional
 * email provider; printing the link to `process.stdout` matches the same
 * shape the rest of the system expects (`{messageId, mode}`) so call-sites
 * don't need to branch.
 */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailSendResult {
  readonly messageId: string;
  /** Where the message actually went. */
  readonly mode: "resend" | "stdout";
}

export interface EmailClientConfig {
  readonly apiKey: string | undefined;
  readonly fromEmail: string;
  readonly fromName: string;
}

export class EmailClient {
  constructor(private readonly cfg: EmailClientConfig) {}

  /** True iff Resend is wired and we'll make a real HTTP call. */
  get isLive(): boolean {
    return Boolean(this.cfg.apiKey && this.cfg.apiKey.trim().length > 0);
  }

  async send(msg: EmailMessage): Promise<EmailSendResult> {
    if (!this.isLive) {
      // Use raw stdout (not the pino transport — see note on
      // password-reset.service for the reason). Returns a synthetic id so
      // downstream audit logs don't care which mode ran.
      process.stdout.write(
        `[email-stub] to=${msg.to} subject="${msg.subject}"\n${msg.text}\n`
      );
      return { messageId: `stub-${Date.now()}`, mode: "stdout" };
    }

    const from = `${this.cfg.fromName} <${this.cfg.fromEmail}>`;
    const body: Record<string, unknown> = {
      from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
    };
    if (msg.html) body["html"] = msg.html;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      throw new Error(
        `Resend send failed: ${res.status} ${res.statusText} — ${text.slice(0, 300)}`
      );
    }
    const json = (await res.json()) as { id?: string };
    return {
      messageId: json.id ?? `resend-${Date.now()}`,
      mode: "resend",
    };
  }
}
