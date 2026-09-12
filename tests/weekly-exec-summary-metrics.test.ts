import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildExecSummaryMetrics,
  getExecSummaryWindow,
  previousSameLocalWeekdayTime,
  type ExecSummaryMetricRow,
} from "../server/services/weekly-exec-summary-metrics";

const WTD_CUTOFF = "2026-09-10T19:30:00.000Z"; // Thursday, 3:30 PM ET

const rendererMocks = vi.hoisted(() => ({
  dbExecute: vi.fn(),
  getSystemSetting: vi.fn(async () => null),
  broadcastToAdmins: vi.fn(),
  sendEmail: vi.fn(),
}));

// The service imports storage, websocket, and email at module evaluation time.
// Keep this suite a renderer regression test: importing it must not open a DB
// connection or require an email configuration.
vi.mock("../server/storage", () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  db: { execute: rendererMocks.dbExecute, transaction: vi.fn() },
  storage: { getSystemSetting: rendererMocks.getSystemSetting },
}));
vi.mock("../server/websocket", () => ({
  broadcastToAdmins: rendererMocks.broadcastToAdmins,
}));
vi.mock("../server/services/email", () => ({
  sendEmail: rendererMocks.sendEmail,
  isEmailConfigured: () => false,
  isPlausibleEmail: () => true,
}));

function row(
  id: number,
  values: Partial<ExecSummaryMetricRow> & Pick<ExecSummaryMetricRow, "createdAt">,
): ExecSummaryMetricRow {
  return { id, ...values };
}

describe("weekly executive summary pure metrics", () => {
  it("keeps mixed outcomes in one cohort and leaves null/invalid timestamps out", () => {
    const bounds = getExecSummaryWindow(WTD_CUTOFF);
    const rows: ExecSummaryMetricRow[] = [
      row(1, {
        createdAt: "2026-09-07T14:00:00.000Z",
        ticketStatus: "completed",
        technicianLdapId: "Tech-A",
        reviewedAt: "2026-09-07T14:30:00.000Z",
      }),
      row(2, {
        createdAt: "2026-09-08T15:00:00.000Z",
        ticket_status: "rejected_closed",
        technician_ldap_id: "tech-a",
        reviewed_at: "2026-09-08T15:45:00.000Z",
        rejection_reasons: ["missing part", "missing part"],
      }),
      row(3, {
        createdAt: "2026-09-09T16:00:00.000Z",
        status: "invalid",
        technicianLdapId: "tech-b",
        reviewedAt: "2026-09-09T16:15:00.000Z",
      }),
      row(4, {
        createdAt: "2026-09-10T18:00:00.000Z",
        status: "queued",
        technician_ldap_id: "tech-b",
      }),
      row(5, {
        createdAt: "2026-09-09T17:00:00.000Z",
        status: "manual_hold",
        technicianLdapId: "TECH-B",
        rejectionReasons: '[ "manual hold" ]',
      }),
      // Missing and malformed timestamps must not become cohort rows.
      row(6, {
        createdAt: null,
        ticketStatus: "completed",
        technicianLdapId: "excluded-null-time",
      }),
      row(7, {
        createdAt: "not-a-timestamp",
        ticketStatus: "rejected",
        technicianLdapId: "excluded-invalid-time",
      }),
      // A future row is outside this WTD cutoff as well.
      row(8, {
        createdAt: "2026-09-11T14:00:00.000Z",
        ticketStatus: "completed",
        technicianLdapId: "future",
      }),
    ];

    const metrics = buildExecSummaryMetrics(rows, bounds);

    expect(metrics).toMatchObject({
      mode: "wtd",
      weekStart: "2026-09-07",
      weekEnd: "2026-09-13",
      cutoffAt: WTD_CUTOFF,
      submissions: 5,
      uniqueTechnicians: 2,
      approved: 1,
      rejected: 1,
      invalid: 1,
      pending: 1,
      other: 1,
      approvalRate: 50,
      invalidRate: 20,
      resolvedRate: 60,
      avgReviewMinutes: 30,
      medianReviewMinutes: 30,
      latestSubmissionAt: "2026-09-10T18:00:00.000Z",
    });
    expect(metrics.daily).toEqual([
      expect.objectContaining({ date: "2026-09-07", submissions: 1, approved: 1, rejected: 0, invalid: 0, pending: 0, other: 0 }),
      expect.objectContaining({ date: "2026-09-08", submissions: 1, approved: 0, rejected: 1, invalid: 0, pending: 0, other: 0 }),
      expect.objectContaining({ date: "2026-09-09", submissions: 2, approved: 0, rejected: 0, invalid: 1, pending: 0, other: 1 }),
      expect.objectContaining({ date: "2026-09-10", submissions: 1, pending: 1, partial: true }),
      expect.objectContaining({ date: "2026-09-11", submissions: null, approved: null, invalid: null, pending: null, other: null, partial: false }),
      expect.objectContaining({ date: "2026-09-12", submissions: null }),
      expect.objectContaining({ date: "2026-09-13", submissions: null }),
    ]);
    expect(metrics.topRejectionReasons).toEqual([
      { reason: "missing part", count: 2 },
    ]);
  });

  it("deduplicates technician identity across case and identifier fallbacks", () => {
    const bounds = getExecSummaryWindow(WTD_CUTOFF);
    const rows: ExecSummaryMetricRow[] = [
      row(10, { createdAt: "2026-09-07T12:00:00Z", status: "pending", technicianLdapId: "Agent-7" }),
      row(11, { createdAt: "2026-09-07T13:00:00Z", status: "pending", technician_ldap_id: "agent-7" }),
      row(12, { createdAt: "2026-09-07T14:00:00Z", status: "pending", userLdapId: "User-9" }),
      row(13, { createdAt: "2026-09-07T15:00:00Z", status: "pending", user_rac_id: "user-9" }),
      row(14, { createdAt: "2026-09-07T16:00:00Z", status: "pending", technicianId: 42 }),
      row(15, { createdAt: "2026-09-07T17:00:00Z", status: "pending", technician_id: 42 }),
    ];

    const metrics = buildExecSummaryMetrics(rows, bounds);

    expect(metrics.submissions).toBe(6);
    expect(metrics.uniqueTechnicians).toBe(3);
    expect(metrics.pending).toBe(6);
  });

  it("uses ET wall-clock boundaries across the spring DST transition", () => {
    const cutoff = "2026-03-08T16:00:00.000Z"; // Sunday noon EDT
    const bounds = getExecSummaryWindow(cutoff);

    expect(bounds.weekStart.toISOString()).toBe("2026-03-02T05:00:00.000Z");
    expect(bounds.weekEndExclusive.toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(bounds.priorCutoff.toISOString()).toBe("2026-03-01T17:00:00.000Z");
    expect(bounds.weekEndExclusive.getTime() - bounds.weekStart.getTime()).toBe(
      167 * 60 * 60 * 1000,
    );
    expect(previousSameLocalWeekdayTime(cutoff).toISOString()).toBe("2026-03-01T17:00:00.000Z");

    const metrics = buildExecSummaryMetrics(
      [
        row(20, {
          createdAt: "2026-03-08T15:59:59.000Z",
          status: "completed",
          technicianLdapId: "dst-current",
        }),
        row(21, {
          createdAt: "2026-03-01T16:59:59.000Z",
          status: "rejected",
          technicianLdapId: "dst-prior",
        }),
        // Exact prior cutoff is exclusive.
        row(22, {
          createdAt: "2026-03-01T17:00:00.000Z",
          status: "completed",
          technicianLdapId: "excluded-at-boundary",
        }),
      ],
      bounds,
    );

    expect(metrics.submissions).toBe(1);
    expect(metrics.daily[6]).toMatchObject({
      date: "2026-03-08",
      submissions: 1,
      approved: 1,
      partial: true,
    });
    expect(metrics.daily.slice(0, 6).every((day) => day.submissions === 0)).toBe(true);
    expect(metrics.prior).toMatchObject({
      submissions: 1,
      approved: 0,
      rejected: 1,
      approvalRate: 0,
    });
  });

  it("compares created cohorts using their current outcomes, and supports full weeks", () => {
    const wtdBounds = getExecSummaryWindow(WTD_CUTOFF);
    const wtd = buildExecSummaryMetrics(
      [
        row(30, { createdAt: "2026-09-07T12:00:00Z", status: "completed", technicianLdapId: "current-a" }),
        row(31, { createdAt: "2026-09-08T12:00:00Z", status: "rejected", technicianLdapId: "current-b" }),
        // These are prior submissions, but their statuses are evaluated now.
        row(32, { createdAt: "2026-09-02T12:00:00Z", status: "completed", technicianLdapId: "prior-a" }),
        row(33, { createdAt: "2026-09-02T13:00:00Z", status: "rejected", technicianLdapId: "prior-b" }),
        row(34, { createdAt: "2026-09-02T14:00:00Z", status: "invalid", technicianLdapId: "prior-c" }),
      ],
      wtdBounds,
    );

    expect(wtd.prior).toMatchObject({
      submissions: 3,
      approved: 1,
      rejected: 1,
      invalid: 1,
      approvalRate: 50,
      invalidRate: 33.3,
    });

    const fullWeekBounds = getExecSummaryWindow("2026-09-10T19:30:00Z", {
      mode: "full_week",
      weekStart: "2026-08-31",
    });
    const fullWeek = buildExecSummaryMetrics(
      [
        row(40, { createdAt: "2026-09-01T12:00:00Z", status: "completed", technicianLdapId: "full-current" }),
        row(41, { createdAt: "2026-09-06T12:00:00Z", status: "other", technicianLdapId: "full-other" }),
        row(42, { createdAt: "2026-08-25T12:00:00Z", status: "rejected", technicianLdapId: "full-prior" }),
      ],
      fullWeekBounds,
    );

    expect(fullWeek.mode).toBe("full_week");
    expect(fullWeek.cutoffAt).toBe("2026-09-07T04:00:00.000Z");
    expect(fullWeek.daily).toHaveLength(7);
    expect(fullWeek.daily.every((day) => day.submissions !== null && !day.partial)).toBe(true);
    expect(fullWeek.other).toBe(1);
    expect(fullWeek.prior).toMatchObject({ submissions: 1, rejected: 1, approvalRate: 0 });
  });

  it("handles an empty cohort without inventing rates or durations", () => {
    const metrics = buildExecSummaryMetrics([], getExecSummaryWindow(WTD_CUTOFF));

    expect(metrics).toMatchObject({
      submissions: 0,
      uniqueTechnicians: 0,
      approved: 0,
      rejected: 0,
      invalid: 0,
      pending: 0,
      other: 0,
      approvalRate: null,
      invalidRate: null,
      resolvedRate: null,
      avgReviewMinutes: null,
      medianReviewMinutes: null,
      latestSubmissionAt: null,
      topRejectionReasons: [],
    });
    expect(metrics.daily.slice(0, 4).every((day) => day.submissions === 0)).toBe(true);
    expect(metrics.daily.slice(4).every((day) => day.submissions === null)).toBe(true);
    expect(metrics.prior).toMatchObject({
      submissions: 0,
      approvalRate: null,
      invalidRate: null,
      avgReviewMinutes: null,
      medianReviewMinutes: null,
    });
  });

  it("excludes negative review durations and keeps SQL-shaped approved as OTHER", () => {
    const bounds = getExecSummaryWindow(WTD_CUTOFF);
    const metrics = buildExecSummaryMetrics(
      [
        row(50, {
          created_at: "2026-09-07T12:00:00Z",
          ticket_status: "completed",
          reviewed_at: "2026-09-07T11:59:00Z",
          technician_ldap_id: "sql-completed",
        }),
        row(51, {
          created_at: "2026-09-07T13:00:00Z",
          ticket_status: "approved",
          technician_ldap_id: "sql-approved",
        }),
      ],
      bounds,
    );

    expect(metrics).toMatchObject({
      submissions: 2,
      approved: 1,
      other: 1,
      avgReviewMinutes: null,
      medianReviewMinutes: null,
    });
  });

  it("keeps ET wall-clock boundaries across the fall DST transition", () => {
    const cutoff = "2026-11-01T18:00:00.000Z"; // Sunday, 1 PM EST
    const bounds = getExecSummaryWindow(cutoff);

    expect(bounds.weekStart.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    expect(bounds.weekEndExclusive.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(bounds.priorCutoff.toISOString()).toBe("2026-10-25T17:00:00.000Z");
    expect(bounds.weekEndExclusive.getTime() - bounds.weekStart.getTime()).toBe(
      169 * 60 * 60 * 1000,
    );
    expect(previousSameLocalWeekdayTime(cutoff).toISOString()).toBe("2026-10-25T17:00:00.000Z");

    const metrics = buildExecSummaryMetrics(
      [
        row(60, {
          createdAt: "2026-11-01T17:59:59.000Z",
          status: "completed",
          technicianLdapId: "fall-current",
        }),
        row(61, {
          createdAt: "2026-10-25T16:59:59.000Z",
          status: "rejected",
          technicianLdapId: "fall-prior",
        }),
      ],
      bounds,
    );

    expect(metrics.daily[6]).toMatchObject({
      date: "2026-11-01",
      submissions: 1,
      approved: 1,
      partial: true,
    });
    expect(metrics.prior).toMatchObject({ submissions: 1, rejected: 1 });
  });
});

describe("weekly executive summary renderers", () => {
  let renderExecSummaryText: typeof import("../server/services/weekly-exec-summary").renderExecSummaryText;
  let renderExecSummaryHtml: typeof import("../server/services/weekly-exec-summary").renderExecSummaryHtml;

  beforeAll(async () => {
    // This is intentionally after the vi.mock declarations above.
    const service = await import("../server/services/weekly-exec-summary");
    renderExecSummaryText = service.renderExecSummaryText;
    renderExecSummaryHtml = service.renderExecSummaryHtml;
  });

  it("labels WTD and full-week reports, and explains current-outcome comparison", () => {
    const wtd = buildExecSummaryMetrics(
      [
        row(70, { createdAt: "2026-09-07T12:00:00Z", status: "completed", technicianLdapId: "wtd-current" }),
        row(71, { createdAt: "2026-09-02T12:00:00Z", status: "rejected", technicianLdapId: "wtd-prior" }),
      ],
      getExecSummaryWindow(WTD_CUTOFF),
    );
    const fullWeek = buildExecSummaryMetrics(
      [
        row(72, { createdAt: "2026-09-01T12:00:00Z", status: "completed", technicianLdapId: "full-current" }),
        row(73, { createdAt: "2026-08-25T12:00:00Z", status: "rejected", technicianLdapId: "full-prior" }),
      ],
      getExecSummaryWindow(WTD_CUTOFF, { mode: "full_week", weekStart: "2026-08-31" }),
    );

    const wtdText = renderExecSummaryText(wtd);
    const fullText = renderExecSummaryText(fullWeek);
    const fullHtml = renderExecSummaryHtml(fullWeek);

    expect(wtdText).toContain("Week-to-date:");
    expect(wtdText).toContain("Completed (approved)");
    expect(wtdText).toContain("Comparison uses current outcomes (not historical snapshot).");
    expect(wtdText).toContain("so far this week.");

    expect(fullText).toContain("Full week:");
    expect(fullText).toContain("during the reported week.");
    expect(fullText).toContain("This report covers a full seven-day submission cohort");
    expect(fullText).not.toContain("so far this week");
    expect(fullHtml).toContain("Completed (approved)");
    expect(fullHtml).toContain("during the reported week");
    expect(fullHtml).not.toContain("so far this week");
    expect(rendererMocks.dbExecute).not.toHaveBeenCalled();
  });
});