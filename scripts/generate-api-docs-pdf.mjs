import PDFDocument from "pdfkit";
import { createWriteStream } from "fs";

const OUT = "exports/vrs-nla-lookup-api.pdf";
const LEFT = 50;
const RIGHT = 562;
const WIDTH = RIGHT - LEFT;

const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 44, bottom: 44, left: LEFT, right: 50 },
  info: {
    Title: "VRS NLA Lookup API — Integration Guide",
    Author: "VRS Digital Authorization Platform",
    Subject: "External API: service-order NLA lookup",
  },
});
doc.pipe(createWriteStream(OUT));

const C = {
  text: "#111827",
  muted: "#4b5563",
  rule: "#d1d5db",
  code: "#0f172a",
  codeBg: "#f1f5f9",
  accent: "#1d4ed8",
  warn: "#92400e",
};

function h1(t) {
  if (doc.y + 30 > doc.page.height - 44) doc.addPage();
  doc.moveDown(0.3);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(C.accent).text(t.toUpperCase(), { characterSpacing: 0.5 });
  const y = doc.y + 1.5;
  doc.moveTo(LEFT, y).lineTo(RIGHT, y).strokeColor(C.rule).lineWidth(0.8).stroke();
  doc.moveDown(0.35);
}
function h2(t) {
  if (doc.y + 24 > doc.page.height - 44) doc.addPage();
  doc.moveDown(0.15);
  doc.font("Helvetica-Bold").fontSize(10.5).fillColor(C.text).text(t);
  doc.moveDown(0.15);
}
function p(t) {
  doc.font("Helvetica").fontSize(9.5).fillColor(C.text).text(t, { lineGap: 1.5 });
  doc.moveDown(0.2);
}
function muted(t) {
  doc.font("Helvetica-Oblique").fontSize(8.5).fillColor(C.muted).text(t, { lineGap: 1.5 });
  doc.moveDown(0.2);
}
function code(block) {
  const pad = 7;
  const lineGap = 0.5;
  const innerW = WIDTH - pad * 2;
  doc.font("Courier").fontSize(8);
  // Measure the ACTUAL rendered height (accounts for soft-wrapping of long
  // lines), not just the newline count — otherwise the box is too short and
  // following content overlaps the overflow.
  const textH = doc.heightOfString(block, { width: innerW, lineGap });
  const height = textH + pad * 2;
  if (doc.y + height > doc.page.height - 44) doc.addPage();
  const y0 = doc.y;
  doc.rect(LEFT, y0, WIDTH, height).fillColor(C.codeBg).fill();
  doc.fillColor(C.code).text(block, LEFT + pad, y0 + pad, { width: innerW, lineGap });
  doc.y = y0 + height + 5;
  doc.fillColor(C.text);
}
function kv(rows) {
  doc.fontSize(9.5).fillColor(C.text);
  for (const [k, v] of rows) {
    doc.font("Helvetica-Bold").text(k + ":  ", { continued: true });
    doc.font("Courier").fontSize(9).text(v);
    doc.fontSize(9.5);
  }
  doc.font("Helvetica").moveDown(0.2);
}
function bullets(items) {
  doc.font("Helvetica").fontSize(9.5).fillColor(C.text);
  for (const it of items) doc.text("•  " + it, { lineGap: 1.5, indent: 4 });
  doc.moveDown(0.2);
}

// ============================== TITLE ====================================
doc.font("Helvetica-Bold").fontSize(19).fillColor(C.text).text("VRS NLA Lookup API");
doc.font("Helvetica").fontSize(10).fillColor(C.muted)
  .text("Integration guide — calling from another Replit app   ·   Generated " + new Date().toISOString().slice(0, 10));
doc.moveDown(0.15);

// ============================== OVERVIEW =================================
h1("Overview");
kv([
  ["Method", "GET"],
  ["Path", "/api/external/service-order/{SO}/nla"],
  ["Auth", "x-api-key header (machine-to-machine, no JWT)"],
  ["SO format", "DDDD-SSSSSSSS  (e.g. 8175-12345678)"],
]);
muted("Returns every parts_nla submission for the service order, newest first, regardless of ticket status. followedNlaProcess is true when at least one exists.");

// ============================== SETUP ===================================
h1("Setup");

h2("1. Add secrets to the other Replit app");
p("Open the Secrets pane (lock icon) in the calling app and add:");
kv([
  ["VRS_LOOKUP_API_KEY", "vrs_sMk6AGRRubsQFRC9lSF-E71ST-4FKCoFkpSsByfwVoU"],
  ["VRS_API_BASE", "https://<your-vrs-app>.replit.app"],
]);
muted("Replace <your-vrs-app> with this app's deployed URL (Deployments tab after publishing). Do not use the dev .repl.co preview URL.");

h2("2. Add the helper — server/vrsLookup.ts (Node 18+)");
code(`const VRS_BASE = process.env.VRS_API_BASE;
const VRS_KEY = process.env.VRS_LOOKUP_API_KEY;

export type VrsNlaSubmission = {
  id: number; serviceOrder: string; applianceType: string;
  requestType: string; ticketStatus: string;
  technician: { id: number; name: string; racId: string | null; phone: string | null };
  agent: { id: number; name: string } | null;
  escalatedBy: { id: number; name: string } | null;
  nlaResolution: string | null; nlaFoundPartNumber: string | null;
  partNumbers: string | null; technicianMessage: string | null; agentNotes: string | null;
  createdAt: string | null; claimedAt: string | null; statusChangedAt: string | null;
};
export type VrsNlaLookup = {
  serviceOrder: string; followedNlaProcess: boolean;
  nlaSubmissionCount: number; submissions: VrsNlaSubmission[];
};

export async function lookupNlaBySO(serviceOrder: string): Promise<VrsNlaLookup> {
  if (!VRS_BASE || !VRS_KEY) throw new Error("VRS_API_BASE and VRS_LOOKUP_API_KEY must be set");
  if (!/^\\d{4}-\\d{8}$/.test(serviceOrder)) throw new Error(\`Bad SO format: \${serviceOrder}\`);
  const url = \`\${VRS_BASE}/api/external/service-order/\${serviceOrder}/nla\`;
  const res = await fetch(url, { headers: { "x-api-key": VRS_KEY, accept: "application/json" } });
  if (!res.ok) throw new Error(\`VRS lookup \${res.status}: \${await res.text()}\`);
  return res.json() as Promise<VrsNlaLookup>;
}`);

h2("3. Call it");
code(`import { lookupNlaBySO } from "./vrsLookup";

const result = await lookupNlaBySO("8175-12345678");
if (result.followedNlaProcess) {
  for (const s of result.submissions)
    console.log(\`#\${s.id} \${s.ticketStatus} tech=\${s.technician.name} res=\${s.nlaResolution ?? "none"}\`);
} else {
  console.log("No NLA submission found for this SO");
}`);

h2("4. Shell sanity check");
code(`curl -H "x-api-key: vrs_sMk6AGRRubsQFRC9lSF-E71ST-4FKCoFkpSsByfwVoU" \\
  https://<your-vrs-app>.replit.app/api/external/service-order/8175-12345678/nla`);

// ============================== REFERENCE ===============================
h1("Reference");

h2("Response shape");
code(`{
  "serviceOrder": "8175-12345678",
  "followedNlaProcess": true,
  "nlaSubmissionCount": 1,
  "submissions": [{
    "id": 49, "ticketStatus": "queued", "applianceType": "refrigeration",
    "technician": { "id": 10, "name": "...", "racId": "...", "phone": "..." },
    "agent": { "id": 7, "name": "..." } | null,
    "escalatedBy": { "id": 10, "name": "..." } | null,
    "nlaResolution": "part_found_vrs_ordered", "nlaFoundPartNumber": null,
    "partNumbers": "[\\"WPW123456789\\"]",
    "technicianMessage": "...", "agentNotes": "...",
    "createdAt": "...", "claimedAt": "...", "statusChangedAt": "..."
  }]
}`);

h2("Status codes");
bullets([
  "200 — success; check nlaSubmissionCount",
  "400 — bad SO format",
  "401 — missing/invalid x-api-key",
  "503 — VRS_LOOKUP_API_KEY not set on the server",
  "500 — DB error",
]);

h2("Rotating the key");
bullets([
  "Update VRS_LOOKUP_API_KEY in Secrets on this VRS app.",
  "Update the same value in the calling app.",
  "No restart needed — value is read per request.",
]);

h2("Common gotchas");
bullets([
  "401  -  values don't match; check for trailing spaces.",
  "503  -  secret not set on the VRS app; set it and redeploy.",
  "400  -  SO must be 4 digits, hyphen, 8 digits.",
  "Network error  -  use the published deployment URL, not the dev preview.",
]);

h2("Security note");
doc.font("Helvetica").fontSize(9).fillColor(C.warn).text(
  "The payload includes technician name / RAC ID / phone and free-text notes — wider than a yes/no check needs. Treat the key like a password: keep it server-side, rotate when a developer leaves, never embed it in client code. Ask if you want a stripped-down summary endpoint.",
  { lineGap: 1.5 }
);
doc.fillColor(C.text);

doc.end();
await new Promise((res) => doc.on("end", res));
console.log("wrote", OUT);
