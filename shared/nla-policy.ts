// VRS no longer handles NLA (No Longer Available) parts, for any client.
// Techs research NLA parts in TechHub instead: select "Needed for Repair"
// after the part inquiry and follow the TH 2.0 prompts for SOM team research.
//
// New technician submissions (and resubmissions) of request type
// "parts_nla" are refused: the tech forms show the notice below and grey
// out the rest of the form, and POST /api/submissions answers 400 for any
// cached or older client that still sends one. Existing NLA tickets are
// untouched; agents still work them through the NLA queue (/process-nla).

export const NLA_REQUEST_TYPE = "parts_nla" as const;

export const NLA_NO_LONGER_HANDLED_HEADING =
  "VRS no longer handles NLA parts for all Clients, including SHW, SPHW, and PA.";

export const NLA_OPTION_DESCRIPTION =
  "VRS no longer handles NLA parts. Select to see what to do in TechHub.";

/** Error returned by POST /api/submissions for a new parts_nla request. */
export const NLA_SUBMISSION_REJECTED_ERROR =
  `${NLA_NO_LONGER_HANDLED_HEADING} After confirming a part is NLA through part inquiry, ` +
  `select "Needed for Repair" in TechHub, follow all TH 2.0 prompts for SOM team research, ` +
  `and do not close the order until research is complete.`;

/** True for the request type VRS no longer accepts from technicians. */
export function isNlaRequestType(requestType: unknown): boolean {
  return requestType === NLA_REQUEST_TYPE;
}
