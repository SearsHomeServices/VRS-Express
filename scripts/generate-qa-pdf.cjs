/* Generates the VRS QA Testing Guide PDF using pdfkit. */
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(process.cwd(), "exports");
const OUT = path.join(OUT_DIR, "VRS_QA_Testing_Guide.pdf");
fs.mkdirSync(OUT_DIR, { recursive: true });

const NAVY = "#1f3a5d";
const NAVY2 = "#2c5282";
const GREY = "#475569";
const LINE = "#cbd5e1";
const ZEBRA = "#f2f5f9";
const AMBER = "#b45309";

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 56, bottom: 56, left: 50, right: 50 },
  bufferPages: true,
});
doc.pipe(fs.createWriteStream(OUT));

const M = doc.page.margins;
const CW = doc.page.width - M.left - M.right; // 512
const bottom = () => doc.page.height - M.bottom;
const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

function h1(t) {
  ensure(46);
  doc.moveDown(0.4);
  const y = doc.y;
  doc.rect(M.left, y, CW, 24).fill(NAVY);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text(t, M.left + 8, y + 6, { width: CW - 16 });
  doc.fillColor("#000000").y = y + 24 + 8;
  doc.x = M.left;
}
function h2(t) {
  ensure(30);
  doc.moveDown(0.5);
  doc.fillColor(NAVY2).font("Helvetica-Bold").fontSize(11.5).text(t, M.left, doc.y, { width: CW });
  doc.fillColor("#000000").moveDown(0.2);
  doc.x = M.left;
}
function para(t, opts = {}) {
  ensure(16);
  doc.fillColor(opts.color || "#1f2937").font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9.5)
    .text(t, M.left, doc.y, { width: CW, align: "left", lineGap: 1.5 });
  doc.moveDown(0.25);
  doc.x = M.left;
}
function bullets(items) {
  ensure(16);
  doc.fillColor("#1f2937").font("Helvetica").fontSize(9.5);
  doc.list(items, M.left + 6, doc.y, { width: CW - 6, bulletRadius: 1.6, textIndent: 8, lineGap: 1.5, bulletIndent: 0 });
  doc.moveDown(0.3);
  doc.x = M.left;
}
function note(t, color = AMBER, label = "NOTE") {
  ensure(34);
  const padX = 8, padY = 6;
  doc.font("Helvetica-Bold").fontSize(9);
  const txtH = doc.heightOfString(t, { width: CW - 2 * padX - 4 });
  const boxH = txtH + 2 * padY + 12;
  const y = doc.y;
  doc.save();
  doc.rect(M.left, y, CW, boxH).fill("#fff7ed");
  doc.rect(M.left, y, 4, boxH).fill(color);
  doc.restore();
  doc.fillColor(color).font("Helvetica-Bold").fontSize(8).text(label, M.left + padX, y + padY, { width: CW - 2 * padX });
  doc.fillColor("#7c2d12").font("Helvetica").fontSize(9).text(t, M.left + padX, y + padY + 10, { width: CW - 2 * padX - 4, lineGap: 1.5 });
  doc.fillColor("#000000").y = y + boxH + 6;
  doc.x = M.left;
}

// Test-case table. cols: [{label,width}], rows: [[..strings..]]
function table(cols, rows) {
  const padding = 5;
  const xs = [];
  let acc = M.left;
  for (const c of cols) { xs.push(acc); acc += c.width; }

  const cellH = (cells) => {
    let max = 14;
    cells.forEach((txt, i) => {
      doc.font("Helvetica").fontSize(8.5);
      const h = doc.heightOfString(String(txt), { width: cols[i].width - 2 * padding, lineGap: 1 });
      if (h + 2 * padding > max) max = h + 2 * padding;
    });
    return max;
  };

  const drawHeader = () => {
    const hH = 18;
    const y = doc.y;
    doc.rect(M.left, y, CW, hH).fill(NAVY);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5);
    cols.forEach((c, i) => doc.text(c.label, xs[i] + padding, y + 5, { width: c.width - 2 * padding }));
    doc.fillColor("#000000").y = y + hH;
    doc.x = M.left;
  };

  ensure(40);
  drawHeader();
  rows.forEach((cells, ri) => {
    const rH = cellH(cells);
    if (doc.y + rH > bottom()) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    if (ri % 2 === 1) doc.rect(M.left, y, CW, rH).fill(ZEBRA);
    doc.fillColor("#1f2937").font("Helvetica").fontSize(8.5);
    cells.forEach((txt, i) => doc.text(String(txt), xs[i] + padding, y + padding, { width: cols[i].width - 2 * padding, lineGap: 1 }));
    // borders
    doc.strokeColor(LINE).lineWidth(0.5);
    doc.rect(M.left, y, CW, rH).stroke();
    let cx = M.left;
    for (let i = 0; i < cols.length - 1; i++) { cx += cols[i].width; doc.moveTo(cx, y).lineTo(cx, y + rH).stroke(); }
    doc.y = y + rH;
    doc.x = M.left;
  });
  doc.moveDown(0.5);
  doc.x = M.left;
}

const TCOLS = [
  { label: "#", width: 22 },
  { label: "Test steps", width: 212 },
  { label: "Expected result", width: 166 },
  { label: "Env", width: 52 },
  { label: "Pass/Fail", width: 60 },
];
const t = (id, steps, expected, env) => [id, steps, expected, env, ""];

// ---------------- COVER ----------------
doc.rect(0, 0, doc.page.width, 220).fill(NAVY);
doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(26).text("QA Testing Guide", M.left, 80, { width: CW });
doc.font("Helvetica").fontSize(14).fillColor("#cbd9ea").text("VRS Digital Authorization Platform", M.left, 120, { width: CW });
doc.fontSize(12).fillColor("#cbd9ea").text("1099 Provider Portal & New Admin Features", M.left, 142, { width: CW });
doc.fillColor("#000000");
doc.y = 260; doc.x = M.left;
para("Audience: QA / VRS testing team", { bold: true });
para("Version 1.0  ·  June 16, 2026");
para("Scope: How to test the 1099 Provider Portal and the recently shipped admin features in both the Development and Production environments.");
doc.moveDown(0.5);
note(
  "Dev vs Prod is critical for 1099 testing. Snowflake (warranty lookup) only works in PRODUCTION. In DEV, every 1099 provider submission is intentionally rejected at warranty derivation, so the SUCCESSFUL submission happy-path can only be tested in prod. Use dev for all gating, restriction, redaction and admin-UI tests.",
  NAVY2, "READ FIRST"
);
note(
  "Production actions are REAL. A successful 1099 submission in prod fires a live Twilio SMS to the technician phone and creates a real ticket VRS agents can claim. For prod end-to-end tests use a phone number you control and notify your agents beforehand.",
  "#b91c1c", "PRODUCTION SAFETY"
);

// ---------------- 1. ENVIRONMENTS ----------------
doc.addPage();
h1("1. Test Environments & Setup");
h2("1.1 Environments");
bullets([
  "Development: the running app inside the Replit workspace preview. Snowflake is NOT available here.",
  "Production: https://vrs-auth-tool.replit.app . Snowflake works; real SMS and real tickets.",
]);
h2("1.2 Accounts you will need");
bullets([
  "Admin / super_admin login (to manage users, view analytics, run exports).",
  "A VRS agent login (to claim and process tickets).",
  "A technician login (passwordless/roster) for feedback and resubmission tests.",
  "A 1099 provider account - create one via Admin > User management (see section 2.1). Providers log in with username + password.",
]);
note("The 1099 portal must be PUBLISHED to production before it can be tested there. It is live once the production users table has the company_name column and the role 1099 Provider is selectable. If prod still rejects provider creation, it has not been published yet.", NAVY2, "PREREQUISITE");

h2("1.3 What is already verified");
para("The following were confirmed green via automated checks in DEV (with a real provider company name): provider account creation rules, password login, NLA block, warranty-lookup block, history scoping, and warranty redaction. The remaining item - a SUCCESSFUL submission - is pending the production happy-path test (section 4).");

// ---------------- 2. 1099 PORTAL ----------------
doc.addPage();
h1("2. 1099 Provider Portal");

h2("2.1 Admin - Create & manage provider accounts");
table(TCOLS, [
  t("2.1.1", "Log in as admin. Open User management and start Create User.", "Role selector includes '1099 Provider'.", "Dev+Prod"),
  t("2.1.2", "Role = 1099 Provider. Enter a username, a password (min 6 chars), pick a company, Save.", "201 created; appears in the user list as a provider.", "Dev+Prod"),
  t("2.1.3", "Try to create a provider WITHOUT selecting a company.", "Rejected: 'Select a valid 1099 Company Name'.", "Dev+Prod"),
  t("2.1.4", "Try to create a provider with a company name not on the list.", "Rejected with the same validation message.", "Dev+Prod"),
  t("2.1.5", "Try to reuse a username that already belongs to a field technician.", "409 guided message to use 'Grant VRS access' instead.", "Dev+Prod"),
]);

h2("2.2 Searchable company picker (288 names)");
table(TCOLS, [
  t("2.2.1", "Open the company field in the create/assign-company control.", "A searchable dropdown (type-to-filter) opens.", "Dev+Prod"),
  t("2.2.2", "Type part of a name, e.g. 'APPLIANCE'.", "List filters to matching companies; ~288 entries are searchable.", "Dev+Prod"),
  t("2.2.3", "Select a company and save.", "Exact name (original casing) is stored and shown.", "Dev+Prod"),
]);

h2("2.3 Provider login (username + password)");
note("Providers do NOT use passwordless roster login - that is for field technicians only. The 1099 portal is password-based by design.", NAVY2, "BY DESIGN");
table(TCOLS, [
  t("2.3.1", "Go to /tech/login and switch on the 'VRS Auth - 1099 Provider' toggle.", "Login form switches to username + password.", "Dev+Prod"),
  t("2.3.2", "Enter the provider username + correct password.", "200; redirected to the technician home; company name is shown.", "Dev+Prod"),
  t("2.3.3", "Enter a wrong password.", "401 - Invalid credentials.", "Dev+Prod"),
  t("2.3.4", "Observe first login.", "No onboarding wizard / 'What's New' modal for providers.", "Dev+Prod"),
]);

h2("2.4 Restricted submission view");
table(TCOLS, [
  t("2.4.1", "Open the submission form as a provider.", "District hidden; Warranty section removed; NLA option hidden; Help hidden in bottom nav.", "Dev+Prod"),
  t("2.4.2", "Look at the company field.", "'RAC ID' is relabeled '1099 Company Name', read-only and prefilled.", "Dev+Prod"),
  t("2.4.3", "Open the Infestation option wording.", "No AHS / First American warranty terms appear.", "Dev+Prod"),
]);

h2("2.5 Eligibility & warranty gating");
table(TCOLS, [
  t("2.5.1", "Submit a service order that derives to AHS or First American.", "Accepted; ticket created; tech gets SMS (see section 4).", "Prod"),
  t("2.5.2", "Submit a service order whose warranty is Sears-family.", "Rejected with generic 'isn't eligible ... verify the service order number' (no warranty leak).", "Prod"),
  t("2.5.3", "Submit any service order in DEV.", "Rejected with the same generic message (Snowflake unavailable) - confirms no-leak behavior.", "Dev"),
  t("2.5.4", "Submit with a client-supplied warranty value set.", "Ignored - warranty is always derived server-side from the service order.", "Prod"),
]);

h2("2.6 History scoping & warranty redaction");
table(TCOLS, [
  t("2.6.1", "Open History as a provider.", "Only the provider's own submissions are listed.", "Dev+Prod"),
  t("2.6.2", "Inspect any returned submission (list or detail).", "No warranty type / provider fields anywhere.", "Dev+Prod"),
  t("2.6.3", "Try to open another technician's ticket by id/URL.", "403 - Access denied.", "Dev+Prod"),
]);

h2("2.7 Provider restrictions");
table(TCOLS, [
  t("2.7.1", "Attempt an NLA (parts no longer available) request as a provider.", "400 - 'not available through the 1099 provider portal'.", "Dev+Prod"),
  t("2.7.2", "Call the warranty lookup endpoint as a provider.", "403 - Access denied.", "Dev+Prod"),
]);

// ---------------- 3. ADMIN FEATURES ----------------
doc.addPage();
h1("3. New Admin Features");
note("Items marked 'API' are developer/endpoint-level verifications rather than polished screens; confirm with the dev team how they are surfaced in your build.", GREY, "TIP");

h2("3.1 Replacement Review Outcomes");
table(TCOLS, [
  t("3.1.1", "As an agent on a non-NLA ticket, use the purple 'Replacement Review' action and enter a Replacement Code.", "Ticket completed; tech gets the replacement-review SMS; tech detail shows purple 'Placed Into Replacement Review' header.", "Dev+Prod"),
  t("3.1.2", "Open the admin ticket queue.", "Purple 'REPLACEMENT REVIEW' badge next to that ticket's status.", "Dev+Prod"),
  t("3.1.3", "Open admin analytics.", "'Replacement Review Outcomes' card with Today/Week/Month/All Time.", "Dev+Prod"),
  t("3.1.4", "Export XLSX.", "'Authorization Tickets' sheet has a 'Replacement Review' column showing YES.", "Dev+Prod"),
  t("3.1.5", "Try to resubmit a replacement-review ticket.", "Blocked - it is terminal.", "Dev+Prod"),
]);

h2("3.2 NLA admin");
table(TCOLS, [
  t("3.2.1", "In admin ticket overview, use the request-type filter (All / Authorization Only / NLA Only).", "List filters accordingly.", "Dev+Prod"),
  t("3.2.2", "Open admin analytics.", "'NLA Parts Submissions' card with Today/Week/Month/All Time.", "Dev+Prod"),
  t("3.2.3", "In user management, toggle the P-card switch for an agent/admin.", "canOrderParts toggles; P-card badge appears in the user list.", "Dev+Prod"),
  t("3.2.4", "Export XLSX.", "Two sheets: 'Authorization Tickets' and 'NLA Parts Tickets' (Part Numbers, NLA Resolution, Found Part Number).", "Dev+Prod"),
  t("3.2.5", "As an agent, 'Send to NLA' a claimed VRS ticket and pick a target division.", "Ticket becomes NLA, unassigned + queued, broadcast to NLA agents.", "Dev+Prod"),
]);

h2("3.3 Flexed Technicians (Grant / Revoke VRS access)");
table(TCOLS, [
  t("3.3.1", "Open the admin Technicians list.", "VRS-enabled techs show a blue 'VRS-enabled' badge with Grant/Revoke buttons.", "Dev+Prod"),
  t("3.3.2", "Grant VRS access: set a password (min 6) and divisions.", "Role becomes vrs_agent; the tech can now log in as an agent.", "Dev+Prod"),
  t("3.3.3", "Confirm field login still works for that person.", "Field tech login remains passwordless/roster-based.", "Dev+Prod"),
  t("3.3.4", "Revoke VRS access (confirm dialog).", "Role returns to technician; specializations cleared.", "Dev+Prod"),
  t("3.3.5", "Confirm an admin/super_admin cannot be revoked from the Technicians list.", "They are excluded - no Revoke available.", "Dev+Prod"),
]);

h2("3.4 Analytics & Export");
table(TCOLS, [
  t("3.4.1", "Open admin analytics.", "Resubmission-rate tracking, district-level rollup, and real-time agent status all render.", "Dev+Prod"),
  t("3.4.2", "Export CSV.", "CSV downloads with current ticket data.", "Dev+Prod"),
  t("3.4.3", "Export XLSX.", "2-sheet workbook downloads (Authorization + NLA).", "Dev+Prod"),
]);

h2("3.5 Notification Sound Settings");
table(TCOLS, [
  t("3.5.1", "Open Notification Settings (gear in the agent or admin sidebar footer).", "5 tones (Chime/Bell/Pulse/Cascade/Alert) + a volume slider.", "Dev+Prod"),
  t("3.5.2", "Pick a tone and volume, save, then trigger a notification.", "Setting persists per user; the chosen tone plays at the set volume.", "Dev+Prod"),
]);

h2("3.6 Technician Feedback management");
table(TCOLS, [
  t("3.6.1", "As a technician, open /tech/feedback and submit feedback (issue / improvement / general) with a priority and optional attachment.", "Feedback is submitted.", "Dev+Prod"),
  t("3.6.2", "As admin, open the 'Technician Feedback' view.", "Feedback list with status (new/in_progress/resolved/dismissed) and admin notes.", "Dev+Prod"),
  t("3.6.3", "Change a feedback item's status and add a note.", "Status and note are saved.", "Dev+Prod"),
]);

h2("3.7 Agent Activity Log & System Health (developer checks)");
table(TCOLS, [
  t("3.7.1", "Hit GET /api/admin/agent-activity as admin.", "Returns agent status / auto-offline events, filterable by user, event type and time window.", "API"),
  t("3.7.2", "Toggle an agent's status, then re-query.", "A status_toggle event is recorded.", "API"),
  t("3.7.3", "Hit GET /api/admin/health/regression-check as admin.", "Returns overallStatus + the named health checks.", "API"),
  t("3.7.4", "Hit GET /api/admin/health/incidents.", "Lists open/cleared health findings.", "API"),
]);

h2("3.8 Dark mode (cross-cutting)");
table(TCOLS, [
  t("3.8.1", "Toggle dark mode (tech header icon; agent & admin sidebar footer).", "App-wide dark theme applies.", "Dev+Prod"),
  t("3.8.2", "Reload the page.", "Preference persists.", "Dev+Prod"),
]);

// ---------------- 4. PROD HAPPY PATH ----------------
doc.addPage();
h1("4. Production End-to-End (1099 happy path)");
para("This is the one test that DEV cannot prove. Run it only after the portal is published to production.", { bold: true });
h2("Pre-requisites");
bullets([
  "Portal published to prod (the company_name column exists in the production users table).",
  "A test 1099 provider account created in prod.",
  "A real service order known to derive to AHS or First American.",
  "A phone number YOU control (it will receive a real SMS).",
  "Your VRS agents notified that a test ticket is coming.",
]);
h2("Steps");
table(TCOLS, [
  t("4.1", "Provider logs in (prod) and submits the AHS/First American service order using your phone number.", "Accepted; ticket created and placed in the queue.", "Prod"),
  t("4.2", "Check the technician phone.", "A real authorization SMS is received.", "Prod"),
  t("4.3", "An agent claims and processes the ticket; issues an auth code.", "Provider sees the status update; NO warranty is ever shown to the provider.", "Prod"),
  t("4.4", "Review the provider's history for this ticket.", "Visible to this provider only; warranty fields absent.", "Prod"),
  t("4.5", "Clean up: note/close the test ticket so it is not mistaken for real work.", "Test data is identified and handled.", "Prod"),
]);
note("If a provider submission is rejected in prod with the generic 'isn't eligible' message, that is expected for any service order that does not derive to AHS/First American (including Sears-family) - it is the intentional no-leak behavior, not a bug.", NAVY2, "EXPECTED");

// ---------------- 5. SIGN-OFF ----------------
doc.addPage();
h1("5. Sign-off");
const SCOLS = [
  { label: "Area", width: 200 },
  { label: "Tester", width: 110 },
  { label: "Date", width: 80 },
  { label: "Result", width: 122 },
];
const sign = (a) => [a, "", "", ""];
table(SCOLS, [
  sign("2.1-2.2  Provider accounts & company picker"),
  sign("2.3-2.4  Provider login & restricted view"),
  sign("2.5  Eligibility / warranty gating (prod)"),
  sign("2.6-2.7  Scoping, redaction, restrictions"),
  sign("3.1  Replacement Review"),
  sign("3.2  NLA admin"),
  sign("3.3  Flexed technicians"),
  sign("3.4  Analytics & export"),
  sign("3.5  Notification settings"),
  sign("3.6  Technician feedback"),
  sign("3.7  Activity log & health (dev)"),
  sign("3.8  Dark mode"),
  sign("4.   Production happy-path"),
]);

// ---------------- FOOTERS ----------------
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(i);
  doc.page.margins.bottom = 0;
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(8)
    .text(`VRS QA Testing Guide  ·  v1.0  ·  Page ${i + 1} of ${range.count}`,
      M.left, doc.page.height - 38, { width: CW, align: "center" });
}

doc.end();
console.log("PDF written to", OUT);
