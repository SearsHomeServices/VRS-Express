# Threat Model

## Project Overview

The VRS Digital Authorization Platform is a public internet-reachable Node/Express + React application for Sears Home Services. It handles technician authorization submissions, agent/admin review workflows, SMS notifications, uploaded media, and several third-party integrations (Snowflake, Twilio, SHSAI, object storage, and Smartsheet).

This scan is scoped to production-reachable surfaces only. Development-only scripts, seed flows, mockups, and local-only helpers are out of scope unless production reachability is demonstrated. Replit deployment TLS is assumed to be handled by the platform.

## Assets

- **User accounts and sessions** — JWTs, RAC/LDAP-linked identities, password hashes, reset codes, and role assignments for technicians, agents, admins, super admins, and 1099 providers. Compromise enables impersonation and privilege misuse.
- **Submission records** — service orders, technician identifiers, phone numbers, warranty/provider details, notes, review decisions, media URLs, and audit context. These records contain operationally sensitive and personal data.
- **Uploaded media and attachments** — technician photos, video, audio, and feedback attachments stored in object storage. Exposure could reveal customer homes, appliance serial labels, or internal field-work details.
- **External-service capabilities** — Snowflake lookups, Twilio SMS delivery, SHSAI access, Smartsheet intake links, and any API-key-protected machine-to-machine routes. Abuse could leak external data or incur operational cost.
- **Administrative analytics and workflow state** — queue state, agent status, audit trails, and user-management capabilities. Abuse could disrupt operations or expose sensitive internal activity.
- **Application secrets** — `SESSION_SECRET`, database credentials, Twilio credentials, API keys, and any encryption material used for stored external credentials.

## Trust Boundaries

- **Public browser/client to Express API** — all request bodies, query params, headers, upload metadata, and WebSocket handshake data are untrusted until validated and authorized server-side.
- **Authenticated user to privileged workflow** — technician, provider, agent, admin, and super-admin roles have materially different permissions. Role checks alone are insufficient; record ownership and division/assignment checks are also required.
- **API to PostgreSQL** — the application has broad access to operational data. Injection or missing row-level authorization at the route layer would expose or tamper with all submissions.
- **API to object storage** — uploaded media crosses from authenticated submission flows into directly retrievable objects. Object paths, access control, and URL disclosure determine whether stored files stay private.
- **API to external services** — Snowflake, Twilio, SHSAI, Smartsheet, and the external NLA API key route are separate trust domains and must not be callable or influence behavior beyond intended boundaries.
- **Public to authenticated WebSocket boundary** — `/ws` accepts bearer material via query string and then drives real-time operational events; token validation and post-auth connection handling must resist spoofing and abuse.

## Scan Anchors

- **Production entry points:** `server/index.ts`, `server/routes.ts`, `server/websocket.ts`, `server/replit_integrations/object_storage/routes.ts`
- **Highest-risk code areas:** auth and password reset routes, submission/detail/history/notes routes, claim/process/reassign flows, uploaded-media serving, Snowflake-backed lookup routes, external API-key routes
- **Public surfaces:** `/api/healthz`, `/api/config`, `/api/auth/*` public routes, `/api/external/service-order/:so/nla`, `/objects/*`, `/ws`
- **Authenticated surfaces:** `/api/submissions*`, `/api/agent/*`, `/api/admin/*`, `/api/tech/lookup-warranty`, upload/convert routes
- **Usually dev-only / lower-priority unless proven reachable:** `scripts/`, `server/seed.ts`, tests, local migration helpers

## Threat Categories

### Spoofing

This project relies on JWTs and RAC/LDAP-linked identities to separate technicians from internal staff. Public login, technician login, password reset, and WebSocket handshake flows must verify identity strongly enough that an internet attacker cannot mint a valid technician or staff session by knowing a username, service-order context, or other low-entropy identifier.

Required guarantees:
- Public authentication and recovery routes must require proof of identity resistant to guessing, enumeration, and replay.
- JWTs must be signed and validated on every protected HTTP and WebSocket request.
- Public onboarding flows must not allow arbitrary outsiders to create accounts that unlock internal production features unless that behavior is explicitly intended and safely constrained.

### Tampering

Technicians and agents submit user-controlled text, media metadata, review actions, and workflow transitions. The server must ensure clients cannot alter workflow state, submission ownership, or downstream payloads outside the intended process.

Required guarantees:
- Workflow transitions must be enforced server-side with assignment/status/role checks.
- Client-supplied fields that influence external systems or downstream records must be validated and bounded.
- Upload, conversion, and external-credential flows must not allow attacker-controlled input to alter unrelated records or services.

### Information Disclosure

Submission data includes technician phone numbers, service orders, warranty/provider details, notes, review history, and media references. Exposure to the wrong technician, agent, or outsider would disclose internal operations and potentially customer-adjacent information.

Required guarantees:
- Every route returning submission-related data must enforce both authentication and record-level authorization.
- Media objects and lookup endpoints must not be retrievable by unauthorized users or publicly enumerable.
- Logs and error handling must avoid disclosing secrets, bearer tokens, reset materials, or unnecessary sensitive fields.

### Denial of Service

The public deployment exposes login, password reset, upload preparation, WebSocket connection handling, and some external-service-triggering flows. Expensive bcrypt checks, SMS sends, video/audio conversion, and third-party lookups create abuse potential.

Required guarantees:
- Public and high-cost routes must resist brute-force, flooding, and resource-exhaustion attacks with rate limiting or equivalent controls.
- Media and WebSocket endpoints must bound request size and abusive connection behavior.
- External-service-triggering routes must not let unauthenticated or weakly authenticated callers amplify cost or operational noise.

### Elevation of Privilege

The core risk in this application is broken function- or object-level authorization between technicians, agents, admins, and providers. Agents can only act on assigned or division-appropriate tickets; technicians/providers can only access their own submissions; admin-only surfaces must stay unreachable to lower roles.

Required guarantees:
- Protected routes must enforce the correct combination of role, ownership, assignment, reviewer, and division checks.
- Sensitive helper endpoints (notes, history, warranty lookup, media access, analytics, credential reveal) must mirror the same authorization boundary as the primary submission detail route.
- Public or technician-accessible flows must not become stepping stones into internal agent/admin data or capabilities.