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
      submissions: data.submissions,
      approvalRate: data.approvalRate,
      pending: data.pending,
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
      "[exec-summary] SENDGRID_API_KEY is not set; the weekly summary will still generate and persist, but no email will be sent.",
    );
  }
  const scheduleNext = () => {
    const delay = msUntilNextWednesday4pmET();
    log(`[exec-summary] next executive summary in ${(delay / 3600000).toFixed(2)}h (Wednesdays 4:00 PM ET)`);
    setTimeout(async () => {
      try {
        const r = await generateAndSendExecSummary({ skipIfGeneratedToday: true });
        if (r.skipped) {
          log(`[exec-summary] skipped: ${r.skipped}`);
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
