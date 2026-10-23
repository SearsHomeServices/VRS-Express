export type WarrantyType = "sears_protect" | "american_home_shield" | "first_american";

export const WARRANTY_PROVIDER_LABELS: Record<WarrantyType, string> = {
  sears_protect: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)",
  american_home_shield: "American Home Shield",
  first_american: "First American",
};

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
