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

// The warranty a VRS partner_id names (SASHA's /vrs/authorize payloads and
// VRS AI's registry keys), ignoring case, spaces and hyphens. AHS: missing,
// "ahs", "American Home Shield", "N/A" (V5 default). First American: "FA",
// "First American", "FIRST_AMERICAN" (Enzo, 2026-11-04). SASHA's warranty
// client ids also count (SASHA team, 2026-11-04): 61380 AHS, 20730 First
// American. Anything else is null (not a partner VRS AI calls), including
// SASHA's other two clients: 90550 Sears Protect and 61481 Assurant (PA).
export const SASHA_CLIENT_IDS = {
  american_home_shield: "61380",
  first_american: "20730",
  sears_protect: "90550",
  assurant_pa: "61481",
} as const;

export function vrsAiWarrantyFromPartnerId(partnerId: string | null | undefined): VrsAiWarrantyType | null {
  const key = (partnerId ?? "ahs").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["ahs", "american_home_shield", "n/a", SASHA_CLIENT_IDS.american_home_shield].includes(key)) {
    return "american_home_shield";
  }
  if (["fa", "first_american", "firstamerican", SASHA_CLIENT_IDS.first_american].includes(key)) {
    return "first_american";
  }
  return null;
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
