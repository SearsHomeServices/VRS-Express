export interface VrsAiBridgeStatus {
  callId: string;
  contractVersion: "v5" | "v8" | "v9";
  state: string;
  providerCallId: string | null;
  dispatchError: string | null;
  failureReason: string | null;
  retryable: boolean | null;
  dispatchedAt: string | Date | null;
  reviewContext?: {
    service_order: string;
    reason_for_call: string;
    tech_id: string;
    tech_phone: string;
    tech_name: string;
    parts: Array<{
      part_id: string;
      part_description: string;
      sell_price: number;
      part_function: string;
    }>;
    customer_name: string;
    customer_address: string;
    service_address: string;
    brand: string;
    model_number: string;
    serial_number: string;
    appliance_type: string;
    // Omitted on app-origin tickets where the tech left the age blank.
    appliance_age?: number;
    labor_amount: number;
    tax_amount: number;
    part_price: number;
    appliance_location: string;
    failure_cause: string;
    tech_recommendation: string;
    repair_replace_rationale: string;
    appliance_grade?: string;
    appliance_color?: string;
    contract_number?: string;
    cta_no?: string;
    district_number?: string;
    purchase_year?: number | "TBD" | "N/A";
    symptom?: string;
    partner_id?: string;
    appliance_photos?: string[];
    comments?: Array<{
      tech_id: string;
      work_item: string;
      text: string;
      timestamp: string;
    }>;
  };
}

export function getVrsAiApprovalCopy(
  bridge: VrsAiBridgeStatus | null | undefined,
): {
  button: string;
  confirmTitle: string;
  confirmAction: string;
} {
  if (bridge) {
    return {
      button: "Approve & Send to VRS AI",
      confirmTitle: "Approve & Send to VRS AI",
      confirmAction: "Approve, Send & Notify",
    };
  }

  return {
    button: "Approve Submission",
    confirmTitle: "Approve Submission",
    confirmAction: "Approve Submission & Notify",
  };
}
