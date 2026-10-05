import { describe, expect, it } from "vitest";
import { isAdminAnalyticsQuery } from "../client/src/lib/analytics-refresh";
describe("admin analytics refresh scope", () => {
  it.each([
    "/api/admin/analytics", "/api/admin/analytics/resubmissions",
    "/api/admin/analytics/districts", "/api/admin/analytics/coaching-duplicates",
    "/api/admin/nla-analytics", "/api/admin/replacement-review-analytics",
    "/api/admin/b2b-replacement-analytics",
  ])("refreshes %s", key => expect(isAdminAnalyticsQuery(key)).toBe(true));
  it.each([undefined, 1, "/api/submissions", "/api/admin/users", "/api/admin/analytics-other"])(
    "does not refresh unrelated queries: %s", key => expect(isAdminAnalyticsQuery(key)).toBe(false),
  );
});
