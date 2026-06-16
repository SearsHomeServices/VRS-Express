/* Generates a compact (few-page) VRS QA Testing Guide PDF using pdfkit. */
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(process.cwd(), "exports");
const OUT = path.join(OUT_DIR, "VRS_QA_Testing_Guide.pdf");
fs.mkdirSync(OUT_DIR, { recursive: true });

const NAVY = "#1f3a5d";
const NAVY2 = "#2c5282";
const LINE = "#cbd5e1";
const ZEBRA = "#f2f5f9";

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 42, bottom: 40, left: 44, right: 44 },
  bufferPages: true,
});
doc.pipe(fs.createWriteStream(OUT));

const M = doc.page.margins;
const CW = doc.page.width - M.left - M.right; // 524
const bottom = () => doc.page.height - M.bottom;
const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };

function h1(t) {
  ensure(28);
  doc.moveDown(0.25);
  const y = doc.y;
  doc.rect(M.left, y, CW, 18).fill(NAVY);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(10.5).text(t, M.left + 7, y + 4.5, { width: CW - 14 });
  doc.fillColor("#000000").y = y + 18 + 5;
  doc.x = M.left;
}
function h2(t) {
  ensure(20);
  doc.moveDown(0.25);
  doc.fillColor(NAVY2).font("Helvetica-Bold").fontSize(9.5).text(t, M.left, doc.y, { width: CW });
  doc.fillColor("#000000").moveDown(0.1);
  doc.x = M.left;
}
function bullets(items) {
  ensure(14);
  doc.fillColor("#1f2937").font("Helvetica").fontSize(8.5);
  doc.list(items, M.left + 4, doc.y, { width: CW - 4, bulletRadius: 1.4, textIndent: 7, lineGap: 1, bulletIndent: 0 });
  doc.moveDown(0.2);
  doc.x = M.left;
}
function note(t, color = NAVY2, label = "NOTE") {
  const padX = 7, padY = 5;
  doc.font("Helvetica").fontSize(8);
  const txtH = doc.heightOfString(t, { width: CW - 2 * padX - 4, lineGap: 1 });
  const boxH = txtH + 2 * padY + 9;
  ensure(boxH + 4);
  const y = doc.y;
  doc.save();
  doc.rect(M.left, y, CW, boxH).fill("#eef3f9");
  doc.rect(M.left, y, 3.5, boxH).fill(color);
  doc.restore();
  doc.fillColor(color).font("Helvetica-Bold").fontSize(7.5).text(label, M.left + padX, y + padY, { width: CW - 2 * padX });
  doc.fillColor("#1f2937").font("Helvetica").fontSize(8).text(t, M.left + padX, y + padY + 8.5, { width: CW - 2 * padX - 4, lineGap: 1 });
  doc.fillColor("#000000").y = y + boxH + 4;
  doc.x = M.left;
}

function table(cols, rows) {
  const padding = 4;
  const xs = []; let acc = M.left;
  for (const c of cols) { xs.push(acc); acc += c.width; }
  const cellH = (cells) => {
    let max = 12;
    cells.forEach((txt, i) => {
      doc.font("Helvetica").fontSize(7.8);
      const h = doc.heightOfString(String(txt), { width: cols[i].width - 2 * padding, lineGap: 0.5 });
      if (h + 2 * padding > max) max = h + 2 * padding;
    });
    return max;
  };
  const drawHeader = () => {
    const hH = 15; const y = doc.y;
    doc.rect(M.left, y, CW, hH).fill(NAVY);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.8);
    cols.forEach((c, i) => doc.text(c.label, xs[i] + padding, y + 4, { width: c.width - 2 * padding }));
    doc.fillColor("#000000").y = y + hH; doc.x = M.left;
  };
  ensure(34);
  drawHeader();
  rows.forEach((cells, ri) => {
    const rH = cellH(cells);
    if (doc.y + rH > bottom()) { doc.addPage(); drawHeader(); }
    const y = doc.y;
    if (ri % 2 === 1) doc.rect(M.left, y, CW, rH).fill(ZEBRA);
    doc.fillColor("#1f2937").font("Helvetica").fontSize(7.8);
    cells.forEach((txt, i) => doc.text(String(txt), xs[i] + padding, y + padding, { width: cols[i].width - 2 * padding, lineGap: 0.5 }));
    doc.strokeColor(LINE).lineWidth(0.5);
    doc.rect(M.left, y, CW, rH).stroke();
    let cx = M.left;
    for (let i = 0; i < cols.length - 1; i++) { cx += cols[i].width; doc.moveTo(cx, y).lineTo(cx, y + rH).stroke(); }
    doc.y = y + rH; doc.x = M.left;
  });
  doc.moveDown(0.3);
  doc.x = M.left;
}

const TCOLS = [
  { label: "#", width: 22 },
  { label: "Test steps", width: 222 },
  { label: "Expected result", width: 168 },
  { label: "Env", width: 44 },
  { label: "P/F", width: 68 },
];
const t = (id, steps, expected, env) => [id, steps, expected, env, ""];

// ---- Compact header (no separate cover page) ----
const hy = doc.y;
doc.rect(M.left, hy, CW, 40).fill(NAVY);
doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15).text("QA Testing Guide", M.left + 10, hy + 7);
doc.font("Helvetica").fontSize(9).fillColor("#cbd9ea")
  .text("VRS Digital Authorization Platform  -  1099 Provider Portal & New Admin Features   |   v1.0  -  June 16, 2026", M.left + 10, hy + 26, { width: CW - 20 });
doc.fillColor("#000000").y = hy + 40 + 6; doc.x = M.left;

note("DEV vs PROD: Snowflake (warranty lookup) only works in PRODUCTION. In DEV every 1099 provider submission is intentionally rejected at warranty derivation, so the SUCCESSFUL submission can only be tested in prod. Use dev for all gating, restriction, redaction and admin-UI tests.", NAVY2, "READ FIRST");
note("Production actions are REAL: a successful 1099 submission fires a live SMS to the technician phone and creates a real ticket agents can claim. Use a phone you control and notify agents first.", "#b91c1c", "PROD SAFETY");
bullets([
  "Accounts: admin/super_admin, a VRS agent, a technician, and a 1099 provider (create via Admin > User management). Providers log in with username + password (not passwordless).",
  "Prerequisite for prod: the portal must be published - the production users table must have the company_name column and the '1099 Provider' role must be selectable.",
  "P/F column = mark Pass or Fail. Env: Dev+Prod, Prod-only, Dev-only, or API (developer/endpoint check).",
]);

// ---- 1. 1099 PORTAL ----
h1("1. 1099 Provider Portal");
h2("1.1 Admin - create & manage provider accounts");
table(TCOLS, [
  t("1.1.1", "Log in as admin; open User management and start Create User.", "Role selector includes '1099 Provider'.", "Dev+Prod"),
  t("1.1.2", "Role = 1099 Provider; enter username, password (min 6), pick a company, Save.", "201 created; shows in user list as provider.", "Dev+Prod"),
  t("1.1.3", "Create a provider WITHOUT a company / with a company not on the list.", "Rejected: 'Select a valid 1099 Company Name'.", "Dev+Prod"),
  t("1.1.4", "Reuse a username that belongs to a field technician.", "409 - guided to use 'Grant VRS access'.", "Dev+Prod"),
]);
h2("1.2 Searchable company picker (288 names)");
table(TCOLS, [
  t("1.2.1", "Open the company field; type part of a name e.g. 'APPLIANCE'.", "Searchable dropdown filters to matches; ~288 entries.", "Dev+Prod"),
  t("1.2.2", "Select a company and save.", "Exact name (original casing) is stored and shown.", "Dev+Prod"),
]);
h2("1.3 Provider login (username + password)");
table(TCOLS, [
  t("1.3.1", "Go to /tech/login; switch on 'VRS Auth - 1099 Provider'.", "Form switches to username + password.", "Dev+Prod"),
  t("1.3.2", "Enter username + correct password.", "200; redirected to tech home; company shown.", "Dev+Prod"),
  t("1.3.3", "Enter a wrong password.", "401 - Invalid credentials.", "Dev+Prod"),
  t("1.3.4", "Observe first login.", "No onboarding wizard / 'What's New' for providers.", "Dev+Prod"),
]);
h2("1.4 Restricted submission view");
table(TCOLS, [
  t("1.4.1", "Open the submission form as a provider.", "District hidden; Warranty section gone; NLA hidden; Help hidden in nav.", "Dev+Prod"),
  t("1.4.2", "Look at the company field & Infestation wording.", "'1099 Company Name' read-only + prefilled; no AHS/FA terms.", "Dev+Prod"),
]);
h2("1.5 Eligibility & warranty gating");
table(TCOLS, [
  t("1.5.1", "Submit a service order that derives to AHS or First American.", "Accepted; ticket created (see section 3).", "Prod"),
  t("1.5.2", "Submit a Sears-family service order.", "Generic 'isn't eligible ... verify the service order' (no leak).", "Prod"),
  t("1.5.3", "Submit any service order in DEV.", "Same generic rejection (Snowflake unavailable).", "Dev"),
]);
h2("1.6 History scoping, redaction & restrictions");
table(TCOLS, [
  t("1.6.1", "Open History as a provider; inspect list and a detail.", "Only own submissions; no warranty fields anywhere.", "Dev+Prod"),
  t("1.6.2", "Try to open another technician's ticket by id/URL.", "403 - Access denied.", "Dev+Prod"),
  t("1.6.3", "Attempt an NLA request / call the warranty lookup as a provider.", "NLA blocked (400); lookup blocked (403).", "Dev+Prod"),
]);

// ---- 2. ADMIN FEATURES ----
h1("2. New Admin Features");
h2("2.1 Replacement Review Outcomes");
table(TCOLS, [
  t("2.1.1", "Agent uses the purple 'Replacement Review' action with a Replacement Code (non-NLA ticket).", "Completed; replacement-review SMS; tech detail shows purple header.", "Dev+Prod"),
  t("2.1.2", "Check admin queue / analytics / XLSX / resubmit.", "Purple badge; 'Replacement Review Outcomes' card; XLSX 'Replacement Review'=YES; resubmit blocked.", "Dev+Prod"),
]);
h2("2.2 NLA admin");
table(TCOLS, [
  t("2.2.1", "Use the request-type filter (All / Authorization Only / NLA Only) in ticket overview.", "List filters accordingly.", "Dev+Prod"),
  t("2.2.2", "Check NLA analytics card; toggle a P-card switch for an agent.", "'NLA Parts Submissions' card; canOrderParts toggles, P-card badge shows.", "Dev+Prod"),
  t("2.2.3", "Export XLSX; as agent 'Send to NLA' a claimed ticket with a division.", "2 sheets (Auth + NLA Parts); ticket becomes NLA, queued, broadcast to NLA agents.", "Dev+Prod"),
]);
h2("2.3 Flexed Technicians (Grant / Revoke VRS access)");
table(TCOLS, [
  t("2.3.1", "Technicians list: Grant VRS access (set password min 6 + divisions).", "Blue 'VRS-enabled' badge; tech can now log in as an agent.", "Dev+Prod"),
  t("2.3.2", "Confirm field login still works; then Revoke (confirm dialog).", "Field login stays passwordless; role returns to technician, specializations cleared.", "Dev+Prod"),
  t("2.3.3", "Confirm an admin/super_admin has no Revoke in this list.", "Excluded - cannot be demoted here.", "Dev+Prod"),
]);
h2("2.4 Analytics, export & notifications");
table(TCOLS, [
  t("2.4.1", "Open admin analytics.", "Resubmission rate, district rollup, real-time agent status all render.", "Dev+Prod"),
  t("2.4.2", "Export CSV and XLSX.", "CSV downloads; XLSX is a 2-sheet workbook (Auth + NLA).", "Dev+Prod"),
  t("2.4.3", "Open Notification Settings (sidebar footer); pick a tone + volume, save, trigger a notification.", "5 tones + volume; persists per user; chosen tone plays.", "Dev+Prod"),
]);
h2("2.5 Technician feedback & dark mode");
table(TCOLS, [
  t("2.5.1", "Technician submits feedback at /tech/feedback (type, priority, optional attachment).", "Feedback submitted.", "Dev+Prod"),
  t("2.5.2", "Admin opens 'Technician Feedback', changes a status and adds a note.", "List with status (new/in_progress/resolved/dismissed); changes saved.", "Dev+Prod"),
  t("2.5.3", "Toggle dark mode (tech header / sidebar footer) and reload.", "App-wide dark theme; preference persists.", "Dev+Prod"),
]);
h2("2.6 Activity log & system health (developer checks)");
table(TCOLS, [
  t("2.6.1", "GET /api/admin/agent-activity (admin); toggle an agent status; re-query.", "Returns filterable events; a status_toggle event is recorded.", "API"),
  t("2.6.2", "GET /api/admin/health/regression-check and /health/incidents (admin).", "overallStatus + named checks; incident history listed.", "API"),
]);

// ---- 3. PROD HAPPY PATH ----
h1("3. Production End-to-End (1099 happy path)");
bullets([
  "Pre-reqs: portal published to prod; a prod test provider; a real AHS/First American service order; a phone YOU control; agents notified.",
]);
table(TCOLS, [
  t("3.1", "Provider logs in (prod) and submits the AHS/FA service order with your phone.", "Accepted; ticket created and queued.", "Prod"),
  t("3.2", "Check the technician phone.", "A real authorization SMS is received.", "Prod"),
  t("3.3", "Agent claims, processes, issues an auth code.", "Provider sees status update; NO warranty shown to provider.", "Prod"),
  t("3.4", "Clean up: note/close the test ticket.", "Test data identified and handled.", "Prod"),
]);
note("A generic 'isn't eligible' rejection in prod is EXPECTED for any service order not deriving to AHS/First American (incl. Sears-family) - it is the intentional no-leak behavior, not a bug.", NAVY2, "EXPECTED");

// ---- Footers ----
const range = doc.bufferedPageRange();
for (let i = 0; i < range.count; i++) {
  doc.switchToPage(i);
  doc.page.margins.bottom = 0;
  doc.fillColor("#94a3b8").font("Helvetica").fontSize(7.5)
    .text(`VRS QA Testing Guide  -  v1.0  -  Page ${i + 1} of ${range.count}`,
      M.left, doc.page.height - 30, { width: CW, align: "center" });
}
doc.end();
console.log("PDF written:", OUT);
