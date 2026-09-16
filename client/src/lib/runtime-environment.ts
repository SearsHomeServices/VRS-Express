/**
 * The server injects this marker into the HTML shell from its actual
 * NODE_ENV.  It intentionally does not use import.meta.env/Vite build mode,
 * because one built client can be served by more than one runtime. The
 * production static shell intentionally does not inject the marker; an absent
 * marker is therefore disabled by default.
 */
export function isDevelopmentRuntime(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.dataset.vrsRuntimeEnvironment === "development";
}