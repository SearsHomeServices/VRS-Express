// Tyler 2026-04-30: This file used to hold the implementation. The logic
// has moved to `@shared/business-hours` so the server's analytics
// aggregations can use the exact same business-hours math (no drift).
// Existing client imports from `@/lib/business-hours` continue to work via
// these re-exports.
//
// Tyler 2026-05-01: Added `useBusinessHoursConfig` and friends so the
// dashboards can pick up the admin-configured per-category windows. The
// query hits `/api/business-hours` (open to any authenticated user) and
// caches in TanStack Query — falls back to DEFAULT_BUSINESS_HOURS_CONFIG
// while the request is in flight so the UI never flickers between
// "hardcoded" and "configured" values.

import { useQuery } from "@tanstack/react-query";
import {
  DEFAULT_BUSINESS_HOURS_CONFIG,
  type BusinessHoursConfig,
  type BusinessHoursProfile,
  categoryForApplianceType,
} from "@shared/business-hours";

export {
  VRS_OPEN_HOUR_ET,
  VRS_CLOSE_HOUR_ET,
  getBusinessElapsedMs,
  getBusinessElapsedFromNow,
  formatBusinessElapsed,
  isWithinBusinessHours,
  formatHoursLabel,
  categoryForApplianceType,
  DEFAULT_BUSINESS_HOURS_CONFIG,
  DEFAULT_PROFILE,
  DEFAULT_HVAC_PROFILE,
  type BusinessHoursConfig,
  type BusinessHoursProfile,
  type DayKey,
} from "@shared/business-hours";

export function useBusinessHoursConfig(): {
  config: BusinessHoursConfig;
  isLoading: boolean;
} {
  const q = useQuery<BusinessHoursConfig>({
    queryKey: ["/api/business-hours"],
    // The default fetcher (set up in lib/queryClient) already returns parsed
    // JSON for GET requests, so no queryFn needed here.
    staleTime: 60_000,
  });
  return {
    config: q.data ?? DEFAULT_BUSINESS_HOURS_CONFIG,
    isLoading: q.isLoading,
  };
}

export function useBusinessHoursProfile(applianceType?: string): BusinessHoursProfile {
  const { config } = useBusinessHoursConfig();
  return config[categoryForApplianceType(applianceType)];
}
