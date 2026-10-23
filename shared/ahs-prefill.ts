// AHS service-order prefill: the shared contract between the server lookup
// (server/services/snowflake.ts, server/ahs-prefill.ts), the tech form
// (client/src/components/ahs-details-fields.tsx) and the Stage 1 reviewer
// panel.
//
// The data comes from Snowflake through the connection VRS Express already
// has; no new credentials. Only non-PII appliance fields are ever returned to
// the browser. The AHS dispatch number (Sears "service contract ID", the part
// before the "/") is filled on the server at submit time and the browser only
// learns whether one was found.

// Fields the server may fill from the service order. Field names match
// ahsDetailsSchema in shared/ahs-details.ts.
export const AHS_PREFILL_FIELDS = [
  "contractNumber",
  "brand",
  "modelNumber",
  "serialNumber",
  // From the HSSOM Order Lookup (server/services/hssom-order-lookup.ts).
  // Customer PII: filled on the server only, never returned to the browser.
  "customerName",
  "customerAddress",
  // The parts on the order (Snowflake NPSXTPN, server/services/snowflake-lookup.ts).
  // Marks the whole parts list, filled only when the draft had none.
  "parts",
] as const;

export type AhsPrefillField = (typeof AHS_PREFILL_FIELDS)[number];

// GET /api/tech/ahs-prefill?district=DDDD&serviceOrder=SSSSSSSS
export type AhsPrefillResponse =
  | {
      status: "found";
      // Non-PII appliance data the tech confirms against the model tag photo.
      appliance: { brand?: string; modelNumber?: string; serialNumber?: string };
      // The value itself never leaves the server.
      hasDispatchNumber: boolean;
      // True when the server will fill customer name and address from the
      // HSSOM Order Lookup. The values themselves never leave the server.
      hasCustomer?: boolean;
    }
  | { status: "not_found" }
  // Lookup disabled, Snowflake down, or a column mismatch. The form falls back
  // to manual entry and submission is never blocked.
  | { status: "unavailable" };

// AHS dispatch number from the service contract ID: the characters before
// the first "/", trimmed. Returns undefined for blank input.
export function dispatchNumberFromServiceContractId(raw: string | null | undefined): string | undefined {
  if (raw == null) return undefined;
  const value = String(raw).split("/")[0].trim();
  return value === "" ? undefined : value;
}
