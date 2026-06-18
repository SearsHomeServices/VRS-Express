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
// are only present/reachable in the deployed environment. Set the
// `ENABLE_TECHHUB_PHOTOS` env var to "true" in production and republish to turn
// it on. Keeping it explicit-opt-in avoids dev showing a permanently-empty
// section (dev has no Snowflake creds).
export function isTechHubPhotosEnabled(): boolean {
  return process.env.ENABLE_TECHHUB_PHOTOS === "true";
}
