// ============================================================================
// EXTERNAL API v1 — public documentation page
// ----------------------------------------------------------------------------
// Served at GET /api/external/v1/docs with NO auth so the URL can be shared
// with the external integration team. Contains NO secrets — keys are shown as
// placeholders only. Keep this in sync with server/external-api.ts and
// docs/architecture/external-api.md when the contract changes.
// ============================================================================

export const EXTERNAL_API_DOCS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>VRS External API v1 — Integration Guide</title>
<style>
  :root {
    --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #e2e8f0;
    --muted: #94a3b8; --accent: #38bdf8; --green: #4ade80; --red: #f87171;
    --amber: #fbbf24; --code-bg: #0b1220;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 1.9rem; margin: 0 0 4px; }
  h2 { font-size: 1.35rem; margin: 44px 0 12px; padding-top: 20px; border-top: 1px solid var(--border); color: var(--accent); }
  h3 { font-size: 1.05rem; margin: 28px 0 8px; }
  p, li { color: var(--text); }
  .sub { color: var(--muted); margin: 0 0 24px; }
  code { background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; font-size: 0.88em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; overflow-x: auto; font-size: 0.82rem; line-height: 1.5; }
  pre code { background: none; border: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 0.88rem; }
  th, td { border: 1px solid var(--border); padding: 7px 10px; text-align: left; vertical-align: top; }
  th { background: var(--panel); }
  td code { white-space: nowrap; }
  .method { display: inline-block; font-weight: 700; font-size: 0.75rem; padding: 2px 8px; border-radius: 4px; margin-right: 8px; font-family: ui-monospace, monospace; }
  .get { background: #064e3b; color: var(--green); }
  .post { background: #713f12; color: var(--amber); }
  .endpoint { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; margin: 16px 0; }
  .endpoint h3 { margin: 0 0 8px; font-family: ui-monospace, monospace; font-size: 0.95rem; }
  .callout { border-left: 4px solid var(--accent); background: var(--panel); padding: 10px 14px; border-radius: 0 6px 6px 0; margin: 14px 0; font-size: 0.9rem; }
  .warn { border-left-color: var(--amber); }
  .danger { border-left-color: var(--red); }
  .pill { display: inline-block; background: var(--panel); border: 1px solid var(--border); border-radius: 999px; padding: 1px 10px; font-size: 0.78rem; color: var(--muted); margin: 2px 3px 2px 0; }
  a { color: var(--accent); }
  nav { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px; font-size: 0.88rem; }
  nav a { display: inline-block; margin: 2px 12px 2px 0; }
  footer { margin-top: 60px; color: var(--muted); font-size: 0.8rem; border-top: 1px solid var(--border); padding-top: 16px; }
</style>
</head>
<body>
<div class="wrap">

<h1>VRS External API v1</h1>
<p class="sub">Machine-to-machine REST interface for the VRS Digital Authorization Platform (Sears Home Services). Read every workflow; create requests and record decisions programmatically.</p>

<nav>
  <a href="#auth">Authentication</a>
  <a href="#conventions">Conventions</a>
  <a href="#lookup">SO Lookup</a>
  <a href="#list">List / Poll</a>
  <a href="#create">Create Request</a>
  <a href="#decision">Record Decision</a>
  <a href="#object">Submission Object</a>
  <a href="#lifecycle">Ticket Lifecycle</a>
  <a href="#errors">Error Codes</a>
  <a href="#examples">Examples</a>
</nav>

<h2 id="auth">Authentication</h2>
<p>Every request requires an <code>x-api-key</code> header. There are <strong>two separate keys</strong> — they are not interchangeable:</p>
<table>
  <tr><th>Key</th><th>Grants</th><th>Used on</th></tr>
  <tr><td><strong>Read key</strong></td><td>Read-only access</td><td>All <code>GET</code> endpoints</td></tr>
  <tr><td><strong>Write key</strong></td><td>Create + decisions</td><td>All <code>POST</code> endpoints</td></tr>
</table>
<p>Keys are issued by the VRS platform administrator. A missing or wrong key (including using the read key on a write route) returns <code>401 UNAUTHORIZED</code>.</p>
<div class="callout warn">Treat keys as production credentials: server-side only, never in a browser, never in client-side code or logs.</div>

<h3>Base URL</h3>
<pre><code>https://vrs-auth-tool.replit.app/api/external/v1</code></pre>

<h3>Rate limits</h3>
<ul>
  <li><strong>Reads:</strong> 60 requests / minute (global, across all callers of the key)</li>
  <li><strong>Writes:</strong> 10 requests / minute (global)</li>
</ul>
<p>Exceeding a limit returns <code>429 RATE_LIMITED</code>. All requests count toward the window, including ones that fail validation — back off for up to 60 seconds on a 429.</p>

<h2 id="conventions">Conventions</h2>
<ul>
  <li>Request and response bodies are JSON. Send <code>Content-Type: application/json</code> on POSTs.</li>
  <li>Success responses wrap the payload in <code>{ "data": ... }</code>. List responses add <code>"nextCursor"</code>.</li>
  <li>Errors are <code>{ "error": "human message", "code": "MACHINE_CODE" }</code> (code present on most errors).</li>
  <li>Timestamps are ISO-8601 UTC strings.</li>
  <li>Service orders use the format <code>DDDD-SSSSSSSS</code> (4-digit unit, dash, 8-digit order), e.g. <code>8175-12345678</code>.</li>
  <li>IDs are integers and strictly increasing — newer submissions have higher ids.</li>
</ul>

<h2 id="lookup">Look up a service order</h2>
<div class="endpoint">
<h3><span class="method get">GET</span>/service-orders/:serviceOrder</h3>
<p>Returns <em>every</em> submission ever filed against a service order (all workflows, all statuses), newest first. Unknown service orders return a normal 200 with <code>submissionCount: 0</code>.</p>
<pre><code>{
  "data": {
    "serviceOrder": "8175-12345678",
    "submissionCount": 2,
    "submissions": [ { ...submission object... }, ... ]
  }
}</code></pre>
<p>Errors: <code>400 BAD_SERVICE_ORDER</code> (wrong format), <code>401</code>.</p>
</div>

<h2 id="list">List / poll submissions</h2>
<div class="endpoint">
<h3><span class="method get">GET</span>/submissions</h3>
<p>Filterable, cursor-paginated list in <strong>descending id order</strong>. Intended for polling: remember the highest id you have processed and filter client-side, or poll with <code>createdAfter</code>.</p>
<table>
  <tr><th>Query param</th><th>Type</th><th>Notes</th></tr>
  <tr><td><code>requestType</code></td><td>enum</td><td><code>authorization</code> | <code>infestation_non_accessible</code> | <code>parts_nla</code></td></tr>
  <tr><td><code>ticketStatus</code></td><td>enum</td><td><code>queued</code> | <code>pending</code> | <code>completed</code> | <code>rejected</code> | <code>invalid</code></td></tr>
  <tr><td><code>createdAfter</code></td><td>ISO date</td><td>Inclusive lower bound on <code>createdAt</code></td></tr>
  <tr><td><code>createdBefore</code></td><td>ISO date</td><td>Upper bound on <code>createdAt</code></td></tr>
  <tr><td><code>cursor</code></td><td>integer</td><td>Pass the previous response's <code>nextCursor</code> to get the next (older) page</td></tr>
  <tr><td><code>limit</code></td><td>integer</td><td>1–100, default 50</td></tr>
</table>
<pre><code>{ "data": [ { ...submission object... }, ... ], "nextCursor": 231 }</code></pre>
<p><code>nextCursor</code> is <code>null</code> when there are no more pages. Errors: <code>400 BAD_QUERY</code>, <code>401</code>.</p>
</div>

<h2 id="create">Create a request</h2>
<div class="endpoint">
<h3><span class="method post">POST</span>/submissions</h3>
<p>Files a request <strong>on behalf of a real technician</strong>, identified by LDAP id. The submission enters the normal agent queue and the technician receives the standard SMS chain (received → claimed → decision) at their phone on file.</p>
<table>
  <tr><th>Field</th><th>Type</th><th>Required</th><th>Notes</th></tr>
  <tr><td><code>technicianLdapId</code></td><td>string</td><td>yes</td><td>Resolved server-side against the technician roster (case-insensitive). Unknown → <code>422 UNKNOWN_TECHNICIAN</code>; inactive → <code>422 INACTIVE_TECHNICIAN</code>.</td></tr>
  <tr><td><code>serviceOrder</code></td><td>string</td><td>yes</td><td>Format <code>DDDD-SSSSSSSS</code></td></tr>
  <tr><td><code>applianceType</code></td><td>enum</td><td>yes</td><td><code>cooking</code> | <code>dishwasher</code> | <code>microwave</code> | <code>laundry</code> | <code>refrigeration</code> | <code>hvac</code> | <code>all_other</code></td></tr>
  <tr><td><code>requestType</code></td><td>enum</td><td>yes</td><td><code>authorization</code> | <code>infestation_non_accessible</code> | <code>parts_nla</code></td></tr>
  <tr><td><code>warrantyType</code></td><td>enum</td><td>no</td><td><code>sears_protect</code> (default) | <code>american_home_shield</code> | <code>first_american</code></td></tr>
  <tr><td><code>warrantyProvider</code></td><td>string ≤100</td><td>no</td><td>Free-text provider name</td></tr>
  <tr><td><code>issueDescription</code></td><td>string ≤2000</td><td>yes</td><td>What the technician found / needs</td></tr>
  <tr><td><code>estimateAmount</code></td><td>string ≤20</td><td>no</td><td>e.g. <code>"412.50"</code></td></tr>
  <tr><td><code>partNumbers</code></td><td>JSON string ≤2000</td><td>no</td><td><code>'["PART1","PART2"]'</code>, or for NLA: <code>'{"nla":["A"],"available":["B"]}'</code></td></tr>
  <tr><td><code>phone</code></td><td>string 10–20</td><td>no</td><td>Overrides the technician's phone on file. <code>400 NO_PHONE</code> if neither exists.</td></tr>
  <tr><td><code>additionalRequest</code></td><td>boolean</td><td>no</td><td>Second same-day ticket on a return visit</td></tr>
</table>
<div class="callout">Media fields (photos / video / voice notes) and <code>resubmissionOf</code> are <strong>not accepted</strong> in v1. Tickets created here appear to agents without photos.</div>
<p><strong>Responses:</strong></p>
<ul>
  <li><code>201</code> — created; body is <code>{ "data": submission }</code> (same shape as reads).</li>
  <li><code>200</code> — idempotent replay: the identical request (same technician + service order) was already created within the last ~60 seconds; the original row is returned instead of a duplicate.</li>
  <li><code>409</code> — an <em>active</em> (queued/pending) submission already exists for this service order, or the resolved account is not a technician (<code>NOT_A_TECHNICIAN</code>).</li>
  <li><code>400 / 422</code> — validation / technician resolution failures (see <a href="#errors">error codes</a>).</li>
</ul>
</div>

<h2 id="decision">Record a decision</h2>
<div class="endpoint">
<h3><span class="method post">POST</span>/submissions/:id/decision</h3>
<p>Records a decision exactly as a VRS agent would. Decisions are attributed to the <strong>VRS External API</strong> system account in the audit trail. If the ticket is still <code>queued</code>, it is auto-claimed first (the technician gets the normal "claimed" SMS, then the decision SMS).</p>
<table>
  <tr><th>Field</th><th>Type</th><th>Notes</th></tr>
  <tr><td><code>action</code></td><td>enum</td><td>Required — see the two allowlists below. Must match the ticket type or <code>400 ACTION_MISMATCH</code>.</td></tr>
  <tr><td><code>agentNotes</code></td><td>string ≤4000</td><td>Internal notes stored on the ticket</td></tr>
  <tr><td><code>technicianMessage</code></td><td>string ≤2000</td><td>Message included in the technician's SMS. <strong>Required for every NLA resolution action.</strong></td></tr>
  <tr><td><code>authCode</code></td><td>string ≤50</td><td>Required for final approval on AHS / First American tickets</td></tr>
  <tr><td><code>rejectionReasons</code></td><td>string[] ≤20×500</td><td>Reasons shown to the technician on reject</td></tr>
  <tr><td><code>invalidReason</code></td><td>string ≤255</td><td>For <code>invalid</code> / <code>nla_invalid</code></td></tr>
  <tr><td><code>invalidInstructions</code></td><td>string ≤2000</td><td>For <code>invalid</code> / <code>nla_invalid</code></td></tr>
  <tr><td><code>nlaFoundPartNumber</code></td><td>string ≤100</td><td>NLA part-found actions</td></tr>
  <tr><td><code>nlaResolution</code></td><td>string ≤2000</td><td>NLA resolution detail</td></tr>
</table>
<h3>Actions — authorization &amp; infestation tickets</h3>
<span class="pill">approve_submission</span><span class="pill">approve</span><span class="pill">reject</span><span class="pill">reject_and_close</span><span class="pill">invalid</span>
<ul>
  <li><code>approve_submission</code> — Stage-1 approval on two-stage AHS / First American tickets (ticket stays open for the auth code).</li>
  <li><code>approve</code> — final approval. Sears Protect tickets require the daily RGC code to be configured platform-side (otherwise <code>400</code>); AHS / First American finals require <code>authCode</code>.</li>
  <li><code>reject</code> / <code>reject_and_close</code> — terminal rejection (with / without resubmission guidance).</li>
  <li><code>invalid</code> — not a valid request; include <code>invalidReason</code> / <code>invalidInstructions</code>.</li>
</ul>
<h3>Actions — NLA (parts no longer available) tickets</h3>
<span class="pill">nla_replacement_submitted</span><span class="pill">nla_replacement_tech_initiates</span><span class="pill">nla_part_found_tech_orders</span><span class="pill">nla_reject</span><span class="pill">nla_invalid</span>
<div class="callout">Not available in v1 (reserved for human agents): <code>approve_replacement_review</code>, <code>b2b_approved_replacement</code>, <code>nla_part_found_vrs_ordered</code>, <code>nla_escalate_to_pcard</code>, <code>nla_pcard_confirm</code>, <code>nla_rfr_eligible</code>.</div>
<p><strong>Behavior guarantees:</strong></p>
<ul>
  <li>A ticket actively claimed by a <strong>human agent</strong> returns <code>403</code> — the API never overrides a live review.</li>
  <li>All internal business rules apply unchanged (RGC requirement, auth-code requirement, status transition guards).</li>
  <li>If the decision fails <em>after</em> an auto-claim (e.g. missing RGC), the ticket is automatically returned to the general queue — it is never left stranded.</li>
  <li>Decisions on tickets already in a terminal state (<code>completed</code> / <code>rejected</code> / <code>invalid</code>) are refused.</li>
</ul>
<p><strong>Responses:</strong> <code>200</code> with <code>{ "data": submission }</code> on success; <code>400</code>, <code>403</code>, <code>404</code>, <code>409</code> otherwise.</p>
</div>

<h2 id="object">The submission object</h2>
<p>All endpoints return the same bounded projection. Media paths, internal phone overrides, and RGC codes are never included.</p>
<table>
  <tr><th>Field</th><th>Type</th><th>Notes</th></tr>
  <tr><td><code>id</code></td><td>integer</td><td>Stable unique id</td></tr>
  <tr><td><code>serviceOrder</code></td><td>string</td><td></td></tr>
  <tr><td><code>requestType</code></td><td>enum</td><td>authorization | infestation_non_accessible | parts_nla</td></tr>
  <tr><td><code>applianceType</code></td><td>enum</td><td>Division routing key</td></tr>
  <tr><td><code>ticketStatus</code></td><td>enum</td><td>queued | pending | completed | rejected | invalid</td></tr>
  <tr><td><code>stage1Status</code> / <code>stage2Status</code></td><td>string</td><td><code>stage1Status</code> reflects the <strong>overall outcome</strong>; stage2 fields are the AHS/FA second-stage audit</td></tr>
  <tr><td><code>stage2Outcome</code></td><td>string | null</td><td></td></tr>
  <tr><td><code>submissionApproved</code></td><td>boolean</td><td>Stage-1 approval flag on two-stage tickets</td></tr>
  <tr><td><code>warrantyType</code> / <code>warrantyProvider</code></td><td>string</td><td></td></tr>
  <tr><td><code>issueDescription</code></td><td>string</td><td></td></tr>
  <tr><td><code>estimateAmount</code></td><td>string | null</td><td></td></tr>
  <tr><td><code>partNumbers</code></td><td>JSON string | null</td><td>Same encoding as submitted</td></tr>
  <tr><td><code>authCode</code></td><td>string | null</td><td>Present after final approval</td></tr>
  <tr><td><code>rejectionReasons</code></td><td>JSON string | null</td><td></td></tr>
  <tr><td><code>invalidReason</code> / <code>invalidInstructions</code></td><td>string | null</td><td></td></tr>
  <tr><td><code>agentNotes</code> / <code>technicianMessage</code></td><td>string | null</td><td></td></tr>
  <tr><td><code>nlaResolution</code> / <code>nlaFoundPartNumber</code></td><td>string | null</td><td>NLA outcomes</td></tr>
  <tr><td><code>resubmissionOf</code></td><td>integer | null</td><td>Id of the original ticket if this is a resubmission</td></tr>
  <tr><td><code>technician</code></td><td>object</td><td><code>{ id, name, racId }</code> — racId is the LDAP id</td></tr>
  <tr><td><code>agent</code></td><td>object | null</td><td><code>{ id, name }</code> of the current assignee; <code>null</code> when unassigned (rejected tickets release their assignee — the decision-maker stays in the platform audit trail)</td></tr>
  <tr><td><code>createdAt</code> / <code>claimedAt</code> / <code>reviewedAt</code> / <code>statusChangedAt</code></td><td>ISO timestamp | null</td><td></td></tr>
</table>

<h2 id="lifecycle">Ticket lifecycle</h2>
<pre><code>            (create)                    (agent or API claims)
  POST /submissions ──► queued ────────────────► pending ──► decision
                                                              │
              completed  ◄── approve / approve final / NLA resolutions
              rejected   ◄── reject / reject_and_close / nla_reject
              invalid    ◄── invalid / nla_invalid</code></pre>
<ul>
  <li><strong>Two-stage tickets</strong> (AHS / First American): <code>approve_submission</code> first (Stage 1 — ticket stays <code>pending</code> with <code>submissionApproved: true</code>), then <code>approve</code> with <code>authCode</code> to complete.</li>
  <li><strong>Resubmissions</strong> create a new row with <code>resubmissionOf</code> pointing at the original; they can only be filed by the technician in the app, not through this API.</li>
  <li><strong>SMS side effects are real:</strong> every create and decision triggers the production SMS chain to the technician. Do not use production for integration testing without coordinating.</li>
</ul>

<h2 id="errors">Error codes</h2>
<table>
  <tr><th>HTTP</th><th>Code</th><th>Meaning</th></tr>
  <tr><td>400</td><td><code>BAD_SERVICE_ORDER</code></td><td>Service order not in <code>DDDD-SSSSSSSS</code> format</td></tr>
  <tr><td>400</td><td><code>BAD_QUERY</code></td><td>Invalid list filter / cursor / limit</td></tr>
  <tr><td>400</td><td><code>BAD_REQUEST</code></td><td>Body failed validation (message names the first bad field)</td></tr>
  <tr><td>400</td><td><code>BAD_ID</code></td><td>Non-numeric submission id</td></tr>
  <tr><td>400</td><td><code>ACTION_MISMATCH</code></td><td>NLA action on an authorization ticket or vice-versa</td></tr>
  <tr><td>400</td><td>—</td><td>Business-rule refusal from the decision flow (e.g. RGC not set, missing authCode, ticket already in a terminal state); message explains</td></tr>
  <tr><td>401</td><td><code>UNAUTHORIZED</code></td><td>Missing/invalid key, or wrong key class for the route</td></tr>
  <tr><td>403</td><td>—</td><td>Ticket is actively claimed by a human agent</td></tr>
  <tr><td>404</td><td><code>NOT_FOUND</code></td><td>No submission with that id</td></tr>
  <tr><td>409</td><td>—</td><td>Active submission already exists for the service order / concurrent claim conflict</td></tr>
  <tr><td>409</td><td><code>NOT_A_TECHNICIAN</code></td><td>LDAP id resolved to a non-technician account</td></tr>
  <tr><td>422</td><td><code>UNKNOWN_TECHNICIAN</code></td><td>LDAP id not in the technician roster</td></tr>
  <tr><td>422</td><td><code>INACTIVE_TECHNICIAN</code></td><td>Technician exists but is inactive</td></tr>
  <tr><td>429</td><td><code>RATE_LIMITED</code></td><td>Over 60 reads/min or 10 writes/min — back off up to 60s</td></tr>
  <tr><td>503</td><td><code>NOT_CONFIGURED</code></td><td>API key or system account not configured platform-side</td></tr>
</table>

<h2 id="examples">Examples</h2>
<h3>Look up a service order</h3>
<pre><code>curl -H "x-api-key: $READ_KEY" \\
  https://vrs-auth-tool.replit.app/api/external/v1/service-orders/8175-12345678</code></pre>

<h3>Poll for new NLA tickets</h3>
<pre><code>curl -H "x-api-key: $READ_KEY" \\
  "https://vrs-auth-tool.replit.app/api/external/v1/submissions?requestType=parts_nla&amp;ticketStatus=queued&amp;limit=100"</code></pre>

<h3>Page through history</h3>
<pre><code># page 1
curl -H "x-api-key: $READ_KEY" ".../v1/submissions?limit=100"
# page 2 — use nextCursor from page 1
curl -H "x-api-key: $READ_KEY" ".../v1/submissions?limit=100&amp;cursor=133"</code></pre>

<h3>Create an authorization request</h3>
<pre><code>curl -X POST -H "x-api-key: $WRITE_KEY" -H "Content-Type: application/json" \\
  https://vrs-auth-tool.replit.app/api/external/v1/submissions \\
  -d '{
    "technicianLdapId": "jsmith3",
    "serviceOrder": "8175-12345678",
    "applianceType": "laundry",
    "requestType": "authorization",
    "issueDescription": "Drum bearing seized; needs replacement authorization.",
    "estimateAmount": "412.50",
    "partNumbers": "[\\"W10290562\\"]"
  }'</code></pre>

<h3>Reject with reasons</h3>
<pre><code>curl -X POST -H "x-api-key: $WRITE_KEY" -H "Content-Type: application/json" \\
  https://vrs-auth-tool.replit.app/api/external/v1/submissions/231/decision \\
  -d '{
    "action": "reject",
    "rejectionReasons": ["Estimate exceeds repair threshold"],
    "technicianMessage": "Please contact VRS for replacement options."
  }'</code></pre>

<h3>Two-stage AHS approval</h3>
<pre><code># Stage 1
curl -X POST -H "x-api-key: $WRITE_KEY" -H "Content-Type: application/json" \\
  .../v1/submissions/231/decision -d '{ "action": "approve_submission" }'
# Stage 2 — final, with the warranty company's auth code
curl -X POST -H "x-api-key: $WRITE_KEY" -H "Content-Type: application/json" \\
  .../v1/submissions/231/decision -d '{ "action": "approve", "authCode": "AHS-991234" }'</code></pre>

<footer>
  VRS Digital Authorization Platform — External API v1 · This page is public but the API requires keys. Contract questions: contact the VRS platform administrator.
</footer>
</div>
</body>
</html>`;
