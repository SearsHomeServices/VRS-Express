// Tyler 2026-04-30: Multi-video support without DB schema change.
//
// Tyler's hard rule is no DB schema changes. The submissions table has a
// single `video_url varchar(500)` column today. To support up to 3 videos
// per ticket we reuse the same trick the `photos` field already uses
// (text column holding a JSON-encoded array). 3 object-storage paths
// JSON-encoded fits easily in 500 chars (each path ~50–60 chars, brackets
// and quotes ~10 chars overhead).
//
// Reads stay backward-compatible: legacy rows that contain a single URL
// (no JSON) parse into a single-element array. Anything that fails to
// JSON-parse is treated as a legacy single URL string.

export const MAX_VIDEOS_PER_TICKET = 3;

export function parseVideoUrls(value: string | null | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
      }
    } catch {
      // fall through to legacy single-URL handling below
    }
  }
  return [trimmed];
}

export function serializeVideoUrls(urls: string[]): string | null {
  const cleaned = urls.filter((u) => typeof u === "string" && u.trim().length > 0);
  if (cleaned.length === 0) return null;
  return JSON.stringify(cleaned);
}
