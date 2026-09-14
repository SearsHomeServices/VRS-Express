import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  agentCanSeeVrsAiPilotRow,
  canUseVrsAiPilot,
  filterVrsAiPilotRows,
} from "../shared/vrs-ai-pilot";

const linkedRow = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  serviceOrder: "8175-12345678",
  technicianName: "Pilot Tech",
  ticketStatus: "pending",
  vrsAi: { callId: "vrs-call-1" },
  ...overrides,
});

describe("VRS AI Pilot projection", () => {
  it("includes only submissions with a non-empty vrs_ai_calls bridge call id", () => {
    const rows = [
      linkedRow(),
      linkedRow({ id: 2, vrsAi: null }),
      linkedRow({ id: 3, vrsAi: { callId: "" } }),
      linkedRow({ id: 4, vrsAi: { callId: "   " } }),
      linkedRow({ id: 5, ticketStatus: "completed", vrsAi: { callId: "vrs-call-5" } }),
    ];

    expect(filterVrsAiPilotRows(rows).map((row) => row.id)).toEqual([1, 5]);
  });

  it.each(["vrs_agent", "admin", "super_admin"])(
    "allows %s to use the pilot projection",
    (role) => {
      expect(canUseVrsAiPilot(role)).toBe(true);
    },
  );

  it.each(["technician", "provider_1099", "support", undefined, null])(
    "denies %s from using the pilot projection",
    (role) => {
      expect(canUseVrsAiPilot(role)).toBe(false);
    },
  );

  it("keeps agent pilot access broad for assigned/reviewed rows", () => {
    expect(agentCanSeeVrsAiPilotRow(
      { assignedTo: 7, ticketStatus: "completed", applianceType: "cooking" },
      7,
      ["laundry"],
    )).toBe(true);
    expect(agentCanSeeVrsAiPilotRow(
      { reviewedBy: 7, ticketStatus: "rejected_closed", applianceType: "cooking" },
      7,
      [],
    )).toBe(true);
    expect(agentCanSeeVrsAiPilotRow(
      { assignedTo: 8, reviewedBy: 9, ticketStatus: "completed", applianceType: "cooking" },
      7,
      ["cooking"],
    )).toBe(false);
  });

  it("keeps queued pilot access limited to assigned divisions, including NLA", () => {
    const queued = { ticketStatus: "queued", assignedTo: null, reviewedBy: null };
    expect(agentCanSeeVrsAiPilotRow({ ...queued, applianceType: "laundry" }, 7, ["laundry"])).toBe(true);
    expect(agentCanSeeVrsAiPilotRow({ ...queued, applianceType: "laundry" }, 7, ["cooking"])).toBe(false);
    expect(agentCanSeeVrsAiPilotRow({ ...queued, requestType: "parts_nla" }, 7, ["nla"])).toBe(true);
    expect(agentCanSeeVrsAiPilotRow({ ...queued, requestType: "parts_nla" }, 7, ["laundry"])).toBe(false);
    expect(agentCanSeeVrsAiPilotRow({ ...queued, applianceType: "hvac" }, 7, Array.from({ length: 8 }, (_, i) => `division-${i}`))).toBe(true);
  });
});

describe("VRS AI Pilot route boundaries", () => {
  const source = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
  const listRouteStart = source.indexOf('app.get("/api/submissions", authenticateToken');
  const listRouteEnd = source.indexOf('app.get("/api/submissions/:id", authenticateToken', listRouteStart);
  const listRoute = source.slice(listRouteStart, listRouteEnd);

  it("keeps pilot role rejection before the ordinary technician/provider list path", () => {
    expect(listRoute).toMatch(
      /const canUsePilot = canUseVrsAiPilot\(user\.role\);[\s\S]*?if \(user\.role === "technician" \|\| user\.role === "provider_1099"\) \{[\s\S]*?if \(vrsAiOnly && !canUsePilot\) \{[\s\S]*?return res\.status\(403\)/,
    );
    expect(listRoute).toMatch(
      /else if \(vrsAiOnly && !canUsePilot\) \{[\s\S]*?return res\.status\(403\)/,
    );
  });

  it("preserves legacy queued-agent filters when vrsAiOnly is absent", () => {
    const legacyAgentBranchStart = listRoute.indexOf('} else if (user.role === "vrs_agent")');
    const legacyBranchStart = listRoute.indexOf("} else {", legacyAgentBranchStart);
    const legacyBranchEnd = listRoute.indexOf("\n        }\n      } else if", legacyBranchStart);
    const legacyBranch = listRoute.slice(legacyBranchStart, legacyBranchEnd);

    expect(legacyAgentBranchStart).toBeGreaterThanOrEqual(0);
    expect(legacyBranchStart).toBeGreaterThan(legacyAgentBranchStart);
    expect(legacyBranchEnd).toBeGreaterThan(legacyBranchStart);
    expect(legacyBranch).toMatch(
      /if \(ticketStatusFilter === "queued" && !isCompletedView\) \{[\s\S]*?filters\.divisionFilter = divisions;/,
    );
    expect(legacyBranch).toMatch(
      /else if \(ticketStatusFilter === "pending"\) \{[\s\S]*?filters\.assignedTo = user\.id;/,
    );
    expect(legacyBranch).toMatch(
      /else if \(isCompletedView\) \{[\s\S]*?filters\.reviewedBy = user\.id;/,
    );
    expect(legacyBranch).not.toContain("filters.vrsAiOnly = true");
  });
});
