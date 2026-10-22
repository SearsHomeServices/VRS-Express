import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UseFormReturn } from "react-hook-form";
import { apiRequest } from "@/lib/queryClient";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import type { AhsPrefillResponse } from "@shared/ahs-prefill";
import {
  ahsPrefillUpdates,
  normalizeAhsPrefillResponse,
  splitAhsServiceOrder,
  type AhsPrefillApplianceValues,
} from "@/components/ahs-details-fields";

// Server flags for the AHS service-order prefill (GET /api/config
// `ahsServiceOrderPrefill` for Snowflake, `ahsHssomCustomerPrefill` for the
// HSSOM customer lookup; either one turns the lookup on). Off unless the
// server says exactly true, so an older server keeps the manual-entry form.
export function useAhsServiceOrderPrefillEnabled(): boolean {
  const flags = useFeatureFlags();
  return flags.ahsServiceOrderPrefill === true || flags.ahsHssomCustomerPrefill === true;
}

// Looks up the service order and fills brand, model and serial into the AHS
// section (only blanks, or values an earlier lookup filled). Returns the
// latest response for the card's hints, or null while off or loading. Any
// failure is reported as "unavailable": the form keeps working with manual
// entry and submission is never blocked.
export function useAhsServiceOrderPrefill(
  form: UseFormReturn<any>,
  options: { enabled: boolean; serviceOrder: string | null | undefined },
): AhsPrefillResponse | null {
  const parts = splitAhsServiceOrder(options.serviceOrder);
  const enabled = options.enabled && parts !== null;
  const query = useQuery<AhsPrefillResponse>({
    queryKey: ["/api/tech/ahs-prefill", parts?.district, parts?.serviceOrder],
    queryFn: async () => {
      try {
        const params = new URLSearchParams({
          district: parts!.district,
          serviceOrder: parts!.serviceOrder,
        });
        const res = await apiRequest("GET", `/api/tech/ahs-prefill?${params.toString()}`);
        return normalizeAhsPrefillResponse(await res.json());
      } catch {
        return { status: "unavailable" };
      }
    },
    enabled,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
  const prefill = enabled ? query.data ?? null : null;

  const filledRef = useRef<AhsPrefillApplianceValues>({});
  useEffect(() => {
    if (!prefill) return;
    const current = form.getValues("ahsDetails");
    if (!current) return;
    // not_found / unavailable still clear values a previous lookup filled.
    const appliance = prefill.status === "found" ? prefill.appliance : {};
    const updates = ahsPrefillUpdates(current, appliance, filledRef.current);
    for (const [field, value] of Object.entries(updates)) {
      form.setValue(`ahsDetails.${field}`, value, { shouldDirty: true });
    }
    filledRef.current = { ...filledRef.current, ...updates };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, Boolean(form.watch("ahsDetails"))]);

  return prefill;
}
