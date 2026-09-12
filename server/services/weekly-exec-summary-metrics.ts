/**
 * Pure metrics for the weekly executive summary.
 *
 * This module deliberately has no database, clock, or rendering dependency.
 * Keeping the window and aggregation rules here makes the report's numbers
 * fixture-testable and keeps all of the sections of a report on one cohort.
 */

export const EXEC_SUMMARY_TIME_ZONE = "America/New_York";

export type ExecSummaryMode = "wtd" | "full_week";
export type DateLike = Date | string | number;

export interface ExecSummaryWindow {
  mode: ExecSummaryMode;
  reportMode: ExecSummaryMode;
  weekStart: Date;
  /** Monday at 00:00 ET for the following week (exclusive). */
  weekEndExclusive: Date;
  /** The created-at cutoff for this report's cohort. */
  cutoff: Date;
  priorWeekStart: Date;
  priorWeekEndExclusive: Date;
  /** Previous week's equivalent local weekday/time. */
  priorCutoff: Date;
}

export interface ExecSummaryBounds {
  mode?: ExecSummaryMode;
  weekStart?: DateLike;
  /** Alias accepted for fixture callers that call the lower bound `start`. */
  start?: DateLike;
  weekEndExclusive?: DateLike;
  /** Alias accepted for callers that describe the end as `cohortEnd`. */
  cohortEnd?: DateLike;
  /** Alias accepted for callers that use `endExclusive`. */
  endExclusive?: DateLike;
  end?: DateLike;
  cutoff?: DateLike;
  cutoffAt?: DateLike;
  snapshotAt?: DateLike;
  priorWeekStart?: DateLike;
  priorWeekEndExclusive?: DateLike;
  priorCutoff?: DateLike;
}

/** The database-independent row shape used by the metrics builder. */
export interface ExecSummaryMetricRow {
  id?: number | string | null;
  createdAt?: DateLike | null;
  created_at?: DateLike | null;
  ticketStatus?: string | null;
  ticket_status?: string | null;
  /** `status` is accepted for small fixtures and older callers. */
  status?: string | null;
  reviewedAt?: DateLike | null;
  reviewed_at?: DateLike | null;
  technicianLdapId?: string | null;
  technician_ldap_id?: string | null;
  /** The LDAP value obtained by joining users.rac_id. */
  userLdapId?: string | null;
  user_ldap_id?: string | null;
  userRacId?: string | null;
  user_rac_id?: string | null;
  racId?: string | null;
  rac_id?: string | null;
  technicianId?: number | string | null;
  technician_id?: number | string | null;
  rejectionReasons?: unknown;
  rejection_reasons?: unknown;
}

export interface DailyVolumeRow {
  /** ET calendar date, YYYY-MM-DD. */
  date: string;
  label: string;
  /** null = the day has not happened yet ("Not yet included"). */
  submissions: number | null;
  approved: number | null;
  rejected: number | null;
  invalid: number | null;
  pending: number | null;
  other: number | null;
  /** True for the day the snapshot was taken on: the day is incomplete. */
  partial: boolean;
}

export interface ExecSummaryMetadata {
  mode: ExecSummaryMode;
  reportMode: ExecSummaryMode;
  cutoffAt: string;
  comparisonBasis: string;
}

export interface ExecSummaryPriorMetrics {
  submissions: number;
  approved: number;
  rejected: number;
  invalid: number;
  pending: number;
  other: number;
  approvalRate: number | null;
  invalidRate: number | null;
  avgReviewMinutes: number | null;
  medianReviewMinutes: number | null;
}

export interface ExecSummaryMetrics {
  metadata: ExecSummaryMetadata;
  weekStart: string;
  weekEnd: string;
  snapshotAt: string;
  /** The exact cutoff used to select the current cohort. */
  cutoffAt: string;
  mode: ExecSummaryMode;
  latestSubmissionAt: string | null;
  submissions: number;
  uniqueTechnicians: number;
  approved: number;
  rejected: number;
  invalid: number;
  pending: number;
  other: number;
  approvalRate: number | null;
  invalidRate: number | null;
  resolvedRate: number | null;
  avgReviewMinutes: number | null;
  medianReviewMinutes: number | null;
  daily: DailyVolumeRow[];
  /** Previous created cohort, with outcomes as they are now. */
  prior: ExecSummaryPriorMetrics;
  topRejectionReasons: Array<{ reason: string; count: number }>;
}

export type ExecSummaryData = ExecSummaryMetrics;

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function zonedParts(value: Date): LocalDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: EXEC_SUMMARY_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(value).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    millisecond: value.getUTCMilliseconds(),
  };
}

/**
 * Convert local ET wall-clock parts to an instant without relying on the
 * machine's local timezone. The small correction loop also handles DST
 * transitions (all report boundaries are at midnight, but comparison cutoffs
 * can be at any wall-clock time).
 */
function fromZonedParts(parts: LocalDateParts): Date {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let guess = desired;
  for (let i = 0; i < 5; i += 1) {
    const actualParts = zonedParts(new Date(guess));
    const actual = Date.UTC(
      actualParts.year,
      actualParts.month - 1,
      actualParts.day,
      actualParts.hour,
      actualParts.minute,
      actualParts.second,
      actualParts.millisecond,
    );
    const correction = desired - actual;
    guess += correction;
    if (correction === 0) break;
  }
  return new Date(guess);
}

function dateKey(parts: Pick<LocalDateParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function dateKeyParts(key: string): Pick<LocalDateParts, "year" | "month" | "day"> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new Error(`Invalid ET date: ${key}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function addLocalDays(key: string, days: number): string {
  const parts = dateKeyParts(key);
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12));
  return dateKey({ year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() });
}

function etMidnight(key: string): Date {
  const parts = dateKeyParts(key);
  return fromZonedParts({ ...parts, hour: 0, minute: 0, second: 0, millisecond: 0 });
}

function mondayForDate(key: string): string {
  const parts = dateKeyParts(key);
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return addLocalDays(key, -((weekday + 6) % 7));
}

function parseDate(value: DateLike | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    try {
      return etMidnight(value);
    } catch {
      return null;
    }
  }
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function localDateFor(value: Date): string {
  return dateKey(zonedParts(value));
}

/**
 * The previous comparable cutoff preserves ET weekday and wall-clock time,
 * rather than subtracting 7 * 24 hours (which is wrong across DST).
 */
export function previousSameLocalWeekdayTime(value: DateLike): Date {
  const date = parseDate(value);
  if (!date) throw new Error("Invalid date for previousSameLocalWeekdayTime");
  const parts = zonedParts(date);
  const previousDate = dateKeyParts(addLocalDays(dateKey(parts), -7));
  return fromZonedParts({ ...previousDate, hour: parts.hour, minute: parts.minute, second: parts.second, millisecond: parts.millisecond });
}

function asMode(value: ExecSummaryMode | undefined): ExecSummaryMode {
  return value === "full_week" ? "full_week" : "wtd";
}

function explicitWeekStart(value: DateLike | undefined, now: Date): string {
  if (value != null) {
    const parsed = parseDate(value);
    if (!parsed) throw new Error("Invalid weekStart");
    return mondayForDate(localDateFor(parsed));
  }
  return mondayForDate(localDateFor(now));
}

/**
 * Return an ET week window. WTD ends at the one captured instant; full_week
 * ends at the following ET Monday exclusively. `weekStart` may anchor a
 * historical full-week report to any calendar date.
 */
export function getExecSummaryWindow(
  now: DateLike = new Date(),
  options: { mode?: ExecSummaryMode; reportMode?: ExecSummaryMode; weekStart?: DateLike } | ExecSummaryMode = "wtd",
): ExecSummaryWindow {
  const current = parseDate(now);
  if (!current) throw new Error("Invalid report time");
  const normalizedOptions = typeof options === "string" ? { mode: options } : options;
  const mode = asMode(normalizedOptions.mode ?? normalizedOptions.reportMode);
  const currentWeekStart = explicitWeekStart(undefined, current);
  // Without an explicit anchor, full_week means the last completed ET week;
  // callers can select another historical week with weekStart.
  const startKey =
    normalizedOptions.weekStart != null
      ? explicitWeekStart(normalizedOptions.weekStart, current)
      : mode === "full_week"
        ? addLocalDays(currentWeekStart, -7)
        : currentWeekStart;
  const endKey = addLocalDays(startKey, 7);
  const weekStart = etMidnight(startKey);
  const weekEndExclusive = etMidnight(endKey);
  if (mode === "full_week" && weekEndExclusive > current) {
    throw new Error("Full-week reports require a completed ET week");
  }
  const cutoff =
    mode === "full_week"
      ? weekEndExclusive
      : current.getTime() < weekStart.getTime()
        ? weekStart
        : current.getTime() > weekEndExclusive.getTime()
          ? weekEndExclusive
          : current;
  const priorStartKey = addLocalDays(startKey, -7);
  const priorWeekStart = etMidnight(priorStartKey);
  const priorWeekEndExclusive =
    mode === "full_week"
      ? weekStart
      : previousSameLocalWeekdayTime(cutoff);
  return {
    mode,
    reportMode: mode,
    weekStart,
    weekEndExclusive,
    cutoff,
    priorWeekStart,
    priorWeekEndExclusive,
    priorCutoff: previousSameLocalWeekdayTime(cutoff),
  };
}

function normalizedBounds(input: ExecSummaryBounds): Required<
  Pick<ExecSummaryBounds, "mode" | "weekStart" | "weekEndExclusive" | "cutoff" | "snapshotAt" | "priorWeekStart" | "priorWeekEndExclusive" | "priorCutoff">
> & { weekStart: Date; weekEndExclusive: Date; cutoff: Date; snapshotAt: Date; priorWeekStart: Date; priorWeekEndExclusive: Date; priorCutoff: Date } {
  const mode = asMode(input.mode);
  const weekStart = parseDate(input.weekStart ?? input.start);
  if (!weekStart) throw new Error("Invalid metrics weekStart");
  const weekStartKey = mondayForDate(localDateFor(weekStart));
  const canonicalStart = etMidnight(weekStartKey);
  const weekEndExclusive =
    parseDate(input.weekEndExclusive ?? input.cohortEnd ?? input.endExclusive ?? input.end) ??
    etMidnight(addLocalDays(weekStartKey, 7));
  const cutoff = parseDate(input.cutoff ?? input.cutoffAt) ?? weekEndExclusive;
  const snapshotAt = parseDate(input.snapshotAt) ?? cutoff;
  const priorWeekStart =
    parseDate(input.priorWeekStart) ?? etMidnight(addLocalDays(weekStartKey, -7));
  const priorWeekEndExclusive =
    parseDate(input.priorWeekEndExclusive) ??
    (mode === "full_week" ? canonicalStart : previousSameLocalWeekdayTime(cutoff));
  const priorCutoff = parseDate(input.priorCutoff) ?? previousSameLocalWeekdayTime(cutoff);
  return {
    mode,
    weekStart: canonicalStart,
    weekEndExclusive,
    cutoff,
    snapshotAt,
    priorWeekStart,
    priorWeekEndExclusive,
    priorCutoff,
  } as ReturnType<typeof normalizedBounds>;
}

function firstField<T>(row: ExecSummaryMetricRow, ...names: string[]): T | null {
  for (const name of names) {
    const value = (row as Record<string, unknown>)[name];
    if (value != null) return value as T;
  }
  return null;
}

function rowCreatedAt(row: ExecSummaryMetricRow): Date | null {
  return parseDate(firstField<DateLike>(row, "createdAt", "created_at"));
}

function statusOf(row: ExecSummaryMetricRow): "approved" | "rejected" | "invalid" | "pending" | "other" {
  const raw = firstField<string>(row, "ticketStatus", "ticket_status", "status");
  const status = String(raw ?? "").trim().toLowerCase();
  if (status === "completed") return "approved";
  if (status === "rejected" || status === "rejected_closed") return "rejected";
  if (status === "invalid") return "invalid";
  if (status === "pending" || status === "queued") return "pending";
  return "other";
}

function technicianKey(row: ExecSummaryMetricRow): string {
  const direct = firstField<string>(
    row,
    "technicianLdapId",
    "technician_ldap_id",
  );
  const userLdap = firstField<string>(
    row,
    "userLdapId",
    "user_ldap_id",
    "userRacId",
    "user_rac_id",
    "racId",
    "rac_id",
  );
  const normalizedDirect = String(direct ?? "").trim().toLowerCase();
  if (normalizedDirect) return normalizedDirect;
  const normalizedUser = String(userLdap ?? "").trim().toLowerCase();
  if (normalizedUser) return normalizedUser;
  const userId = firstField<number | string>(row, "technicianId", "technician_id");
  const rowId = firstField<number | string>(row, "id");
  return `user:${String(userId ?? rowId ?? "unknown").trim().toLowerCase()}`;
}

function reviewMinutes(row: ExecSummaryMetricRow): number | null {
  const created = rowCreatedAt(row);
  const reviewed = parseDate(firstField<DateLike>(row, "reviewedAt", "reviewed_at"));
  if (!created || !reviewed) return null;
  const duration = (reviewed.getTime() - created.getTime()) / 60000;
  if (!Number.isFinite(duration) || duration < 0) return null;
  return duration;
}

function roundedMinutes(value: number | null): number | null {
  return value == null ? null : Math.round(value * 10) / 10;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return roundedMinutes(
    sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
  );
}

function rate(numerator: number, denominator: number): number | null {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function parseReasons(value: unknown): string[] {
  if (value == null) return [];
  let parsed: unknown = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((reason): reason is string => typeof reason === "string")
    .map((reason) => reason.trim())
    .filter(Boolean);
}

interface CountedMetrics extends ExecSummaryPriorMetrics {
  durations: number[];
  latestSubmissionAt: Date | null;
  uniqueTechnicians: Set<string>;
}

function counted(rows: ExecSummaryMetricRow[]): CountedMetrics {
  const counts: CountedMetrics = {
    submissions: rows.length,
    approved: 0,
    rejected: 0,
    invalid: 0,
    pending: 0,
    other: 0,
    approvalRate: null,
    invalidRate: null,
    avgReviewMinutes: null,
    medianReviewMinutes: null,
    durations: [] as number[],
    latestSubmissionAt: null as Date | null,
    uniqueTechnicians: new Set<string>(),
  };
  for (const row of rows) {
    const status = statusOf(row);
    counts[status] += 1;
    counts.uniqueTechnicians.add(technicianKey(row));
    const created = rowCreatedAt(row);
    if (created && (!counts.latestSubmissionAt || created > counts.latestSubmissionAt)) {
      counts.latestSubmissionAt = created;
    }
    const duration = reviewMinutes(row);
    if (duration != null) counts.durations.push(duration);
  }
  const decided = counts.approved + counts.rejected;
  counts.approvalRate = rate(counts.approved, decided);
  counts.invalidRate = rate(counts.invalid, counts.submissions);
  counts.avgReviewMinutes = roundedMinutes(
    counts.durations.length
      ? counts.durations.reduce((sum, value) => sum + value, 0) / counts.durations.length
      : null,
  );
  counts.medianReviewMinutes = median(counts.durations);
  return counts;
}

function labelForDate(key: string): string {
  const date = etMidnight(key);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EXEC_SUMMARY_TIME_ZONE,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(date).replace(/\s+/g, " ").trim();
}

function rowInRange(row: ExecSummaryMetricRow, start: Date, end: Date): boolean {
  const created = rowCreatedAt(row);
  return Boolean(created && created.getTime() >= start.getTime() && created.getTime() < end.getTime());
}

/**
 * Build a report from rows already selected by the caller. Rows may include
 * both the current and prior created cohorts; all status values are evaluated
 * as supplied (the prior cohort is never reconstructed as a historical
 * snapshot).
 */
export function buildExecSummaryMetrics(
  rows: readonly ExecSummaryMetricRow[],
  inputBounds: ExecSummaryBounds,
): ExecSummaryMetrics {
  const bounds = normalizedBounds(inputBounds);
  const currentRows = rows.filter((row) => rowInRange(row, bounds.weekStart, bounds.cutoff));
  const priorRows = rows.filter((row) =>
    rowInRange(row, bounds.priorWeekStart, bounds.priorWeekEndExclusive),
  );
  const current = counted(currentRows);
  const prior = counted(priorRows);
  const currentDate = localDateFor(bounds.cutoff);
  const days: DailyVolumeRow[] = [];
  const weekStartKey = localDateFor(bounds.weekStart);
  for (let day = 0; day < 7; day += 1) {
    const dayKey = addLocalDays(weekStartKey, day);
    const tomorrow = etMidnight(addLocalDays(dayKey, 1));
    const future = bounds.mode === "wtd" && dayKey > currentDate;
    const partial =
      bounds.mode === "wtd" &&
      dayKey === currentDate &&
      bounds.cutoff.getTime() < tomorrow.getTime();
    if (future) {
      days.push({
        date: dayKey,
        label: labelForDate(dayKey),
        submissions: null,
        approved: null,
        rejected: null,
        invalid: null,
        pending: null,
        other: null,
        partial: false,
      });
      continue;
    }
    const dayMetrics = counted(currentRows.filter((row) => {
      const created = rowCreatedAt(row);
      return Boolean(created && localDateFor(created) === dayKey);
    }));
    days.push({
      date: dayKey,
      label: labelForDate(dayKey),
      submissions: dayMetrics.submissions,
      approved: dayMetrics.approved,
      rejected: dayMetrics.rejected,
      invalid: dayMetrics.invalid,
      pending: dayMetrics.pending,
      other: dayMetrics.other,
      partial,
    });
  }

  const reasonCounts = new Map<string, number>();
  for (const row of currentRows) {
    if (statusOf(row) !== "rejected") continue;
    const rawReasons = firstField<unknown>(row, "rejectionReasons", "rejection_reasons");
    for (const reason of parseReasons(rawReasons)) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  const topRejectionReasons = Array.from(reasonCounts.entries())
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 5);

  const resolved = current.approved + current.rejected + current.invalid;
  return {
    metadata: {
      mode: bounds.mode,
      reportMode: bounds.mode,
      cutoffAt: bounds.cutoff.toISOString(),
      comparisonBasis: "current outcomes (not historical snapshot)",
    },
    weekStart: weekStartKey,
    weekEnd: addLocalDays(weekStartKey, 6),
    snapshotAt: bounds.snapshotAt.toISOString(),
    cutoffAt: bounds.cutoff.toISOString(),
    mode: bounds.mode,
    latestSubmissionAt: current.latestSubmissionAt?.toISOString() ?? null,
    submissions: current.submissions,
    uniqueTechnicians: current.uniqueTechnicians.size,
    approved: current.approved,
    rejected: current.rejected,
    invalid: current.invalid,
    pending: current.pending,
    other: current.other,
    approvalRate: current.approvalRate,
    invalidRate: current.invalidRate,
    resolvedRate: rate(resolved, current.submissions),
    avgReviewMinutes: current.avgReviewMinutes,
    medianReviewMinutes: current.medianReviewMinutes,
    daily: days,
    prior: {
      submissions: prior.submissions,
      approved: prior.approved,
      rejected: prior.rejected,
      invalid: prior.invalid,
      pending: prior.pending,
      other: prior.other,
      approvalRate: prior.approvalRate,
      invalidRate: prior.invalidRate,
      avgReviewMinutes: prior.avgReviewMinutes,
      medianReviewMinutes: prior.medianReviewMinutes,
    },
    topRejectionReasons,
  };
}

