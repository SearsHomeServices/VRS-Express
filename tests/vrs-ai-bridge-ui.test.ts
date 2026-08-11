import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VrsAiBridgeReview } from "../client/src/components/vrs-ai-bridge-review";
import {
  getVrsAiApprovalCopy,
  type VrsAiBridgeStatus,
} from "../client/src/lib/vrsAiBridge";

const signedPhotoUrl =
  "https://tina.example.test/download/photo%2Fwasher.jpg?signature=abc%2B123&expires=1786406400";
const escapedSignedPhotoUrl =
  "https://tina.example.test/download/photo%2Fwasher.jpg?signature=abc%2B123&amp;expires=1786406400";

const v8Bridge: VrsAiBridgeStatus = {
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
    reason_for_call: "authorization",
    tech_id: "0123456",
    tech_phone: "N/A",
    tech_name: "",
    parts: [{
      part_id: "WPW10503278",
      part_description: "Electronic Control Board",
      sell_price: 245,
      part_function: "Controls wash cycle timing and motor speed.",
    }],
    customer_name: "Maria Gonzalez",
    customer_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
    service_address: "742 Evergreen Terrace, Hagerstown, MD 21740",
    brand: "Whirlpool",
    model_number: "WTW5000DW1",
    serial_number: "C31290822",
    appliance_type: "Washer",
    appliance_age: 0,
    labor_amount: 0,
    tax_amount: 0,
    part_price: 245,
    appliance_location: "laundry room",
    failure_cause: "other",
    tech_recommendation: "replace",
    repair_replace_rationale: "",
    appliance_grade: "N/A",
    appliance_color: "N/A",
    contract_number: "CN-0008",
    purchase_year: "TBD",
    symptom: "N/A",
    partner_id: "American Home Shield",
    appliance_photos: [signedPhotoUrl],
    comments: [{
      tech_id: "comment-tech-99",
      work_item: "failure_diagnosis",
      text: "Diagnostic code F7E1 observed.",
      timestamp: "2026-08-11T13:55:00Z",
    }],
  },
};

const v5Bridge: VrsAiBridgeStatus = {
  ...v8Bridge,
  callId: "vrs_call_v5_review",
  contractVersion: "v5",
  reviewContext: {
    ...v8Bridge.reviewContext!,
    partner_id: undefined,
    appliance_grade: undefined,
    contract_number: "must-not-render-for-v5",
    symptom: "must-not-render-for-v5",
    purchase_year: "TBD",
    appliance_color: "must-not-render-for-v5",
    appliance_photos: [],
    comments: [],
  },
};

function renderReview(bridge: VrsAiBridgeStatus): string {
  return renderToStaticMarkup(createElement(VrsAiBridgeReview, { bridge }));
}

function expectField(html: string, field: string, value: string): void {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(html).toMatch(
    new RegExp(`data-field="${field}"[^>]*>${escapedValue}</p>`),
  );
}

describe("VRS AI bridge agent approval copy", () => {
  it("makes the human-to-AI handoff explicit for bridge tickets", () => {
    expect(getVrsAiApprovalCopy(v8Bridge)).toEqual({
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

describe("VRS AI bridge review rendering", () => {
  it("renders the complete V8 business context with exact placeholders, zeroes, totals, and comment metadata", () => {
    const html = renderReview(v8Bridge);

    for (const label of [
      "Contract version",
      "Service order",
      "Reason for call",
      "Partner",
      "Contract number",
      "Technician ID",
      "Technician name",
      "Technician phone",
      "Customer name",
      "Customer address",
      "Service address",
      "Appliance location",
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
      "Labor",
      "Tax",
      "Parts total",
      "Total",
      "Parts",
      "Technician comments",
      "Sender photos",
    ]) {
      expect(html, `missing rendered label: ${label}`).toContain(label);
    }

    for (const value of [
      "13538277",
      "authorization",
      "0123456",
      "Maria Gonzalez",
      "742 Evergreen Terrace, Hagerstown, MD 21740",
      "laundry room",
      "Whirlpool",
      "WTW5000DW1",
      "C31290822",
      "comment-tech-99",
      "failure_diagnosis",
      "Diagnostic code F7E1 observed.",
      "2026-08-11T13:55:00Z",
      "WPW10503278",
      "Electronic Control Board",
      "Controls wash cycle timing and motor speed.",
    ]) {
      expect(html, `missing rendered value: ${value}`).toContain(value);
    }

    expect(html).toMatch(/data-field="tech-name"[^>]*><\/p>/);
    expect(html).toMatch(/data-field="repair-replace-rationale"[^>]*><\/p>/);
    expectField(html, "tech-phone", "N/A");
    expectField(html, "symptom", "N/A");
    expectField(html, "purchase-year", "TBD");
    expectField(html, "appliance-age", "0");
    expectField(html, "labor", "$0.00");
    expectField(html, "tax", "$0.00");
    expectField(html, "parts-total", "$245.00");
    expectField(html, "total", "$245.00");
    expectField(html, "part-0-price", "$245.00");
  });

  it("renders the exact sender URL as a safe direct link and no-referrer preview", () => {
    const html = renderReview(v8Bridge);

    expect(html).toContain(
      `href="${escapedSignedPhotoUrl}" target="_blank" rel="noreferrer noopener"`,
    );
    expect(html).toContain(
      `src="${escapedSignedPhotoUrl}" referrerPolicy="no-referrer"`,
    );
    expect(html).not.toMatch(
      /buildMediaUrl|buildMediaUrls|prefetchMediaTokens|PhotoLightbox/,
    );
  });

  it("keeps V8-only and absent optional V5 rows out of the V5 review", () => {
    const html = renderReview(v5Bridge);

    expectField(html, "contract-version", "v5");
    expect(html).toContain("Service order");
    expect(html).not.toContain("Contract number");
    expect(html).not.toContain("Symptom");
    expect(html).not.toContain("Purchase year");
    expect(html).not.toContain(">Color<");
    expect(html).not.toContain("must-not-render-for-v5");
    expect(html).not.toContain(">Partner<");
    expect(html).not.toContain("Appliance grade");

    const withV5OptionalRows = renderReview({
      ...v5Bridge,
      reviewContext: {
        ...v5Bridge.reviewContext!,
        partner_id: "ahs",
        appliance_grade: "mid",
      },
    });
    expectField(withV5OptionalRows, "partner", "ahs");
    expectField(withV5OptionalRows, "appliance-grade", "mid");
  });

  it("is consumed only inside the dashboard bridge guard and keeps manual wording", () => {
    const dashboardSource = readFileSync(
      new URL("../client/src/pages/agent-dashboard.tsx", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const guardStart = dashboardSource.indexOf("{selectedSubmission.vrsAi && (");
    const componentUse = dashboardSource.indexOf(
      "<VrsAiBridgeReview bridge={selectedSubmission.vrsAi} />",
    );
    const guardEnd = dashboardSource.indexOf("{(\n", guardStart);

    expect(guardStart).toBeGreaterThan(-1);
    expect(componentUse).toBeGreaterThan(guardStart);
    expect(componentUse).toBeLessThan(guardEnd);
    expect(dashboardSource).toContain(
      "Approving the submission will notify the technician that their photos and information meet the requirements. You will then need to obtain the authorization code from the warranty provider to complete this ticket.",
    );
    expect(dashboardSource).not.toContain("sends its V5 payload");

    const componentSource = readFileSync(
      new URL(
        "../client/src/components/vrs-ai-bridge-review.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(componentSource).not.toMatch(
      /buildMediaUrl|buildMediaUrls|prefetchMediaTokens|PhotoLightbox/,
    );
  });
});
