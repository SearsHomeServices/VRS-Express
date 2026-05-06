// =============================================================================
// Draft identity validation — Tier 1 hotfix regression harness (2026-04-28)
// =============================================================================
// Covers the pure helper module that gates draft hydration in tech-submit.tsx.
// The integration symptom this protects against: a draft saved by Hector
// Ramirez on 4/22 was being loaded into David Wiggins' session days later
// and David's submit was returning the 409 "already submitted" error from
// POST /api/submissions because the request was effectively being made
// under Hector's identity.
//
// These tests lock in the behavior of `parseAndValidateDraft`,
// `stampDraftIdentity`, and `clearAllTechSubmitDrafts` so any future edit
// that loosens identity checking causes a precise assertion failure rather
// than a silent regression.
// =============================================================================

import { describe, it, expect } from "vitest";
import {
  parseAndValidateDraft,
  stampDraftIdentity,
  clearAllTechSubmitDrafts,
} from "../client/src/lib/draft-identity";

const HECTOR = { id: 242, ldapId: "hramire" };
const DAVID = { id: 162, ldapId: "dwiggi8" };

function stampedDraft(user: { id: number; ldapId: string | null }, body: Record<string, unknown> = {}) {
  return JSON.stringify(stampDraftIdentity({ savedAt: "2026-04-22T20:07:43.000Z", ...body }, user));
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? (this.map.get(k) as string) : null; }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}

describe("parseAndValidateDraft", () => {
  it("returns no_draft when raw is null", () => {
    const r = parseAndValidateDraft(null, DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_draft");
  });

  it("returns no_draft when raw is empty string", () => {
    const r = parseAndValidateDraft("", DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_draft");
  });

  it("returns parse_error on invalid JSON", () => {
    const r = parseAndValidateDraft("not json {{", DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("parse_error");
  });

  it("returns missing_identity for legacy drafts (pre-hotfix)", () => {
    // Mimics the v1 envelope shape used before this hotfix.
    const legacyRaw = JSON.stringify({
      formValues: { serviceOrder: "7435-13629175" },
      partNumbers: ["abc"],
      savedAt: "2026-04-22T20:07:43.000Z",
    });
    const r = parseAndValidateDraft(legacyRaw, DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_identity");
  });

  it("returns missing_identity when identity.userId is not a number", () => {
    const raw = JSON.stringify({ identity: { userId: "162", ldapId: "dwiggi8" } });
    const r = parseAndValidateDraft(raw, DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing_identity");
  });

  it("returns id_mismatch when userId differs (Hector→David scenario)", () => {
    const r = parseAndValidateDraft(stampedDraft(HECTOR), DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("id_mismatch");
  });

  it("returns ldap_mismatch when userId matches but ldap differs", () => {
    // Edge case: same numeric id by coincidence after a re-seed, different
    // ldap. Belt-and-suspenders defense.
    const raw = JSON.stringify({
      identity: { userId: DAVID.id, ldapId: "different_ldap" },
      savedAt: "x",
    });
    const r = parseAndValidateDraft(raw, DAVID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("ldap_mismatch");
  });

  it("ignores ldap mismatch when current user has null ldap (admin/agent)", () => {
    const ADMIN = { id: 1, ldapId: null };
    const raw = JSON.stringify({
      identity: { userId: 1, ldapId: "anything" },
      savedAt: "x",
    });
    const r = parseAndValidateDraft(raw, ADMIN);
    expect(r.ok).toBe(true);
  });

  it("returns ok with the parsed envelope when identity matches", () => {
    const r = parseAndValidateDraft(
      stampedDraft(DAVID, { formValues: { serviceOrder: "7435-13629999" } }),
      DAVID,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.identity).toEqual({ userId: DAVID.id, ldapId: DAVID.ldapId });
      expect((r.draft.formValues as any).serviceOrder).toBe("7435-13629999");
    }
  });
});

describe("stampDraftIdentity", () => {
  it("attaches an identity field while preserving the body", () => {
    const stamped = stampDraftIdentity(
      { formValues: { serviceOrder: "x" }, savedAt: "y" },
      DAVID,
    );
    expect(stamped.identity).toEqual({ userId: DAVID.id, ldapId: DAVID.ldapId });
    expect(stamped.formValues).toEqual({ serviceOrder: "x" });
    expect(stamped.savedAt).toBe("y");
  });

  it("supports null ldap (non-tech users)", () => {
    const stamped = stampDraftIdentity({ a: 1 }, { id: 9, ldapId: null });
    expect(stamped.identity).toEqual({ userId: 9, ldapId: null });
  });
});

describe("clearAllTechSubmitDrafts", () => {
  it("removes only vrs_tech_submit_draft_v1_* keys", () => {
    const s = new MemoryStorage();
    s.setItem("vrs_tech_submit_draft_v1_162", "x");
    s.setItem("vrs_tech_submit_draft_v1_242", "y");
    s.setItem("vrs_token", "keep");
    s.setItem("unrelated", "keep too");
    const removed = clearAllTechSubmitDrafts(s);
    expect(removed).toBe(2);
    expect(s.getItem("vrs_tech_submit_draft_v1_162")).toBeNull();
    expect(s.getItem("vrs_tech_submit_draft_v1_242")).toBeNull();
    expect(s.getItem("vrs_token")).toBe("keep");
    expect(s.getItem("unrelated")).toBe("keep too");
  });

  it("returns 0 when no draft keys exist", () => {
    const s = new MemoryStorage();
    s.setItem("vrs_token", "x");
    expect(clearAllTechSubmitDrafts(s)).toBe(0);
    expect(s.getItem("vrs_token")).toBe("x");
  });
});
