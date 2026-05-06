// =============================================================================
// Draft identity validation — Tier 1 hotfix (2026-04-28)
// =============================================================================
// Drafts persisted to localStorage by `tech-submit.tsx` were not stamped
// with the saving user's identity. Combined with the fact that `logout()`
// did not remove the draft entry, that allowed a draft saved by one
// technician to be loaded under a different technician's session whenever
// the two ended up sharing client storage (the underlying inheritance
// mechanism is still under investigation — district-pool theory was ruled
// out by Tyler 2026-04-28).
//
// This module is the mechanism-agnostic defense: every saved draft now
// carries an `identity` field, and load-time validation refuses to hydrate
// any draft whose identity does not match the current authenticated user
// (or that pre-dates the identity stamp at all).
// =============================================================================

export interface DraftIdentity {
  userId: number;
  ldapId: string | null;
}

export interface DraftEnvelope {
  identity?: DraftIdentity;
  [k: string]: unknown;
}

export interface CurrentUser {
  id: number;
  ldapId: string | null;
}

export type DraftValidation =
  | { ok: true; draft: DraftEnvelope }
  | {
      ok: false;
      reason:
        | "no_draft"
        | "parse_error"
        | "missing_identity"
        | "id_mismatch"
        | "ldap_mismatch";
    };

export function parseAndValidateDraft(
  raw: string | null,
  current: CurrentUser,
): DraftValidation {
  if (!raw) return { ok: false, reason: "no_draft" };
  let parsed: DraftEnvelope;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "parse_error" };
  }
  if (
    !parsed.identity ||
    typeof parsed.identity !== "object" ||
    typeof parsed.identity.userId !== "number"
  ) {
    return { ok: false, reason: "missing_identity" };
  }
  if (parsed.identity.userId !== current.id) {
    return { ok: false, reason: "id_mismatch" };
  }
  // Enforce ldap match only when the current user has a non-null ldap.
  // (Tech users always do; admin/agent users may not.)
  if (current.ldapId != null && parsed.identity.ldapId !== current.ldapId) {
    return { ok: false, reason: "ldap_mismatch" };
  }
  return { ok: true, draft: parsed };
}

export function stampDraftIdentity<T extends Record<string, unknown>>(
  body: T,
  current: CurrentUser,
): T & { identity: DraftIdentity } {
  return {
    ...body,
    identity: { userId: current.id, ldapId: current.ldapId },
  };
}

/**
 * Removes every `vrs_tech_submit_draft_v1_*` key from the given storage.
 * Called from `logout()` so a session that's about to be replaced cannot
 * leave its draft behind for the next person to log in on the same client.
 */
export function clearAllTechSubmitDrafts(storage: Storage): number {
  const keysToRemove: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k && k.startsWith("vrs_tech_submit_draft_v1_")) {
      keysToRemove.push(k);
    }
  }
  for (const k of keysToRemove) {
    try {
      storage.removeItem(k);
    } catch {
      /* swallow — removal failure should not block logout */
    }
  }
  return keysToRemove.length;
}
