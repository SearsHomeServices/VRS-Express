export type WarrantyType = "sears_protect" | "american_home_shield" | "first_american";

export const WARRANTY_PROVIDER_LABELS: Record<WarrantyType, string> = {
  sears_protect: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)",
  american_home_shield: "American Home Shield",
  first_american: "First American",
};

// The warranty companies VRS AI calls for authorization, and the partner_id
// each is sent as. VRS AI resolves partner_id by its exact registry key, case
// insensitive, with no aliases (confirmed by the VRS AI agent-service,
// 2026-11-04): keys AHS and FIRST_AMERICAN. An unknown id (e.g. "fa") falls
// back to the AHS flow, so FA must be "FIRST_AMERICAN". Dispatch always sends
// one of these two keys, never SASHA's own spelling.
// Sears Protect and Assurant (PA) are never sent: Sears is the warranty
// company, so the VRS agent decides, and technicians call Assurant directly.
export const VRS_AI_PARTNER_IDS = {
  american_home_shield: "AHS",
  first_american: "FIRST_AMERICAN",
} as const;
export type VrsAiWarrantyType = keyof typeof VRS_AI_PARTNER_IDS;

export function isVrsAiWarrantyType(value: string | null | undefined): value is VrsAiWarrantyType {
  return value === "american_home_shield" || value === "first_american";
}

// The warranty a VRS partner_id names (SASHA's display name, or VRS AI's
// registry key on app-origin rows), ignoring case, spaces and hyphens. AHS:
// "AHS", "American Home Shield". First American: "FA", "First American",
// "FIRST_AMERICAN", "First American Home Buyers" (SASHA's V11 display name).
// Anything else is null, never AHS: a missing partner_id and "N/A" included
// (V11 §5 rule 3; on 2026-11-04 SASHA's "N/A" orders were Assurant and
// Sears), and SASHA's "Assurant - PA" and "Sears, Roebuck & Co.". The SRDM
// client ids (61380, 20730, ...) are a namespace SASHA never sends (V11 §3),
// so they are not aliases.
export function vrsAiWarrantyFromPartnerId(partnerId: string | null | undefined): VrsAiWarrantyType | null {
  const key = (partnerId ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["ahs", "american_home_shield"].includes(key)) return "american_home_shield";
  if (["fa", "first_american", "firstamerican", "first_american_home_buyers"].includes(key)) {
    return "first_american";
  }
  return null;
}

// SASHA contract V11 §3 (SHSAI-3374): b2b_client_id is the client company
// id (LCDM catalog), one per client, and VRS routes on it. 2318 Assurant - PA
// and 2172 Sears, Roebuck & Co. are not called. (Not laborPricing
// b2bClientIdRef, e.g. 61380: a different namespace SASHA never sends.)
export const SASHA_B2B_CLIENT_WARRANTIES: Readonly<Record<string, VrsAiWarrantyType>> = {
  "2276": "american_home_shield",
  "2151": "first_american",
};

// proc_id names the plan and must belong to the b2b_client_id's client.
// Same prefixes as VRS AI's router: AHS / AHZ / AHT (AHS000, AHZ000, AHT300)
// for AHS, FAA (FAA01A ... FAA03A) for First American. FWSM (Assurant) and SP
// (Sears) plans are not callable.
const SASHA_PROC_ID_PREFIXES: Record<VrsAiWarrantyType, RegExp> = {
  american_home_shield: /^(?:AHS|AHZ|AHT)/i,
  first_american: /^FAA/i,
};

export type SashaPartnerResolution =
  | { ok: true; warrantyType: VrsAiWarrantyType; source: "b2b_client_id" | "partner_id" }
  | { ok: false; reason: string };

// Placeholder values that mean "no value" (trimmed, any case), the same set
// VRS AI's router uses.
const SASHA_PLACEHOLDER_VALUES = new Set(["", "N/A", "NA", "TBD", "NONE", "NULL", "UNKNOWN"]);

// SASHA sends text; a number is read the same way. null and the placeholders
// above are no value ("").
function sashaValueText(value: unknown): string {
  const text = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  return SASHA_PLACEHOLDER_VALUES.has(text.toUpperCase()) ? "" : text;
}

// Which partner VRS AI calls for a SASHA request. Fails closed and never
// defaults to AHS (V11 §5; Enzo, 2026-11-06: "anything like N/A in the
// partner id or procid should be declined"). Used at intake (422),
// mapVrsPayloadToSubmission and dispatch.
// "No value" below means missing, null or a placeholder ("", N/A, NA, TBD,
// NONE, NULL, UNKNOWN; any case).
// 1. partner_id has no value: unsupported, even with valid ids.
// 2. Either V11 id key present (null counts as present): both must
//    have a value; b2b_client_id must be 2276 (AHS) or 2151 (FA) and decides
//    the warranty; proc_id must be one of its plans (AHS/AHZ/AHT; FAA). A
//    partner_id naming the other known partner contradicts it: unsupported.
//    A partner_id naming no known partner is ignored.
// 3. No V11 ids: the partner_id name decides (vrsAiWarrantyFromPartnerId).
// Reasons carry partner, client and plan identifiers only, never customer data.
export function resolveSashaPartner(payload: {
  partner_id?: unknown;
  proc_id?: unknown;
  b2b_client_id?: unknown;
}): SashaPartnerResolution {
  const partnerId = sashaValueText(payload.partner_id);
  if (!partnerId) return { ok: false, reason: "partner_id is missing or a placeholder" };
  const named = vrsAiWarrantyFromPartnerId(partnerId);

  if (payload.b2b_client_id !== undefined || payload.proc_id !== undefined) {
    const clientId = sashaValueText(payload.b2b_client_id);
    const procId = sashaValueText(payload.proc_id);
    if (!clientId) return { ok: false, reason: "b2b_client_id is missing or a placeholder" };
    if (!procId) return { ok: false, reason: "proc_id is missing or a placeholder" };
    const warrantyType = SASHA_B2B_CLIENT_WARRANTIES[clientId];
    if (!warrantyType) {
      return { ok: false, reason: `b2b_client_id ${clientId} is not a client VRS AI calls` };
    }
    if (!SASHA_PROC_ID_PREFIXES[warrantyType].test(procId)) {
      return { ok: false, reason: `proc_id ${procId} is not a plan of b2b_client_id ${clientId}` };
    }
    if (named && named !== warrantyType) {
      return { ok: false, reason: `partner_id ${partnerId} contradicts b2b_client_id ${clientId}` };
    }
    return { ok: true, warrantyType, source: "b2b_client_id" };
  }

  return named
    ? { ok: true, warrantyType: named, source: "partner_id" }
    : { ok: false, reason: `partner_id ${partnerId} is not a partner VRS AI calls` };
}

// The short name the Stage 1 views use ("AHS details", "First American
// details"); AHS when the warranty is not one VRS AI calls.
export function vrsAiPartnerName(warrantyType: string | null | undefined): string {
  return warrantyType === "first_american" ? "First American" : "AHS";
}

export interface DerivedWarranty {
  warrantyType: WarrantyType;
  warrantyProvider: string;
  source: "client_nm" | "proc_id";
}

// GET /api/tech/lookup-warranty also returns the appliance type derived from
// the service order's product code (shared/appliance-division.ts), when known.
// Separate from DerivedWarranty so submit-time warranty derivation is
// unchanged. Non-PII.
export interface DerivedServiceOrderAppliance {
  applianceType?: import("./appliance-division").ApplianceDivision;
}

// The service order's product category exactly as the source shows it
// (WOM / ServicePower "Product Category", e.g. "WASHERDD - WASHER, DIRECT
// DRIVE"; Snowflake HS_SP_CD only when WOM is unavailable). The tech form
// shows it under Appliance Type so the tech sees where the type came from;
// stored on the ticket as submissions.service_order_product. Non-PII.
export interface ServiceOrderProduct {
  text: string;
  source: "wom" | "snowflake";
}

// GET /api/tech/lookup-warranty response.
export interface WarrantyLookupResponse {
  serviceOrder: string;
  // Null when the warranty is unknown (older clients lock on non-null).
  derived: (DerivedWarranty & DerivedServiceOrderAppliance) | null;
  // Top level whenever known, whatever the warranty.
  applianceType?: import("./appliance-division").ApplianceDivision;
  serviceOrderProduct?: ServiceOrderProduct;
}

function norm(s: string | null | undefined): string {
  return (s || "").toString().trim().toLowerCase();
}

export function deriveWarrantyFromProcId(
  procId: string | null | undefined,
  clientNm: string | null | undefined,
): DerivedWarranty | null {
  const proc = norm(procId);
  const client = norm(clientNm);

  if (!proc && !client) return null;
  if (proc === "not found" && client === "not found") return null;

  if (client && client !== "not found") {
    if (client.includes("american home shield") || client.includes("ahs")) {
      return { warrantyType: "american_home_shield", warrantyProvider: WARRANTY_PROVIDER_LABELS.american_home_shield, source: "client_nm" };
    }
    if (client.includes("first american")) {
      return { warrantyType: "first_american", warrantyProvider: WARRANTY_PROVIDER_LABELS.first_american, source: "client_nm" };
    }
    if (
      client.includes("sears protect") ||
      client.includes("sears home warranty") ||
      client.includes("sears pa") ||
      client.includes("cinch") ||
      client.includes("sphw")
    ) {
      return { warrantyType: "sears_protect", warrantyProvider: WARRANTY_PROVIDER_LABELS.sears_protect, source: "client_nm" };
    }
  }

  if (proc && proc !== "not found") {
    if (proc.startsWith("ahs")) {
      return { warrantyType: "american_home_shield", warrantyProvider: WARRANTY_PROVIDER_LABELS.american_home_shield, source: "proc_id" };
    }
    if (proc.startsWith("fa") || proc.startsWith("fah") || proc.startsWith("first")) {
      return { warrantyType: "first_american", warrantyProvider: WARRANTY_PROVIDER_LABELS.first_american, source: "proc_id" };
    }
    if (
      proc.startsWith("sphw") ||
      proc.startsWith("sears") ||
      proc.startsWith("cinch") ||
      proc.startsWith("shw") ||
      proc.startsWith("sp")
    ) {
      return { warrantyType: "sears_protect", warrantyProvider: WARRANTY_PROVIDER_LABELS.sears_protect, source: "proc_id" };
    }
  }

  return null;
}
