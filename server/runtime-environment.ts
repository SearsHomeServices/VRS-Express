/**
 * Development marker for client-only environment gates. Keeping it in the
 * Vite-served HTML avoids adding an API field or coupling unrelated UI to a
 * photo proxy flag, while still deriving the value from the server process.
 * Production static serving intentionally keeps the marker absent.
 */
export function injectRuntimeEnvironmentMarker(html: string): string {
  const runtime = process.env.NODE_ENV === "development" ? "development" : "production";
  return html.replace(
    /<html(\s[^>]*)?>/i,
    (openingTag) => openingTag.replace(
      /^<html/i,
      `<html data-vrs-runtime-environment="${runtime}"`,
    ),
  );
}