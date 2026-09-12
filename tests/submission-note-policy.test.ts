import { describe, expect, it } from "vitest";
import {
  canAccessTicketNotes,
  canReadNote,
  isTerminalTicketStatus,
  noteVisibilityForPost,
} from "../server/submission-note-policy";

const ticket = {
  technicianId: 7,
  ticketStatus: "queued",
  requestType: "authorization",
  applianceType: "laundry",
  allDivisionCount: 8,
};

describe("submission note audience policy", () => {
  it.each(["completed", "approved", "rejected", "rejected_closed", "invalid"])(
    "treats %s as terminal",
    (status) => expect(isTerminalTicketStatus(status)).toBe(true),
  );

  it.each(["queued", "pending"])("treats %s as open", (status) => {
    expect(isTerminalTicketStatus(status)).toBe(false);
  });

  it.each(["vrs_agent", "admin", "super_admin"])(
    "creates staff-only notes for terminal tickets as %s",
    (role) => expect(noteVisibilityForPost(role, "completed")).toBe("staff_only"),
  );

  it.each(["technician", "provider_1099"])(
    "prevents %s from posting after close but permits shared open notes",
    (role) => {
      expect(noteVisibilityForPost(role, "rejected_closed")).toBeNull();
      expect(noteVisibilityForPost(role, "pending")).toBe("shared");
    },
  );

  it("denies unknown roles", () => {
    expect(noteVisibilityForPost("future_role", "pending")).toBeNull();
    expect(canReadNote("future_role", null)).toBe(false);
  });

  it("enforces technician and provider ownership", () => {
    expect(canAccessTicketNotes({ ...ticket, role: "technician", userId: 7 })).toBe(true);
    expect(canAccessTicketNotes({ ...ticket, role: "technician", userId: 8 })).toBe(false);
    expect(canAccessTicketNotes({ ...ticket, role: "provider_1099", userId: 8 })).toBe(false);
  });

  it("enforces queued division access for agents", () => {
    expect(canAccessTicketNotes({ ...ticket, role: "vrs_agent", userId: 8, divisions: ["laundry"] })).toBe(true);
    expect(canAccessTicketNotes({ ...ticket, role: "vrs_agent", userId: 8, divisions: ["cooking"] })).toBe(false);
    expect(canAccessTicketNotes({
      ...ticket,
      requestType: "parts_nla",
      role: "vrs_agent",
      userId: 8,
      divisions: ["nla"],
    })).toBe(true);
  });

  it("allows agents across divisions once a ticket is non-queued", () => {
    expect(canAccessTicketNotes({
      ...ticket,
      ticketStatus: "completed",
      role: "vrs_agent",
      userId: 8,
      divisions: [],
    })).toBe(true);
  });

  it("allows a generalist with all divisions into any queued ticket", () => {
    expect(canAccessTicketNotes({
      ...ticket,
      role: "vrs_agent",
      userId: 8,
      divisions: Array.from({ length: 8 }, (_, index) => `division-${index}`),
    })).toBe(true);
  });

  it("preserves old null-visibility notes as shared history", () => {
    expect(canReadNote("technician", null)).toBe(true);
    expect(canReadNote("provider_1099", "shared")).toBe(true);
    expect(canReadNote("technician", "staff_only")).toBe(false);
  });

  it("keeps independent concurrent posts append-only", () => {
    const posts = ["first", "second"].map((body) => ({
      body,
      visibility: noteVisibilityForPost("admin", "completed"),
    }));
    expect(posts).toEqual([
      { body: "first", visibility: "staff_only" },
      { body: "second", visibility: "staff_only" },
    ]);
  });
});