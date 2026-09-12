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
// outage returns a structured result and logs — it never throws into a
// scheduler tick or an admin request.
// ---------------------------------------------------------------------------

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000;

// The shared SHS notification sender, same address the other internal apps
// use. Overridable without a code change if the verified identity moves.
export const DEFAULT_FROM_EMAIL = "notifications@shs.com";
export const DEFAULT_FROM_NAME = "VRS Express";

export interface SendEmailResult {
  /**
   * Compatibility field: true means SendGrid accepted the request (HTTP 202).
   * It does not mean that the message was delivered to the recipient.
   */
  sent: boolean;
  status?: number;
  /** Populated whenever sent === false. Safe to show an admin. */
  reason?: string;
  /** SendGrid's per-message id, when it gives us one. */
  messageId?: string;
  /** A later attempt may be safe without risking a duplicate send. */
  retryable: boolean;
  /** The request outcome is unknown; an automatic resend could duplicate mail. */
  ambiguous: boolean;
  /** Bounded provider retry hint, when SendGrid supplied a valid Retry-After. */
  retryAfterMs?: number;
}

export interface EmailConfigurationStatus {
  /** True only when both the API key and configured sender address are usable. */
  configured: boolean;
  /** Whether a non-blank API key exists; the key itself is never returned. */
  apiKeyPresent: boolean;
  /** The effective sender address (the default is safe to expose). */
  fromEmail: string;
  /** Whether the effective sender address passes validation. */
  fromEmailValid: boolean;
  /** Safe, non-secret configuration issue identifiers. */
  issues: string[];
}

export function resolveFromAddress(): { email: string; name: string } {
  // Treat an explicitly blank override as invalid rather than silently
  // switching to a different sender. An unset variable still gets the
  // application default.
  const configuredEmail =
    process.env.SENDGRID_FROM_EMAIL === undefined
      ? DEFAULT_FROM_EMAIL
      : process.env.SENDGRID_FROM_EMAIL.trim();
  const configuredName =
    process.env.SENDGRID_FROM_NAME?.trim() || DEFAULT_FROM_NAME;
  return {
    email: configuredEmail,
    name: configuredName,
  };
}

/**
 * RFC-5322-ish sanity check. This intentionally accepts ordinary SendGrid
 * mailbox addresses, but not display names, control characters, or malformed
 * domains.
 */
export function isPlausibleEmail(addr: string): boolean {
  if (typeof addr !== "string") return false;
  const value = addr.trim();
  if (value.length === 0 || value.length > 254) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (
    local.length > 64 ||
    !/^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i.test(
      local,
    )
  ) {
    return false;
  }

  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels[labels.length - 1].length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(label),
    )
  );
}

/**
 * Return only safe configuration facts. In particular, this function never
 * includes, logs, or derives anything from the API key value.
 */
export function getEmailConfigurationStatus(): EmailConfigurationStatus {
  const apiKeyPresent =
    typeof process.env.SENDGRID_API_KEY === "string" &&
    process.env.SENDGRID_API_KEY.trim().length > 0;
  const from = resolveFromAddress();
  const fromEmailValid = isPlausibleEmail(from.email);
  const issues: string[] = [];

  if (!apiKeyPresent) issues.push("missing_api_key");
  if (!fromEmailValid) issues.push("invalid_from_email");

  return {
    configured: issues.length === 0,
    apiKeyPresent,
    fromEmail: from.email,
    fromEmailValid,
    issues,
  };
}

export function isEmailConfigured(): boolean {
  return getEmailConfigurationStatus().configured;
}

function result(
  values: Omit<SendEmailResult, "retryable" | "ambiguous"> & {
    retryable?: boolean;
    ambiguous?: boolean;
  },
): SendEmailResult {
  return {
    retryable: false,
    ambiguous: false,
    ...values,
  };
}

function invalidResult(reason: string): SendEmailResult {
  return result({ sent: false, reason });
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const header = value.trim();
  if (!header) return undefined;

  // Retry-After's delta-seconds grammar is an integer. Clamp before
  // multiplying so a hostile/absurd header cannot overflow the delay.
  if (/^\d+$/.test(header)) {
    const seconds = Number(header);
    if (!Number.isSafeInteger(seconds)) return MAX_RETRY_AFTER_MS;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // HTTP-date is also permitted by RFC 9110. A past date means retry now.
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

function responseHeader(
  response: Response,
  name: string,
): string | undefined {
  try {
    const value = response.headers?.get(name);
    return value?.trim() || undefined;
  } catch {
    // A malformed test double or non-standard Headers object must not turn a
    // provider response into an ambiguous send.
    return undefined;
  }
}

function normalizedRecipients(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const recipients = value.map((address) =>
    typeof address === "string" ? address.trim() : "",
  );
  // Do not filter bad entries and send the rest: that can silently omit a
  // recipient the caller believed was included.
  if (recipients.some((address) => !isPlausibleEmail(address))) return null;

  return Array.from(new Set(recipients));
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
  // Dry-run is deliberately independent of provider configuration and input
  // validity: callers use it to generate/preview a report without sending, so
  // it must never suppress that work because a future send would be invalid.
  // Keep this log generic; do not echo caller-supplied recipients or content.
  if (opts?.dryRun) {
    console.log("[email] DRY RUN — no provider request made.");
    return invalidResult("dryRun");
  }

  const recipients = normalizedRecipients(opts?.to);
  if (!recipients) {
    return invalidResult(
      "Every recipient must be a valid email address, and at least one recipient is required.",
    );
  }

  const from = resolveFromAddress();
  if (!isPlausibleEmail(from.email)) {
    return invalidResult("The configured sender email address is invalid.");
  }

  let replyTo: string | undefined;
  if (opts.replyTo !== undefined) {
    if (typeof opts.replyTo !== "string" || !isPlausibleEmail(opts.replyTo)) {
      return invalidResult("The configured reply-to email address is invalid.");
    }
    replyTo = opts.replyTo.trim();
  }

  const configuration = getEmailConfigurationStatus();
  if (!configuration.configured) {
    console.warn("[email] SendGrid configuration is incomplete or invalid — skipping send.");
    return invalidResult(
      !configuration.apiKeyPresent
        ? "SENDGRID_API_KEY is not configured."
        : "The configured sender email address is invalid.",
    );
  }
  // The status check above guarantees a non-blank value. Trim it before
  // putting it in the Authorization header, and never include it in output.
  const apiKey = process.env.SENDGRID_API_KEY!.trim();

  // One personalization per recipient so nobody sees the others' addresses.
  const payload = {
    personalizations: recipients.map((email) => ({ to: [{ email }] })),
    from,
    ...(replyTo ? { reply_to: { email: replyTo } } : {}),
    subject: opts.subject,
    content: [
      { type: "text/plain", value: opts.text },
      { type: "text/html", value: opts.html },
    ],
  };

  const controller = new AbortController();
  const timeoutMs =
    typeof opts.timeoutMs === "number" &&
    Number.isFinite(opts.timeoutMs) &&
    opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
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
      const messageId = responseHeader(res, "x-message-id");
      console.log(
        `[email] provider accepted ${recipients.length} recipient(s)${messageId ? ` (message ${messageId})` : ""}; delivery is not confirmed`,
      );
      return result({ sent: true, status: 202, messageId });
    }

    // Never read or log the provider response body: it can contain request
    // details, recipient data, or other information unsafe for application
    // logs. Status and Retry-After are sufficient for the caller.
    const retryAfterMs =
      res.status === 429 || (res.status >= 500 && res.status <= 599)
        ? parseRetryAfter(responseHeader(res, "retry-after") ?? null)
        : undefined;
    const retryable = res.status === 429 || (res.status >= 500 && res.status <= 599);
    const reason =
      res.status === 401
        ? "SendGrid rejected the API key."
        : res.status === 403
          ? "SendGrid refused the configured sender."
          : retryable
            ? "SendGrid temporarily rejected the request; a later retry may be attempted."
            : `SendGrid rejected the request (HTTP ${res.status}).`;
    console.error(
      `[email] send rejected (HTTP ${res.status})${retryAfterMs !== undefined ? `; retry after ${retryAfterMs}ms` : ""}`,
    );
    return result({
      sent: false,
      status: res.status,
      reason,
      retryable,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  } catch (err: unknown) {
    const reason =
      timedOut || (err && typeof err === "object" && "name" in err && err.name === "AbortError")
        ? "SendGrid request timed out before provider acceptance; delivery status is unknown."
        : "SendGrid request failed before provider acceptance; delivery status is unknown.";
    console.error(`[email] ${reason}`);
    // A timeout or network failure can happen after SendGrid accepted the
    // message. Marking this ambiguous prevents an automatic resend that could
    // create a duplicate.
    return result({ sent: false, reason, retryable: false, ambiguous: true });
  } finally {
    clearTimeout(timer);
  }
}
