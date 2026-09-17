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
  const storageSource = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
  const agentDashboardSource = readFileSync(new URL("../client/src/pages/agent-dashboard.tsx", import.meta.url), "utf8");
  const adminDashboardSource = readFileSync(new URL("../client/src/pages/admin-dashboard.tsx", import.meta.url), "utf8");
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

  it("keeps ordinary staff lists separate from the bridge-linked Pilot projection", () => {
    expect(listRoute).toMatch(
      /if \(!vrsAiOnly[\s\S]*?filters\.excludeVrsAiLinked = true;/,
    );
    expect(storageSource).toMatch(
      /if \(filters\?\.excludeVrsAiLinked\)[\s\S]*?vrsAiCalls\.callId\} IS NULL/,
    );
    expect(storageSource).toMatch(
      /if \(filters\?\.vrsAiOnly\)[\s\S]*?vrsAiCalls\.callId\} IS NOT NULL/,
    );
  });

  it.each([
    "getCompletedTodayCount",
    "getAgentQueueCount",
    "getDivisionQueueCount",
    "getStage2QueueCount",
    "getQueuedCount",
    "getQueuedCountAll",
    "getPendingCount",
    "getNlaQueuedCount",
    "getNlaPendingCount",
    "getNlaCompletedTodayCount",
    "getWarrantyProviderCounts",
  ])("excludes bridge-linked rows from %s counts", (method) => {
    const methodStart = storageSource.indexOf(`async ${method}`);
    const nextMethod = storageSource.indexOf("\n  async ", methodStart + 1);
    const methodSource = storageSource.slice(methodStart, nextMethod < 0 ? undefined : nextMethod);
    expect(methodStart).toBeGreaterThanOrEqual(0);
    expect(methodSource).toMatch(/leftJoin\(vrsAiCalls[\s\S]*?vrsAiCalls\.callId\} IS NULL/);
  });

  it("gates Pilot navigation and reuses the scoped admin overview without workflow controls", () => {
    expect(agentDashboardSource).toContain("const canUsePilot = canUseVrsAiPilot(user?.role);");
    expect(agentDashboardSource).toMatch(/\{canUsePilot && \([\s\S]*?data-testid="nav-vrs-ai-pilot"/);
    expect(agentDashboardSource).toContain("const handlePilotOpen =");
    expect(agentDashboardSource).toContain("handleClaimAndOpen(submissionId, true)");

    const pilotSectionStart = adminDashboardSource.indexOf("function VrsAiPilotSection()");
    const pilotSectionEnd = adminDashboardSource.indexOf("function TicketOverviewSection()", pilotSectionStart);
    const pilotSection = adminDashboardSource.slice(pilotSectionStart, pilotSectionEnd);
    expect(pilotSection).toContain('<TicketOverviewSection scope="vrs-ai-pilot" />');
    expect(adminDashboardSource).toContain('if (vrsAiOnly) adminSubmissionsParams.set("vrsAiOnly", "true")');
    expect(adminDashboardSource).toContain('if (vrsAiOnly) searchSubmissionsParams.set("vrsAiOnly", "true")');
    expect(adminDashboardSource).toContain('filterVrsAiPilotRows(rawTicketsUnbounded)');
    expect(adminDashboardSource).toContain('data-testid="request-type-filter"');
    expect(adminDashboardSource).toContain('data-testid="select-pdc-filter"');
    expect(adminDashboardSource).toContain('data-testid={`count-tickets-${tab.key}`}');
    expect(adminDashboardSource).toContain('!vrsAiOnly && (statusFilter === "queued"');
    expect(adminDashboardSource).toContain('if (vrsAiOnly) params.set("vrsAiOnly", "true")');
    expect(adminDashboardSource).toContain('activeView === "vrs-ai-pilot") params.set("vrsAiOnly", "true")');
    expect(adminDashboardSource).toContain('Tech Sign-In Report (Global)');
    expect(adminDashboardSource).toContain('Send Weekly Summary (Global)');
    expect(adminDashboardSource).toContain("This is a global report for all tickets, not only VRS AI Pilot tickets.");
  });

  it("keeps terminal Pilot rows read-only even when the bridge state is still active", () => {
    const handlePilotOpenStart = agentDashboardSource.indexOf("const handlePilotOpen =");
    const handlePilotOpenEnd = agentDashboardSource.indexOf("const handleProcessSubmit =", handlePilotOpenStart);
    const handlePilotOpen = agentDashboardSource.slice(handlePilotOpenStart, handlePilotOpenEnd);
    const reviewCardStart = agentDashboardSource.indexOf(
      'isTicketWorkView && selectedSubmission.ticketStatus === "pending" && selectedSubmission.requestType !== "parts_nla"',
    );

    expect(handlePilotOpenStart).toBeGreaterThanOrEqual(0);
    expect(handlePilotOpenEnd).toBeGreaterThan(handlePilotOpenStart);
    expect(handlePilotOpen).toMatch(
      /row\.ticketStatus === "pending"[\s\S]*?setPilotWorkflowId\(submissionId\)[\s\S]*?setSelectedId\(submissionId\)/,
    );
    expect(handlePilotOpen).toMatch(
      /setPilotWorkflowId\(null\);\s*setSelectedId\(submissionId\);/,
    );
    expect(reviewCardStart).toBeGreaterThanOrEqual(0);

    // A bridge row can retain an active provider state while its submission
    // has already been closed by the direct call-result path. Display labels
    // such as Authorization/Aging must not turn that terminal row back into
    // a review workflow or allow an AI result to be re-approved.
    const resolvedPilotRow = linkedRow({
      assignedTo: 90,
      ticketStatus: "completed",
      submissionApproved: true,
      vrsAi: { callId: "vrs-call-550", state: "reviewing" },
    });
    expect(resolvedPilotRow.ticketStatus).toBe("completed");
    expect(handlePilotOpen).toContain('row.ticketStatus === "pending"');
  });
});
