// HSSOM Order Lookup client (customer name and address for a service order).
//
// INTERFACE STUB: the shape below is the contract between this module and
// server/ahs-prefill.ts. The implementation replaces the body of
// lookupHssomOrder; keep the exported names and types.
//
// Same service ai-agent-mcp calls through CustomerTools.
// get_customer_details_by_order (gateway mode, HSSOM bearer token). Disabled
// unless AHS_HSSOM_CUSTOMER_PREFILL_ENABLED is exactly "true" and the HSSOM
// credentials are configured. Never logs customer values or tokens.

export type HssomOrderLookupResult =
  | {
      status: "found";
      customerName?: string;
      // One line: "street, city, ST zip".
      customerAddress?: string;
      // Raw thirdParty.contractNumber; AHS dispatch number is the part
      // before "/" (dispatchNumberFromServiceContractId). Unverified.
      serviceContractId?: string;
      brand?: string;
      modelNumber?: string;
      serialNumber?: string;
      // ISO date (YYYY-MM-DD) when HSSOM has one.
      purchaseDate?: string;
    }
  | { status: "not_found" }
  | { status: "unavailable" };

// district: 4 digits; bareServiceOrder: 8 digits. The HSSOM order ID is
// "<district padded to 7>-<service order>", e.g. 0008175-13717195.
export async function lookupHssomOrder(
  _district: string,
  _bareServiceOrder: string,
): Promise<HssomOrderLookupResult> {
  return { status: "unavailable" };
}
