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
//
// ⛔ THE SHAPE OF THIS REPORT IS NOT A CHOICE. It mirrors, field for field, the
// weekly summary the Replit Agent has been producing on request for the VRS
// Express owners. A second, differently-computed version of the same week is
// worse than no email: the first draft of this file reported a 69.1% approval
// rate against their 75.6% for the identical week, because it divided by
// approved+rejected+invalid where they divide by approved+rejected only.
//
// Definitions, all locked to their report:
//   cohort        submissions CREATED in the current Mon-Sun ET week, to date
//   approval rate approved / (approved + rejected)   <- invalid EXCLUDED
//   invalid rate  invalid / cohort
//   resolved      cohort - pending, over cohort
//   pending       unreviewed WITHIN THIS WEEK'S COHORT, not the all-time backlog
//   review time   created_at -> stage1_reviewed_at, wall clock, this cohort
//                 (the Analytics page's figure is all-time AND business-hours
//                  aware, so it is a different number on purpose; never mix)
// Buckets count on stage1_status, the column storage.getAnalytics() uses.

const TZ_SQL = "America/New_York";

export interface DailyVolumeRow {
  /** ET calendar date, YYYY-MM-DD. */
  date: string;
  label: string;
  /** null = the day has not happened yet ("Not yet included"). */
  submissions: number | null;
  approved: number | null;
  rejected: number | null;
  /** True for the day the snapshot was taken on: the day is incomplete. */
  partial: boolean;
}

export interface ExecSummaryData {
  weekStart: string;
  weekEnd: string;
  snapshotAt: string;
  latestSubmissionAt: string | null;
  submissions: number;
  uniqueTechnicians: number;
  approved: number;
  rejected: number;
  invalid: number;
  pending: number;
  approvalRate: number | null;
  invalidRate: number | null;
  resolvedRate: number | null;
  avgReviewMinutes: number | null;
  medianReviewMinutes: number | null;
  daily: DailyVolumeRow[];
  /** Same cohort measured at the same weekday+time one week earlier. */
  prior: {
    submissions: number;
    approvalRate: number | null;
    invalidRate: number | null;
    avgReviewMinutes: number | null;
    medianReviewMinutes: number | null;
  };
  topRejectionReasons: Array<{ reason: string; count: number }>;
}

function rate(n: number, d: number): number | null {
  if (!d) return null;
  return Math.round((n / d) * 1000) / 10;
}
function mins(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

export async function computeExecSummary(): Promise<ExecSummaryData> {
  // One cohort query. `weeks_back` = 0 for this week, 1 for the same slice of
  // last week, so the comparison is always like-for-like: Monday through this
  // exact weekday and time, never a full week against a partial one.
  const cohort = async (weeksBack: number) => {
    const res = await db.execute(sql`
      WITH bounds AS (
        SELECT
          (date_trunc('week', (now() AT TIME ZONE ${TZ_SQL}))
             - make_interval(weeks => ${weeksBack})) AT TIME ZONE ${TZ_SQL} AS week_start,
          ((now() AT TIME ZONE ${TZ_SQL}) - make_interval(weeks => ${weeksBack}))
             AT TIME ZONE ${TZ_SQL} AS cutoff
      )
      SELECT
        count(*)::int AS submissions,
        count(DISTINCT coalesce(nullif(technician_ldap_id, ''), technician_id::text))::int AS unique_techs,
        count(*) FILTER (WHERE stage1_status = 'approved')::int AS approved,
        count(*) FILTER (WHERE stage1_status = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE stage1_status = 'invalid')::int  AS invalid,
        count(*) FILTER (WHERE stage1_status = 'pending')::int  AS pending,
        avg(EXTRACT(EPOCH FROM (stage1_reviewed_at - created_at)) / 60.0)
          FILTER (WHERE stage1_reviewed_at IS NOT NULL)          AS avg_review_min,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (stage1_reviewed_at - created_at)) / 60.0
        ) FILTER (WHERE stage1_reviewed_at IS NOT NULL)          AS median_review_min,
        max(created_at)                                          AS latest_submission
      FROM submissions, bounds
      WHERE created_at >= bounds.week_start AND created_at <= bounds.cutoff
    `);
    return res.rows[0] as Record<string, any>;
  };

  const [cur, prev] = await Promise.all([cohort(0), cohort(1)]);

  const dailyRes = await db.execute(sql`
    WITH bounds AS (
      SELECT (date_trunc('week', (now() AT TIME ZONE ${TZ_SQL}))) AT TIME ZONE ${TZ_SQL} AS week_start,
             (now() AT TIME ZONE ${TZ_SQL})::date AS today_et
    ),
    days AS (
      SELECT generate_series(
        (SELECT (week_start AT TIME ZONE ${TZ_SQL})::date FROM bounds),
        (SELECT (week_start AT TIME ZONE ${TZ_SQL})::date FROM bounds) + 6,
        interval '1 day'
      )::date AS d
    )
    SELECT
      to_char(days.d, 'YYYY-MM-DD') AS date,
      to_char(days.d, 'FMDay, FMMon. FMDD') AS label,
      (days.d >  (SELECT today_et FROM bounds)) AS future,
      (days.d =  (SELECT today_et FROM bounds)) AS partial,
      count(s.id) FILTER (WHERE s.id IS NOT NULL)::int AS submissions,
      count(s.id) FILTER (WHERE s.stage1_status = 'approved')::int AS approved,
      count(s.id) FILTER (WHERE s.stage1_status = 'rejected')::int AS rejected
    FROM days
    LEFT JOIN submissions s
      ON (s.created_at AT TIME ZONE ${TZ_SQL})::date = days.d
    GROUP BY days.d
    ORDER BY days.d
  `);

  let reasons: { rows: any[] } = { rows: [] };
  try {
    reasons = await db.execute(sql`
      WITH bounds AS (
        SELECT (date_trunc('week', (now() AT TIME ZONE ${TZ_SQL}))) AT TIME ZONE ${TZ_SQL} AS week_start
      )
      SELECT reason, count(*)::int AS count
      FROM submissions s, bounds,
           LATERAL json_array_elements_text(s.rejection_reasons::json) AS reason
      WHERE s.rejection_reasons ~ '^\s*\['
        AND s.created_at >= bounds.week_start
      GROUP BY reason
      ORDER BY count DESC, reason ASC
      LIMIT 5
    `) as any;
  } catch (err: any) {
    console.error(`[exec-summary] rejection-reason rollup skipped: ${err?.message || err}`);
  }

  const daily: DailyVolumeRow[] = (dailyRes.rows as any[]).map((r) => ({
    date: String(r.date),
    label: String(r.label).replace(/\s+/g, " ").trim(),
    submissions: r.future ? null : Number(r.submissions),
    approved: r.future ? null : Number(r.approved),
    rejected: r.future ? null : Number(r.rejected),
    partial: Boolean(r.partial),
  }));

  const decided = cur.approved + cur.rejected;
  const prevDecided = prev.approved + prev.rejected;

  return {
    weekStart: daily[0]?.date ?? "",
    weekEnd: daily[daily.length - 1]?.date ?? "",
    snapshotAt: new Date().toISOString(),
    latestSubmissionAt: cur.latest_submission ? new Date(cur.latest_submission).toISOString() : null,
    submissions: cur.submissions,
    uniqueTechnicians: cur.unique_techs,
    approved: cur.approved,
    rejected: cur.rejected,
    invalid: cur.invalid,
    pending: cur.pending,
    approvalRate: rate(cur.approved, decided),
    invalidRate: rate(cur.invalid, cur.submissions),
    resolvedRate: rate(cur.submissions - cur.pending, cur.submissions),
    avgReviewMinutes: mins(cur.avg_review_min),
    medianReviewMinutes: mins(cur.median_review_min),
    daily,
    prior: {
      submissions: prev.submissions,
      approvalRate: rate(prev.approved, prevDecided),
      invalidRate: rate(prev.invalid, prev.submissions),
      avgReviewMinutes: mins(prev.avg_review_min),
      medianReviewMinutes: mins(prev.median_review_min),
    },
    topRejectionReasons: (reasons.rows as any[]).map((r) => ({
      reason: String(r.reason),
      count: Number(r.count),
    })),
  };
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
  if (d === 0) return "unchanged from the same point last week";
  return `${d > 0 ? "up" : "down"} ${Math.abs(d)} percentage point${Math.abs(d) === 1 ? "" : "s"} from the same point last week`;
}

export function execSummarySubject(d: ExecSummaryData): string {
  return `VRS Express weekly update: ${etRange(d.weekStart, d.weekEnd)}`;
}

function provenance(d: ExecSummaryData): string {
  const latest = d.latestSubmissionAt
    ? `; latest submission at approximately ${etClock(d.latestSubmissionAt)}`
    : "";
  return `Week-to-date: production snapshot queried ${etLong(d.snapshotAt)} at ${etClock(d.snapshotAt)}${latest}.`;
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
  out.push(`This is a week-to-date update, not a final seven-day report.`);
  return out;
}

function dayCells(r: DailyVolumeRow): [string, string, string] {
  if (r.submissions == null) return ["Not yet included", "-", "-"];
  return [String(r.submissions), String(r.approved ?? 0), String(r.rejected ?? 0)];
}

export function renderExecSummaryText(d: ExecSummaryData): string {
  const L: string[] = [];
  L.push(`VRS EXPRESS WEEKLY UPDATE`);
  L.push(etRange(d.weekStart, d.weekEnd));
  L.push(provenance(d));
  L.push("");
  L.push(`VRS Express has received ${d.submissions} submissions from ${d.uniqueTechnicians} unique technicians so far this week.`);
  L.push("");
  L.push("OUTCOMES");
  L.push(`  ${d.approved} approved`);
  L.push(`  ${d.rejected} rejected`);
  L.push(`  ${d.invalid} invalid`);
  L.push(`  ${d.pending} pending`);
  L.push(`  ${d.approvalRate ?? "n/a"}% approval rate among approved/rejected decisions`);
  L.push(`  ${d.invalidRate ?? "n/a"}% invalid rate`);
  L.push(`  ${d.resolvedRate ?? "n/a"}% of submissions resolved`);
  L.push("");
  L.push("TURNAROUND TIME");
  L.push(`  ${d.avgReviewMinutes ?? "n/a"} minutes average review time`);
  L.push(`  ${d.medianReviewMinutes ?? "n/a"} minutes median review time`);
  L.push("");
  L.push("DAILY VOLUME");
  L.push(`  ${"Day".padEnd(22)}${"Submissions".padStart(17)}${"Approved".padStart(10)}${"Rejected".padStart(10)}`);
  for (const r of d.daily) {
    const [s, a, j] = dayCells(r);
    L.push(`  ${(r.label + (r.partial ? "*" : "")).padEnd(22)}${s.padStart(17)}${a.padStart(10)}${j.padStart(10)}`);
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
  return L.join("\n");
}

const F = "-apple-system,Segoe UI,Arial,sans-serif";

function bullet(t: string): string {
  return `<li style="margin:0 0 6px;font:400 14px/1.55 ${F};color:#111827;">${esc(t)}</li>`;
}

export function renderExecSummaryHtml(d: ExecSummaryData): string {
  const dayRows = d.daily.map((r) => {
    const [s, a, j] = dayCells(r);
    const muted = r.submissions == null;
    return `<tr>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};">${esc(r.label)}${r.partial ? "*" : ""}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:${muted ? "400" : "700"} 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(s)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(a)}</td>
      <td style="padding:7px 12px;border-bottom:1px solid #eef0f3;font:400 14px/1.4 ${F};color:${muted ? "#9ca3af" : "#111827"};text-align:right;">${esc(j)}</td>
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
      VRS Express has received <strong>${d.submissions} submissions</strong> from <strong>${d.uniqueTechnicians} unique technicians</strong> so far this week.
    </div>
  </td></tr>

  <tr><td style="padding:18px 22px 0;">
    <div style="font:700 15px/1.3 ${F};color:#111827;margin-bottom:8px;">Outcomes</div>
    <ul style="margin:0;padding-left:20px;">
      ${outcome("approved", String(d.approved))}
      ${outcome("rejected", String(d.rejected))}
      ${outcome("invalid", String(d.invalid))}
      ${outcome("pending", String(d.pending))}
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
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Approved</td>
        <td style="padding:7px 12px;font:600 12px/1.3 ${F};color:#6b7280;text-align:right;">Rejected</td>
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
