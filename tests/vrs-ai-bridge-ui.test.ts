import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import * as reviewComponents from "../client/src/components/vrs-ai-bridge-review";
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
    service_order: "service-order-13538277",
    reason_for_call: "reason-authorization",
    tech_id: "tech-id-0123456",
    tech_phone: "N/A",
    tech_name: "tech-name-Jordan",
    parts: [{
      part_id: "part-id-WPW10503278",
      part_description: "part-description-control-board",
      sell_price: 222.22,
      part_function: "part-function-controls-cycle-timing",
    }],
    customer_name: "customer-name-Maria",
    customer_address: "customer-address-742-Evergreen",
    service_address: "service-address-901-Repair-Lane",
    brand: "brand-Whirlpool",
    model_number: "model-WTW5000DW1",
    serial_number: "serial-C31290822",
    appliance_type: "appliance-type-Washer",
    appliance_age: 7,
    labor_amount: 123.45,
    tax_amount: 6.78,
    part_price: 245.67,
    appliance_location: "appliance-location-laundry-room",
    failure_cause: "failure-cause-other",
    tech_recommendation: "recommendation-replace",
    repair_replace_rationale: "rationale-control-board-shorted",
    appliance_grade: "appliance-grade-mid",
    appliance_color: "appliance-color-stainless",
    contract_number: "contract-number-CN-0008",
    purchase_year: "TBD",
    symptom: "symptom-not-draining",
    partner_id: "partner-American-Home-Shield",
    appliance_photos: [signedPhotoUrl],
    comments: [{
      tech_id: "comment-tech-id-99",
      work_item: "comment-work-item-failure-diagnosis",
      text: "comment-text-diagnostic-F7E1",
      timestamp: "comment-timestamp-2026-08-11T13:55:00Z",
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

const v9Bridge: VrsAiBridgeStatus = {
  ...v8Bridge,
  callId: "vrs_call_v9_review",
  contractVersion: "v9",
  reviewContext: {
    ...v8Bridge.reviewContext!,
    cta_no: "contract-number-CN-0008",
    district_number: "8206",
  },
};

function renderReview(
  bridge: VrsAiBridgeStatus,
  bridgePhotoProxyEnabled = false,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: bridgePhotoProxyEnabled,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(reviewComponents.VrsAiBridgeReview, { bridge }),
    ),
  );
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
  it("renders the two V9 fields alongside the unchanged V8 fields", () => {
    const html = renderReview(v9Bridge);

    expectField(html, "contract-version", "v9");
    expectField(html, "cta-number", "contract-number-CN-0008");
    expectField(html, "district-number", "8206");
    expectField(html, "contract-number", "contract-number-CN-0008");
    expectField(html, "symptom", "symptom-not-draining");
  });

  it("renders every V8 field into its exact row with placeholders, totals, and comment metadata", () => {
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

    expectField(html, "contract-version", "v8");
    expectField(html, "service-order", "service-order-13538277");
    expectField(html, "reason-for-call", "reason-authorization");
    expectField(html, "partner", "partner-American-Home-Shield");
    expectField(html, "contract-number", "contract-number-CN-0008");
    expectField(html, "symptom", "symptom-not-draining");
    expectField(html, "tech-id", "tech-id-0123456");
    expectField(html, "tech-name", "tech-name-Jordan");
    expectField(html, "tech-phone", "N/A");
    expectField(html, "customer-name", "customer-name-Maria");
    expectField(html, "customer-address", "customer-address-742-Evergreen");
    expectField(html, "service-address", "service-address-901-Repair-Lane");
    expectField(html, "appliance-location", "appliance-location-laundry-room");
    expectField(html, "failure-cause", "failure-cause-other");
    expectField(html, "recommendation", "recommendation-replace");
    expectField(
      html,
      "repair-replace-rationale",
      "rationale-control-board-shorted",
    );
    expectField(html, "purchase-year", "TBD");
    expectField(html, "appliance-age", "7");
    expectField(html, "appliance-grade", "appliance-grade-mid");
    expectField(html, "appliance-color", "appliance-color-stainless");
    expectField(html, "brand", "brand-Whirlpool");
    expectField(html, "appliance-type", "appliance-type-Washer");
    expectField(html, "model", "model-WTW5000DW1");
    expectField(html, "serial", "serial-C31290822");
    expectField(html, "labor", "$123.45");
    expectField(html, "tax", "$6.78");
    expectField(html, "parts-total", "$245.67");
    expectField(html, "total", "$375.90");
    expectField(html, "part-0-id", "part-id-WPW10503278");
    expectField(html, "part-0-description", "part-description-control-board");
    expectField(html, "part-0-price", "$222.22");
    expectField(html, "part-0-function", "part-function-controls-cycle-timing");
    expectField(html, "comment-0-tech-id", "comment-tech-id-99");
    expectField(
      html,
      "comment-0-work-item",
      "comment-work-item-failure-diagnosis",
    );
    expectField(html, "comment-0-text", "comment-text-diagnostic-F7E1");
    expectField(
      html,
      "comment-0-timestamp",
      "comment-timestamp-2026-08-11T13:55:00Z",
    );
  });

  it("preserves the direct sender link behavior while the photo proxy is disabled", () => {
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

  it("does not render signed sender URLs when the server flag supplies proxy paths", () => {
    const html = renderReview(
      {
        ...v8Bridge,
        reviewContext: {
          ...v8Bridge.reviewContext!,
          appliance_photos: ["/api/submissions/44/vrs-ai-photos/0"],
        },
      },
      true,
    );

    // DEV proxy mode moves the bridge gallery into the dashboard's existing
    // Photos & Media card instead of duplicating it in the payload review.
    expect(html).not.toContain("Sender photos");
    expect(html).not.toContain(signedPhotoUrl);
    expect(html).not.toContain("tina.example.test");
  });

  it("preserves exact empty fields, placeholders, and numeric zeroes", () => {
    const html = renderReview({
      ...v8Bridge,
      reviewContext: {
        ...v8Bridge.reviewContext!,
        tech_name: "",
        tech_phone: "N/A",
        repair_replace_rationale: "",
        purchase_year: "TBD",
        appliance_age: 0,
        labor_amount: 0,
        tax_amount: 0,
        part_price: 0,
        parts: [{
          ...v8Bridge.reviewContext!.parts[0],
          sell_price: 0,
        }],
      },
    });

    expectField(html, "tech-name", "");
    expectField(html, "tech-phone", "N/A");
    expectField(html, "repair-replace-rationale", "");
    expectField(html, "purchase-year", "TBD");
    expectField(html, "appliance-age", "0");
    expectField(html, "labor", "$0.00");
    expectField(html, "tax", "$0.00");
    expectField(html, "parts-total", "$0.00");
    expectField(html, "total", "$0.00");
    expectField(html, "part-0-price", "$0.00");
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

  it("runtime-gates the complete production panel for manual and bridge tickets", () => {
    const candidate = reviewComponents as typeof reviewComponents & {
      VrsAiBridgePanel?: (props: {
        bridge: VrsAiBridgeStatus | null | undefined;
      }) => React.ReactNode;
    };
    expect(typeof candidate.VrsAiBridgePanel).toBe("function");
    if (!candidate.VrsAiBridgePanel) return;

    const renderPanel = (bridge: VrsAiBridgeStatus | null | undefined) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      queryClient.setQueryData(["/api/config"], {
        portal1099Enabled: false,
        techHubPhotosEnabled: false,
        vrsBridgePhotoProxyEnabled: false,
      });
      return renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(candidate.VrsAiBridgePanel!, { bridge }),
        ),
      );
    };

    expect(renderPanel(null)).toBe("");
    expect(renderPanel(undefined)).toBe("");

    const v8Panel = renderPanel({
      ...v8Bridge,
      dispatchError: "dispatch-error-unique",
    });
    expect(v8Panel).toContain('data-testid="vrs-ai-bridge-status"');
    expect(v8Panel).toContain("pending review");
    expect(v8Panel).toContain("Last send failed: dispatch-error-unique");
    expectField(v8Panel, "contract-version", "v8");

    const v5Panel = renderPanel({
      ...v5Bridge,
      state: "failed",
      failureReason: "failure-reason-unique",
      retryable: true,
    });
    expect(v5Panel).toContain("VRS AI could not complete the call");
    expect(v5Panel).toContain("failure-reason-unique");
    expect(v5Panel).toContain("Use the existing manual authorization flow.");
    expect(v5Panel).toContain("VRS AI marked this failure as retryable.");
    expectField(v5Panel, "contract-version", "v5");
  });

  it("passes dashboard bridge state to the runtime-tested panel and keeps manual wording", () => {
    const dashboardSource = readFileSync(
      new URL("../client/src/pages/agent-dashboard.tsx", import.meta.url),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const componentUse = dashboardSource.indexOf(
      "<VrsAiBridgePanel bridge={selectedSubmission.vrsAi} />",
    );

    expect(componentUse).toBeGreaterThan(-1);
    expect(dashboardSource).toContain(
      "Approving the submission will notify the technician that their photos and information meet the requirements. You will then need to obtain the authorization code from the warranty provider to complete this ticket.",
    );
    expect(dashboardSource).not.toContain("sends its V5 payload");

    // Photos & Media integration is exercised by the mounted dashboard in
    // vrs-agent-media.test.ts, not by assertions about its source text.
  });
});
