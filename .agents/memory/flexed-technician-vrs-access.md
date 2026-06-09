---
name: Flexed technician VRS access
description: Why granting a field tech VRS-agent access is done by flipping their users.role, and the guardrails that keeps it safe.
---

# Flexed technicians (field tech that also works VRS)

A team lead has ONE `users` row. "Grant VRS access" = flip that row's `role`
`technician` → `vrs_agent` + set password + assign divisions. No new column;
"VRS-enabled" is derivable from `role` + roster (`technicians.ldap_id`) membership.

**Why the role-flip is safe (the key non-obvious fact):**
- `authenticateToken` trusts the JWT's role and never re-fetches the DB.
- `signToken` uses the stored `user.role`.
- Field tech-login (`/api/auth/tech-login`) is passwordless/roster-based and ALWAYS
  forces a `technician` token regardless of stored role.
So flipping stored role to `vrs_agent` does NOT change field login, but yields a
native agent session on agent login. No auth special-casing required. This is why
the role-based model was chosen over a separate `vrsEnabled` flag (which would have
needed token special-casing in login + `/api/auth/me`).

**Guardrails (added after code review flagged a demotion hole):**
- `getTechnicianUsers()` must only surface `technician` OR (`vrs_agent` with a roster
  match) — NEVER admin/super_admin. Otherwise a roster-linked admin shows in the
  Technicians list with a Revoke button that would demote them.
- `PATCH /api/admin/users/:id` role-transition guard: super_admin role can't be
  changed at all; only a super_admin can change an admin's role.

**Known limitation:** revoke does NOT invalidate an already-issued agent JWT (7-day
expiry). This is platform-wide — middleware trusts the JWT until expiry for
deactivate/delete/role-edit too. Don't "fix" it just for revoke without doing token
versioning across the board.
