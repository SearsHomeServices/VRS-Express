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
// lock). Delivery is a durable per-report state machine with catch-up and
// bounded safe retries; it never mistakes provider acceptance for mailbox
// delivery.
// ---------------------------------------------------------------------------
import { sql, desc, eq } from "drizzle-orm";
import { db, storage, pool } from "../storage";
import { weeklyReports, execSummaryDeliveries, type WeeklyReport } from "@shared/schema";
import { broadcastToAdmins } from "../websocket";
import { sendEmail, isEmailConfigured, type SendEmailResult } from "./email";
import {
  ensureExecSummaryDeliverySchema,
  PostgresExecSummaryDeliveryStore,
  type ExecSummaryDeliveryPayload,
  type ProviderEmailResult,
} from "./exec-summary-delivery";
import {
  buildExecSummaryMetrics as buildPureExecSummaryMetrics,
  getExecSummaryWindow as getPureExecSummaryWindow,
  type DateLike,
  type DailyVolumeRow,
  type ExecSummaryData as PureExecSummaryData,
  type ExecSummaryMetricRow,
  type ExecSummaryMode,
} from "./weekly-exec-summary-metrics";

export {
  buildExecSummaryMetrics,
  getExecSummaryWindow,
  previousSameLocalWeekdayTime,
} from "./weekly-exec-summary-metrics";
export type {
  DateLike,
  DailyVolumeRow,
  ExecSummaryBounds,
  ExecSummaryMetadata,
  ExecSummaryMetricRow,
  ExecSummaryMetrics,
  ExecSummaryMode,
} from "./weekly-exec-summary-metrics";

export const EXEC_SUMMARY_REPORT_TYPE = "exec_summary";

const REPORT_DOW_ET = 3; // Wednesday (0 = Sunday)
const REPORT_HOUR_ET = 16; // 4:00 PM ET
const TZ = "America/New_York";

// Distinct from the tech-no-login lock (0x7ec4_0001) so the two Wednesday jobs
// never block each other.
const REPORT_LOCK_KEY = 0x7ec4_0002;
export const EXEC_SUMMARY_RECIPIENTS_SETTING = "vrs_exec_summary_recipients";
export const DEFAULT_EXEC_SUMMARY_RECIPIENTS = [
  "Tyler.Morgan@transformco.com",
  "Hamed.Jabarkhail@transformco.com",
  "Meghna.Saraf@transformco.com",
];

export async function getExecSummaryRecipients(): Promise<string[]> {
  try {
    const raw = await storage.getSystemSetting(EXEC_SUMMARY_RECIPIENTS_SETTING);
    // Defaults are for an absent setting only.  A configured-but-blank,
    // malformed, or unreadable distribution list must fail closed rather than
    // unexpectedly sending management reporting to a stale default list.
    if (raw === undefined) return [...DEFAULT_EXEC_SUMMARY_RECIPIENTS];
    const parsed = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!parsed.length) {
      throw new Error("The executive-summary recipient setting is empty.");
    }
    // Do not discard malformed values here. email.ts validates the complete
    // recipient set atomically so a typo cannot silently omit an intended
    // executive from a send.
    return parsed;
  } catch (err: any) {
    console.error(`[exec-summary] recipient configuration unavailable: ${err?.message || err}`);
    throw new Error("Executive-summary recipients are not configured correctly.");
  }
}

// --- Metrics ---------------------------------------------------------------
// The pure metrics module owns ET windows, cohort membership, outcome
// classification, review durations, daily volume, and rejection reasons.

export type ExecSummaryReportMode = ExecSummaryMode;

export type ExecSummaryData = PureExecSummaryData;

export interface ComputeExecSummaryOptions {
  reportMode?: ExecSummaryReportMode;
  mode?: ExecSummaryMode;
  /** Optional ET date anchor for a full historical week. */
  weekStart?: DateLike;
  /** Defaults to the instant at which the computation starts. */
  cutoffAt?: DateLike;
}

export async function computeExecSummary(
  opts: ComputeExecSummaryOptions = {},
): Promise<ExecSummaryData> {
  const snapshotAt = opts.cutoffAt == null ? new Date() : new Date(opts.cutoffAt);
  if (!Number.isFinite(snapshotAt.getTime())) {
    throw new Error("Invalid cutoffAt for executive summary");
  }
  const window = getPureExecSummaryWindow(snapshotAt, {
    mode: opts.mode ?? opts.reportMode ?? "wtd",
    weekStart: opts.weekStart,
  });

  // One query is intentionally used for both cohorts.  It captures one
  // present-outcome snapshot; the pure builder applies the identical
  // created-at bounds to headlines, daily volume, and reasons.
  const result = await db.execute(sql`
    SELECT
      s.id,
      s.created_at,
      s.ticket_status,
      s.reviewed_at,
      s.rejection_reasons,
      COALESCE(
        NULLIF(trim(s.technician_ldap_id), ''),
        NULLIF(trim(u.rac_id), ''),
        'user:' || s.technician_id::text
      ) AS technician_ldap_id,
      s.technician_id
    FROM submissions s
    LEFT JOIN users u ON u.id = s.technician_id
    WHERE s.created_at >= ${window.priorWeekStart}
      AND s.created_at < ${window.cutoff}
  `);
  const data = buildPureExecSummaryMetrics(result.rows as ExecSummaryMetricRow[], {
    mode: window.mode,
    weekStart: window.weekStart,
    weekEndExclusive: window.weekEndExclusive,
    cutoff: window.cutoff,
    snapshotAt,
    priorWeekStart: window.priorWeekStart,
    priorWeekEndExclusive: window.priorWeekEndExclusive,
    priorCutoff: window.priorCutoff,
  });
  return data;
}

// --- Rendering -------------------------------------------------------------

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function etLong(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", month: "long", day: "numeric",
  }).format(new Date(iso));
}
function etRange(startIso: string, endIso: string): string {
  const d0 = new Date(startIso + "T12:00:00Z");
  const d1 = new Date(endIso + "T12:00:00Z");
  const part = (d: Date, o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...o }).format(d);
  const sameMonth = part(d0, { month: "long" }) === part(d1, { month: "long" });
  // "September 7-13, 2026" when the week sits in one month, matching the
  // agent's header; "September 28-October 4, 2026" when it straddles two.
  return sameMonth
    ? `${part(d0, { month: "long", day: "numeric" })}–${part(d1, { day: "numeric" })}, ${part(d1, { year: "numeric" })}`
    : `${part(d0, { month: "long", day: "numeric" })}–${part(d1, { month: "long", day: "numeric" })}, ${part(d1, { year: "numeric" })}`;
}
function etClock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
  }).format(new Date(iso)) + " ET";
}

/** "up 5.1 percentage points" / "down 0.4 points" / "unchanged" */
function pointMove(cur: number | null, prior: number | null): string {
  if (cur == null || prior == null) return "no comparable prior week";
  const d = Math.round((cur - prior) * 10) / 10;
  if (d === 0) return "unchanged from the prior comparison cohort";
  return `${d > 0 ? "up" : "down"} ${Math.abs(d)} percentage point${Math.abs(d) === 1 ? "" : "s"} from the prior comparison cohort`;
}

export function execSummarySubject(d: ExecSummaryData): string {
  return `VRS Express ${d.metadata.reportMode === "full_week" ? "full-week" : "week-to-date"} update: ${etRange(d.weekStart, d.weekEnd)}`;
}

function provenance(d: ExecSummaryData): string {
  const latest = d.latestSubmissionAt
    ? `; latest submission at approximately ${etClock(d.latestSubmissionAt)}`
    : "";
  const mode = d.metadata.reportMode === "full_week" ? "Full week" : "Week-to-date";
  return `${mode}: submissions created before ${etLong(d.metadata.cutoffAt)} at ${etClock(d.metadata.cutoffAt)}${latest}. Outcomes queried ${etLong(d.snapshotAt)} at ${etClock(d.snapshotAt)}. Comparison uses ${d.metadata.comparisonBasis}.`;
}

const METRIC_DEFINITIONS = "Completed (approved) means ticket status completed; rejected includes rejected_closed; pending includes queued. Other statuses are shown separately, not treated as resolved. Approval rate = completed / (completed + rejected). Review time is wall-clock created_at to reviewed_at, excluding missing or negative durations. Technicians are counted by trimmed, case-insensitive LDAP, with the linked user identity as fallback.";

function cohortPeriod(d: ExecSummaryData): string {
  return d.metadata.reportMode === "full_week" ? "during the reported week" : "so far this week";
}

function takeaways(d: ExecSummaryData): string[] {
  const out: string[] = [];
  const done = d.daily.filter((r) => r.submissions != null && (r.submissions ?? 0) > 0);
  const busiest = done.slice().sort((a, b) => (b.submissions ?? 0) - (a.submissions ?? 0))[0];
  if (busiest) {
    out.push(`${busiest.label.split(",")[0]} was the busiest day, with ${busiest.submissions} submissions.`);
  }
  if (d.approvalRate != null) {
    out.push(`Approval rate is ${d.approvalRate}%, ${pointMove(d.approvalRate, d.prior.approvalRate)}.`);
  }
  if (d.avgReviewMinutes != null) {
    const pr = d.prior.avgReviewMinutes;
    const move = pr == null ? "no comparable prior week"
      : pr === d.avgReviewMinutes ? "unchanged"
      : `${d.avgReviewMinutes < pr ? "improved" : "slipped"} from ${pr} minutes`;
    out.push(`Average review time is ${d.avgReviewMinutes} minutes (${move}); median is ${d.medianReviewMinutes ?? "n/a"} minutes.`);
  }
  if (d.invalidRate != null) {
    out.push(`Invalid rate is ${d.invalidRate}%, ${pointMove(d.invalidRate, d.prior.invalidRate)}.`);
  }
  out.push(
    d.pending === 0
      ? `No submissions from this week's cohort remain pending at the snapshot.`
      : `${d.pending} submission${d.pending === 1 ? "" : "s"} from this week's cohort remain${d.pending === 1 ? "s" : ""} pending at the snapshot.`,
  );
  out.push(
    d.metadata.reportMode === "full_week"
       ? "This report covers a full seven-day submission cohort; outcomes reflect the query snapshot."
      : "This is a week-to-date update, not a final seven-day report.",
  );
  return out;
}

function dayCells(r: DailyVolumeRow): [string, string, string, string, string, string] {
  if (r.submissions == null) return ["Not yet included", "-", "-", "-", "-", "-"];
  return [
    String(r.submissions),
    String(r.approved ?? 0),
    String(r.rejected ?? 0),
    String(r.invalid ?? 0),
    String(r.pending ?? 0),
    String(r.other ?? 0),
  ];
}

export function renderExecSummaryText(d: ExecSummaryData): string {
  const L: string[] = [];
  L.push(`VRS EXPRESS WEEKLY UPDATE`);
  L.push(etRange(d.weekStart, d.weekEnd));
  L.push(provenance(d));
  L.push("");
  L.push(`VRS Express has received ${d.submissions} submissions from ${d.uniqueTechnicians} unique technicians ${cohortPeriod(d)}.`);
  L.push("");
  L.push("OUTCOMES");
  L.push(`  ${d.approved} Completed (approved)`);
  L.push(`  ${d.rejected} rejected`);
  L.push(`  ${d.invalid} invalid`);
  L.push(`  ${d.pending} pending`);
  L.push(`  ${d.other} other`);
  L.push(`  ${d.approvalRate ?? "n/a"}% approval rate among approved/rejected decisions`);
  L.push(`  ${d.invalidRate ?? "n/a"}% invalid rate`);
  L.push(`  ${d.resolvedRate ?? "n/a"}% of submissions resolved`);
  L.push("");
  L.push("TURNAROUND TIME");
  L.push(`  ${d.avgReviewMinutes ?? "n/a"} minutes average review time`);
  L.push(`  ${d.medianReviewMinutes ?? "n/a"} minutes median review time`);
  L.push("");
  L.push("DAILY VOLUME");
  L.push(`  ${"Day".padEnd(22)}${"Submissions".padStart(17)}${"Completed (approved)".padStart(22)}${"Rejected".padStart(10)}${"Invalid".padStart(10)}${"Pending".padStart(10)}${"Other".padStart(8)}`);
  for (const r of d.daily) {
    const [s, a, j, i, p, o] = dayCells(r);
    L.push(`  ${(r.label + (r.partial ? "*" : "")).padEnd(22)}${s.padStart(17)}${a.padStart(22)}${j.padStart(10)}${i.padStart(10)}${p.padStart(10)}${o.padStart(8)}`);
  }
  if (d.daily.some((r) => r.partial)) L.push("  * partial day at the time of the snapshot.");
  L.push("");
  if (d.topRejectionReasons.length) {
    L.push("TOP REJECTION REASONS THIS WEEK");
    for (const r of d.topRejectionReasons) L.push(`  ${r.count}  ${r.reason}`);
    L.push("");
  }
  L.push("EXECUTIVE TAKEAWAYS");
  for (const t of takeaways(d)) L.push(`  - ${t}`);
  L.push("");
  L.push("Generated automatically by VRS Express every Wednesday at 4:00 PM ET.");
  L.push(METRIC_DEFINITIONS);
  return L.join("\n");
}

const F = "-apple-system,Segoe UI,Arial,sans-serif";

function bullet(t: string): string {
  return `<li style="margin:0 0 6px;font:400 14px/1.55 ${F};color:#111827;">${esc(t)}</li>`;
}

export function renderExecSummaryHtml(d: ExecSummaryData): string {
  const dayRows = d.daily.map((r) => {
    const [s, a, j, i, p, o] = dayCells(r);
    const muted = r.submissions == null;
    return `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};">${esc(r.label)}${r.partial ? "*" : ""}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:${muted ? "400" : "700"} 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(s)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(a)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(j)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(i)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(p)}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(o)}</td>
    </tr>`;
  }).join("");

  const outcome = (label: string, value: string) =>
    `<li style="margin:0 0 5px;font:400 14px/1.5 ${F};color:#111827;"><strong>${esc(value)}</strong> ${esc(label)}</li>`;

  const reasonRows = d.topRejectionReasons.length
    ? d.topRejectionReasons.map((r) => `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:#111827;">${esc(r.reason)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #eef0f3;font:700 14px/1.4 ${F};color:#111827;text-align:right;">${r.count}</td>
      </tr>`).join("")
    : `<tr><td colspan="2" style="padding:10px 12px;font:400 14px/1.4 ${F};color:#6b7280;">No rejections recorded this week.</td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f6f8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="660" cellpadding="0" cellspacing="0" style="max-width:660px;width:100%;background:#ffffff;border:1px solid #e2e5ea;border-radius:10px;">

  <tr><td style="padding:20px 22px 0;">
    <div style="font:700 20px/1.3 ${F};color:#111827;">${esc(etRange(d.weekStart, d.weekEnd))}</div>
    <div style="font:italic 400 12.5px/1.5 ${F};color:#6b7280;margin-top:4px;">${esc(provenance(d))}</div>
    <div style="font:400 15px/1.6 ${F};color:#111827;margin-top:12px;">
      VRS Express has received <strong>${d.submissions} submissions</strong> from <strong>${d.uniqueTechnicians} unique technicians</strong> ${cohortPeriod(d)}.
    </div>
  </td></tr>

  <tr><td style="padding:18px 22px 0;">
    <div style="font:700 15px/1.3 ${F};color:#111827;margin-bottom:8px;">Outcomes</div>
    <ul style="margin:0;padding-left:20px;">
       ${outcome("Completed (approved)", String(d.approved))}
      ${outcome("rejected", String(d.rejected))}
      ${outcome("invalid", String(d.invalid))}
      ${outcome("pending", String(d.pending))}
       ${outcome("other", String(d.other))}
      ${outcome("approval rate among approved/rejected decisions", `${d.approvalRate ?? "n/a"}%`)}
      ${outcome("invalid rate", `${d.invalidRate ?? "n/a"}%`)}
      ${outcome("of submissions resolved", `${d.resolvedRate ?? "n/a"}%`)}
    </ul>
  </td></tr>

  <tr><td style="padding:18px 22px 0;">
    <div style="font:700 15px/1.3 ${F};color:#111827;margin-bottom:8px;">Turnaround time</div>
    <ul style="margin:0;padding-left:20px;">
      ${outcome("average review time", `${d.avgReviewMinutes ?? "n/a"} minutes`)}
      ${outcome("median review time", `${d.medianReviewMinutes ?? "n/a"} minutes`)}
    </ul>
  </td></tr>

  <tr><td style="padding:18px 22px 0;">
    <div style="font:700 15px/1.3 ${F};color:#111827;margin-bottom:8px;">Daily volume</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e5ea;border-radius:8px;overflow:hidden;">
      <tr style="background:#f9fafb;">
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;">Day</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Submissions</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Completed (approved)</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Rejected</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Invalid</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Pending</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Other</td>
      </tr>
      ${dayRows}
    </table>
    ${d.daily.some((r) => r.partial) ? `<div style="font:italic 400 12px/1.5 ${F};color:#6b7280;margin-top:6px;">* partial day at the time of the snapshot.</div>` : ""}
  </td></tr>

  <tr><td style="padding:18px 22px 0;">
    <div style="font:700 15px/1.3 ${F};color:#111827;margin-bottom:8px;">Top rejection reasons</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e5ea;border-radius:8px;overflow:hidden;">${reasonRows}</table>
  </td></tr>

  <tr><td style="padding:18px 22px 4px;">
    <div style="font:700 15px/1.3 ${F};color:#111827;margin-bottom:8px;">Executive takeaways</div>
    <ul style="margin:0;padding-left:20px;">${takeaways(d).map(bullet).join("")}</ul>
  </td></tr>

  <tr><td style="padding:14px 22px 20px;font:400 12px/1.5 ${F};color:#9ca3af;">
    Generated automatically by VRS Express every Wednesday at 4:00 PM ET.
    <br>${esc(METRIC_DEFINITIONS)}
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
  /** Durable state; accepted means provider accepted, never mailbox delivered. */
  delivery?: Record<string, any> | null;
  skipped?: string;
}

export type ExecSummaryGenerateOptions = {
  skipIfGeneratedToday?: boolean;
  dryRun?: boolean;
  send?: boolean;
  /** Internal scheduler key. Manual/generate-only runs never set this. */
  scheduleKey?: string;
};
export async function generateAndSendExecSummary(
  opts: ExecSummaryGenerateOptions = {},
): Promise<ExecSummaryRunResult> {
  const plan = execSummaryDeliveryPlan(opts);
  const send = plan.send;
  // Legacy /run has no client request key.  A live manual run therefore uses
  // an ET-day durable intent key: concurrent/double-clicked /run requests
  // converge on one report + provider attempt.  Generate-only and dry-run
  // deliberately do not create this key and cannot suppress the scheduler.
  const deliveryKey = plan.deliveryKey;

  // Persist under the advisory lock so two scheduler ticks (or a tick racing a
  // manual run) cannot double-generate and double-send.
  const persisted = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPORT_LOCK_KEY})`);

    // A schedule key, not "a report was generated today", is the durable
    // idempotency boundary.  Preview, dry-run, and generate-only reports must
    // never suppress the real Wednesday delivery.
    if (deliveryKey) {
      const existingSchedule = await tx.execute(sql`
        SELECT report_id FROM exec_summary_deliveries
        WHERE schedule_key = ${deliveryKey}
        LIMIT 1
      `);
      if (existingSchedule.rows.length) return null;
    } else if (opts.skipIfGeneratedToday) {
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

    // Do not use the generic bounded-report cleanup for executive summaries.
    // Each report is the parent of an immutable delivery/audit ledger and the
    // FK intentionally prevents deleting that evidence.
    // A dry-run/generate-only request has no delivery intent and therefore
    // cannot reserve the scheduled key.  A live send is durably enqueued
    // before the provider is contacted.
    if (plan.createDelivery) {
      // Recipient/configuration resolution is live-send-only. Generate-only
      // and dry-run still persist reports when the distribution list is bad.
      const payload: ExecSummaryDeliveryPayload = {
        to: await getExecSummaryRecipients(),
        subject: execSummarySubject(data),
        html: renderExecSummaryHtml(data),
        text: renderExecSummaryText(data),
      };
      await tx.insert(execSummaryDeliveries).values({
        reportId: report.id,
        scheduleKey: deliveryKey,
        state: "pending",
        payload: payload as any,
        nextAttemptAt: new Date(),
      });
    }

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
      submissions: data.submissions,
      approvalRate: data.approvalRate,
      pending: data.pending,
    },
  });

  if (!send || opts.dryRun) {
    // Dry-run is a generation diagnostic, not a provider operation. It must
    // not resolve recipients/configuration or create durable retry work.
    const email = opts.dryRun
      ? { sent: false, reason: "dryRun", retryable: false, ambiguous: false }
      : null;
    return { report, data, email, delivery: null };
  }

  // Sending is deliberately outside the report transaction.  The durable
  // claim/attempt is already committed, so crashes and concurrent clicks are
  // recoverable without a second provider submission.
  const deliveryResult = await deliveryStore.deliver(
    report.id,
    { requestKey: `generate:${report.id}`, automatic: true },
    sendPersistedExecSummary,
  );

  return {
    report,
    data,
    email: (deliveryResult.provider as SendEmailResult | undefined) ?? null,
    delivery: deliveryResult.delivery,
  };
}

export async function getLatestExecSummaries(
  limit = 8,
): Promise<Array<Omit<WeeklyReport, "csv"> & { delivery: Record<string, any> | null }>> {
  const reports = await db
    .select({
      id: weeklyReports.id,
      reportType: weeklyReports.reportType,
      generatedAt: weeklyReports.generatedAt,
      summary: weeklyReports.summary,
    })
    .from(weeklyReports)
    .where(eq(weeklyReports.reportType, EXEC_SUMMARY_REPORT_TYPE))
    .orderBy(desc(weeklyReports.generatedAt))
    .limit(limit) as Array<Omit<WeeklyReport, "csv">>;
  // The report list is small and this preserves complete attempt history for
  // the admin endpoint without making a generated-only report create delivery
  // intent.  `delivery:null` is a meaningful generated-only state.
  return Promise.all(reports.map(async (report) => ({
    ...report,
    delivery: await deliveryStore.getStatus(report.id),
  })));
}

const deliveryStore = new PostgresExecSummaryDeliveryStore(pool);
function etParts(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value])) as Record<string, string>;
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    dow: dowMap[parts.weekday],
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

/** Monday ET date that identifies this Wednesday's scheduled report. */
export function execSummaryScheduleKey(now: Date = new Date()): string {
  const et = etParts(now);
  const mondayUtc = new Date(Date.UTC(et.year, et.month - 1, et.day - ((et.dow + 6) % 7)));
  return mondayUtc.toISOString().slice(0, 10);
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
  // The production bootstrap is the only caller, but this guard protects
  // restart/scheduler tests from ever touching a real provider if they invoke
  // the exported scheduler directly.
  if (process.env.NODE_ENV !== "production") {
    log("[exec-summary] scheduler disabled outside production.");
    return;
  }

  if (!isEmailConfigured()) {
    log(
      "[exec-summary] SENDGRID_API_KEY is not set; the weekly summary will still generate and persist, but no email will be sent.",
    );
  }
  const runScheduledCatchup = async () => {
    if (!isExecSummaryDue()) return;
    const scheduleKey = execSummaryScheduleKey();
    if (await deliveryStore.hasSchedule(scheduleKey)) return;
    const r = await generateAndSendExecSummary({ send: true, scheduleKey });
    if (r.skipped) log(`[exec-summary] catch-up skipped: ${r.skipped}`);
    else log(`[exec-summary] catch-up report #${r.report?.id} ${r.delivery?.state || "created"}`);
  };

  const scheduleNext = () => {
    const delay = msUntilNextWednesday4pmET();
    log(`[exec-summary] next executive summary in ${(delay / 3600000).toFixed(2)}h (Wednesdays 4:00 PM ET)`);
    setTimeout(async () => {
      try {
        const r = await generateAndSendExecSummary({ send: true, scheduleKey: execSummaryScheduleKey() });
        if (r.skipped) {
          log(`[exec-summary] skipped: ${r.skipped}`);
        } else if (r.email?.sent) {
          log(`[exec-summary] report #${r.report?.id} provider accepted; mailbox delivery remains unconfirmed`);
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
  // Seed normally performs this migration first.  Await here too because this
  // service can be embedded independently and must not race a fresh database.
  void (async () => {
    // A temporary database failure during startup must not permanently kill
    // next-Wednesday scheduling.  Every poll re-runs catch-up, so once the DB
    // recovers it creates only the latest ET-week intent key.
    let deliverySchemaReady = false;
    const recover = async () => {
      // Keep attempting the idempotent ensure on every recovery tick until
      // success. A brief database outage during boot must not leave this
      // process permanently unable to catch up or poll durable attempts.
      if (!deliverySchemaReady) {
        try {
          await ensureExecSummaryDeliverySchema(pool);
          deliverySchemaReady = true;
        } catch (error: any) {
          log(`[exec-summary] delivery storage setup failed: ${error?.message || error}`);
          return;
        }
      }
      try {
        await runScheduledCatchup();
      } catch (error: any) {
        log(`[exec-summary] catch-up failed: ${error?.message || error}`);
      }
      try {
        await processDueExecSummaryDeliveries();
      } catch (error: any) {
        log(`[exec-summary] retry poll failed: ${error?.message || error}`);
      }
    };
    await recover();
    setInterval(() => { void recover(); }, 5 * 60_000);
    scheduleNext();
  })();
}

async function ensureSavedExecSummaryDelivery(reportId: number): Promise<void> {
  if (await deliveryStore.getStatus(reportId)) return;
  // Generate-only rows have no delivery intent.  Turning one into a manual
  // send must use the saved report snapshot — never compute current metrics.
  const result = await db.execute(sql`
    SELECT id, report_type, summary, csv
    FROM weekly_reports
    WHERE id = ${reportId} AND report_type = ${EXEC_SUMMARY_REPORT_TYPE}
    LIMIT 1
  `);
  const report = result.rows[0] as { id: number; summary: unknown; csv: string } | undefined;
  if (!report || !report.summary || typeof report.summary !== "object" || typeof report.csv !== "string") {
    throw new Error("Executive summary report was not found or its saved snapshot is invalid.");
  }
  const data = report.summary as ExecSummaryData;
  if (!data.weekStart || !data.weekEnd || !data.snapshotAt) {
    throw new Error("Executive summary report is missing required saved snapshot fields.");
  }
  const payload: ExecSummaryDeliveryPayload = {
    to: await getExecSummaryRecipients(),
    subject: execSummarySubject(data),
    html: renderExecSummaryHtml(data),
    text: report.csv,
  };
  // Concurrent first-send clicks race safely on the report_id unique index;
  // the losing process then claims the durable row created by the winner.
  await deliveryStore.create(reportId, payload);
}

/** Run only already-due, provider-safe retries; ambiguous outcomes stay put. */
export async function processDueExecSummaryDeliveries(): Promise<number> {
  const ids = await deliveryStore.listDueReportIds();
  for (const reportId of ids) {
    await deliveryStore.deliver(
      reportId,
      { requestKey: `automatic:${reportId}:${Date.now()}`, automatic: true },
      sendPersistedExecSummary,
    ).catch((error) => {
      console.error(`[exec-summary] retry for report #${reportId} failed: ${error?.message || error}`);
    });
  }
  return ids.length;
}

/**
 * Report delivery and full attempt history for admin report APIs.  `accepted`
 * is provider acceptance only; deliveryConfirmed is intentionally always false
 * until a provider webhook is implemented.
 */
export async function getExecSummaryDeliveryStatus(reportId: number) {
  return deliveryStore.getStatus(reportId);
}

function execSummaryEtDate(now: Date = new Date()): string {
  const et = etParts(now);
  return `${et.year}-${String(et.month).padStart(2, "0")}-${String(et.day).padStart(2, "0")}`;
}

/**
 * The current Monday–Sunday ET week has passed its Wednesday 4 PM instant.
 * Catch-up deliberately covers this current reporting week only: older weeks
 * remain visible/auditable but are not silently backfilled after an outage.
 */
export function isExecSummaryDue(now: Date = new Date()): boolean {
  const et = etParts(now);
  return et.dow === 0 || et.dow > REPORT_DOW_ET ||
    (et.dow === REPORT_DOW_ET && et.hour >= REPORT_HOUR_ET);
}

export async function listExecSummaryDeliveryHistory(reportId: number) {
  return getExecSummaryDeliveryStatus(reportId);
}

export async function retryExecSummaryDelivery(
  reportId: number,
  options: { resend: boolean; requestKey: string },
) {
  const requestKey = String(options.requestKey || "").trim();
  if (!requestKey || requestKey.length > 200) {
    throw new Error("A requestKey of 1–200 characters is required to safely retry a delivery.");
  }
  await ensureSavedExecSummaryDelivery(reportId);
  return deliveryStore.deliver(
    reportId,
    { resend: options.resend === true, requestKey, automatic: false },
    sendPersistedExecSummary,
  );
}

async function sendPersistedExecSummary(payload: ExecSummaryDeliveryPayload): Promise<ProviderEmailResult> {
  // SendEmailResult gained retry metadata in Task 57.  Keep this cast
  // compatible with the existing route-facing return type while email.ts is
  // upgraded independently.
  return sendEmail(payload) as Promise<ProviderEmailResult>;
}

/**
 * Pure orchestration policy used by generation and mocked service tests.
 * Crucially, no delivery key means no recipient lookup, provider validation,
 * persisted envelope, or chance of suppressing the scheduled run.
 */
export function execSummaryDeliveryPlan(
  opts: ExecSummaryGenerateOptions = {},
  now: Date = new Date(),
) {
  const send = opts.send !== false;
  const createDelivery = send && !opts.dryRun;
  return {
    send,
    createDelivery,
    dryRunDiagnostic: opts.dryRun ? "dryRun" : null,
    deliveryKey: createDelivery
      ? (opts.scheduleKey ??
        (isExecSummaryDue(now) ? execSummaryScheduleKey(now) : `m:${execSummaryEtDate(now)}`))
      : undefined,
  };
}
