# Callback release repairs implementation plan

Goal: repair the pre-mortem blockers while preserving both callback routes and the manual, PWA, NLA, V5/V8/V9 and notification workflows.
Architecture: strict callback identity and eligibility gates; an additive direct-result receipt table; database-backed event admission and terminal transition protection; API JSON fallback and validated acknowledgments. No production database commands, restart or Publish in this task.
Spec: VRS-Release-Premortem-2026-09-08.md in the parent VRS workspace. Baseline b0cc40b; 226 isolated tests; build passing; TypeScript 56 baseline diagnostics.

- [x] Direct result identity and eligibility: test mismatched call/order/tech, ambiguity, pre-review/NLA, successful unique manual/bridge approvals. Add explicit errors and fresh-read/snapshot guards only to internal automated closes.
- [x] Durable receipts: add a separate table without changing existing tables. Claim by event and call, bind one submission before side effects, retain binding across failure/restart, reject changed payloads. Test on a new isolated PostgreSQL instance, never DATABASE_URL.
- [x] Signed events: test concurrent different events, cross-call event ID collision, delayed nonterminal event, terminal conflicts and forwarding retries. Serialize per-call admission, compare stored payloads, reject stale/regressive application. Retain legacy signed contract and upstream forwarding.
- [x] Response safety: JSON 404 for unknown API paths, preserve SPA GET navigation. Test direct sender validation and reject HTML upstream acknowledgments while preserving documented empty-200 legacy acknowledgments.
- [x] Callback audit and notification outcomes: preserve original human review and notes; report failed notifications separately from ticket completion; do not reapprove/resend on event retry. Keep manual handlers unchanged.
- [x] Regression gate: all safe baseline tests plus new real-Postgres receipt/state tests and extracted real-handler integration tests. Verify build, compare TypeScript baseline, inspect complete diff, update contract/changelog and this checklist. Do not run the two live-mutating test harnesses.
- [x] Prepare the scoped box commit and desktop refresh. Git sync is verified in the delivery record; memory continuity uses the permitted Codex notes path.
- [ ] Tyler: Publish and verify the controlled live canary after release review.

## Compatibility evidence

- Existing NLA handler identical to baseline; all pre-existing registered routes retained.
- No client source or dependency changes. All existing pgTable definitions identical; only two new tables added.
- Normal manual approval and online-status restoration verified. Automation gates use a trusted WeakMap context, not public request-body flags.
- PostgreSQL tests use only the new /tmp/vrs-callback-tests-* Unix socket, vrs_callback_tests database and vrs_test user, with explicit identity checks. The two existing live-mutating test harnesses were not run.
- Independent reviewer identified recovery/forwarding races; regression tests reproduced them, fixes passed, and final targeted review found no remaining Important issues.
- Final production activation and controlled live canary remain Tyler's release actions. Nothing has been published by Codex.

Final pre-commit gate: 281/281 safe tests, passing production build, and exactly the same 56 normalized TypeScript diagnostics as b0cc40b (none added or removed). Final independent targeted review passed.
