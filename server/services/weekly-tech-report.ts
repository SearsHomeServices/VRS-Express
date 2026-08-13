// ---------------------------------------------------------------------------
// Weekly IH Tech No-Login Report — 2026-08-12
//
// Every Wednesday at 5:00 PM ET (end of business day), generate the list of
// active in-home technicians on the roster who have never signed into VRS
// Express (no users row for their LDAP ID — tech user rows are created on
// first login by getOrCreateTechUser). The report is persisted in
// weekly_reports (summary + CSV) and admins are notified in-app over WS.
//
// Scheduler follows the DST-safe wall-clock pattern of tech-sync.ts.
// Best-effort: a failed run logs and waits for next week.
// ---------------------------------------------------------------------------
import { sql, desc, eq } from "drizzle-orm";
import { db } from "../storage";
import { weeklyReports, type WeeklyReport } from "@shared/schema";
import { broadcastToAdmins } from "../websocket";

export const TECH_NO_LOGIN_REPORT_TYPE = "tech_no_login";

const REPORT_DOW_ET = 3; // Wednesday (0 = Sunday)
const REPORT_HOUR_ET = 17; // 5:00 PM ET — "end of day"
const TZ = "America/New_York";

// Spreadsheet formula-injection guard (same policy as export-coaching:
// leading formula chars, tab, and CR all neutralized; CR/LF cells quoted).
function deFormulaCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
function csvCell(v: string | null | undefined): string {
  const s = deFormulaCell(String(v ?? ""));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Bounded retention: the CSV bodies contain tech names/phones (PII), so keep
// only the most recent reports per type (~6 months of weekly runs).
const KEEP_REPORTS_PER_TYPE = 26;

// Advisory lock key so overlapping scheduler runs / concurrent manual runs
// can't double-generate + double-notify.
const REPORT_LOCK_KEY = 0x7ec4_0001;

export async function generateTechNoLoginReport(
  opts: { skipIfGeneratedToday?: boolean } = {},
): Promise<WeeklyReport | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${REPORT_LOCK_KEY})`);

    if (opts.skipIfGeneratedToday) {
      // Scheduler idempotence: at most one report per ET day (covers server
      // restarts / multiple scheduler instances firing the same Wednesday).
      const existing = await tx.execute(sql`
        SELECT id FROM weekly_reports
        WHERE report_type = ${TECH_NO_LOGIN_REPORT_TYPE}
          AND (generated_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date
              = (now() AT TIME ZONE 'America/New_York')::date
        LIMIT 1
      `);
      if (existing.rows.length) return null;
    }

    // Single consistent snapshot: one query over the roster with a
    // has-account flag, so the list and the totals can't drift apart.
    // Tech user rows are only created at first login (getOrCreateTechUser),
    // so a missing users row == never signed in. Compare case-insensitively
    // to be safe against manually created accounts.
    const result = await tx.execute(sql`
      SELECT t.name, t.ldap_id, t.district, t.manager_name, t.phone,
             (u.id IS NOT NULL) AS has_account
      FROM technicians t
      LEFT JOIN users u ON upper(u.rac_id) = upper(t.ldap_id)
      WHERE t.is_active = true
      ORDER BY t.district, t.manager_name, t.name
    `);
    const all = result.rows as Array<{
      name: string | null;
      ldap_id: string;
      district: string | null;
      manager_name: string | null;
      phone: string | null;
      has_account: boolean;
    }>;
    const rows = all.filter((r) => !r.has_account);

    const header = "Technician Name,LDAP ID,District,Manager,Phone";
    const csv = [
      header,
      ...rows.map((r) =>
        [r.name, r.ldap_id, r.district, r.manager_name, r.phone].map(csvCell).join(","),
      ),
    ].join("\n");

    const summary = {
      notSignedIn: rows.length,
      activeRoster: all.length,
      districts: new Set(rows.map((r) => r.district || "")).size,
      managers: new Set(rows.map((r) => r.manager_name || "")).size,
    };

    const [report] = await tx
      .insert(weeklyReports)
      .values({ reportType: TECH_NO_LOGIN_REPORT_TYPE, summary, csv })
      .returning();

    // Retention prune (same transaction, still under the advisory lock).
    await tx.execute(sql`
      DELETE FROM weekly_reports
      WHERE report_type = ${TECH_NO_LOGIN_REPORT_TYPE}
        AND id NOT IN (
          SELECT id FROM weekly_reports
          WHERE report_type = ${TECH_NO_LOGIN_REPORT_TYPE}
          ORDER BY generated_at DESC, id DESC
          LIMIT ${KEEP_REPORTS_PER_TYPE}
        )
    `);

    broadcastToAdmins({
      type: "weekly_report_ready",
      payload: {
        reportId: report.id,
        reportType: TECH_NO_LOGIN_REPORT_TYPE,
        generatedAt: report.generatedAt,
        ...summary,
      },
    });

    return report;
  });
}

export async function getLatestTechNoLoginReports(limit = 8): Promise<Array<Omit<WeeklyReport, "csv">>> {
  return db
    .select({
      id: weeklyReports.id,
      reportType: weeklyReports.reportType,
      generatedAt: weeklyReports.generatedAt,
      summary: weeklyReports.summary,
    })
    .from(weeklyReports)
    .where(eq(weeklyReports.reportType, TECH_NO_LOGIN_REPORT_TYPE))
    .orderBy(desc(weeklyReports.generatedAt))
    .limit(limit) as any;
}

export async function getWeeklyReportById(id: number): Promise<WeeklyReport | undefined> {
  const [r] = await db.select().from(weeklyReports).where(eq(weeklyReports.id, id)).limit(1);
  return r;
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

export function msUntilNextWednesday5pmET(now: Date = new Date()): number {
  const et = etParts(now);
  const nowSecs = et.hour * 3600 + et.minute * 60 + et.second;
  const targetSecs = REPORT_HOUR_ET * 3600;
  let daysAhead = (REPORT_DOW_ET - et.dow + 7) % 7;
  if (daysAhead === 0 && nowSecs >= targetSecs) daysAhead = 7;
  let deltaSecs = daysAhead * 24 * 3600 + (targetSecs - nowSecs);

  // Exact except across a DST transition (off by ±1h). Re-check ET wall
  // clock at the candidate and nudge (same approach as tech-sync).
  let candidate = now.getTime() + deltaSecs * 1000;
  for (let i = 0; i < 3; i++) {
    const c = etParts(new Date(candidate));
    if (c.dow === REPORT_DOW_ET && c.hour === REPORT_HOUR_ET) break;
    const hourDiff = REPORT_HOUR_ET - c.hour;
    candidate += (hourDiff < -12 ? hourDiff + 24 : hourDiff > 12 ? hourDiff - 24 : hourDiff) * 3600 * 1000;
  }
  return Math.max(candidate - now.getTime(), 60_000);
}

export function scheduleWeeklyTechNoLoginReport(log: (msg: string) => void): void {
  const scheduleNext = () => {
    const delay = msUntilNextWednesday5pmET();
    log(`[weekly-report] next tech no-login report in ${(delay / 3600000).toFixed(2)}h (Wednesdays 5:00 PM ET)`);
    setTimeout(async () => {
      try {
        const r = await generateTechNoLoginReport({ skipIfGeneratedToday: true });
        if (!r) {
          log(`[weekly-report] skipped — a report was already generated today`);
        } else {
          const s = r.summary as any;
          log(`[weekly-report] generated report #${r.id}: ${s.notSignedIn}/${s.activeRoster} active IH techs never signed in`);
        }
      } catch (err: any) {
        log(`[weekly-report] generation failed: ${err?.message || String(err)}`);
      } finally {
        scheduleNext();
      }
    }, delay);
  };
  scheduleNext();
}
