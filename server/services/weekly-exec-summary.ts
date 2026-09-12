// ---------------------------------------------------------------------------
// Weekly VRS Express Executive Summary — Tyler 2026-09-11
//
// Every Wednesday at 4:00 PM ET, compute a one-week operating picture, persist
// it to weekly_reports (report_type = 'exec_summary'), and email it via
// SendGrid. Replaces the manual "ask the Replit agent for an exec summary"
// loop that was being run by hand each week.
//
// Structure follows the house exec-reporting format: a governing sentence with
// the number in it, three KPI cards, then a MECE stage table ordered by
// certainty.
//
// Scheduler mirrors weekly-tech-report.ts (DST-safe ET wall clock, advisory
// lock, once-per-ET-day idempotence). Best-effort: a failed run logs and waits
// for next week rather than crashing the process.
// ---------------------------------------------------------------------------
import { sql, desc, eq } from "drizzle-orm";
import { db, storage } from "../storage";
import { weeklyReports, type WeeklyReport } from "@shared/schema";
import { broadcastToAdmins } from "../websocket";
import { sendEmail, isEmailConfigured, isPlausibleEmail, type SendEmailResult } from "./email";

export const EXEC_SUMMARY_REPORT_TYPE = "exec_summary";

const REPORT_DOW_ET = 3; // Wednesday (0 = Sunday)
const REPORT_HOUR_ET = 16; // 4:00 PM ET
const TZ = "America/New_York";

// Distinct from the tech-no-login lock (0x7ec4_0001) so the two Wednesday jobs
// never block each other.
const REPORT_LOCK_KEY = 0x7ec4_0002;
const KEEP_REPORTS_PER_TYPE = 26;

// The three people who own VRS Express. Overridable at runtime without a
// redeploy via the system_settings key below (comma-separated), so the
// distribution list can change from the admin side.
export const EXEC_SUMMARY_RECIPIENTS_SETTING = "vrs_exec_summary_recipients";
export const DEFAULT_EXEC_SUMMARY_RECIPIENTS = [
  "Tyler.Morgan@transformco.com",
  "Hamed.Jabarkhail@transformco.com",
  "Meghna.Saraf@transformco.com",
];

export async function getExecSummaryRecipients(): Promise<string[]> {
  try {
    const raw = await storage.getSystemSetting(EXEC_SUMMARY_RECIPIENTS_SETTING);
    if (raw && raw.trim()) {
      const parsed = raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter((s) => isPlausibleEmail(s));
      if (parsed.length) return parsed;
    }
  } catch (err: any) {
    console.error(
      `[exec-summary] could not read ${EXEC_SUMMARY_RECIPIENTS_SETTING}, using defaults: ${err?.message || err}`,
    );
  }
  return [...DEFAULT_EXEC_SUMMARY_RECIPIENTS];
}

// --- Metrics ---------------------------------------------------------------

export interface ExecSummaryData {
  windowStart: string;
  windowEnd: string;
  received: { current: number; prior: number };
  completed: { current: number; prior: number };
  rejected: { current: number; prior: number };
  invalid: { current: number; prior: number };
  /**
   * Awaiting a first review RIGHT NOW. Same definition as the Analytics
   * page's pendingCount (stage1_status = 'pending'), so the two can never
   * disagree.
   */
  openPending: number;
  approvalRateCurrent: number | null;
  approvalRatePrior: number | null;
  // All-time, business-hours aware — the same numbers the admin dashboard
  // shows. Stored as RAW MILLISECONDS and formatted at render time: auth codes
  // come back in about a minute (measured 2026-09-11, 0.02 h), so pre-rounding
  // to hours printed a meaningless "0 h".
  avgMsToStage1AllTime: number | null;
  topRejectionReasons: Array<{ reason: string; count: number }>;
  topDistricts: Array<{ district: string; count: number }>;
}

function pct(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

export async function computeExecSummary(): Promise<ExecSummaryData> {
  const now = new Date();
  const windowEnd = now.toISOString();
  const windowStart = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  // One pass over submissions for every count, so the headline number and the
  // stage table can never disagree with each other.
  // ⛔ EVERY bucket below counts on stage1_status, NOT ticket_status.
  // Measured 2026-09-12 against production: the first version of this report
  // counted open work on ticket_status and reported "0 open right now" while
  // the Analytics page showed 2,559 pending. Both columns exist and they do
  // not agree. storage.getAnalytics() - which is what the admin dashboard
  // renders - filters on stage1_status, so this does too. If these numbers
  // ever disagree with the Analytics page again, this report is the one
  // that is wrong.
  const counts = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS received_cur,
      count(*) FILTER (WHERE created_at >= now() - interval '14 days'
                         AND created_at <  now() - interval  '7 days')::int AS received_prior,

      count(*) FILTER (WHERE stage1_status = 'approved'
                         AND stage1_reviewed_at >= now() - interval '7 days')::int AS completed_cur,
      count(*) FILTER (WHERE stage1_status = 'approved'
                         AND stage1_reviewed_at >= now() - interval '14 days'
                         AND stage1_reviewed_at <  now() - interval  '7 days')::int AS completed_prior,

      count(*) FILTER (WHERE stage1_status = 'rejected'
                         AND stage1_reviewed_at >= now() - interval '7 days')::int AS rejected_cur,
      count(*) FILTER (WHERE stage1_status = 'rejected'
                         AND stage1_reviewed_at >= now() - interval '14 days'
                         AND stage1_reviewed_at <  now() - interval  '7 days')::int AS rejected_prior,

      count(*) FILTER (WHERE stage1_status = 'invalid'
                         AND stage1_reviewed_at >= now() - interval '7 days')::int AS invalid_cur,
      count(*) FILTER (WHERE stage1_status = 'invalid'
                         AND stage1_reviewed_at >= now() - interval '14 days'
                         AND stage1_reviewed_at <  now() - interval  '7 days')::int AS invalid_prior,

      count(*) FILTER (WHERE stage1_status = 'pending')::int AS open_pending
    FROM submissions
  `);
  const c = counts.rows[0] as Record<string, number>;

  // rejection_reasons is a JSON string array ('["Photos do not meet ..."]').
  // Guard the cast with the regex: a row that is not a JSON array would abort
  // the whole query.
  // The regex only proves the value STARTS with '[', not that it parses, and
  // Postgres has no try_cast: one malformed row ('[unclosed') would abort the
  // cast and take the whole weekly summary down with it. The reasons block is
  // the least important section here, so it degrades to empty rather than
  // costing the report. Isolated in its own try so the counts above survive.
  let reasons: { rows: any[] } = { rows: [] };
  try {
    reasons = await db.execute(sql`
      SELECT reason, count(*)::int AS count
      FROM submissions s,
           LATERAL json_array_elements_text(s.rejection_reasons::json) AS reason
      WHERE s.rejection_reasons ~ '^\\s*\\['
        AND s.reviewed_at >= now() - interval '7 days'
      GROUP BY reason
      ORDER BY count DESC, reason ASC
      LIMIT 5
    `) as any;
  } catch (err: any) {
    console.error(
      `[exec-summary] rejection-reason rollup failed (likely a non-JSON rejection_reasons value); continuing without it: ${err?.message || err}`,
    );
  }

  const districts = await db.execute(sql`
    SELECT coalesce(nullif(district_code, ''), 'Unknown') AS district, count(*)::int AS count
    FROM submissions
    WHERE created_at >= now() - interval '7 days'
    GROUP BY 1
    ORDER BY count DESC, district ASC
    LIMIT 5
  `);

  // Latency comes from the same helper the admin dashboard renders, so the
  // email cannot print a number that contradicts the screen. It is all-time
  // and business-hours aware, and it is labelled that way in the email.
  // Only time-to-first-review is reported. avgTimeToAuthCodeMs is deliberately
  // NOT shown: measured on production 2026-09-12 it returns 0.0102 ms, which is
  // not a duration, and formatting it produced "under a minute" - a broken
  // metric reading as a headline win. It stays out until it means something.
  let avgMsToStage1AllTime: number | null = null;
  try {
    const analytics = await storage.getAnalytics();
    avgMsToStage1AllTime = analytics.avgTimeToStage1Ms ?? null;
  } catch (err: any) {
    console.error(`[exec-summary] analytics lookup failed: ${err?.message || err}`);
  }

  const closedCur = c.completed_cur + c.rejected_cur + c.invalid_cur;
  const closedPrior = c.completed_prior + c.rejected_prior + c.invalid_prior;

  return {
    windowStart,
    windowEnd,
    received: { current: c.received_cur, prior: c.received_prior },
    completed: { current: c.completed_cur, prior: c.completed_prior },
    rejected: { current: c.rejected_cur, prior: c.rejected_prior },
    invalid: { current: c.invalid_cur, prior: c.invalid_prior },
    openPending: c.open_pending,
    approvalRateCurrent: pct(c.completed_cur, closedCur),
    approvalRatePrior: pct(c.completed_prior, closedPrior),
    avgMsToStage1AllTime,
    topRejectionReasons: (reasons.rows as any[]).map((r) => ({
      reason: String(r.reason),
      count: Number(r.count),
    })),
    topDistricts: (districts.rows as any[]).map((r) => ({
      district: String(r.district),
      count: Number(r.count),
    })),
  };
}

// --- Rendering -------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function etDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  }).format(new Date(iso));
}

/**
 * Pick the unit that actually carries information. Auth codes come back in
 * roughly a minute, so hours-with-one-decimal rendered them as "0 h"; queue
 * waits run to days, where a raw hour count stops being readable.
 */
function formatDurationMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "n/a";
  const minutes = ms / 60_000;
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

/** "+12" / "-3" / "flat", for a week-over-week delta. */
function delta(current: number, prior: number): string {
  const d = current - prior;
  if (d === 0) return "flat vs prior week";
  return `${d > 0 ? "+" : ""}${d} vs prior week`;
}

function ratePoints(current: number | null, prior: number | null): string {
  if (current == null || prior == null) return "no prior-week comparison";
  const d = Math.round((current - prior) * 10) / 10;
  if (d === 0) return "flat vs prior week";
  return `${d > 0 ? "+" : ""}${d} pts vs prior week`;
}

export function execSummarySubject(d: ExecSummaryData): string {
  const rate = d.approvalRateCurrent == null ? "n/a" : `${d.approvalRateCurrent}%`;
  return `VRS Express weekly: ${d.received.current} submissions, ${rate} approved (${etDate(d.windowStart)}–${etDate(d.windowEnd)})`;
}

/** The governing thought. First sentence, with the number in it. */
function governingThought(d: ExecSummaryData): string {
  const closed = d.completed.current + d.rejected.current + d.invalid.current;
  const rate = d.approvalRateCurrent == null ? "n/a" : `${d.approvalRateCurrent}%`;
  const openTotal = d.openPending;
  // Received and closed are deliberately NOT the same cohort — a ticket closed
  // this week may have arrived last week — so the sentence never says "closed
  // N of them", which reads as a subset and invites an exec to catch it when
  // closures exceed arrivals.
  return `VRS Express received ${d.received.current} submissions this week (${delta(d.received.current, d.received.prior)}) and closed ${closed} tickets at a ${rate} approval rate, with ${openTotal} still awaiting a first review.`;
}

export function renderExecSummaryText(d: ExecSummaryData): string {
  const lines: string[] = [];
  lines.push(`VRS EXPRESS — WEEKLY EXECUTIVE SUMMARY`);
  lines.push(`${etDate(d.windowStart)} to ${etDate(d.windowEnd)} (last 7 days)`);
  lines.push("");
  lines.push(governingThought(d));
  lines.push("");
  lines.push(`Submissions received: ${d.received.current} (${delta(d.received.current, d.received.prior)})`);
  lines.push(
    `Approval rate: ${d.approvalRateCurrent == null ? "n/a" : d.approvalRateCurrent + "%"} (${ratePoints(d.approvalRateCurrent, d.approvalRatePrior)})`,
  );
  lines.push(`Awaiting first review right now: ${d.openPending}`);
  lines.push("");
  lines.push("WHERE THE WEEK LANDED");
  lines.push("  (counted by the week a ticket CLOSED, so it can include tickets received earlier)");
  lines.push(`  Approved / completed   ${d.completed.current}  (${delta(d.completed.current, d.completed.prior)})`);
  lines.push(`  Rejected               ${d.rejected.current}  (${delta(d.rejected.current, d.rejected.prior)})`);
  lines.push(`  Invalid                ${d.invalid.current}  (${delta(d.invalid.current, d.invalid.prior)})`);
  lines.push(`  Awaiting first review  ${d.openPending}  (open right now, not a weekly figure)`);
  lines.push("");
  if (d.topRejectionReasons.length) {
    lines.push("TOP REJECTION REASONS THIS WEEK");
    for (const r of d.topRejectionReasons) lines.push(`  ${r.count}  ${r.reason}`);
    lines.push("");
  }
  if (d.topDistricts.length) {
    lines.push("TOP DISTRICTS BY VOLUME");
    for (const r of d.topDistricts) lines.push(`  ${r.count}  District ${r.district}`);
    lines.push("");
  }
  lines.push("TURNAROUND (all tickets to date, business hours)");
  lines.push(`  To first review: ${formatDurationMs(d.avgMsToStage1AllTime)}`);
  lines.push("");
  lines.push("Generated automatically by VRS Express every Wednesday at 4:00 PM ET.");
  return lines.join("\n");
}

function kpiCard(label: string, value: string, sub: string): string {
  return `
    <td style="padding:0 6px;width:33.33%;vertical-align:top;">
      <div style="border:1px solid #e2e5ea;border-radius:8px;padding:14px 16px;background:#ffffff;">
        <div style="font:600 11px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
        <div style="font:700 28px/1.2 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;margin-top:6px;">${esc(value)}</div>
        <div style="font:400 12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;margin-top:4px;">${esc(sub)}</div>
      </div>
    </td>`;
}

function stageRow(label: string, count: number, note: string, accent: string): string {
  return `
    <tr>
      <td style="padding:9px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${accent};margin-right:8px;"></span>${esc(label)}
      </td>
      <td style="padding:9px 12px;border-bottom:1px solid #eef0f3;font:700 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;text-align:right;">${count}</td>
      <td style="padding:9px 12px;border-bottom:1px solid #eef0f3;font:400 13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;text-align:right;white-space:nowrap;">${esc(note)}</td>
    </tr>`;
}

export function renderExecSummaryHtml(d: ExecSummaryData): string {
  const rate = d.approvalRateCurrent == null ? "n/a" : `${d.approvalRateCurrent}%`;
  const openNote = "open right now";

  const reasonRows = d.topRejectionReasons.length
    ? d.topRejectionReasons
        .map(
          (r) => `
      <tr>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;">${esc(r.reason)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:700 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;text-align:right;">${r.count}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="2" style="padding:10px 12px;font:400 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;">No rejections this week.</td></tr>`;

  const districtRows = d.topDistricts.length
    ? d.topDistricts
        .map(
          (r) => `
      <tr>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;">District ${esc(r.district)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:700 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;text-align:right;">${r.count}</td>
      </tr>`,
        )
        .join("")
    : `<tr><td colspan="2" style="padding:10px 12px;font:400 14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;">No submissions this week.</td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

  <tr><td style="padding:0 6px 4px;">
    <div style="font:700 20px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;">VRS Express — Weekly Executive Summary</div>
    <div style="font:400 13px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;margin-top:3px;">${esc(etDate(d.windowStart))} to ${esc(etDate(d.windowEnd))} · last 7 days</div>
  </td></tr>

  <tr><td style="padding:14px 6px 18px;">
    <div style="border-left:3px solid #2563eb;background:#ffffff;border-radius:0 8px 8px 0;padding:14px 16px;font:400 15px/1.55 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;">
      ${esc(governingThought(d))}
    </div>
  </td></tr>

  <tr><td style="padding:0 0 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${kpiCard("Submissions received", String(d.received.current), delta(d.received.current, d.received.prior))}
      ${kpiCard("Approval rate", rate, ratePoints(d.approvalRateCurrent, d.approvalRatePrior))}
      ${kpiCard("Awaiting first review", String(d.openPending), openNote)}
    </tr></table>
  </td></tr>

  <tr><td style="padding:0 6px 18px;">
    <div style="border:1px solid #e2e5ea;border-radius:8px;background:#ffffff;overflow:hidden;">
      <div style="padding:12px 12px 2px;font:600 12px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Where the week landed</div>
      <div style="padding:0 12px 8px;font:400 11px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#9ca3af;">Counted by the week a ticket closed, so it can include tickets received earlier.</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        ${stageRow("Approved / completed", d.completed.current, delta(d.completed.current, d.completed.prior), "#16a34a")}
        ${stageRow("Rejected", d.rejected.current, delta(d.rejected.current, d.rejected.prior), "#dc2626")}
        ${stageRow("Invalid", d.invalid.current, delta(d.invalid.current, d.invalid.prior), "#9ca3af")}
        ${stageRow("Awaiting first review", d.openPending, "open right now", "#f59e0b")}
      </table>
    </div>
  </td></tr>

  <tr><td style="padding:0 6px 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="width:50%;padding-right:6px;vertical-align:top;">
        <div style="border:1px solid #e2e5ea;border-radius:8px;background:#ffffff;overflow:hidden;">
          <div style="padding:12px 12px 6px;font:600 12px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Top rejection reasons</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${reasonRows}</table>
        </div>
      </td>
      <td style="width:50%;padding-left:6px;vertical-align:top;">
        <div style="border:1px solid #e2e5ea;border-radius:8px;background:#ffffff;overflow:hidden;">
          <div style="padding:12px 12px 6px;font:600 12px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Top districts by volume</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${districtRows}</table>
        </div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:0 6px 18px;">
    <div style="border:1px solid #e2e5ea;border-radius:8px;background:#ffffff;padding:12px 14px;">
      <div style="font:600 12px/1.3 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Turnaround</div>
      <div style="font:400 14px/1.7 -apple-system,Segoe UI,Arial,sans-serif;color:#111827;margin-top:6px;">
        To first review: <strong>${esc(formatDurationMs(d.avgMsToStage1AllTime))}</strong>
      </div>
      <div style="font:400 12px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#6b7280;margin-top:6px;">All tickets to date, business hours only. Same basis as the Analytics page.</div>
    </div>
  </td></tr>

  <tr><td style="padding:4px 6px 0;font:400 12px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#9ca3af;">
    Generated automatically by VRS Express every Wednesday at 4:00 PM ET.
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// --- Generate, persist, send -----------------------------------------------

export interface ExecSummaryRunResult {
  report: WeeklyReport | null;
  data: ExecSummaryData | null;
  email: SendEmailResult | null;
  skipped?: string;
}

export async function generateAndSendExecSummary(
  opts: { skipIfGeneratedToday?: boolean; dryRun?: boolean; send?: boolean } = {},
): Promise<ExecSummaryRunResult> {
  const send = opts.send !== false;

  // Persist under the advisory lock so two scheduler ticks (or a tick racing a
  // manual run) cannot double-generate and double-send.
  const persisted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPORT_LOCK_KEY})`);

    if (opts.skipIfGeneratedToday) {
      const existing = await tx.execute(sql`
        SELECT id FROM weekly_reports
        WHERE report_type = ${EXEC_SUMMARY_REPORT_TYPE}
          AND (generated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
              = (now() AT TIME ZONE 'America/New_York')::date
        LIMIT 1
      `);
      if (existing.rows.length) return null;
    }

    const data = await computeExecSummary();

    // The CSV body is the plain-text summary. weekly_reports.csv is served as a
    // download by the existing admin report route shape; a text report is the
    // honest thing to put there rather than a fake spreadsheet.
    const [report] = await tx
      .insert(weeklyReports)
      .values({
        reportType: EXEC_SUMMARY_REPORT_TYPE,
        summary: data as any,
        csv: renderExecSummaryText(data),
      })
      .returning();

    await tx.execute(sql`
      DELETE FROM weekly_reports
      WHERE report_type = ${EXEC_SUMMARY_REPORT_TYPE}
        AND id NOT IN (
          SELECT id FROM weekly_reports
          WHERE report_type = ${EXEC_SUMMARY_REPORT_TYPE}
          ORDER BY generated_at DESC, id DESC
          LIMIT ${KEEP_REPORTS_PER_TYPE}
        )
    `);

    return { report, data };
  });

  if (!persisted) {
    return { report: null, data: null, email: null, skipped: "already generated today" };
  }

  const { report, data } = persisted;

  broadcastToAdmins({
    type: "weekly_report_ready",
    payload: {
      reportId: report.id,
      reportType: EXEC_SUMMARY_REPORT_TYPE,
      generatedAt: report.generatedAt,
      received: data.received.current,
      approvalRate: data.approvalRateCurrent,
      openPending: data.openPending,
    },
  });

  if (!send) return { report, data, email: null };

  // Sending is deliberately outside the transaction: a SendGrid failure must
  // not roll back a report that was correctly generated.
  const recipients = await getExecSummaryRecipients();
  const email = await sendEmail({
    to: recipients,
    subject: execSummarySubject(data),
    html: renderExecSummaryHtml(data),
    text: renderExecSummaryText(data),
    dryRun: opts.dryRun,
  });

  return { report, data, email };
}

export async function getLatestExecSummaries(limit = 8): Promise<Array<Omit<WeeklyReport, "csv">>> {
  return db
    .select({
      id: weeklyReports.id,
      reportType: weeklyReports.reportType,
      generatedAt: weeklyReports.generatedAt,
      summary: weeklyReports.summary,
    })
    .from(weeklyReports)
    .where(eq(weeklyReports.reportType, EXEC_SUMMARY_REPORT_TYPE))
    .orderBy(desc(weeklyReports.generatedAt))
    .limit(limit) as any;
}

// --- Scheduler -------------------------------------------------------------

function etParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dowMap[parts.weekday],
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

/**
 * Milliseconds until the next Wednesday 4:00 PM ET. Same DST-safe approach as
 * weekly-tech-report.ts: compute naively, then re-check the ET wall clock at
 * the candidate instant and nudge, because a spring-forward or fall-back in
 * between shifts the target by an hour.
 */
export function msUntilNextWednesday4pmET(now: Date = new Date()): number {
  const et = etParts(now);
  const nowSecs = et.hour * 3600 + et.minute * 60 + et.second;
  const targetSecs = REPORT_HOUR_ET * 3600;
  let daysAhead = (REPORT_DOW_ET - et.dow + 7) % 7;
  if (daysAhead === 0 && nowSecs >= targetSecs) daysAhead = 7;
  const deltaSecs = daysAhead * 24 * 3600 + (targetSecs - nowSecs);

  let candidate = now.getTime() + deltaSecs * 1000;
  for (let i = 0; i < 3; i++) {
    const c = etParts(new Date(candidate));
    if (c.dow === REPORT_DOW_ET && c.hour === REPORT_HOUR_ET) break;
    const hourDiff = REPORT_HOUR_ET - c.hour;
    candidate += (hourDiff < -12 ? hourDiff + 24 : hourDiff > 12 ? hourDiff - 24 : hourDiff) * 3600 * 1000;
  }
  return Math.max(candidate - now.getTime(), 60_000);
}

export function scheduleWeeklyExecSummary(log: (msg: string) => void): void {
  if (!isEmailConfigured()) {
    log(
      "[exec-summary] SENDGRID_API_KEY is not set — the weekly summary will still generate and persist, but no email will be sent.",
    );
  }
  const scheduleNext = () => {
    const delay = msUntilNextWednesday4pmET();
    log(`[exec-summary] next executive summary in ${(delay / 3600000).toFixed(2)}h (Wednesdays 4:00 PM ET)`);
    setTimeout(async () => {
      try {
        const r = await generateAndSendExecSummary({ skipIfGeneratedToday: true });
        if (r.skipped) {
          log(`[exec-summary] skipped — ${r.skipped}`);
        } else if (r.email?.sent) {
          log(`[exec-summary] report #${r.report?.id} generated and emailed`);
        } else {
          log(
            `[exec-summary] report #${r.report?.id} generated but NOT emailed: ${r.email?.reason || "unknown reason"}`,
          );
        }
      } catch (err: any) {
        log(`[exec-summary] run failed: ${err?.message || String(err)}`);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  scheduleNext();
}
