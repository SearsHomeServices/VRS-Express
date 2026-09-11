// ---------------------------------------------------------------------------
// Outbound email — SendGrid v3 Mail Send. Tyler 2026-09-11.
//
// VRS Express had no email channel at all before this (SMS via Twilio only).
//
// Deliberately uses raw fetch against the REST API instead of @sendgrid/mail:
// zero new npm dependency, so a Replit rebuild that skips `npm install` cannot
// take the weekly report down. (That exact failure mode bit this app once
// already with browser-image-compression.)
//
// Fails SOFT by design. A missing key, an unverified sender, or a SendGrid
// outage returns { sent: false, reason } and logs — it never throws into a
// scheduler tick or an admin request.
// ---------------------------------------------------------------------------

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";

// The shared SHS notification sender, same address the other internal apps
// use. Overridable without a code change if the verified identity moves.
export const DEFAULT_FROM_EMAIL = "notifications@shs.com";
export const DEFAULT_FROM_NAME = "VRS Express";

export interface SendEmailResult {
  sent: boolean;
  status?: number;
  /** Populated whenever sent === false. Safe to show an admin. */
  reason?: string;
  /** SendGrid's per-message id, when it gives us one. */
  messageId?: string;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.SENDGRID_API_KEY);
}

export function resolveFromAddress(): { email: string; name: string } {
  return {
    email: process.env.SENDGRID_FROM_EMAIL || DEFAULT_FROM_EMAIL,
    name: process.env.SENDGRID_FROM_NAME || DEFAULT_FROM_NAME,
  };
}

/** RFC-5322-ish sanity check. Bad addresses are dropped, not sent. */
export function isPlausibleEmail(addr: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(addr.trim());
}

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  /** Log and report what WOULD be sent without calling SendGrid. */
  dryRun?: boolean;
  timeoutMs?: number;
}): Promise<SendEmailResult> {
  const recipients = Array.from(
    new Set(opts.to.map((a) => a.trim()).filter((a) => isPlausibleEmail(a))),
  );
  if (recipients.length === 0) {
    return { sent: false, reason: "No valid recipient addresses were configured." };
  }

  const from = resolveFromAddress();

  if (opts.dryRun) {
    console.log(
      `[email] DRY RUN — would send "${opts.subject}" from ${from.email} to ${recipients.join(", ")}`,
    );
    return { sent: false, reason: "dryRun" };
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn("[email] SENDGRID_API_KEY is not set — skipping send.");
    return {
      sent: false,
      reason:
        "SENDGRID_API_KEY is not set on this deployment. Add it as a Replit Secret.",
    };
  }

  // One personalization per recipient so nobody sees the others' addresses.
  const payload = {
    personalizations: recipients.map((email) => ({ to: [{ email }] })),
    from,
    ...(opts.replyTo ? { reply_to: { email: opts.replyTo } } : {}),
    subject: opts.subject,
    content: [
      { type: "text/plain", value: opts.text },
      { type: "text/html", value: opts.html },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (res.status === 202) {
      const messageId = res.headers.get("x-message-id") || undefined;
      console.log(
        `[email] sent "${opts.subject}" to ${recipients.length} recipient(s)${messageId ? ` (message ${messageId})` : ""}`,
      );
      return { sent: true, status: 202, messageId };
    }

    // Non-202: read the body, because SendGrid puts the actual cause there and
    // the status alone is misleading. 403 on a first send is almost always an
    // unverified sender identity, not a bad key.
    const body = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? "SendGrid rejected the API key (401). The key is wrong, revoked, or lacks Mail Send permission."
        : res.status === 403
          ? `SendGrid refused the sender (403). "${from.email}" is most likely not a verified Sender Identity on this SendGrid account — verify the address or authenticate the shs.com domain.`
          : `SendGrid returned ${res.status}.`;
    console.error(`[email] send failed: ${hint} Body: ${body.slice(0, 600)}`);
    return { sent: false, status: res.status, reason: `${hint} ${body.slice(0, 300)}`.trim() };
  } catch (err: any) {
    const reason =
      err?.name === "AbortError"
        ? "SendGrid did not respond before the timeout."
        : `SendGrid request failed: ${err?.message || String(err)}`;
    console.error(`[email] ${reason}`);
    return { sent: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
