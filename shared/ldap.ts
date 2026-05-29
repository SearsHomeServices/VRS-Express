/**
 * Normalize an LDAP ID submitted from a (mobile) keyboard so that brittle
 * exact-string lookups still match.
 *
 * Handles realistic input mishaps:
 * - leading/trailing whitespace from a mobile keyboard
 * - non-breaking spaces and other unicode spaces
 * - zero-width characters (zero-width space/joiner, BOM)
 * - a stray trailing period or other punctuation added by autocorrect
 * - inconsistent casing
 *
 * It intentionally does NOT change what counts as a valid ID — a valid LDAP ID
 * is alphanumeric starting with a letter, and normalization only removes noise
 * around/within that value.
 */
export function normalizeLdapId(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/[^a-zA-Z0-9]+$/, "")
    .toLowerCase();
}
