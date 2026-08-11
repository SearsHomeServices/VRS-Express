import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getVrsAiApprovalCopy,
  type VrsAiBridgeStatus,
} from "../client/src/lib/vrsAiBridge";

const dashboardSource = readFileSync(
  new URL("../client/src/pages/agent-dashboard.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function getBridgePanelSource(): string {
  const start = dashboardSource.indexOf("{selectedSubmission.vrsAi && (");
  const end = dashboardSource.indexOf("{(\n", start);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return dashboardSource.slice(start, end);
}

describe("VRS AI bridge agent approval copy", () => {
  it("makes the human-to-AI handoff explicit for bridge tickets", () => {
    const bridge: VrsAiBridgeStatus = {
      callId: "vrs_call_bridge_123",
      contractVersion: "v8",
      state: "pending_review",
      providerCallId: null,
      dispatchError: null,
      failureReason: null,
      retryable: null,
      dispatchedAt: null,
    };

    expect(getVrsAiApprovalCopy(bridge)).toEqual({
      button: "Approve & Send to VRS AI",
      confirmTitle: "Approve & Send to VRS AI",
      confirmAction: "Approve, Send & Notify",
    });
  });

  it("keeps the existing human-only approval copy for ordinary tickets", () => {
    expect(getVrsAiApprovalCopy(null)).toEqual({
      button: "Approve Submission",
      confirmTitle: "Approve Submission",
      confirmAction: "Approve Submission & Notify",
    });
  });
});

describe("VRS AI bridge review context", () => {
  it("keeps the complete V8 review contract representable without making V8-only fields mandatory for V5", () => {
    const bridge: VrsAiBridgeStatus = {
      callId: "vrs_call_v8_review",
      contractVersion: "v8",
      state: "pending_review",
      providerCallId: null,
      dispatchError: null,
      failureReason: null,
      retryable: null,
      dispatchedAt: null,
      reviewContext: {
        service_order: "13538277",
        tech_id: "0123456",
        tech_phone: "N/A",
        tech_name: "",
        parts: [{
          part_id: "WPW10503278",
          part_description: "Electronic Control Board",
          sell_price: 0,
          part_function: "Controls wash cycle timing.",
        }],
        customer_name: "Maria Gonzalez",
        customer_address: "742 Evergreen Terrace",
        service_address: "742 Evergreen Terrace",
        brand: "Whirlpool",
        model_number: "WTW5000DW1",
        serial_number: "C31290822",
        appliance_type: "Washer",
        appliance_age: 0,
        labor_amount: 0,
        tax_amount: 0,
        part_price: 0,
        appliance_location: "laundry room",
        failure_cause: "normal-wear",
        tech_recommendation: "repair",
        repair_replace_rationale: "",
        appliance_color: "N/A",
        contract_number: "V8-00001",
        purchase_year: "TBD",
        symptom: "Washer not draining",
        appliance_grade: "N/A",
        partner_id: "American Home Shield",
        appliance_photos: [
          "https://tina.example.test/photo.jpg?X-Amz-Signature=a%2Bb%2Fc%3D",
        ],
        comments: [],
      },
    };

    expect(bridge.reviewContext).toMatchObject({
      tech_phone: "N/A",
      tech_name: "",
      appliance_color: "N/A",
      purchase_year: "TBD",
      appliance_age: 0,
      labor_amount: 0,
      appliance_photos: [
        "https://tina.example.test/photo.jpg?X-Amz-Signature=a%2Bb%2Fc%3D",
      ],
    });

    const {
      appliance_color: _applianceColor,
      contract_number: _contractNumber,
      purchase_year: _purchaseYear,
      symptom: _symptom,
      ...v5ReviewContext
    } = bridge.reviewContext!;
    const v5: VrsAiBridgeStatus = {
      ...bridge,
      contractVersion: "v5",
      reviewContext: v5ReviewContext,
    };
    expect(v5.contractVersion).toBe("v5");
  });

  it("renders every requested business field inside the bridge-only guard", () => {
    const panel = getBridgePanelSource();

    for (const label of [
      "Contract version",
      "Partner",
      "Contract number",
      "Symptom",
      "Failure cause",
      "Recommendation",
      "Repair / replace rationale",
      "Purchase year",
      "Appliance age",
      "Appliance grade",
      "Color",
      "Brand",
      "Appliance type",
      "Model",
      "Serial",
      "Technician name",
      "Technician phone",
      "Labor",
      "Tax",
      "Parts total",
      "Total",
      "Parts",
      "Technician comments",
      "Sender photos",
    ]) {
      expect(panel, `missing bridge label: ${label}`).toContain(label);
    }

    for (const field of [
      "contractVersion",
      "partner_id",
      "contract_number",
      "symptom",
      "failure_cause",
      "tech_recommendation",
      "repair_replace_rationale",
      "purchase_year",
      "appliance_age",
      "appliance_grade",
      "appliance_color",
      "brand",
      "appliance_type",
      "model_number",
      "serial_number",
      "tech_name",
      "tech_phone",
      "labor_amount",
      "tax_amount",
      "part_price",
      "sell_price",
      "part_function",
      "comments",
      "appliance_photos",
    ]) {
      expect(panel, `missing guarded bridge field: ${field}`).toContain(field);
    }
  });

  it("uses each sender photo URL directly for a safe link and preview without token helpers", () => {
    const panel = getBridgePanelSource();

    expect(panel).toContain("href={photo}");
    expect(panel).toContain('target="_blank"');
    expect(panel).toContain('rel="noreferrer noopener"');
    expect(panel).toContain("src={photo}");
    expect(panel).toContain('referrerPolicy="no-referrer"');
    expect(panel).not.toMatch(
      /buildMediaUrl|buildMediaUrls|prefetchMediaTokens|PhotoLightbox/,
    );
  });

  it("keeps manual approval wording and makes only the bridge sentence version-neutral", () => {
    expect(dashboardSource).toContain(
      "Approving the submission will notify the technician that their photos and information meet the requirements. You will then need to obtain the authorization code from the warranty provider to complete this ticket.",
    );
    expect(dashboardSource).not.toContain("sends its V5 payload");
    expect(getBridgePanelSource()).toContain(
      'data-testid="vrs-ai-bridge-status"',
    );
  });
});
