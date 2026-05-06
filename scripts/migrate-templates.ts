/**
 * Task B Phase B C.1 — pre-load communication_templates with verbatim
 * copy from the existing hard-coded SMS strings.
 *
 * Run manually:  tsx scripts/migrate-templates.ts
 *
 * Idempotent: skips any (channel, action_key) row that already exists.
 * Every insert also writes a matching v1 row to communication_template_versions.
 *
 * Scope notes:
 *   - SMS only. Email and Push pre-staged in the channel enum but no rows
 *     are seeded here — admin UI will show "No templates configured" for
 *     those channels until Phase D wires them up.
 *   - Branchy templates split into dotted sub-keys (e.g.
 *     "ticket_claimed.standard", "ticket_claimed.two_stage"). The render
 *     layer in C.2 picks the right sub-key from runtime context;
 *     branch-selection logic stays in code, admins edit each branch's
 *     text independently.
 *   - Password-reset SMS is intentionally absent (security-critical, stays
 *     in code with a NOT-IN-TEMPLATES marker comment when C.2 lands).
 *   - Bodies are byte-for-byte copies of the current strings except that
 *     literal interpolations like ${submission.serviceOrder} are replaced
 *     with {{serviceOrder}} placeholders. Optional appendages (like
 *     "\n\n${technicianMessage}" if present) are represented as a single
 *     {{technicianMessageBlock}} placeholder that the render layer expands
 *     to either an empty string or "\n\n<message>" based on input.
 *   - "Available variables" panel data lives in the `variables` JSONB
 *     column on each row — the admin UI reads it to show insertion chips
 *     and validate previews.
 *
 * Source-of-truth references for each template are noted inline so a
 * future maintainer can verify the seed against the live code.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../server/storage";
import {
  communicationTemplates,
  communicationTemplateVersions,
} from "../shared/schema";

type Variable = {
  name: string;
  required: boolean;
  sample: string;
  description?: string;
};

type SmsTemplate = {
  actionKey: string;
  body: string;
  variables: Variable[];
  source: string; // file:line reference for traceability
};

const SMS_TEMPLATES: SmsTemplate[] = [
  // -----------------------------------------------------------------
  // submission_received.* — sent immediately when a tech submits a ticket
  // (server/routes.ts:682, body built by buildSubmissionReceivedMessage in
  // server/sms.ts:170-200). Three branches by warranty/request type.
  // -----------------------------------------------------------------
  {
    actionKey: "submission_received.standard",
    source: "server/sms.ts:195-196 (standard branch)",
    body:
      "VRS Submission received for SO#{{serviceOrder}}\n\n" +
      "A VRS agent will review your request shortly. Standard turnaround is a few minutes during business hours. Please remain at the site until you receive the approval/rejection text.\n\n" +
      "You will receive a follow-up text when the decision is made.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
    ],
  },
  {
    actionKey: "submission_received.external_warranty",
    source: "server/sms.ts:192-193 (AHS / First American branch)",
    body:
      "VRS Submission received for SO#{{serviceOrder}}\n\n" +
      "This is an external-warranty request (AHS / First American). Approvals require a provider callback and can take longer than standard Sears Protect tickets. Please remain at the site until you receive the approval/rejection text.\n\n" +
      "You will receive a follow-up text when the decision is made.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
    ],
  },
  {
    actionKey: "submission_received.parts_nla",
    source: "server/sms.ts:189-190 (NLA branch — Tyler Task A 2026-04-28)",
    body:
      "VRS Submission received for SO#{{serviceOrder}}\n\n" +
      "NLA submission received by the VRS parts team. Typical turnaround is same-day. Reschedule this call for later today and move on to your next stop — you'll receive a follow-up text with the sourcing decision.\n\n" +
      "You will receive a follow-up text when the decision is made.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
    ],
  },

  // -----------------------------------------------------------------
  // ticket_claimed.* — sent when an agent claims a ticket from the queue.
  // Suppressed entirely for parts_nla (Tyler Task A 2026-04-28, see
  // server/routes.ts:1267 `if (!isNla)` guard). Three branches preserved:
  //   - standard: single-stage Sears Protect (server/routes.ts:1272)
  //   - two_stage: AHS / First American (server/routes.ts:1270)
  //   - resubmit: tech resubmitted a previously-rejected ticket
  //               (server/routes.ts:700)
  // -----------------------------------------------------------------
  {
    actionKey: "ticket_claimed.standard",
    source: "server/routes.ts:1272 (single-stage Sears Protect claim)",
    body:
      "VRS Update for SO#{{serviceOrder}}: An agent is actively working on your ticket. Stand by for confirmation of your submission, which will let you know when you can leave.\n\n" +
      "DO NOT LEAVE THE SITE until you receive that confirmation text.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
    ],
  },
  {
    actionKey: "ticket_claimed.two_stage",
    source: "server/routes.ts:1270 (AHS / First American two-stage claim)",
    body:
      "VRS Update for SO#{{serviceOrder}}: An agent is actively working on your ticket. Stand by for confirmation of your submission, which will let you know when you can leave.\n\n" +
      "DO NOT LEAVE THE SITE until you receive that confirmation text.\n\n" +
      "1. Your photos and details will be reviewed. If anything is missing, you'll receive a text with details so you can quickly resubmit.\n" +
      "2. If approved, VRS will obtain your authorization code and send it to you.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
    ],
  },
  {
    actionKey: "ticket_claimed.resubmit",
    source: "server/routes.ts:700 (tech resubmitted a rejected ticket)",
    body:
      "VRS Update for SO#{{serviceOrder}}: An agent is actively working on your resubmitted ticket. Stand by for confirmation of your submission, which will let you know when you can leave.\n\n" +
      "DO NOT LEAVE THE SITE until you receive that confirmation text.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
    ],
  },

  // -----------------------------------------------------------------
  // submission_approved — Stage-1 approval ("you can leave the site, auth
  // code is coming"). Single template; agent's optional technician message
  // is appended via {{technicianMessageBlock}} placeholder.
  //   server/routes.ts:1362
  // -----------------------------------------------------------------
  {
    actionKey: "submission_approved",
    source: "server/routes.ts:1362",
    body:
      "VRS Update for SO#{{serviceOrder}}: Your submission has been reviewed and APPROVED. You are cleared to leave the site and head to your next call.\n\n" +
      "IMPORTANT: Reschedule this call for the same day so you can reopen it later and enter the authorization code to finalize the part order.\n\n" +
      "VRS is now working on obtaining your authorization code and will text it to you as soon as it is available.{{technicianMessageBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175", description: "Service order number" },
      { name: "technicianMessageBlock", required: false, sample: "\n\nPlease confirm the model number on the unit.", description: "Optional agent note; render layer expands to '\\n\\n<message>' or empty string" },
    ],
  },

  // -----------------------------------------------------------------
  // ticket_approved.* — Stage-2 approval (auth code delivered). Branchy
  // by which codes are present:
  //   - auth_and_rgc: external warranty with both codes
  //   - rgc_only:     standard Sears Protect (rgc == auth)
  //   - auth_only:    legacy/edge case (no rgc)
  //   - nla:          parts_nla approval (different copy entirely)
  //   server/sms.ts:153-168 buildAuthCodeMessage + 141-151 buildNlaApprovalMessage
  // -----------------------------------------------------------------
  {
    actionKey: "ticket_approved.auth_and_rgc",
    source: "server/sms.ts:158 (external warranty with both codes)",
    body:
      "VRS Authorization for SO#{{serviceOrder}}\n" +
      "Authorization Code: {{authCode}}\n" +
      "RGC Code: {{rgcCode}}\n" +
      "Enter both codes in TechHub to complete the job.{{technicianMessageBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "authCode", required: true, sample: "AHS-998877" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "technicianMessageBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "ticket_approved.rgc_only",
    source: "server/sms.ts:160 (standard Sears Protect — single code)",
    body:
      "VRS Authorization for SO#{{serviceOrder}}\n" +
      "Your RGC/Auth Code: {{rgcCode}}\n" +
      "Enter this code in TechHub to complete the job.{{technicianMessageBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "technicianMessageBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "ticket_approved.auth_only",
    source: "server/sms.ts:162 (legacy fallback — no RGC)",
    body:
      "VRS Authorization Code: Your auth code for SO# {{serviceOrder}} is: {{authCode}}. Please use this code to proceed with the repair.{{technicianMessageBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "authCode", required: true, sample: "AUTH-123456" },
      { name: "technicianMessageBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "ticket_approved.nla",
    source: "server/sms.ts:142+146 buildNlaApprovalMessage (with RGC — live branch)",
    body:
      "VRS Authorization for SO#{{serviceOrder}}\n" +
      "Your RGC/Auth Code: {{rgcCode}}\n" +
      "Enter this code in TechHub to complete the job.\n\n" +
      "Your Parts NLA request has been received by the VRS Parts team. You will be contacted with further information regarding part sourcing and availability.{{technicianMessageBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "technicianMessageBlock", required: false, sample: "" },
    ],
  },

  // -----------------------------------------------------------------
  // ticket_rejected — "more info needed", with resubmit link.
  //   server/sms.ts:111-118 buildStage1RejectedMessage
  //   server/routes.ts:1459 (live caller, always passes resubmitLink)
  // -----------------------------------------------------------------
  {
    actionKey: "ticket_rejected",
    source: "server/sms.ts:112-114 (with resubmitLink — live branch)",
    body:
      "VRS Update for SO#{{serviceOrder}}\n\n" +
      "Status: MORE INFO NEEDED\n" +
      "Reason: {{reason}}\n\n" +
      "Tap to resubmit with your info saved:\n" +
      "{{resubmitLink}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "reason", required: true, sample: "Photos missing model plate; please retake.", description: "Composed reason text including rejection reasons + media issues + agent message" },
      { name: "resubmitLink", required: true, sample: "https://vrs.example.com/tech/resubmit/123", description: "Auto-generated; do not edit the placeholder" },
    ],
  },

  // -----------------------------------------------------------------
  // ticket_rejected_closed.* — Stage-1 reject-and-close (not covered).
  // Branchy by warranty: AHS/First American + infestation cases suppress
  // the cash-call line; everything else offers cash call.
  //   server/sms.ts:130-139 buildRejectAndCloseMessage
  // -----------------------------------------------------------------
  {
    actionKey: "ticket_rejected_closed.no_cash_call",
    source: "server/sms.ts:136 (AHS/First American/infestation — suppress cash-call offer)",
    body:
      "VRS Update for SO#{{serviceOrder}}\n\n" +
      "Status: REJECTED — NOT COVERED\n" +
      "Reason: {{reason}}\n\n" +
      "This repair is not covered under warranty. No further VRS submissions can be made for this service order.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "reason", required: true, sample: "Pre-existing damage", description: "Composed reason + optional agent feedback" },
    ],
  },
  {
    actionKey: "ticket_rejected_closed.cash_call",
    source: "server/sms.ts:137 (Sears Protect — offer cash-call estimate)",
    body:
      "VRS Update for SO#{{serviceOrder}}\n\n" +
      "Status: REJECTED — NOT COVERED\n" +
      "Reason: {{reason}}\n\n" +
      "This repair is not covered under warranty. You may offer the customer a cash call estimate for the repair. No further VRS submissions can be made for this service order.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "reason", required: true, sample: "Cosmetic damage only", description: "Composed reason + optional agent feedback" },
    ],
  },

  // -----------------------------------------------------------------
  // ticket_invalid — "not applicable to VRS, do this instead".
  //   server/sms.ts:121-127 buildStage1InvalidMessage
  // Optional `instructions` block is collapsed into a single placeholder.
  // -----------------------------------------------------------------
  {
    actionKey: "ticket_invalid",
    source: "server/sms.ts:122-126",
    body:
      "VRS Update for SO#{{serviceOrder}}\n\n" +
      "Status: NOT APPLICABLE\n" +
      "Reason: {{invalidReason}}{{invalidInstructionsBlock}}\n\n" +
      "This request cannot be processed through VRS. Please follow the instructions above.",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "invalidReason", required: true, sample: "Service order has been closed in TechHub" },
      { name: "invalidInstructionsBlock", required: false, sample: "\n\nInstructions: Reopen the SO and resubmit.", description: "Optional; render layer expands to '\\n\\nInstructions: <text>' or empty string" },
    ],
  },

  // -----------------------------------------------------------------
  // NLA resolution outcomes (Parts NLA workflow).
  // All carry an Auth Code from the daily RGC + an optional agent message.
  //   server/routes.ts:1639, 1652, 1668, 1685, 1698, 1747-1752, 1773, 1791
  // -----------------------------------------------------------------
  {
    actionKey: "nla_replacement_submitted",
    source: "server/routes.ts:1639",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: REPLACEMENT SUBMITTED\n" +
      "Auth Code: {{rgcCode}}\n" +
      "The part(s) you requested could not be sourced. A replacement request has been submitted to the warranty company.\n\n" +
      "Action Required: Close the call using the NLA labor code.{{instructionsBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "instructionsBlock", required: false, sample: "\n\nInstructions: Use labor code 7842.", description: "Optional agent message; expands to '\\n\\nInstructions: <text>' or empty" },
    ],
  },
  {
    actionKey: "nla_replacement_tech_initiates",
    source: "server/routes.ts:1652",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: NLA REPLACEMENT APPROVED\n" +
      "Auth Code: {{rgcCode}}\n" +
      "The part(s) you requested could not be sourced. VRS has approved a replacement.\n\n" +
      "Action Required: You must initiate the replacement in TechHub. Follow standard replacement procedures in TechHub to process this replacement.{{instructionsBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "instructionsBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "nla_part_ordered_vrs",
    source: "server/routes.ts:1668",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: PART FOUND — ORDERED BY VRS\n" +
      "Auth Code: {{rgcCode}}\n" +
      "The VRS parts team has located and ordered the part(s) for this service order.{{instructionsBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "instructionsBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "nla_part_tech_orders",
    source: "server/routes.ts:1685",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: PART FOUND — YOU NEED TO ORDER\n" +
      "Auth Code: {{rgcCode}}\n" +
      "Part Number: {{partNumber}}\n\n" +
      "This part is available in TechHub. Order it and reschedule the call.{{feedbackBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "partNumber", required: true, sample: "WP67005560" },
      { name: "feedbackBlock", required: false, sample: "\n\nFeedback from VRS — Action required: Use the alternate part.", description: "Optional agent message; expands to '\\n\\nFeedback from VRS — Action required: <text>' or empty" },
    ],
  },
  {
    actionKey: "nla_rfr_eligible",
    source: "server/routes.ts:1698",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: RFR ELIGIBLE\n" +
      "Auth Code: {{rgcCode}}\n\n" +
      "This part is RFR eligible. Remove the failed part and return it for repair, then reschedule the call in TechHub.{{instructionsBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "instructionsBlock", required: false, sample: "" },
    ],
  },
  // P-card-confirmed templates: same wording as the direct VRS-ordered/tech-ordered
  // versions but sent from a different code path (after P-card escalation). Kept as
  // separate sub-keys so admins can intentionally diverge them later if needed
  // (e.g. add "this was processed by the P-card team" preamble).
  {
    actionKey: "nla_pcard_confirmed.part_found_vrs",
    source: "server/routes.ts:1747 (post-escalation, mirrors nla_part_ordered_vrs)",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: PART FOUND — ORDERED BY VRS\n" +
      "Auth Code: {{rgcCode}}\n" +
      "The VRS parts team has located and ordered the part(s) for this service order.{{feedbackBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "feedbackBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "nla_pcard_confirmed.part_found_tech",
    source: "server/routes.ts:1750 (post-escalation, mirrors nla_part_tech_orders)",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: PART FOUND — YOU NEED TO ORDER\n" +
      "Auth Code: {{rgcCode}}\n" +
      "Part Number: {{partNumber}}\n\n" +
      "This part is available in TechHub. Order it and reschedule the call.{{feedbackBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "partNumber", required: true, sample: "WP67005560" },
      { name: "feedbackBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "nla_pcard_confirmed.fallback",
    source: "server/routes.ts:1752 (post-escalation generic fallback)",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Auth Code: {{rgcCode}}\n" +
      "Your NLA parts request has been processed by the VRS team.{{feedbackBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "rgcCode", required: true, sample: "RGC-123456" },
      { name: "feedbackBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "nla_rejected",
    source: "server/routes.ts:1773",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: MORE INFO NEEDED\n" +
      "Reason: {{reason}}\n\n" +
      "Tap to resubmit:\n" +
      "{{resubmitLink}}{{feedbackBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "reason", required: true, sample: "Part number unclear; please retake the photo of the rating plate." },
      { name: "resubmitLink", required: true, sample: "https://vrs.example.com/tech/resubmit/123", description: "Auto-generated; do not edit" },
      { name: "feedbackBlock", required: false, sample: "" },
    ],
  },
  {
    actionKey: "nla_invalid",
    source: "server/routes.ts:1791",
    body:
      "VRS NLA Update for SO#{{serviceOrder}}\n\n" +
      "Status: INVALID NLA REQUEST\n" +
      "Reason: {{invalidReason}}{{invalidInstructionsBlock}}",
    variables: [
      { name: "serviceOrder", required: true, sample: "7435-13629175" },
      { name: "invalidReason", required: true, sample: "Service order is not eligible for NLA processing" },
      { name: "invalidInstructionsBlock", required: false, sample: "\n\nInstructions: File via the standard NLA channel." },
    ],
  },
];

async function seedTemplate(t: SmsTemplate): Promise<"inserted" | "skipped"> {
  const existing = await db
    .select()
    .from(communicationTemplates)
    .where(
      and(
        eq(communicationTemplates.channel, "sms"),
        eq(communicationTemplates.actionKey, t.actionKey)
      )
    )
    .limit(1);

  if (existing.length) {
    console.log(`[skip] sms/${t.actionKey} (id=${existing[0].id}, v=${existing[0].currentVersion})`);
    return "skipped";
  }

  const [inserted] = await db
    .insert(communicationTemplates)
    .values({
      channel: "sms",
      actionKey: t.actionKey,
      body: t.body,
      variables: t.variables as any,
      isDefault: true,
      isActive: true,
      currentVersion: 1,
      updatedBy: null,
    })
    .returning();

  await db.insert(communicationTemplateVersions).values({
    templateId: inserted.id,
    version: 1,
    body: t.body,
    variables: t.variables as any,
    editedBy: null,
    editReason: `Seeded from ${t.source} (Phase B C.1 migration)`,
  });

  console.log(`[insert] sms/${t.actionKey} (id=${inserted.id}, v=1) — ${t.source}`);
  return "inserted";
}

async function main() {
  console.log(`=== Seeding ${SMS_TEMPLATES.length} SMS communication templates ===`);
  let inserted = 0;
  let skipped = 0;
  for (const t of SMS_TEMPLATES) {
    const result = await seedTemplate(t);
    if (result === "inserted") inserted += 1;
    else skipped += 1;
  }
  console.log(`=== Done. Inserted: ${inserted}, Skipped: ${skipped}, Total: ${SMS_TEMPLATES.length} ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
