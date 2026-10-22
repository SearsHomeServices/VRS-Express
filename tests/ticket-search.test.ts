import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { matchesTicketSearch, ticketAgentIds } from "../shared/ticket-search";

describe("ticket overview agent search", () => {
  it.each(["rejected", "rejected_closed", "invalid", "completed", "approved", "pending", "queued"])(
    "finds recorded reviewers regardless of %s status or cleared assignment", ticketStatus => {
      const row = {
        ticketStatus, assignedAgentName: null,
        workedAgentSearchTerms: ["David Wiggins", "DWIGGI8"],
      };
      expect(matchesTicketSearch(row, "  DAVID WIGGINS ")).toBe(true);
      expect(matchesTicketSearch(row, "dwiggi8")).toBe(true);
      expect(matchesTicketSearch(row, "other agent")).toBe(false);
    },
  );
  it("preserves current assignment, technician and service-order matching", () => {
    for (const row of [
      { assignedAgentName: "David Wiggins" },
      { technicianName: "David Wiggins" },
      { workedAgentSearchTerms: ["David Wiggins"] },
    ]) expect(matchesTicketSearch(row, "david")).toBe(true);
    expect(matchesTicketSearch({ serviceOrder: "7435-14316104" }, "14316104")).toBe(true);
    expect(matchesTicketSearch({ technicianLdapId: "TECH1" }, "tech1")).toBe(true);
    expect(matchesTicketSearch({}, "someone")).toBe(false);
    expect(matchesTicketSearch({}, "  ")).toBe(true);
  });
  it("keeps all recorded agent roles, even when the final reviewer differs", () => {
    expect(ticketAgentIds({
      assignedTo: null, reviewedBy: 2, stage1ReviewedBy: 1,
      stage2ReviewedBy: 2, nlaEscalatedBy: 3,
    })).toEqual([2, 1, 3]);
  });
  it("uses the shared matcher on both server paths and the client", () => {
    const route = readFileSync("server/routes.ts", "utf8");
    const client = readFileSync("client/src/pages/admin-dashboard.tsx", "utf8");
    expect(route).toContain("result.filter(sub => matchesTicketSearch(sub, search))");
    expect(route).toContain("rows.filter(s => matchesTicketSearch({");
    expect(client).toContain("out.filter(t => matchesTicketSearch(t, searchQuery))");
  });
  it("retains the selected date window during search and exports", () => {
    const client = readFileSync("client/src/pages/admin-dashboard.tsx", "utf8");
    expect(client).toContain('if (createdAfterIso) searchSubmissionsParams.set("createdAfter", createdAfterIso)');
    expect(client).toContain("if (createdBeforeMs == null) return scopeRows");
    expect(client).not.toContain("if (searchActive || createdBeforeMs == null)");
    expect(client).toContain('params.set("createdBefore", new Date(createdBeforeMs).toISOString())');
  });
});
