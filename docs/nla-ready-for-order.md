# NLA card readiness and queue-wait timing

- Active NLA tickets handed off for P-card ordering automatically display the
  credit-card icon and Ready for Order badge. Completed/terminal tickets do not.
- A claimed ticket still undergoing research is not automatically ready.
- The NLA escalation writes its handoff timestamp with the existing transition.
  Card elapsed time and urgency stop at that timestamp through later claims,
  reassignment and reloads. Admin queue-wait display/sorting and the XLSX export
  use the same stop logic. Handle-time calculations are unchanged.
- Existing handoffs without the new timestamp remain visible and confirmable.
  Legacy fallback timestamps are persisted before normal claim/reassignment/NLA
  processing overwrites them. Historical fallbacks are approximate, not proof of
  the exact research completion time.
- Moving a ticket back to VRS research clears its NLA handoff metadata.
- Ordering permissions, supported NLA resolutions, notifications and queue
  ordering are unchanged.

## Schema and verification

The nullable submissions.nla_ready_for_order_at column was applied to DEV before
restart. One existing DEV handoff was backfilled using its earliest retained
escalation audit when available, otherwise its persisted claim/status timestamps.
There is no startup DDL or production mutation. Publish must apply the additive
schema change before running this version in production; DEV backfilled data
does not migrate to production, so runtime compatibility does not require it.

Nineteen focused hermetic tests cover status, legacy, response projection and
frozen-clock behavior. TypeScript checking passed. The complete release build
also passed. No live order or technician notification was created for testing.