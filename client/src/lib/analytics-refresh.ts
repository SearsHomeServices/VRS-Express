/** All panels on Admin Analytics; exclude unrelated ticket/user queries. */
export function isAdminAnalyticsQuery(key: unknown): boolean {
  return typeof key === "string" && (
    key === "/api/admin/analytics" ||
    key.startsWith("/api/admin/analytics/") ||
    ["/api/admin/nla-analytics", "/api/admin/replacement-review-analytics",
      "/api/admin/b2b-replacement-analytics"].includes(key)
  );
}
