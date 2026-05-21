export type SmsPreviewContext = {
  serviceOrder: string;
  action:
    | "approve"
    | "approve_submission"
    | "approve_replacement_review"
    | "reject"
    | "reject_and_close"
    | "invalid"
    | "nla_replacement_submitted"
    | "nla_replacement_tech_initiates"
    | "nla_part_found_vrs_ordered"
    | "nla_part_found_tech_orders"
    | "nla_reject"
    | "nla_invalid"
    | "nla_rfr_eligible";
  message?: string;
  rejectionReasons?: string[];
  rejectedMediaSummary?: string[];
  rejectCloseReason?: string;
  invalidReasons?: string[];
  invalidInstructions?: string;
  rgcCode?: string | null;
  authCode?: string;
  authCodeProvider?: string;
  partNumber?: string;
  isNlaApproval?: boolean;
  warrantyType?: string;
};

export function shouldSuppressCashCall(warrantyType?: string, reasonText?: string): boolean {
  const wt = (warrantyType || "").toLowerCase();
  if (wt === "american_home_shield" || wt === "first_american") return true;
  if (reasonText && /infestation/i.test(reasonText)) return true;
  return false;
}

const RESUBMIT_PLACEHOLDER = "(resubmit link will be included)";

export function buildSmsPreview(ctx: SmsPreviewContext): string {
  const so = ctx.serviceOrder || "______";
  const msg = (ctx.message || "").trim();

  switch (ctx.action) {
    case "approve_submission": {
      const base = `VRS Update for SO#${so}: Your submission has been reviewed and APPROVED. You are cleared to leave the site and head to your next call.\n\nIMPORTANT: Reschedule this call for the same day so you can reopen it later and enter the authorization code to finalize the part order.\n\nVRS is now working on obtaining your authorization code and will text it to you as soon as it is available.`;
      return msg ? `${base}\n\n${msg}` : base;
    }

    case "approve": {
      if (ctx.isNlaApproval) {
        let m = `VRS Authorization for SO#${so}`;
        if (ctx.rgcCode) {
          m += `\nYour RGC/Auth Code: ${ctx.rgcCode}\nEnter this code in TechHub to complete the job.`;
        }
        m += `\n\nYour Parts NLA request has been received by the VRS Parts team. You will be contacted with further information regarding part sourcing and availability.`;
        if (msg) m += `\n\n${msg}`;
        return m;
      }
      let m: string;
      const hasAuth = !!(ctx.authCode && ctx.authCode.trim());
      const hasRgc = !!(ctx.rgcCode && ctx.rgcCode.trim());
      if (hasAuth && hasRgc) {
        m = `VRS Authorization for SO#${so}\nStatus: APPROVED TO REPAIR\nAuthorization Code: ${ctx.authCode}\nRGC Code: ${ctx.rgcCode}\nEnter both codes in TechHub to complete the job.`;
      } else if (hasRgc) {
        m = `VRS Authorization for SO#${so}\nStatus: APPROVED TO REPAIR\nYour RGC/Auth Code: ${ctx.rgcCode}\nEnter this code in TechHub to complete the job.`;
      } else {
        m = `VRS Authorization for SO# ${so}\nStatus: APPROVED TO REPAIR\nAuth Code: ${ctx.authCode || "______"}\nUse this code to proceed with the repair.`;
      }
      if (msg) m += `\n\n${msg}`;
      return m;
    }

    case "approve_replacement_review": {
      const hasAuth = !!(ctx.authCode && ctx.authCode.trim());
      const hasRgc = !!(ctx.rgcCode && ctx.rgcCode.trim());
      const codeLines: string[] = [];
      if (hasAuth) codeLines.push(`Replacement Code: ${ctx.authCode}`);
      if (hasRgc && ctx.rgcCode !== ctx.authCode) codeLines.push(`RGC Code: ${ctx.rgcCode}`);
      let m = `VRS Update for SO#${so}\n\nStatus: PLACED INTO REPLACEMENT REVIEW`;
      if (codeLines.length) m += `\n${codeLines.join("\n")}`;
      m += `\n\nPlaced into Replacement Review, remove all parts from the order and select the proper replacement labor code and close the call.`;
      if (msg) m += `\n\nFeedback from VRS: ${msg}`;
      return m;
    }

    case "reject": {
      const parts: string[] = [];
      if (ctx.rejectionReasons && ctx.rejectionReasons.length > 0) {
        parts.push(ctx.rejectionReasons.join(", "));
      }
      if (ctx.rejectedMediaSummary && ctx.rejectedMediaSummary.length > 0) {
        parts.push(ctx.rejectedMediaSummary.join("; "));
      }
      const reason = parts.length > 0 ? parts.join(". ") : "More information needed";
      const full = msg ? `${reason}\n\nFeedback from VRS — Action required: ${msg}` : reason;
      return `VRS Update for SO#${so}\n\nStatus: MORE INFO NEEDED\nReason: ${full}\n\nTap to resubmit with your info saved:\n${RESUBMIT_PLACEHOLDER}`;
    }

    case "reject_and_close": {
      const reason = ctx.rejectCloseReason || "Not covered under warranty";
      const full = msg ? `${reason}\n\nFeedback from VRS: ${msg}` : reason;
      const suppress = shouldSuppressCashCall(ctx.warrantyType, `${reason} ${msg}`);
      const closing = suppress
        ? "This repair is not covered under warranty. No further VRS submissions can be made for this service order."
        : "This repair is not covered under warranty. You may offer the customer a cash call estimate for the repair. No further VRS submissions can be made for this service order.";
      return `VRS Update for SO#${so}\n\nStatus: REJECTED — NOT COVERED\nReason: ${full}\n\n${closing}`;
    }

    case "invalid": {
      const reason =
        (ctx.invalidReasons && ctx.invalidReasons.length > 0
          ? ctx.invalidReasons.join(", ")
          : "") || "Request not applicable";
      let m = `VRS Update for SO#${so}\n\nStatus: NOT APPLICABLE\nReason: ${reason}`;
      const instructions = (ctx.invalidInstructions || msg || "").trim();
      if (instructions) m += `\n\nInstructions: ${instructions}`;
      m += `\n\nThis request cannot be processed through VRS. Please follow the instructions above.`;
      return m;
    }

    case "nla_part_found_tech_orders": {
      let m = `VRS NLA Update for SO#${so}\n\nStatus: PART FOUND — YOU NEED TO ORDER\nAuth Code: ${ctx.rgcCode || "______"}\nPart Number: ${ctx.partNumber?.trim().toUpperCase() || "______"}\n\nThis part is available in TechHub. Order it and reschedule the call.`;
      if (msg) m += `\n\nFeedback from VRS — Action required: ${msg}`;
      return m;
    }

    case "nla_part_found_vrs_ordered": {
      let m = `VRS NLA Update for SO#${so}\n\nStatus: PART FOUND — ORDERED BY VRS\nAuth Code: ${ctx.rgcCode || "______"}\nThe VRS parts team has located and ordered the part(s) for this service order.`;
      if (msg) m += `\n\nFeedback from VRS: ${msg}`;
      return m;
    }

    case "nla_replacement_submitted":
    case "nla_replacement_tech_initiates": {
      let m = `VRS NLA Update for SO#${so}\n\nAuth Code: ${ctx.rgcCode || "______"}\nYour NLA parts request has been processed by the VRS team.`;
      if (msg) m += `\n\nFeedback from VRS: ${msg}`;
      return m;
    }

    case "nla_rfr_eligible": {
      let m = `VRS NLA Update for SO#${so}\n\nStatus: RFR ELIGIBLE\nAuth Code: ${ctx.rgcCode || "______"}\n\nThis part is RFR eligible. Remove the failed part and return it for repair, then reschedule the call in TechHub.`;
      if (msg) m += `\n\nInstructions: ${msg}`;
      return m;
    }

    case "nla_reject": {
      const reason =
        (ctx.rejectionReasons && ctx.rejectionReasons.length > 0
          ? ctx.rejectionReasons.join(", ")
          : "") || "More information needed";
      let m = `VRS NLA Update for SO#${so}\n\nStatus: MORE INFO NEEDED\nReason: ${reason}\n\nTap to resubmit:\n${RESUBMIT_PLACEHOLDER}`;
      if (msg) m += `\n\nFeedback from VRS — Action required: ${msg}`;
      return m;
    }

    case "nla_invalid": {
      const reason =
        (ctx.invalidReasons && ctx.invalidReasons.length > 0
          ? ctx.invalidReasons.join(", ")
          : "") || "Request not applicable";
      let m = `VRS NLA Update for SO#${so}\n\nStatus: NOT APPLICABLE\nReason: ${reason}`;
      if (msg) m += `\n\nInstructions: ${msg}`;
      return m;
    }

    default:
      return "";
  }
}

export function smsSegmentInfo(text: string): { chars: number; segments: number } {
  const chars = text.length;
  const segments = chars === 0 ? 0 : Math.ceil(chars / 160);
  return { chars, segments };
}
