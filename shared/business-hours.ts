// Tyler 2026-04-29: VRS business-hours timer utility.
//
// VRS hours are configurable per-category (default + HVAC) via the admin
// panel. This module exposes the elapsed-time math; the actual profile
// values live in `system_settings.vrs_business_hours` and are loaded by
// `server/business-hours-config.ts` on the server. Clients fetch the
// config via `GET /api/business-hours` and pass the profile in.
//
// Tyler asked that ticket timers (queue wait, handle time, total time,
// agent-queue elapsed, urgency highlights) NOT accumulate during
// after-hours windows so a ticket submitted at 9 PM doesn't show "11h"
// in the queue at 8 AM the next morning.
//
// 2026-05-01 — switched from hardcoded 8-20 ET (7 days) to a profile
// argument. Default profile (`DEFAULT_PROFILE` below) preserves the
// pre-refactor behavior so any caller that omits `profile` keeps working.
//
// All elapsed timers across the app should route through `getBusinessElapsedMs`
// instead of subtracting two timestamps directly. The algorithm walks the ET
// calendar day by day and sums the overlap of [start, end] with each day's
// [open, close] window. DST transitions are handled by computing each day's
// open/close as a real wall-clock time in `America/New_York`. Days NOT in
// `profile.openDays` contribute zero.
//
// All `Date` values in the codebase are stored as ISO strings or JS Date
// objects in UTC. The conversions below are all wall-clock <-> UTC via the
// `Intl.DateTimeFormat` `America/New_York` zone — no third-party tz lib
// needed (date-fns / luxon would work too, but adding deps requires Tyler's
// approval per package.json hard rule).

const VRS_TIMEZONE = "America/New_York";

// Day-of-week keys used in profile.openDays. Order matches JS getDay() with
// Mon=1 ... Sun=0; we index via DAY_KEYS[Date.getUTCDay()] AFTER converting
// to ET wall clock.
export type DayKey = "Sun" | "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat";
export const ALL_DAYS: DayKey[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Display labels (kept here so the admin UI and any future server-rendered
// surface — email, audit trail — agree on the spelling).
export const DAY_LABELS: Record<DayKey, string> = {
  Sun: "Sun",
  Mon: "Mon",
  Tue: "Tue",
  Wed: "Wed",
  Thu: "Thu",
  Fri: "Fri",
  Sat: "Sat",
};

export interface BusinessHoursProfile {
  open: string;     // "HH:MM" 24-hour, ET
  close: string;    // "HH:MM" 24-hour, ET (exclusive)
  openDays: DayKey[];
}

export interface BusinessHoursConfig {
  default: BusinessHoursProfile;
  hvac: BusinessHoursProfile;
}

// Compile-time defaults — used when no profile is passed AND when system_settings
// has no row yet. Mon-Sat 8a-8p (default) / Mon-Fri 8a-5:30p (HVAC) per Tyler.
export const DEFAULT_PROFILE: BusinessHoursProfile = {
  open: "08:00",
  close: "20:00",
  openDays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};

export const DEFAULT_HVAC_PROFILE: BusinessHoursProfile = {
  open: "08:00",
  close: "17:30",
  openDays: ["Mon", "Tue", "Wed", "Thu", "Fri"],
};

export const DEFAULT_BUSINESS_HOURS_CONFIG: BusinessHoursConfig = {
  default: DEFAULT_PROFILE,
  hvac: DEFAULT_HVAC_PROFILE,
};

// Architect-flagged perf: cache the `Intl.DateTimeFormat` instances at module
// scope. The admin tickets table can render hundreds of rows × multiple
// timer columns × per-render — without caching, each render constructed
// thousands of formatter objects and put real GC pressure on long sessions.
const ET_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: VRS_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
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

function getEtCalendarParts(d: Date): { year: number; month: number; day: number; weekday: DayKey } {
  const parts = ET_DATE_FMT.formatToParts(d);
  const obj: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  return {
    year: Number(obj.year),
    month: Number(obj.month),
    day: Number(obj.day),
    weekday: (obj.weekday as DayKey),
  };
}

function getEtOffsetMs(d: Date): number {
  const parts = ET_DATETIME_FMT.formatToParts(d);
  const obj: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
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

// Build a real UTC Date that represents `hour:minute ET` on the given ET
// calendar date. Handles DST by computing the offset that ET would apply at
// that instant. `day` may overflow (e.g. day 32 of Apr) — Date.UTC normalizes.
function etWallTimeToUtc(year: number, month: number, day: number, hour: number, minute: number = 0): Date {
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  const probe = new Date(naiveUtcMs);
  const offsetMs = getEtOffsetMs(probe);
  return new Date(naiveUtcMs + offsetMs);
}

// "HH:MM" → { hour, minute }. Returns { hour: 0, minute: 0 } on parse failure
// (defensive — never throw in render path). Caller should validate input
// upstream (Zod) so this fallback never fires in practice.
function parseHHMM(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return { hour: 0, minute: 0 };
  return { hour: Math.min(23, Math.max(0, Number(m[1]))), minute: Math.min(59, Math.max(0, Number(m[2]))) };
}

// Sum the overlap (in ms) of [start, end] with each ET calendar day's
// [open, close] window for days listed in profile.openDays. Returns 0 if
// end <= start, no openDays match, or the entire range falls outside
// business hours.
export function getBusinessElapsedMs(
  start: Date,
  end: Date,
  profile: BusinessHoursProfile = DEFAULT_PROFILE,
): number {
  if (!(end instanceof Date) || !(start instanceof Date)) return 0;
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return 0;
  if (end.getTime() <= start.getTime()) return 0;

  const open = parseHHMM(profile.open);
  const close = parseHHMM(profile.close);
  const openDays = new Set(profile.openDays);

  let total = 0;
  let cursorMs = start.getTime();
  let safety = 0;
  while (cursorMs < end.getTime() && safety < 366) {
    const cursorDate = new Date(cursorMs);
    const { year, month, day, weekday } = getEtCalendarParts(cursorDate);

    if (openDays.has(weekday)) {
      const dayOpenMs = etWallTimeToUtc(year, month, day, open.hour, open.minute).getTime();
      const dayCloseMs = etWallTimeToUtc(year, month, day, close.hour, close.minute).getTime();
      const overlapStart = Math.max(start.getTime(), cursorMs, dayOpenMs);
      const overlapEnd = Math.min(end.getTime(), dayCloseMs);
      if (overlapEnd > overlapStart) {
        total += overlapEnd - overlapStart;
      }
    }

    const nextMidnightMs = etWallTimeToUtc(year, month, day + 1, 0, 0).getTime();
    if (nextMidnightMs <= cursorMs) break;
    cursorMs = nextMidnightMs;
    safety++;
  }
  return total;
}

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

// Returns true if the given UTC instant falls inside the profile's business
// window in ET (and the day is open). Used by callers that want to decorate
// live timers with a "paused" indicator while we're after hours.
export function isWithinBusinessHours(
  d: Date = new Date(),
  profile: BusinessHoursProfile = DEFAULT_PROFILE,
): boolean {
  const { year, month, day, weekday } = getEtCalendarParts(d);
  if (!profile.openDays.includes(weekday)) return false;
  const open = parseHHMM(profile.open);
  const close = parseHHMM(profile.close);
  const openMs = etWallTimeToUtc(year, month, day, open.hour, open.minute).getTime();
  const closeMs = etWallTimeToUtc(year, month, day, close.hour, close.minute).getTime();
  const t = d.getTime();
  return t >= openMs && t < closeMs;
}

// Format a profile as a human-readable label for SMS: "Mon–Sat 8am–8pm EST"
// or "Mon, Wed, Fri 8am–5:30pm EST". Always uses "EST" suffix per Tyler's
// preferred wording — DST-correct timezone is handled by the underlying
// Intl calls; "EST" here is the colloquial year-round shorthand techs use.
export function formatHoursLabel(profile: BusinessHoursProfile): string {
  return `${formatDayRange(profile.openDays)} ${formatTimeAmPm(profile.open)}–${formatTimeAmPm(profile.close)} EST`;
}

function formatDayRange(days: DayKey[]): string {
  if (days.length === 0) return "(no days)";
  if (days.length === 7) return "Daily";
  // Detect contiguous range starting from Mon. Most VRS configs are
  // Mon-Fri / Mon-Sat / Mon-Sun, so prioritize that pattern.
  const weekOrder: DayKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const set = new Set(days);
  // Find the longest contiguous run starting from Mon.
  let runEnd = -1;
  for (let i = 0; i < weekOrder.length; i++) {
    if (set.has(weekOrder[i])) runEnd = i; else break;
  }
  if (runEnd >= 0 && set.size === runEnd + 1) {
    if (runEnd === 0) return "Mon";
    return `Mon–${weekOrder[runEnd]}`;
  }
  // Fallback: comma-separated in calendar order.
  return weekOrder.filter((d) => set.has(d)).join(", ");
}

function formatTimeAmPm(hhmm: string): string {
  const { hour, minute } = parseHHMM(hhmm);
  const period = hour >= 12 ? "pm" : "am";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return minute === 0 ? `${h12}${period}` : `${h12}:${String(minute).padStart(2, "0")}${period}`;
}

// Used by the SMS gate (server) to determine which category's hours apply
// to a given submission. Lives here so client code can reuse the same
// mapping if needed (currently only the server uses it).
export function categoryForApplianceType(applianceType: string | null | undefined): "default" | "hvac" {
  return applianceType === "hvac" ? "hvac" : "default";
}

// Today's date as `YYYY-MM-DD` in America/New_York. Use this — not
// `toISOString().slice(0,10)` — anywhere we key a daily record by date
// (RGC codes, etc.). The UTC slice rolls over at 8 PM EDT / 7 PM EST,
// which made the daily RGC lookup miss after that point and surfaced as
// "No RGC code has been set for today" while agents were still working.
// VRS day boundary is ET midnight, the same anchor used by the business-
// hours timers above.
export function getEtDateString(d: Date = new Date()): string {
  const { year, month, day } = getEtCalendarParts(d);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
