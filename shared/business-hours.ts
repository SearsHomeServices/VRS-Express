// Tyler 2026-04-29: VRS business-hours timer utility.
//
// VRS hours are 8:00 AM to 8:00 PM Eastern Time. Tyler asked that ticket
// timers (queue wait, handle time, total time, agent-queue elapsed, urgency
// highlights) NOT accumulate during after-hours windows so a ticket
// submitted at 9 PM doesn't show "11h" in the queue at 8 AM the next
// morning.
//
// All elapsed timers across the app should route through `getBusinessElapsedMs`
// (this file) instead of subtracting two timestamps directly. The algorithm
// walks the ET calendar day by day and sums the overlap of [start, end] with
// each day's [VRS_OPEN_HOUR_ET, VRS_CLOSE_HOUR_ET] window. DST transitions
// are handled by computing each day's open/close as a real wall-clock time
// in `America/New_York`.
//
// IMPORTANT ASSUMPTIONS (call out for Tyler):
//   - 7 days a week. Weekends are NOT excluded. If VRS is closed Sat/Sun,
//     add a `WEEKEND_DAYS = new Set([0, 6])` short-circuit in the day loop
//     below — single-line edit.
//   - Holidays are NOT excluded. If VRS observes federal holidays, the
//     simplest add is a `HOLIDAYS: Set<string>` of `YYYY-MM-DD` ET strings
//     and a check in the day loop.
//
// All `Date` values in the codebase are stored as ISO strings or JS Date
// objects in UTC. The conversions below are all wall-clock <-> UTC via the
// `Intl.DateTimeFormat` `America/New_York` zone — no third-party tz lib
// needed (date-fns / luxon would work too, but adding deps requires Tyler's
// approval per package.json hard rule).

const VRS_TIMEZONE = "America/New_York";
export const VRS_OPEN_HOUR_ET = 8;   // 08:00 ET (inclusive)
export const VRS_CLOSE_HOUR_ET = 20; // 20:00 ET (exclusive)

// Architect-flagged perf: cache the `Intl.DateTimeFormat` instances at module
// scope. The admin tickets table can render hundreds of rows × multiple
// timer columns × per-render — without caching, each render constructed
// thousands of formatter objects and put real GC pressure on long sessions.
// The two formatters below are the only ones we ever need (date-only +
// date+time), and `timeZone` never changes.
const ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: VRS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ET_DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: VRS_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

// Returns the ET wall-clock {year, month, day} for the given UTC moment.
// Month is 1-12 (NOT zero-indexed) for readability — converted to 0-11 when
// constructing Dates below.
function getEtCalendarParts(d: Date): { year: number; month: number; day: number } {
  const parts = ET_DATE_FMT.formatToParts(d);
  const obj: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  return { year: Number(obj.year), month: Number(obj.month), day: Number(obj.day) };
}

// Returns the offset (in ms) that ET applies at the given UTC instant.
// Positive when ET is behind UTC (ET = UTC - 5h in EST, UTC - 4h in EDT).
// Computed by formatting the UTC instant as ET wall-clock, treating that
// wall-clock as if it were UTC, and subtracting.
function getEtOffsetMs(d: Date): number {
  const parts = ET_DATETIME_FMT.formatToParts(d);
  const obj: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  // Intl can report hour as "24" at midnight in some locales/runtimes — clamp.
  const hour = Number(obj.hour) === 24 ? 0 : Number(obj.hour);
  const etAsUtc = Date.UTC(
    Number(obj.year),
    Number(obj.month) - 1,
    Number(obj.day),
    hour,
    Number(obj.minute),
    Number(obj.second),
  );
  return d.getTime() - etAsUtc;
}

// Build a real UTC Date that represents `hour:00 ET` on the given ET
// calendar date. Handles DST by computing the offset that ET would apply at
// that instant. `day` may overflow (e.g. day 32 of Apr) — Date.UTC normalizes.
function etWallTimeToUtc(year: number, month: number, day: number, hour: number): Date {
  // First-pass UTC for the wall-clock components — wrong by ET's offset.
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, 0, 0);
  const probe = new Date(naiveUtcMs);
  // What's ET's offset at that probe? Add it back to align the wall clock.
  const offsetMs = getEtOffsetMs(probe);
  return new Date(naiveUtcMs + offsetMs);
}

// Sum the overlap (in ms) of [start, end] with each ET calendar day's
// [VRS_OPEN_HOUR_ET, VRS_CLOSE_HOUR_ET] window. Returns 0 if end <= start
// or the entire range falls outside business hours.
export function getBusinessElapsedMs(start: Date, end: Date): number {
  if (!(end instanceof Date) || !(start instanceof Date)) return 0;
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  if (end.getTime() <= start.getTime()) return 0;

  let total = 0;
  // Walk in ET calendar days. Cap iterations at 366 — ticket TAT shouldn't
  // exceed a year, and this prevents runaway loops on bad data.
  let cursorMs = start.getTime();
  let safety = 0;
  while (cursorMs < end.getTime() && safety < 366) {
    const cursorDate = new Date(cursorMs);
    const { year, month, day } = getEtCalendarParts(cursorDate);
    const dayOpenMs = etWallTimeToUtc(year, month, day, VRS_OPEN_HOUR_ET).getTime();
    const dayCloseMs = etWallTimeToUtc(year, month, day, VRS_CLOSE_HOUR_ET).getTime();

    const overlapStart = Math.max(start.getTime(), cursorMs, dayOpenMs);
    const overlapEnd = Math.min(end.getTime(), dayCloseMs);
    if (overlapEnd > overlapStart) {
      total += overlapEnd - overlapStart;
    }

    // Advance to next ET midnight. Date.UTC normalizes day overflow.
    const nextMidnightMs = etWallTimeToUtc(year, month, day + 1, 0).getTime();
    if (nextMidnightMs <= cursorMs) {
      // Pathological case (DST edge or bad clock) — bail to avoid infinite loop.
      break;
    }
    cursorMs = nextMidnightMs;
    safety++;
  }
  return total;
}

// Convenience: ms between an event and now, clipped to business hours.
export function getBusinessElapsedFromNow(start: Date): number {
  return getBusinessElapsedMs(start, new Date());
}

// Format a millisecond duration as "Xd Yh", "Xh Ym", "Xm", or "< 1m".
// Mirrors the formatting the existing `getTimeInStatus` used so column
// widths in the admin table don't shift.
export function formatBusinessElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return "< 1m";
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// Returns true if the given UTC instant falls inside the VRS business window
// in ET. Used by callers that want to decorate live timers with a "paused"
// indicator while we're after hours.
export function isWithinBusinessHours(d: Date = new Date()): boolean {
  const { year, month, day } = getEtCalendarParts(d);
  const openMs = etWallTimeToUtc(year, month, day, VRS_OPEN_HOUR_ET).getTime();
  const closeMs = etWallTimeToUtc(year, month, day, VRS_CLOSE_HOUR_ET).getTime();
  const t = d.getTime();
  return t >= openMs && t < closeMs;
}
