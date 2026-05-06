import twilio from "twilio";
import { storage } from "./storage";

// 2026-04-30 — Tyler request: business-hours awareness for the
// `submission_received` SMS. The standard template literally promises
// "Standard turnaround is a few minutes during business hours" but was
// firing 24/7 — a tech submitting at midnight got a text claiming an
// agent would review shortly when no agent was on shift. This helper
// gates the after-hours wording. VRS staffing window: Mon-Fri 8am-6pm
// America/Chicago. en-GB locale is used because en-US can return a
// 12-hour clock for `hour: "2-digit"` with `hour12: false` on some
// Node ICU builds, while en-GB reliably returns "00"-"23".
export function isAfterHoursCentral(now: Date = new Date()): boolean {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value;
  const hourStr = parts.find((p) => p.type === "hour")?.value;
  const hour = Number(hourStr);
  if (weekday === "Sat" || weekday === "Sun") return true;
  if (Number.isNaN(hour)) return false; // Safety net — never gate when we can't parse
  return hour < 8 || hour >= 18;
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (phone.startsWith("+")) return phone;
  return `+${digits}`;
}

function getTwilioConfig() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const rawPhone = process.env.TWILIO_PHONE_NUMBER;
  const phone = rawPhone ? normalizePhone(rawPhone) : undefined;
  return { sid, token, phone };
}

function getTwilioClient(): { client: ReturnType<typeof twilio>; phone: string } | null {
  const { sid, token, phone } = getTwilioConfig();
  if (!sid || !token || !phone) {
    console.warn(`[SMS] Twilio not configured — missing: ${[
      !sid && "TWILIO_ACCOUNT_SID",
      !token && "TWILIO_AUTH_TOKEN",
      !phone && "TWILIO_PHONE_NUMBER",
    ].filter(Boolean).join(", ")}`);
    return null;
  }
  return { client: twilio(sid, token), phone };
}

export async function sendSmsMessage(
  recipientPhone: string,
  messageBody: string
): Promise<{ success: boolean; twilioSid?: string; error?: string }> {
  const twilioConfig = getTwilioClient();
  const normalizedPhone = normalizePhone(recipientPhone);

  if (twilioConfig) {
    try {
      const message = await twilioConfig.client.messages.create({
        body: messageBody,
        from: twilioConfig.phone,
        to: normalizedPhone,
      });
      console.log(`[SMS] Sent to ${normalizedPhone} (from: ${recipientPhone}), SID: ${message.sid}`);
      return { success: true, twilioSid: message.sid };
    } catch (err: any) {
      console.error("Twilio SMS error:", err.message);
      return { success: false, error: err.message };
    }
  } else {
    console.log(`[SMS MOCK] To: ${recipientPhone} | Body: ${messageBody}`);
    return { success: true, twilioSid: `MOCK_${Date.now()}` };
  }
}

export async function sendSms(
  submissionId: number,
  recipientPhone: string,
  messageType: string,
  messageBody: string
): Promise<{ success: boolean; twilioSid?: string; error?: string }> {
  if (!recipientPhone) {
    console.error(`[SMS] No phone number for submission ${submissionId}, type: ${messageType}`);
    return { success: false, error: "No recipient phone number" };
  }

  const normalizedPhone = normalizePhone(recipientPhone);
  const twilioConfig = getTwilioClient();

  let twilioSid: string | null = null;

  if (twilioConfig) {
    try {
      const message = await twilioConfig.client.messages.create({
        body: messageBody,
        from: twilioConfig.phone,
        to: normalizedPhone,
      });
      twilioSid = message.sid;
      console.log(`[SMS] Sent ${messageType} to ${normalizedPhone} (input: ${recipientPhone}) for submission ${submissionId}, SID: ${message.sid}`);
    } catch (err: any) {
      console.error(`[SMS] Failed to send ${messageType} to ${recipientPhone} for submission ${submissionId}:`, err.message);
      await storage.createSmsNotification({
        submissionId,
        recipientPhone,
        messageType,
        messageBody,
        twilioSid: `ERROR: ${err.message}`,
      });
      return { success: false, error: err.message };
    }
  } else {
    console.log(`[SMS MOCK] To: ${recipientPhone} | Type: ${messageType} | Body: ${messageBody}`);
    twilioSid = `MOCK_${Date.now()}`;
  }

  await storage.createSmsNotification({
    submissionId,
    recipientPhone,
    messageType,
    messageBody,
    twilioSid,
  });

  return { success: true, twilioSid: twilioSid || undefined };
}

// ============================================================================
// Tyler 2026-04-29 — Communication Templates render layer
// ============================================================================
// Renders an admin-editable template from the `communication_templates` table
// by substituting `{varName}` placeholders. Returns null when the template is
// missing or a render error occurs — every call site below falls back to the
// hardcoded copy in that case so the SMS pipeline never silently breaks if
// the DB row is gone or a variable expansion fails.
//
// The hardcoded fallbacks are kept verbatim alongside the render call so that:
//   1. A grep for the live SMS copy still finds it in this file.
//   2. The admin UI can show "Restore default" by re-running the seed.
//   3. If an admin saves an edit that breaks something (missing variable,
//      typo), the fallback path silently keeps tech notifications flowing
//      while the issue gets fixed.

// Substitutes {varName} placeholders. Returns null if any placeholder in the
// template body has no corresponding non-empty value in `vars` — that null
// signals the caller to fall back to the hardcoded copy rather than send a
// message with blanks where data should be. This is the safety contract that
// guarantees admin typos (e.g. {servceOrder} instead of {serviceOrder}) can
// never produce a half-blank SMS to a technician.
function applyVariables(body: string, vars: Record<string, string | undefined | null>): string | null {
  let missing = false;
  const out = body.replace(/\{(\w+)\}/g, (_match, name) => {
    const v = vars[name];
    if (v == null || String(v).length === 0) {
      missing = true;
      return "";
    }
    return String(v);
  });
  return missing ? null : out;
}

export async function renderTemplate(
  actionKey: string,
  vars: Record<string, string | undefined | null>
): Promise<string | null> {
  try {
    const tpl = await storage.getCommunicationTemplate("sms", actionKey);
    if (!tpl) return null;
    const rendered = applyVariables(tpl.body, vars);
    if (rendered === null) {
      console.warn(`[SMS template] render fallback for ${actionKey}: unresolved placeholder(s) in body`);
      return null;
    }
    return rendered;
  } catch (err) {
    console.warn(`[SMS template] render fallback for ${actionKey}:`, (err as Error)?.message);
    return null;
  }
}

// ============================================================================
// Builders — each one tries the admin-editable template first and falls back
// to the hardcoded copy. CallSites in routes.ts use `await` on these now.
// ============================================================================

export async function buildStage1RejectedMessage(
  serviceOrder: string,
  reason: string,
  resubmitLink?: string
): Promise<string> {
  const rendered = await renderTemplate("ticket_rejected", {
    serviceOrder,
    reason,
    resubmitLink: resubmitLink ?? "",
    closingLine: resubmitLink
      ? `Tap to resubmit with your info saved:\n${resubmitLink}`
      : "Please contact your supervisor if you have questions.",
  });
  if (rendered !== null) return rendered;

  let msg = `VRS Update for SO#${serviceOrder}\n\nStatus: MORE INFO NEEDED\nReason: ${reason}`;
  if (resubmitLink) {
    msg += `\n\nTap to resubmit with your info saved:\n${resubmitLink}`;
  } else {
    msg += `\n\nPlease contact your supervisor if you have questions.`;
  }
  return msg;
}

export async function buildStage1InvalidMessage(
  serviceOrder: string,
  invalidReason: string,
  instructions?: string
): Promise<string> {
  const rendered = await renderTemplate("ticket_invalid", {
    serviceOrder,
    invalidReason,
    instructions: instructions ?? "",
    instructionsLine: instructions ? `\n\nInstructions: ${instructions}` : "",
  });
  if (rendered !== null) return rendered;

  let msg = `VRS Update for SO#${serviceOrder}\n\nStatus: NOT APPLICABLE\nReason: ${invalidReason}`;
  if (instructions) {
    msg += `\n\nInstructions: ${instructions}`;
  }
  msg += `\n\nThis request cannot be processed through VRS. Please follow the instructions above.`;
  return msg;
}

export async function buildRejectAndCloseMessage(
  serviceOrder: string,
  reason: string,
  warrantyType?: string
): Promise<string> {
  const wt = (warrantyType || "").toLowerCase();
  const isExternalWarranty = wt === "american_home_shield" || wt === "first_american";
  const isInfestation = /infestation/i.test(reason);
  const suppressCashCall = isExternalWarranty || isInfestation;
  const closing = suppressCashCall
    ? "This repair is not covered under warranty. No further VRS submissions can be made for this service order."
    : "This repair is not covered under warranty. You may offer the customer a cash call estimate for the repair. No further VRS submissions can be made for this service order.";

  // Closing line is baked into the seeded template body (not passed as a
  // var) so the admin sees and can edit the actual closing copy. The actionKey
  // routing handles which template variant to pull.
  const actionKey = suppressCashCall
    ? "ticket_rejected_closed.no_cash_call"
    : "ticket_rejected_closed.with_cash_call";
  const rendered = await renderTemplate(actionKey, {
    serviceOrder,
    reason,
  });
  if (rendered !== null) return rendered;
  void closing;

  return `VRS Update for SO#${serviceOrder}\n\nStatus: REJECTED — NOT COVERED\nReason: ${reason}\n\n${closing}`;
}

export async function buildNlaApprovalMessage(
  serviceOrder: string,
  rgcCode?: string | null,
  agentMessage?: string
): Promise<string> {
  const rendered = await renderTemplate("nla_approval", {
    serviceOrder,
    rgcCode: rgcCode ?? "",
    rgcLine: rgcCode
      ? `\nYour RGC/Auth Code: ${rgcCode}\nEnter this code in TechHub to complete the job.`
      : "",
    agentMessage: agentMessage ?? "",
    agentMessageLine: agentMessage ? `\n\n${agentMessage}` : "",
  });
  if (rendered !== null) return rendered;

  let msg = `VRS Authorization for SO#${serviceOrder}`;
  if (rgcCode) {
    msg += `\nYour RGC/Auth Code: ${rgcCode}\nEnter this code in TechHub to complete the job.`;
  }
  msg += `\n\nYour Parts NLA request has been received by the VRS Parts team. You will be contacted with further information regarding part sourcing and availability.`;
  if (agentMessage) {
    msg += `\n\n${agentMessage}`;
  }
  return msg;
}

export async function buildAuthCodeMessage(
  serviceOrder: string,
  authCode: string,
  rgcCode?: string | null,
  agentMessage?: string
): Promise<string> {
  const hasAuth = !!(authCode && authCode.trim());
  const hasRgc = !!(rgcCode && rgcCode.trim());

  const actionKey = hasAuth && hasRgc
    ? "ticket_approved.with_auth_and_rgc"
    : hasRgc
      ? "ticket_approved.rgc_only"
      : "ticket_approved.auth_only";

  const rendered = await renderTemplate(actionKey, {
    serviceOrder,
    authCode,
    rgcCode: rgcCode ?? "",
    agentMessage: agentMessage ?? "",
    agentMessageLine: agentMessage ? `\n\n${agentMessage}` : "",
  });
  if (rendered !== null) return rendered;

  let msg: string;
  if (hasAuth && hasRgc) {
    msg = `VRS Authorization for SO#${serviceOrder}\nAuthorization Code: ${authCode}\nRGC Code: ${rgcCode}\nEnter both codes in TechHub to complete the job.`;
  } else if (hasRgc) {
    msg = `VRS Authorization for SO#${serviceOrder}\nYour RGC/Auth Code: ${rgcCode}\nEnter this code in TechHub to complete the job.`;
  } else {
    msg = `VRS Authorization Code: Your auth code for SO# ${serviceOrder} is: ${authCode}. Please use this code to proceed with the repair.`;
  }
  if (agentMessage) {
    msg += `\n\n${agentMessage}`;
  }
  return msg;
}

export async function buildSubmissionReceivedMessage(
  serviceOrder: string,
  warrantyType?: string,
  requestType?: string
): Promise<string> {
  const wt = (warrantyType || "").toLowerCase();
  const isExternal = wt === "american_home_shield" || wt === "first_american";
  const isNla = requestType === "parts_nla";
  // 2026-04-30 — Tyler request: route to an after-hours variant when the
  // submission lands outside Mon-Fri 8am-6pm Central. Day variants keep
  // their existing copy; after-hours variants tell the tech to expect a
  // next-business-day response and explicitly release them from the site.
  const afterHours = isAfterHoursCentral();

  const dayKey = isNla
    ? "submission_received.nla"
    : isExternal
      ? "submission_received.external_warranty"
      : "submission_received.standard";

  // Render order matters here. After hours: try the after-hours variant
  // first; if that row is missing or its render fails, try the admin's
  // (potentially edited) day-variant template before falling all the way
  // through to the hardcoded copy below. This preserves admin overrides
  // even on environments where the seeded after-hours rows haven't landed
  // yet (e.g. brand-new prod) — flagged by architect review.
  if (afterHours) {
    const ah = await renderTemplate(`${dayKey}_after_hours`, { serviceOrder });
    if (ah !== null) return ah;
  }
  const dayRendered = await renderTemplate(dayKey, { serviceOrder });
  if (dayRendered !== null && !afterHours) return dayRendered;
  // If we're after-hours and only the day template is available, we still
  // fall through to the hardcoded after-hours copy below — better to ship
  // accurate after-hours wording than a misleading day-time promise.

  let waitCopy: string;
  if (isNla) {
    // 2026-04-28 (Tyler pilot-feedback Task A, stopgap):
    // Real-world turnaround for NLA sourcing is SAME DAY, not 1-2 business
    // days. The prior "1-2 business days" line was telling techs to expect
    // a multi-day wait, which combined with the claim-SMS "DO NOT LEAVE
    // THE SITE" wording was making them stand by at the home for hours.
    waitCopy = afterHours
      ? "NLA submission received outside of VRS parts-team hours (Mon–Fri 8am–6pm Central). The parts team will source this on the next business day. Reschedule this call accordingly — you'll receive a follow-up text with the sourcing decision when it's available."
      : "NLA submission received by the VRS parts team. Typical turnaround is same-day. Reschedule this call for later today and move on to your next stop — you'll receive a follow-up text with the sourcing decision.";
  } else if (isExternal) {
    waitCopy = afterHours
      ? "This is an external-warranty request (AHS / First American). Submitted outside of standard VRS hours (Mon–Fri 8am–6pm Central) — VRS will work this on the next business day, when the provider callback can be initiated. You do NOT need to remain at the site; you'll receive a follow-up text when the decision is made."
      : "This is an external-warranty request (AHS / First American). Approvals require a provider callback and can take longer than standard Sears Protect tickets. Please remain at the site until you receive the approval/rejection text.";
  } else {
    waitCopy = afterHours
      ? "Your submission was received outside of standard VRS hours (Mon–Fri 8am–6pm Central). It will be reviewed when agents are next available — typically the next business day. You do NOT need to remain at the site; you'll receive a follow-up text when the decision is made."
      : "A VRS agent will review your request shortly. Standard turnaround is a few minutes during business hours. Please remain at the site until you receive the approval/rejection text.";
  }

  return `VRS Submission received for SO#${serviceOrder}\n\n${waitCopy}\n\nYou will receive a follow-up text when the decision is made.`;
}

// ============================================================================
// New builders for templates that previously lived as inline strings inside
// routes.ts call sites. Extracting them lets the admin edit them through the
// Communication Templates page like every other tech-facing message.
// ============================================================================

export async function buildResubmissionClaimMessage(serviceOrder: string): Promise<string> {
  const rendered = await renderTemplate("ticket_claimed.resubmission", { serviceOrder });
  if (rendered !== null) return rendered;
  return `VRS Update for SO#${serviceOrder}: An agent is actively working on your resubmitted ticket. Stand by for confirmation of your submission, which will let you know when you can leave.\n\nDO NOT LEAVE THE SITE until you receive that confirmation text.`;
}

export async function buildStandardClaimMessage(serviceOrder: string): Promise<string> {
  const rendered = await renderTemplate("ticket_claimed.standard", { serviceOrder });
  if (rendered !== null) return rendered;
  return `VRS Update for SO#${serviceOrder}: An agent is actively working on your ticket. Stand by for confirmation of your submission, which will let you know when you can leave.\n\nDO NOT LEAVE THE SITE until you receive that confirmation text.`;
}

export async function buildTwoStageClaimMessage(serviceOrder: string): Promise<string> {
  const rendered = await renderTemplate("ticket_claimed.two_stage", { serviceOrder });
  if (rendered !== null) return rendered;
  return `VRS Update for SO#${serviceOrder}: An agent is actively working on your ticket. Stand by for confirmation of your submission, which will let you know when you can leave.\n\nDO NOT LEAVE THE SITE until you receive that confirmation text.\n\n1. Your photos and details will be reviewed. If anything is missing, you'll receive a text with details so you can quickly resubmit.\n2. If approved, VRS will obtain your authorization code and send it to you.`;
}

export async function buildSubmissionApprovedMessage(
  serviceOrder: string,
  technicianMessage?: string | null
): Promise<string> {
  const rendered = await renderTemplate("submission_approved.stage1", {
    serviceOrder,
    technicianMessage: technicianMessage ?? "",
    technicianMessageLine: technicianMessage ? `\n\n${technicianMessage}` : "",
  });
  if (rendered !== null) return rendered;

  const baseMsg = `VRS Update for SO#${serviceOrder}: Your submission has been reviewed and APPROVED. You are cleared to leave the site and head to your next call.\n\nIMPORTANT: Reschedule this call for the same day so you can reopen it later and enter the authorization code to finalize the part order.\n\nVRS is now working on obtaining your authorization code and will text it to you as soon as it is available.`;
  return technicianMessage ? `${baseMsg}\n\n${technicianMessage}` : baseMsg;
}

export async function buildNlaInvalidMessage(
  serviceOrder: string,
  invalidReason: string,
  instructions?: string | null
): Promise<string> {
  const rendered = await renderTemplate("nla_invalid", {
    serviceOrder,
    invalidReason,
    instructions: instructions ?? "",
    instructionsLine: instructions ? `\n\nInstructions: ${instructions}` : "",
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: INVALID NLA REQUEST\nReason: ${invalidReason}`;
  if (instructions) msg += `\n\nInstructions: ${instructions}`;
  return msg;
}

// ============================================================================
// Tyler 2026-04-29 (Phase B continuation): NLA second-stage resolution
// builders. These were previously inline string literals in routes.ts inside
// the `nla_*` action handlers (lines 1651-1785). Extracting them into
// renderTemplate-backed builders means EVERY tech-facing SMS the system
// sends now flows through the admin-editable Communication Templates table
// — there are no inline string literals left in the codebase that techs
// could receive.
//
// Each builder uses the same shape as the existing ones:
//   1. Try renderTemplate(actionKey, vars) — pulls admin-edited copy if set,
//      seeded default otherwise.
//   2. If that returns null (template missing or required var unresolved),
//      fall back to the byte-identical hardcoded string. The fallback is the
//      safety net Tyler explicitly asked for in the silent-blank-fix audit;
//      it ensures techs never receive an empty SMS even if the templates
//      table is wiped.
//
// `technicianMessageBlock` is a pre-formatted compound variable: empty
// string when no agent note, or `\n\n<prefix>: <message>` with the
// historically-correct prefix word ("Instructions:" / "Feedback from VRS — Action required:")
// baked in. This matches the `agentMessageLine` pattern already used in
// buildAuthCodeMessage and keeps existing tech-facing UX byte-identical.
// ============================================================================

export async function buildNlaReplacementSubmittedMessage(
  serviceOrder: string,
  rgcCode: string,
  technicianMessage?: string | null
): Promise<string> {
  const technicianMessageBlock = technicianMessage ? `\n\nInstructions: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_replacement_submitted", {
    serviceOrder,
    rgcCode,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: REPLACEMENT SUBMITTED\nAuth Code: ${rgcCode}\nThe part(s) you requested could not be sourced. A replacement request has been submitted to the warranty company.\n\nAction Required: Close the call using the NLA labor code.`;
  if (technicianMessage) msg += `\n\nInstructions: ${technicianMessage}`;
  return msg;
}

export async function buildNlaReplacementTechInitiatesMessage(
  serviceOrder: string,
  rgcCode: string,
  technicianMessage?: string | null
): Promise<string> {
  const technicianMessageBlock = technicianMessage ? `\n\nInstructions: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_replacement_tech_initiates", {
    serviceOrder,
    rgcCode,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: NLA REPLACEMENT APPROVED\nAuth Code: ${rgcCode}\nThe part(s) you requested could not be sourced. VRS has approved a replacement.\n\nAction Required: You must initiate the replacement in TechHub. Follow standard replacement procedures in TechHub to process this replacement.`;
  if (technicianMessage) msg += `\n\nInstructions: ${technicianMessage}`;
  return msg;
}

export async function buildNlaPartFoundVrsOrderedMessage(
  serviceOrder: string,
  rgcCode: string,
  technicianMessage?: string | null,
  // pcardConfirmContext: when called from the nla_pcard_confirm branch the
  // historical prefix was "Feedback from VRS:" not "Instructions:". Default
  // false preserves the original "Instructions:" prefix used in the
  // nla_part_found_vrs_ordered branch.
  fromPcardConfirm: boolean = false
): Promise<string> {
  const prefix = fromPcardConfirm ? "Feedback from VRS" : "Instructions";
  const technicianMessageBlock = technicianMessage ? `\n\n${prefix}: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_part_found_vrs_ordered", {
    serviceOrder,
    rgcCode,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: PART FOUND — ORDERED BY VRS\nAuth Code: ${rgcCode}\nThe VRS parts team has located and ordered the part(s) for this service order.`;
  if (technicianMessage) msg += `\n\n${prefix}: ${technicianMessage}`;
  return msg;
}

export async function buildNlaPartFoundTechOrdersMessage(
  serviceOrder: string,
  rgcCode: string,
  partNumber: string,
  technicianMessage?: string | null,
  fromPcardConfirm: boolean = false
): Promise<string> {
  // Same prefix-vs-pcard-context distinction. The original inline string for
  // nla_part_found_tech_orders used "Feedback from VRS — Action required:"
  // (note the em-dash + ALL CAPS Action), and the pcard branch used
  // "Feedback from VRS:" — keep both verbatim so techs see no change.
  const prefix = fromPcardConfirm ? "Feedback from VRS" : "Feedback from VRS — Action required";
  const technicianMessageBlock = technicianMessage ? `\n\n${prefix}: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_part_found_tech_orders", {
    serviceOrder,
    rgcCode,
    partNumber,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: PART FOUND — YOU NEED TO ORDER\nAuth Code: ${rgcCode}\nPart Number: ${partNumber}\n\nThis part is available in TechHub. Order it and reschedule the call.`;
  if (technicianMessage) msg += `\n\n${prefix}: ${technicianMessage}`;
  return msg;
}

export async function buildNlaRfrEligibleMessage(
  serviceOrder: string,
  rgcCode: string,
  technicianMessage?: string | null
): Promise<string> {
  const technicianMessageBlock = technicianMessage ? `\n\nInstructions: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_rfr_eligible", {
    serviceOrder,
    rgcCode,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: RFR ELIGIBLE\nAuth Code: ${rgcCode}\n\nThis part is RFR eligible. Remove the failed part and return it for repair, then reschedule the call in TechHub.`;
  if (technicianMessage) msg += `\n\nInstructions: ${technicianMessage}`;
  return msg;
}

export async function buildNlaPcardConfirmedGenericMessage(
  serviceOrder: string,
  rgcCode: string,
  technicianMessage?: string | null
): Promise<string> {
  // Generic fallback used by the nla_pcard_confirm branch when the
  // resolution type doesn't match the two specific cases (part_found_*).
  const technicianMessageBlock = technicianMessage ? `\n\nFeedback from VRS: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_pcard_confirmed.generic", {
    serviceOrder,
    rgcCode,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nAuth Code: ${rgcCode}\nYour NLA parts request has been processed by the VRS team.`;
  if (technicianMessage) msg += `\n\nFeedback from VRS: ${technicianMessage}`;
  return msg;
}

export async function buildNlaRejectedMessage(
  serviceOrder: string,
  reason: string,
  resubmitLink: string,
  technicianMessage?: string | null
): Promise<string> {
  const technicianMessageBlock = technicianMessage ? `\n\nFeedback from VRS — Action required: ${technicianMessage}` : "";
  const rendered = await renderTemplate("nla_rejected", {
    serviceOrder,
    reason,
    resubmitLink,
    technicianMessage: technicianMessage ?? "",
    technicianMessageBlock,
  });
  if (rendered !== null) return rendered;

  let msg = `VRS NLA Update for SO#${serviceOrder}\n\nStatus: MORE INFO NEEDED\nReason: ${reason}\n\nTap to resubmit:\n${resubmitLink}`;
  if (technicianMessage) msg += `\n\nFeedback from VRS — Action required: ${technicianMessage}`;
  return msg;
}
