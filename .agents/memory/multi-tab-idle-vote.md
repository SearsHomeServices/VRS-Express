---
name: Multi-tab idle-vote demotion gate
description: Why VRS auto-offline uses per-tab idle votes (not a simple liveSessions guard) and the four edge cases that forced each refinement.
---

A user with multiple open tabs/browsers must not be auto-demoted to offline by a backgrounded idle tab while another tab is actively in use. The correct gate is per-tab idle votes, not "skip if liveSessions > 1".

**Why:** Architect rejected the simple `liveSessions > 1 → skip` design because two genuinely-idle tabs would both skip indefinitely, leaving the agent online forever (presence-stale-cleanup never fires while sessions are live). Each refinement below was forced by a specific failure class.

**How to apply** (any future change to the auto-offline / multi-tab path must preserve all of these):
1. **Vote, don't skip.** Server tracks `Map<userId, Map<tabId, expiresAt>>`. Demote only when `votes >= getLiveSessionCount(userId)`. A single-tab user still demotes (1 vote ≥ 1 session).
2. **Stable per-tab id.** Client generates a UUID once per tab into `sessionStorage` and sends it on every auto-offline POST. Don't use IP/UA — multiple tabs share those.
3. **Explicit unvote on activity.** TTL-only expiry is not enough: a tab that voted idle then became active again would still contribute to a false demotion within TTL. Client must POST `/api/agent/idle-vote-clear` on the first user activity event after voting.
4. **ACK-based clear with retry.** Fire-and-forget clear can silently fail (network blip, 5xx) leaving the stale server vote. Only clear the client-side flag on a 204 ACK; otherwise next activity retries. Use a `clearInFlight` guard so mouse-move spam doesn't stack requests.
5. **Persist the vote flag across reloads.** The "have I voted" flag must live in `sessionStorage` (same per-tab storage as the tabId). Lost auto-offline response + page reload would otherwise make the client forget about the server-side vote. On effect mount, if persisted flag is true, immediately attempt clear.
6. **Optimistic flag set.** Set the persisted flag BEFORE the auto-offline POST, not after the response. Clear it back only on definitive signals: `agentStatus="offline"` (demote path called `clearIdleVotes`), or `skipped` with `reason="not_online"` / `"pending_ticket"` (server short-circuited before `recordIdleVote`). On `multi_tab_pending_votes`, network errors, or unknown skip reasons: leave it true.

The four-iteration architect review is the canonical regression suite — any future refactor that drops one of these invariants will reopen a real false-demotion path that VRS noticed in production (Brandon getting resubmissions while mid-ticket was the original symptom that started this work).
