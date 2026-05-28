import PDFDocument from "pdfkit";
import { createWriteStream } from "fs";

const OUT = "exports/vrs-nla-lookup-api.pdf";
const doc = new PDFDocument({
  size: "LETTER",
  margins: { top: 56, bottom: 56, left: 56, right: 56 },
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
  rule: "#e5e7eb",
  code: "#0f172a",
  codeBg: "#f1f5f9",
  accent: "#1d4ed8",
  warn: "#92400e",
};

function h1(t) {
  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(20).fillColor(C.text).text(t);
  const y = doc.y + 2;
  doc.moveTo(56, y).lineTo(556, y).strokeColor(C.rule).lineWidth(1).stroke();
  doc.moveDown(0.6);
}
function h2(t) {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(13).fillColor(C.text).text(t);
  doc.moveDown(0.25);
}
function p(t) {
  doc.font("Helvetica").fontSize(10.5).fillColor(C.text).text(t, { lineGap: 2 });
  doc.moveDown(0.3);
}
function muted(t) {
  doc.font("Helvetica-Oblique").fontSize(9.5).fillColor(C.muted).text(t, { lineGap: 2 });
  doc.moveDown(0.3);
}
function code(block) {
  const lines = block.split("\n");
  doc.font("Courier").fontSize(9);
  const padding = 8;
  const lineHeight = doc.currentLineHeight();
  const height = lines.length * lineHeight + padding * 2;
  const startX = 56;
  const width = 500;
  if (doc.y + height > doc.page.height - 56) doc.addPage();
  const startY = doc.y;
  doc.rect(startX, startY, width, height).fillColor(C.codeBg).fill();
  doc.fillColor(C.code);
  doc.text(block, startX + padding, startY + padding, { width: width - padding * 2, lineGap: 1 });
  doc.y = startY + height + 6;
  doc.fillColor(C.text);
}
function kv(rows) {
  doc.font("Helvetica").fontSize(10.5).fillColor(C.text);
  for (const [k, v] of rows) {
    doc.font("Helvetica-Bold").text(k + ":  ", { continued: true });
    doc.font("Courier").text(v);
  }
  doc.font("Helvetica").moveDown(0.3);
}
function bullets(items) {
  doc.font("Helvetica").fontSize(10.5).fillColor(C.text);
  for (const it of items) doc.text("•  " + it, { lineGap: 2, indent: 6 });
  doc.moveDown(0.3);
}

// =========================================================================
doc.font("Helvetica-Bold").fontSize(24).fillColor(C.text)
  .text("VRS NLA Lookup API");
doc.font("Helvetica").fontSize(11).fillColor(C.muted)
  .text("Integration guide — calling from another Replit app");
doc.moveDown(0.2);
doc.font("Helvetica").fontSize(9).fillColor(C.muted)
  .text("Generated " + new Date().toISOString().slice(0, 10));

h1("Endpoint");
kv([
  ["Method", "GET"],
  ["Path", "/api/external/service-order/{SO}/nla"],
  ["Auth", "x-api-key header (machine-to-machine, no JWT)"],
  ["SO format", "DDDD-SSSSSSSS  (e.g. 8175-12345678)"],
]);
muted("Returns every parts_nla submission for the given service order, newest first, regardless of ticket status.");

h1("Step 1 — Add secrets to the OTHER Replit app");
p("In the calling app, open the Secrets pane (lock icon in the sidebar) and add two entries:");
kv([
  ["Key", "VRS_LOOKUP_API_KEY"],
  ["Value", "vrs_sMk6AGRRubsQFRC9lSF-E71ST-4FKCoFkpSsByfwVoU"],
]);
kv([
  ["Key", "VRS_API_BASE"],
  ["Value", "https://<your-vrs-app>.replit.app"],
]);
muted("Replace <your-vrs-app> with this app's deployed URL — find it in the Deployments tab after publishing. Do NOT use the dev .repl.co preview URL.");

h1("Step 2 — Paste this helper into the other app");
p("File: server/vrsLookup.ts  (TypeScript, works on Node 18+)");
code(`const VRS_BASE = process.env.VRS_API_BASE;
const VRS_KEY = process.env.VRS_LOOKUP_API_KEY;

export type VrsNlaSubmission = {
  id: number;
  serviceOrder: string;
  applianceType: string;
  requestType: string;
  ticketStatus: string;
  technician: { id: number; name: string; racId: string | null; phone: string | null };
  agent: { id: number; name: string } | null;
  escalatedBy: { id: number; name: string } | null;
  nlaResolution: string | null;
  nlaFoundPartNumber: string | null;
  partNumbers: string | null;
  technicianMessage: string | null;
  agentNotes: string | null;
  createdAt: string | null;
  claimedAt: string | null;
  statusChangedAt: string | null;
};

export type VrsNlaLookup = {
  serviceOrder: string;
  followedNlaProcess: boolean;
  nlaSubmissionCount: number;
  submissions: VrsNlaSubmission[];
};

export async function lookupNlaBySO(serviceOrder: string): Promise<VrsNlaLookup> {
  if (!VRS_BASE || !VRS_KEY) {
    throw new Error("VRS_API_BASE and VRS_LOOKUP_API_KEY must be set");
  }
  if (!/^\\d{4}-\\d{8}$/.test(serviceOrder)) {
    throw new Error(\`Bad SO format: \${serviceOrder} (expected DDDD-SSSSSSSS)\`);
  }
  const url = \`\${VRS_BASE}/api/external/service-order/\${serviceOrder}/nla\`;
  const res = await fetch(url, {
    headers: { "x-api-key": VRS_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(\`VRS lookup \${res.status}: \${body}\`);
  }
  return res.json() as Promise<VrsNlaLookup>;
}`);

h1("Step 3 — Call it from anywhere in that app");
code(`import { lookupNlaBySO } from "./vrsLookup";

const result = await lookupNlaBySO("8175-12345678");

if (result.followedNlaProcess) {
  console.log(\`Tech followed NLA process — \${result.nlaSubmissionCount} submission(s)\`);
  for (const s of result.submissions) {
    console.log(\`  #\${s.id}  status=\${s.ticketStatus}  tech=\${s.technician.name}  \` +
                \`resolution=\${s.nlaResolution ?? "none"}\`);
  }
} else {
  console.log("No NLA submission found for this SO");
}`);

h1("Step 4 — Quick shell sanity check");
code(`curl -H "x-api-key: vrs_sMk6AGRRubsQFRC9lSF-E71ST-4FKCoFkpSsByfwVoU" \\
  https://<your-vrs-app>.replit.app/api/external/service-order/8175-12345678/nla`);
muted("Expect a 200 with JSON containing \"followedNlaProcess\": true (for an SO that has NLA history).");

h1("Response shape");
code(`{
  "serviceOrder": "8175-12345678",
  "followedNlaProcess": true,
  "nlaSubmissionCount": 1,
  "submissions": [{
    "id": 49,
    "ticketStatus": "queued",
    "applianceType": "refrigeration",
    "technician": { "id": 10, "name": "...", "racId": "...", "phone": "..." },
    "agent": { "id": 7, "name": "..." } | null,
    "escalatedBy": { "id": 10, "name": "..." } | null,
    "nlaResolution": "part_found_vrs_ordered",
    "nlaFoundPartNumber": null,
    "partNumbers": "[\\"WPW123456789\\"]",
    "technicianMessage": "...",
    "agentNotes": "...",
    "createdAt": "2026-04-05T17:43:00.756Z",
    "claimedAt":  "2026-04-22T21:24:41.742Z",
    "statusChangedAt": "2026-04-27T12:32:54.488Z"
  }]
}`);
p("followedNlaProcess is the headline boolean — true if any parts_nla submission exists for that SO (any status).");

h1("Status codes");
bullets([
  "200 — query succeeded; check nlaSubmissionCount",
  "400 — bad SO format",
  "401 — missing or invalid x-api-key",
  "503 — VRS_LOOKUP_API_KEY is not set on this app",
  "500 — DB error",
]);

h1("Rotating the key");
bullets([
  "Update VRS_LOOKUP_API_KEY in Replit Secrets on this (VRS) app.",
  "Update the same value in the calling app's secrets.",
  "No restart needed on either side — the value is read per request.",
]);

h1("Common gotchas");
bullets([
  "401 → secret values don't match. Check both apps for trailing spaces.",
  "503 → secret isn't set on the VRS app yet. Set it and redeploy.",
  "400 → SO must be 4 digits, hyphen, 8 digits (e.g. 8175-12345678).",
  "Network error → ensure VRS_API_BASE points to the published deployment URL, not the dev preview.",
]);

h1("Security note");
doc.font("Helvetica").fontSize(10.5).fillColor(C.warn);
doc.text(
  "The payload includes technician name / RAC ID / phone and free-text agent notes — wider than the minimum needed for a yes/no check. Treat the key like a password: keep it server-side, rotate when a developer leaves, and never embed it in client-side code. If you ever want a stripped-down summary endpoint, ask and we'll add one.",
  { lineGap: 2 }
);
doc.fillColor(C.text);

doc.end();

await new Promise((res) => doc.on("end", res));
console.log("wrote", OUT);
