import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_REPORT_PILOT_SCOPE_ERROR,
  requestsVrsAiPilotScope,
} from "../server/vrs-ai-pilot-scope";

describe("VRS AI Pilot report scope opt-in", () => {
  it("enables scope only for an explicit true value", () => {
    expect(requestsVrsAiPilotScope({ vrsAiOnly: "true" })).toBe(true);
    expect(requestsVrsAiPilotScope({ vrsAiOnly: true })).toBe(true);
    expect(requestsVrsAiPilotScope({})).toBe(false);
    expect(requestsVrsAiPilotScope({ vrsAiOnly: "false" })).toBe(false);
    expect(requestsVrsAiPilotScope({ vrsAiOnly: "1" })).toBe(false);
    expect(requestsVrsAiPilotScope({ vrsAiOnly: false })).toBe(false);
  });

  it("uses the durable bridge link for ticket exports without changing default queries", () => {
    const storage = readFileSync(new URL("../server/storage.ts", import.meta.url), "utf8");
    const methodStart = storage.indexOf("async getAllSubmissions(");
    const methodEnd = storage.indexOf("\n  async ", methodStart + 1);
    const method = storage.slice(methodStart, methodEnd);

    expect(method).toMatch(/if \(options\?\.vrsAiOnly\)/);
    expect(method).toContain("conditions.push(sql`${vrsAiCalls.callId} IS NOT NULL`)");
    expect(method).toContain(
      ".innerJoin(vrsAiCalls, eq(vrsAiCalls.submissionId, submissions.id))",
    );
    expect(method).toMatch(
      /if \(conditions\.length > 0\)[\s\S]*?db\.select\(\)\.from\(submissions\)/,
    );
  });

  it("threads pilot scope through ticket CSV, XLSX, coaching export, and Tech PDC selection", () => {
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const requiredRoutes = [
      "/api/admin/export-csv",
      "/api/admin/export-xlsx",
      "/api/admin/export-coaching",
      "/api/tech-pdc/export",
    ];
    for (const route of requiredRoutes) expect(routes).toContain(route);

    expect(routes.match(/\{ vrsAiOnly \}/g)?.length).toBeGreaterThanOrEqual(3);
    expect(routes).toContain("const vrsAiOnly = requestsVrsAiPilotScope(query);");
    expect(routes).toContain("getCoachingRecords(coachingQuery)");
  });

  it("rejects a misleading pilot scope on global executive summary tools", () => {
    expect(GLOBAL_REPORT_PILOT_SCOPE_ERROR).toContain("global administrative report");
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const historyStart = routes.indexOf('app.get("/api/admin/reports/exec-summary"');
    const historyEnd = routes.indexOf("\n  app.", historyStart + 1);
    const sendStart = routes.indexOf('app.post("/api/admin/reports/exec-summary/send"');
    const sendEnd = routes.indexOf("\n  app.", sendStart + 1);

    expect(routes.slice(historyStart, historyEnd)).toContain("GLOBAL_REPORT_PILOT_SCOPE_ERROR");
    expect(routes.slice(sendStart, sendEnd)).toContain("GLOBAL_REPORT_PILOT_SCOPE_ERROR");
  });
});