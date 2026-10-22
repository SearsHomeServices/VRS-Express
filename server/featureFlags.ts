// Feature flags for environment-gated functionality.
//
// 1099 Provider Portal: default ON in development, OFF in production. To enable
// the portal in production, set the `ENABLE_1099_PORTAL` env var to "true" in
// the production environment and republish. Set it to "false" to force it off
// anywhere (including dev).
export function is1099PortalEnabled(): boolean {
  const v = process.env.ENABLE_1099_PORTAL;
  if (v === "true") return true;
  if (v === "false") return false;
  return process.env.NODE_ENV !== "production";
}

// TechHub parts photos (read-only Snowflake lookup + CDN proxy). Default OFF
// everywhere — the feature depends on production Snowflake credentials and an
// external CDN (parts-images-pr-us-east-2 / d1kq8vno1fudyz.cloudfront.net) that
// are only present/reachable in the deployed environment.
//
// TEMPORARILY FORCE-DISABLED: the feature is hidden across the whole app while
// the photo-source / network-access question is being worked out. This hard
// `return false` overrides the env var so it stays off even if
// `ENABLE_TECHHUB_PHOTOS=true` is still set in production. To re-enable, restore
// the original body (`return process.env.ENABLE_TECHHUB_PHOTOS === "true";`) and
// republish with `ENABLE_TECHHUB_PHOTOS=true`.
export function isTechHubPhotosEnabled(): boolean {
  return false;
}

// SHSAI Bridge photo proxy (dev and production). This intentionally has no
// environment fallback: missing, whitespace, malformed, or false values all
// remain off. Source hosts are limited to the two Sasha hosts in
// vrs-bridge-photo-proxy.ts, and ticket access checks still apply.
export function isVrsBridgePhotoProxyEnabled(): boolean {
  return process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED === "true";
}

// Technician-submitted AHS authorization tickets → VRS AI bridge enrollment
// (server/vrs-app-enroll.ts). Default OFF everywhere; only the exact value
// "true" enables it. When on, each new queued AHS authorization ticket from
// the app gets a vrs_ai_calls row at creation, so it moves to the VRS AI
// Pilot view and Stage 1 approval sends it to VRS AI. Also shows the AHS
// details section (shared/ahs-details.ts) on the tech submit/resubmit forms;
// tickets without those details are never enrolled.
export function isVrsAiAppEnrollEnabled(): boolean {
  return process.env.VRS_AI_APP_ENROLL_ENABLED === "true";
}

// AHS service-order prefill (server/ahs-prefill.ts). Default OFF everywhere;
// only the exact value "true" enables it. When on, GET /api/tech/ahs-prefill
// returns brand/model/serial for the tech form, and POST /api/submissions
// fills blank AHS dispatch number/brand/model/serial from Snowflake
// (IH_SERVICEORDER_FULLDETAIL_TBL) before the ticket is stored. Check the
// unverified column names in server/services/snowflake-lookup.ts first.
export function isAhsServiceOrderPrefillEnabled(): boolean {
  return process.env.AHS_SERVICE_ORDER_PREFILL_ENABLED === "true";
}
