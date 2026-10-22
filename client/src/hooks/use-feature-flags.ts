import { useQuery } from "@tanstack/react-query";

interface AppConfig {
  portal1099Enabled: boolean;
  techHubPhotosEnabled: boolean;
  vrsBridgePhotoProxyEnabled: boolean;
  vrsAiAppEnrollEnabled?: boolean;
  ahsServiceOrderPrefill?: boolean;
  ahsHssomCustomerPrefill?: boolean;
}

// Runtime feature flags sourced from GET /api/config. Defaults to disabled
// while loading so feature-flagged UI never flashes before confirmation.
export function useAppConfig() {
  return useQuery<AppConfig>({
    queryKey: ["/api/config"],
    staleTime: 5 * 60 * 1000,
  });
}

export function usePortal1099Enabled(): boolean {
  const { data } = useAppConfig();
  return data?.portal1099Enabled ?? false;
}

export function useVrsBridgePhotoProxyEnabled(): boolean {
  const { data } = useAppConfig();
  return data?.vrsBridgePhotoProxyEnabled ?? false;
}

// AHS details section on the tech submit/resubmit forms + VRS AI enrollment
// of those tickets (server VRS_AI_APP_ENROLL_ENABLED).
export function useVrsAiAppEnrollEnabled(): boolean {
  const { data } = useAppConfig();
  return data?.vrsAiAppEnrollEnabled ?? false;
}

// Every runtime flag, each false until /api/config confirms it.
export function useFeatureFlags() {
  const { data } = useAppConfig();
  return {
    portal1099Enabled: data?.portal1099Enabled ?? false,
    techHubPhotosEnabled: data?.techHubPhotosEnabled ?? false,
    vrsBridgePhotoProxyEnabled: data?.vrsBridgePhotoProxyEnabled ?? false,
    vrsAiAppEnrollEnabled: data?.vrsAiAppEnrollEnabled ?? false,
    // AHS form reads brand/model/serial from GET /api/tech/ahs-prefill
    // (server AHS_SERVICE_ORDER_PREFILL_ENABLED).
    ahsServiceOrderPrefill: data?.ahsServiceOrderPrefill ?? false,
    // Customer name/address from the HSSOM Order Lookup, filled on the
    // server only (server AHS_HSSOM_CUSTOMER_PREFILL_ENABLED).
    ahsHssomCustomerPrefill: data?.ahsHssomCustomerPrefill ?? false,
  };
}
