// Tyler 2026-04-30: This file used to hold the implementation. The logic
// has moved to `@shared/business-hours` so the server's analytics
// aggregations can use the exact same business-hours math (no drift).
// Existing client imports from `@/lib/business-hours` continue to work via
// these re-exports.

export {
  VRS_OPEN_HOUR_ET,
  VRS_CLOSE_HOUR_ET,
  getBusinessElapsedMs,
  getBusinessElapsedFromNow,
  formatBusinessElapsed,
  isWithinBusinessHours,
} from "@shared/business-hours";
