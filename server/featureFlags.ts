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
