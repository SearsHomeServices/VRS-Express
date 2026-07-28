# VRS Digital Authorization Platform

## Overview
The VRS Digital Authorization Platform is a full-stack web application designed for Sears Home Services. It digitalizes the authorization process, moving away from traditional call-in methods. The platform features two distinct interfaces: a mobile-first Progressive Web Application (PWA) for field technicians and a desktop dashboard for VRS agents and administrators. This system aims to streamline workflows, improve efficiency in authorization requests, and enhance communication between technicians and agents.

## User Preferences
- I prefer clear and concise communication.
- I appreciate explanations that are straightforward and to the point.
- I value a structured and organized approach to development tasks.
- I expect the agent to ask for clarification if instructions are ambiguous.
- I prefer detailed explanations for complex solutions or significant changes.

## System Architecture
The application is built with a robust architecture utilizing a modern tech stack. The backend is powered by Node.js, Express, and TypeScript, while the frontend is developed with React, Vite, TailwindCSS, and shadcn/ui. PostgreSQL is used as the database, managed with Drizzle ORM. Authentication is handled via JWT with bcryptjs.

Key architectural patterns include:
- **Role-Based Access Control (RBAC):** Users (technicians, VRS agents, admins, super_admins) have distinct roles with varying access permissions.
- **Two-Stage Submission Review:** Authorization requests, particularly for AHS/First American warranties, undergo a two-stage review process to manage initial approval and subsequent authorization code entry.
- **Real-time Communication:** A WebSocket server (ws library) facilitates live push notifications for critical events like new tickets, claimed tickets, and agent status changes.
- **Resubmission Routing (2026-05-06):** All resubmissions land in the general queue (`assignedTo: null`, `ticketStatus: "queued"`) so any available agent can claim them — they are no longer auto-assigned back to the original reviewer (which caused pile-ups on busy agents). The prior reviewer still receives an informational `resubmission_received` notification, and the resubmission is broadcast as `new_ticket` to all division (or NLA division) agents. The tech gets the claim SMS when an agent actually claims from the queue, not at submit-time. Includes ownership validation (tech can only resubmit their own tickets) and a blue "Resubmission" badge in the agent's ticket list.
- **Unified Ticket Workflow:** Submissions progress through defined `ticketStatus` states (queued, pending, completed, rejected, invalid) managed by agents.
- **Division Auto-Assignment:** Admins and super_admins automatically access all divisions, while VRS agents can select their specializations, influencing ticket routing.
- **Division Correction:** Agents can correct the appliance type mid-review, with intelligent handling of ticket ownership based on their assigned divisions.
- **Comprehensive Onboarding & Help System:** Features first-login wizards, "What's New" modals, contextual help tooltips, and a searchable Help Center.
- **Mobile-First Design:** The technician PWA and agent/admin dashboards adapt to various screen sizes.
- **Photo Thumbnails (2026-07-08):** Tech clients generate a ~480px/~60KB JPEG thumbnail per photo at upload time (browser-image-compression), stored as a `{fullPath: thumbPath}` JSON map in `submissions.photo_thumbnails`. Photo grids swap ONLY the `<img>` src to the thumb; full paths remain the identity for rejection toggles, rejected_media, lightbox, and downloads. Missing thumb → silent fallback to the full image (legacy rows unaffected).
- **Dark Mode:** App-wide dark mode toggle via `ThemeProvider` (`client/src/components/theme-provider.tsx`) using Tailwind's `darkMode: ["class"]`. Persists preference to `localStorage` (key `vrs-theme`) with OS preference fallback. Toggle buttons in tech header, agent sidebar footer, and admin sidebar footer.
- **Performance Layer (2026-07-08):** (a) gzip via `compression` in `server/index.ts`, skipping `/objects/*`; (b) jittered dashboard polling (`JITTERED_POLL_INTERVAL_MS`) + a 2s in-process micro-cache on the staff branch of `GET /api/submissions`, invalidated by a `submissionsDataVersion` stamp — **every new write path touching `submissions` or `intake_forms` in `server/storage.ts` must call `bumpSubmissionsDataVersion()`**; tech/provider (redacted) branch is never cached; (c) WS-triggered query invalidations coalesced through `scheduleWsInvalidate()` (2.5s trailing debounce) in `client/src/lib/queryClient.ts` — mutation `onSuccess` invalidations stay immediate; (d) `POST /api/media-tokens` batch endpoint (≤60 paths) + `prefetchMediaTokens()` in `client/src/lib/auth.tsx` warms media tokens when a ticket detail opens, with the same per-role ownership boundary as the single-token route.

**Frontend Pages:**
- **Technician:** Login, Home, Submission Form, History, Submission Detail, Help Center. Add-photos-while-open (2026-07-23): techs can append issue/estimate photos to their OWN ticket while it is queued/pending via `POST /api/submissions/:id/photos` (append-only merge into the photos JSON + thumbnail map, optimistic-lock on status, audit note in submission_notes, `ticket_updated` WS to assigned agent + admins). Closed states 409 — rejected tickets keep the resubmission flow. UI: "Add More Photos" card on the tech Submission Detail page reusing the compress→signed-URL→PUT→thumb pipeline. Add-videos-while-open (2026-07-27): same endpoint accepts `videos` (append-only merge into the videoUrl JSON, max 3 total, CAS now also compares video_url); UI adds an "Add Video (30 sec max)" button in the same card (type/50MB/30s checks, non-MP4 converted via /api/uploads/convert-video before attaching). request-url + convert-video routes now also allow provider_1099 for role parity with the append route. Full first-submission parity (2026-07-27): applies to BOTH authorization and parts_nla tickets (no requestType gate), and the endpoint also accepts a single-slot `voiceNote` (400 if one already exists, CAS on voice_note_url); UI adds a "Record Voice Note (2 min max)" button shown only when the ticket has no voice note; convert-audio also allows provider_1099.
- **VRS Agent:** SO Lookup (2026-07-24): header button opens a dialog where any agent can enter a service order (dashed or 12-digit) and see all matching submissions across ALL divisions — status, tech name/RAC ID, who claimed/reviewed it, timestamps, NLA/resubmission badges — via `GET /api/agent/so-lookup` (read-only bounded projection: no media, codes, phones, or notes; detail-route division checks unchanged). When reviewing a resubmission, a "Media From Previous Submissions" card (2026-07-23) shows every strictly-earlier submission in the chain — photos (red ring + badge for ones the prior reviewer rejected via rejectedMedia), videos, voice notes, outcome badge, date, reviewer — sourced from the existing /history endpoint; no server change. Login, Dashboard (unified Queue, My Tickets, Completed views + dedicated NLA Queue, NLA My Tickets, NLA Completed sub-tabs), supporting claim-to-process workflow, division correction. SHSAI panel is suppressed for NLA tickets.
- **Admin:** Login, Dashboard (user management, division assignments, analytics with resubmission rate tracking, district-level rollup, and NLA analytics card, real-time agent status, ticket overview with FIFO queue and request type filter (All/Authorization Only/NLA Only), clickable audit trail per ticket, technician feedback management, export with CSV + XLSX).
- **Technician Feedback:** Technicians can submit feedback (issue, improvement, general) with priority and optional attachments from /tech/feedback. Admins manage feedback from the "Technician Feedback" view with status tracking (new, in_progress, resolved, dismissed) and admin notes.

## Detailed Feature Docs
Deep-dive operational notes for individual subsystems live under `docs/architecture/`. Read the relevant file before changing that subsystem:
- [NLA (Parts No Longer Available)](docs/architecture/nla.md) — standalone "nla" specialization, send-to-NLA flow, P-card system, resolution actions, division filtering, XLSX export.
- [Agent Operations](docs/architecture/agent-operations.md) — ticket timing columns, the `agent_activity_log` event taxonomy, and the System Health Regression Watch checks/endpoints.
- [Notification Sounds](docs/architecture/notification-sounds.md) — per-user tone + volume settings and where they load.
- [Replacement Review Outcome](docs/architecture/replacement-review.md) — `approve_replacement_review` action, SMS copy, terminal behavior, UI surfaces.
- [Flexed Technicians (VRS Access)](docs/architecture/flexed-technicians.md) — role-based grant/revoke model, why field login is unaffected, demotion guards.
- [1099 Provider Portal](docs/architecture/1099-provider-portal.md) — `ENABLE_1099_PORTAL` flag, `provider_1099` role, warranty derivation + Sears-exclusion / no-leak behavior.
- [Dashboard Query Performance](docs/architecture/dashboard-performance.md) — SQL business-hours averages, N+1 removal, performance indexes, concurrent reads.
- [External API v1](docs/architecture/external-api.md) — `/api/external/v1/*` machine-to-machine surface: two x-api-key keys (read/write), adapter-over-existing-handlers design, VRS_EXTERNAL_API system account, allowlisted decision actions, bounded projections.
- [VRS Express ↔ VRS AI Bridge](docs/architecture/vrs-sasha-api-v5.md) — SASHA/Tech Hub intake, normal human review ticket, AHS-only approval/send action, outbound VRS AI client, signed result callback, and callback forwarding to SASHA.
- [Enzo VRS AI Integration Handoff](docs/integration/enzo-vrs-ai-bridge-handoff.md) — send-ready partner guide with the matching [OpenAPI 3.1 contract](docs/integration/enzo-vrs-ai-bridge-openapi.yaml), HMAC test vector, callback/retry rules, and staging acceptance checklist.

## Schema & Data Safety
- `drizzle.config.ts` has `strict: true` and `verbose: true` — `db:push` will prompt for confirmation on any destructive changes.
- `shared/schema.ts` has safety rules at the top: never change column types, never rename columns, never remove columns without approval.
- `server/seed.ts` test cleanup (`cleanupTestSubmissions`) is skipped in production (NODE_ENV === "production").
- `server/seed.ts` one-time migrations (resetAllPasswords, backfillClaimedAt) use flag rows — do not remove these checks.
- `server/storage.ts` `deleteUser()` refuses system accounts and logs cascading submission deletes.
- `DELETE /api/admin/users/:id` blocks: self-delete, system accounts, super_admin role.
- All primary keys are `serial`. Never change to varchar/UUID.

## Memory System Boundaries
- **`memory/`** — Replit Agent's memory (this agent). Do NOT read or write from Claude AI.
- **`.claude/memory/`** — Claude AI's memory (VS Code SSH). Do NOT read or write from Replit Agent.
- **`CHANGELOG.md`** — Shared between both agents. Both update the `[Unreleased]` section.
- **`CLAUDE.md`** — Instructions file for Claude AI. Replit Agent should not modify unless the user asks.
- **`replit.md`** — Instructions file for Replit Agent (this file).

## External Dependencies
- **Twilio:** Used for sending SMS notifications to technicians.
- **SASHA/VRS AI bridge:** `POST /vrs/authorize` requires `VRS_SASHA_API_KEY` and creates a normal pending Express ticket. Bridge callback secrets use the dedicated `VRS_BRIDGE_ENCRYPTION_KEY`. Human Stage 1 approval sends the V5 payload to Enzo's VRS AI service; VRS AI callbacks return through Express and are forwarded to SASHA.
- **Snowflake:** Integrates for synchronizing technician data into the platform's database. Also provides ProcID (CMB_THD_PTY_ID) and Client Name lookup per service order via `fetchProcIdForServiceOrder` in `server/services/snowflake.ts`, stored as `procId` and `clientNm` on the submissions table.
- **SHSAI Service:** An external AI service for querying service order history and handling follow-up questions during the authorization process.
- **LDAP Service:** Utilized for secure authentication of technicians (passwordless) and verifying credentials for agents and administrators.
