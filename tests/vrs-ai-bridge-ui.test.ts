// @vitest-environment jsdom
// Static renders (renderToStaticMarkup) plus mounted DOM runs of the Stage 1
// AHS details editor; fetch is mocked, nothing reaches a server.
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as reviewComponents from "../client/src/components/vrs-ai-bridge-review";
import {
  AHS_CHECK_APPLIANCE,
  AHS_CHECK_CUSTOMER,
  AHS_CHECK_PARTS,
} from "../client/src/components/ahs-ticket-review";
import {
  AHS_EDITOR_ENROLLED_TEXT,
  AHS_EDITOR_REFRESH_LABEL,
  AHS_EDITOR_SAVE_LABEL,
  AHS_EDITOR_SKIPPED_TEXT,
  AHS_EDITOR_TITLE,
} from "../client/src/components/ahs-details-editor";
import {
  ahsIssueFieldName,
  groupAhsIssues,
  isAhsDetailsEditable,
} from "../client/src/lib/ahsReview";
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
      path.resolve(process.cwd(), "client/src/pages/agent-dashboard.tsx"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const componentUse = dashboardSource.indexOf(
      `<VrsAiBridgePanel
                            bridge={selectedSubmission.vrsAi}
                            submission={selectedSubmission}`,
    );

    expect(componentUse).toBeGreaterThan(-1);
    // The Stage 1 card is the one place the AHS details are editable.
    expect(dashboardSource.slice(componentUse, componentUse + 400)).toContain("allowAhsEdit");
    expect(dashboardSource).toContain(
      "Approving the submission will notify the technician that their photos and information meet the requirements. You will then need to obtain the authorization code from the warranty provider to complete this ticket.",
    );
    expect(dashboardSource).not.toContain("sends its V5 payload");

    // Photos & Media integration is exercised by the mounted dashboard in
    // vrs-agent-media.test.ts, not by assertions about its source text.
  });
});

// ---------------------------------------------------------------------------
// Stage 1 reviewer: technician-filed AHS tickets (submissions.ahs_details)
// ---------------------------------------------------------------------------

const appOriginBridge: VrsAiBridgeStatus = {
  ...v9Bridge,
  callId: "vrs_call_app_origin",
  origin: "app",
};

const prefilledAhsDetails = {
  contractNumber: "ahs-dispatch-77001",
  customerName: "",
  customerAddress: "   ",
  applianceKind: "washer",
  brand: "brand-from-so-Whirlpool",
  modelNumber: "model-from-so-WTW5000",
  serialNumber: "serial-from-so-C3129",
  applianceLocation: "Laundry room",
  applianceGrade: "",
  failureCause: "normal-wear",
  techRecommendation: "replace",
  laborAmount: 120,
  taxAmount: 8.5,
  parts: [{
    partNumber: "part-WPW10503278",
    quantity: 2,
    description: "part-desc-control-board",
    unitPrice: 50.25,
    partFunction: "",
  }],
  prefilledFields: ["contractNumber", "brand", "modelNumber", "serialNumber"],
};

const ticketMedia = {
  photos: JSON.stringify({
    issue: ["/objects/issue-1.jpg"],
    estimate: ["/objects/model-tag.jpg", "/objects/estimate.jpg"],
  }),
  photoThumbnails: JSON.stringify({}),
  videoUrl: JSON.stringify([
    "/objects/video-1.mp4",
    "/objects/video-2.mp4",
    "/objects/video-3.mp4",
  ]),
};

type PanelProps = {
  bridge: VrsAiBridgeStatus | null | undefined;
  submission?: {
    ahsDetails?: string | null;
    photos?: string | null;
    photoThumbnails?: string | null;
    videoUrl?: string | null;
  } | null;
};

function renderAhsPanel(props: PanelProps): string {
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
      createElement(reviewComponents.VrsAiBridgePanel, props),
    ),
  );
}

// The source badge rendered next to one AHS field's label.
function fieldSource(html: string, field: string): string | null {
  const start = html.indexOf(`data-field-wrapper="${field}"`);
  if (start === -1) return null;
  const end = html.indexOf(`data-field="${field}"`, start);
  return /data-source="([a-z_]+)"/.exec(html.slice(start, end))?.[1] ?? null;
}

// The amber "check before approving" hint, tags stripped.
function prefillHint(html: string): string {
  const start = html.indexOf('data-testid="ahs-prefill-hint"');
  if (start === -1) return "";
  const end = html.indexOf("</div>", start);
  return html.slice(start, end).replace(/<[^>]+>/g, "");
}

describe("Stage 1 reviewer: technician-filed AHS tickets", () => {
  it("labels the source as the technician in VRS Express for app-origin rows", () => {
    const html = renderAhsPanel({ bridge: appOriginBridge });
    expect(html).toMatch(
      /data-testid="vrs-ai-bridge-source"[^>]*>Source: Submitted by technician in VRS Express</,
    );
    expect(html).not.toContain("Review SASHA / Tech Hub details");
    expect(html).toContain("Review the VRS AI request built from these details");
  });

  it.each([["sasha" as const], [undefined]])(
    "keeps the SASHA label for SASHA rows (origin %s)",
    (origin) => {
      const html = renderAhsPanel({ bridge: { ...v9Bridge, origin } });
      expect(html).toMatch(/data-testid="vrs-ai-bridge-source"[^>]*>Source: SASHA</);
      expect(html).not.toContain("Submitted by technician in VRS Express");
      expect(html).toContain("Review SASHA / Tech Hub details");
      expect(html).not.toContain('data-testid="ahs-ticket-review"');
    },
  );

  it("marks prefilled fields as from the service order and everything else as entered in VRS Express", () => {
    const html = renderAhsPanel({
      bridge: appOriginBridge,
      submission: { ahsDetails: JSON.stringify(prefilledAhsDetails), ...ticketMedia },
    });

    expect(html).toContain('data-testid="ahs-ticket-review"');
    for (const field of ["ahs-contract-number", "ahs-brand", "ahs-model", "ahs-serial"]) {
      expect(fieldSource(html, field), field).toBe("service_order");
    }
    for (const field of [
      "ahs-customer-name",
      "ahs-customer-address",
      "ahs-appliance-type",
      "ahs-appliance-age",
      "ahs-appliance-location",
      "ahs-appliance-grade",
      "ahs-appliance-color",
      "ahs-failure-cause",
      "ahs-tech-recommendation",
      "ahs-labor",
      "ahs-tax",
      "ahs-part-0-number",
      "ahs-part-0-function",
      "ahs-part-0-failure-reason",
    ]) {
      expect(fieldSource(html, field), field).toBe("tech");
    }
    // Calculated totals are neither typed nor prefilled.
    expect(fieldSource(html, "ahs-parts-total")).toBeNull();
    expect(html).toContain("From service order");
    expect(html).toContain("Entered in VRS Express");
    expect(html).not.toContain("Entered by tech");
    expect(html).toContain('data-testid="ahs-prefill-hint"');
    expect(html).toContain("model tag photo");
    expect(prefillHint(html)).toContain(AHS_CHECK_APPLIANCE);
    // No customer field was prefilled, so the hint doesn't ask about one.
    expect(prefillHint(html)).not.toContain(AHS_CHECK_CUSTOMER);

    expectField(html, "ahs-contract-number", "ahs-dispatch-77001");
    expectField(html, "ahs-brand", "brand-from-so-Whirlpool");
    expectField(html, "ahs-model", "model-from-so-WTW5000");
    expectField(html, "ahs-serial", "serial-from-so-C3129");
    expectField(html, "ahs-appliance-type", "Washer");
    expectField(html, "ahs-failure-cause", "Normal wear");
    expectField(html, "ahs-tech-recommendation", "Replace");
    expectField(html, "ahs-part-0-quantity", "2");
    expectField(html, "ahs-part-0-line-total", "$100.50");
    expectField(html, "ahs-parts-total", "$100.50");
    expectField(html, "ahs-total", "$229.00");
  });

  const customerPrefilledDetails = {
    ...prefilledAhsDetails,
    customerName: "so-customer-Maria",
    customerAddress: "so-address-742-Evergreen",
    prefilledFields: [...prefilledAhsDetails.prefilledFields, "customerName", "customerAddress"],
  };

  it("marks a server-filled customer name and address as from the service order", () => {
    const html = renderAhsPanel({
      bridge: appOriginBridge,
      submission: { ahsDetails: JSON.stringify(customerPrefilledDetails), ...ticketMedia },
    });
    for (const field of ["ahs-customer-name", "ahs-customer-address", "ahs-brand"]) {
      expect(fieldSource(html, field), field).toBe("service_order");
    }
    expectField(html, "ahs-customer-name", "so-customer-Maria");
    expectField(html, "ahs-customer-address", "so-address-742-Evergreen");
    const hint = prefillHint(html);
    expect(hint).toContain("Before approving, check:");
    expect(hint).toContain(AHS_CHECK_APPLIANCE);
    expect(hint).toContain(AHS_CHECK_CUSTOMER);
    expect(AHS_CHECK_APPLIANCE).toBe("Brand, model and serial against the model tag photo.");
    expect(AHS_CHECK_CUSTOMER).toBe(
      "Customer name and address against the service order. Confirm with the customer if unsure.",
    );
  });

  it("lists only the customer check when only the customer was prefilled", () => {
    const html = renderAhsPanel({
      bridge: null,
      submission: {
        ahsDetails: JSON.stringify({
          ...prefilledAhsDetails,
          customerName: "so-customer-Maria",
          customerAddress: "typed-address",
          prefilledFields: ["customerName"],
        }),
      },
    });
    expect(fieldSource(html, "ahs-customer-name")).toBe("service_order");
    expect(fieldSource(html, "ahs-customer-address")).toBe("tech");
    expect(fieldSource(html, "ahs-brand")).toBe("tech");
    expect(prefillHint(html)).toContain(AHS_CHECK_CUSTOMER);
    expect(prefillHint(html)).not.toContain(AHS_CHECK_APPLIANCE);
  });

  it("keeps the hint to its first sentence when only the dispatch number was prefilled", () => {
    const html = renderAhsPanel({
      bridge: null,
      submission: {
        ahsDetails: JSON.stringify({ ...prefilledAhsDetails, prefilledFields: ["contractNumber"] }),
      },
    });
    const hint = prefillHint(html);
    expect(hint).toContain("were filled from the");
    expect(hint).not.toContain("Before approving, check:");
    expect(hint).not.toContain(AHS_CHECK_APPLIANCE);
    expect(hint).not.toContain(AHS_CHECK_CUSTOMER);
  });

  it("treats every field as entered by tech when nothing was prefilled", () => {
    const { prefilledFields: _prefilled, ...typed } = prefilledAhsDetails;
    const html = renderAhsPanel({
      bridge: appOriginBridge,
      submission: { ahsDetails: JSON.stringify(typed) },
    });
    for (const field of ["ahs-contract-number", "ahs-brand", "ahs-model", "ahs-serial"]) {
      expect(fieldSource(html, field), field).toBe("tech");
    }
    expect(html).not.toContain('data-source="service_order"');
    expect(html).not.toContain('data-testid="ahs-prefill-hint"');
  });

  it('shows blank and missing optional fields as "Not provided", never "N/A"', () => {
    const html = renderAhsPanel({
      bridge: appOriginBridge,
      submission: { ahsDetails: JSON.stringify(prefilledAhsDetails), ...ticketMedia },
    });
    for (const field of [
      "ahs-customer-name",
      "ahs-customer-address",
      "ahs-appliance-grade",
      "ahs-appliance-color",
      "ahs-appliance-age",
      "ahs-part-0-function",
      "ahs-part-0-failure-reason",
    ]) {
      expectField(html, field, "Not provided");
    }
    const ahsSection = html.slice(
      html.indexOf('data-testid="ahs-ticket-review"'),
      html.indexOf("Review the VRS AI request built from these details"),
    );
    expect(ahsSection).not.toContain("N/A");
  });

  it("shows the model/serial and estimate screenshots and up to 3 videos through the media-token components", () => {
    const html = renderAhsPanel({
      bridge: appOriginBridge,
      submission: {
        ahsDetails: JSON.stringify(prefilledAhsDetails),
        ...ticketMedia,
        videoUrl: JSON.stringify([
          "/objects/video-1.mp4",
          "/objects/video-2.mp4",
          "/objects/video-3.mp4",
          "/objects/video-4.mp4",
        ]),
      },
    });
    expect(html).toContain("Model, serial &amp; estimate screenshots (2)");
    expect(html).toContain('data-testid="ahs-review-estimate-photo-0"');
    expect(html).toContain('data-testid="ahs-review-estimate-photo-1"');
    expect(html).not.toContain('data-testid="ahs-review-estimate-photo-2"');
    expect(html).toContain("Videos (3)");
    expect(html).toContain('data-testid="ahs-review-video-2"');
    expect(html).not.toContain('data-testid="ahs-review-video-3"');
    // MediaImage/MediaVideo only set src once a scoped media token arrives;
    // raw /objects/ paths must never be rendered as a src.
    expect(html).not.toMatch(/src="\/objects\//);
  });

  it("still shows the AHS details when the ticket has no bridge row", () => {
    const html = renderAhsPanel({
      bridge: null,
      submission: { ahsDetails: JSON.stringify(prefilledAhsDetails), ...ticketMedia },
    });
    expect(html).toContain('data-testid="ahs-details-no-bridge"');
    expect(html).not.toContain('data-testid="vrs-ai-bridge-status"');
    expect(html).toMatch(
      /data-testid="vrs-ai-bridge-source"[^>]*>Source: Submitted by technician in VRS Express</,
    );
    expect(html).toContain("not enrolled in VRS AI");
    expectField(html, "ahs-brand", "brand-from-so-Whirlpool");
    expect(fieldSource(html, "ahs-brand")).toBe("service_order");
    expectField(html, "ahs-customer-name", "Not provided");
    expect(html).toContain('data-testid="ahs-review-estimate-photo-0"');
  });

  it("reads fields the strict schema does not know yet and ignores unknown prefill names", () => {
    const html = renderAhsPanel({
      bridge: null,
      submission: {
        ahsDetails: JSON.stringify({
          brand: "brand-typed",
          applianceColor: "color-typed",
          techRecommendation: "repair",
          prefilledFields: ["applianceColor", "customerPhone", "customerName", "brand"],
          parts: [],
        }),
      },
    });
    expectField(html, "ahs-tech-recommendation", "Repair");
    expect(fieldSource(html, "ahs-brand")).toBe("service_order");
    // customerName is a known prefill field now; the others are not.
    expect(fieldSource(html, "ahs-customer-name")).toBe("service_order");
    expect(fieldSource(html, "ahs-appliance-color")).toBe("tech");
    expectField(html, "ahs-parts-total", "Not provided");
    expectField(html, "ahs-total", "Not provided");
  });

  it("renders nothing without a bridge row or AHS details", () => {
    expect(renderAhsPanel({ bridge: null, submission: { ahsDetails: null } })).toBe("");
    expect(renderAhsPanel({ bridge: null, submission: { ahsDetails: "not-json" } })).toBe("");
    expect(renderAhsPanel({ bridge: null, submission: { ahsDetails: "[]" } })).toBe("");
    expect(renderAhsPanel({ bridge: undefined, submission: null })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Stage 1 editor: the VRS manager completes the server's AHS draft
// ---------------------------------------------------------------------------

// What GET /api/submissions/:id returns for an AHS authorization ticket the
// manager has claimed and not yet decided.
const editableTicket = {
  id: 44,
  requestType: "authorization",
  warrantyType: "american_home_shield",
  ticketStatus: "pending",
  stage1Status: "pending",
  submissionApproved: false,
  issueDescription: "evidence-desc: washer stops mid-cycle with F7E1",
  ...ticketMedia,
};

// A draft the lookups filled part of.
const partialDraft = {
  contractNumber: "ahs-dispatch-77001",
  customerName: "so-customer-Maria",
  brand: "brand-from-so-Whirlpool",
  modelNumber: "model-typed-WTW5000",
  parts: [{ partNumber: "so-part-W10724237", description: "so-part-drum-roller", unitPrice: 19.99 }],
  prefilledFields: ["contractNumber", "customerName", "brand", "parts"],
};

// A draft that already passes ahsDetailsSchema, as the server may store it
// after a previous save (purchaseYear and prefilledFields are server-only).
const completeDraft = {
  contractNumber: "ahs-dispatch-77001",
  customerName: "so-customer-Maria",
  customerAddress: "so-address-742-Evergreen",
  applianceKind: "washer",
  brand: "brand-from-so-Whirlpool",
  modelNumber: "model-from-so-WTW5000",
  serialNumber: "serial-from-so-C3129",
  applianceAge: 7,
  applianceLocation: "Laundry room",
  applianceGrade: "mid",
  applianceColor: "White",
  failureCause: "normal-wear",
  techRecommendation: "replace",
  laborAmount: 120,
  taxAmount: 8.5,
  parts: [{
    partNumber: "part-WPW10503278",
    quantity: 2,
    description: "part-desc-control-board",
    unitPrice: 50.25,
    partFunction: "Controls the cycle",
    failureReason: "Shorted",
  }],
  prefilledFields: ["contractNumber", "brand", "modelNumber", "serialNumber", "customerName", "customerAddress"],
  purchaseYear: 2019,
};

type EditorPanelProps = PanelProps & {
  allowAhsEdit?: boolean;
  onOpenPhoto?: (photos: string[], index: number) => void;
  submission?: (PanelProps["submission"] & Record<string, unknown>) | null;
};

function editorClient(flag: boolean): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: false,
    vrsAiAppEnrollEnabled: flag,
  });
  return queryClient;
}

function renderEditorPanel(props: EditorPanelProps, flag = true): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: editorClient(flag) },
      createElement(reviewComponents.VrsAiBridgePanel, props as never),
    ),
  );
}

function stageOneTicket(draft: unknown, overrides: Record<string, unknown> = {}) {
  return { ...editableTicket, ahsDetails: draft === null ? null : JSON.stringify(draft), ...overrides };
}

function requiredLabels(html: string): string[] {
  return [...html.matchAll(/<label[^>]*>([^<]*\*)<\/label>/g)].map((match) => match[1]);
}

describe("Stage 1 AHS editor: when it shows", () => {
  it("decides editability from the ticket and the bridge row", () => {
    const ticket = stageOneTicket({});
    expect(isAhsDetailsEditable(ticket, null)).toBe(true);
    expect(isAhsDetailsEditable(ticket, { state: "pending_review", providerCallId: null, dispatchedAt: null })).toBe(true);
    expect(isAhsDetailsEditable(ticket, { state: "dispatch_failed", providerCallId: null, dispatchedAt: null })).toBe(true);
    // Dispatched or VRS AI already working on it.
    expect(isAhsDetailsEditable(ticket, { state: "dispatching", providerCallId: null, dispatchedAt: null })).toBe(false);
    expect(isAhsDetailsEditable(ticket, { state: "queued", providerCallId: "p-1", dispatchedAt: "2026-10-23T12:00:00Z" })).toBe(false);
    expect(isAhsDetailsEditable(ticket, { state: "pending_review", providerCallId: "p-1", dispatchedAt: null })).toBe(false);
    // Stage 1 decided, or not an AHS authorization ticket.
    expect(isAhsDetailsEditable({ ...ticket, stage1Status: "approved", submissionApproved: true }, null)).toBe(false);
    expect(isAhsDetailsEditable({ ...ticket, stage1Status: "rejected" }, null)).toBe(false);
    expect(isAhsDetailsEditable({ ...ticket, ticketStatus: "completed" }, null)).toBe(false);
    expect(isAhsDetailsEditable({ ...ticket, ticketStatus: "queued" }, null)).toBe(false);
    expect(isAhsDetailsEditable({ ...ticket, warrantyType: "sears_protect" }, null)).toBe(false);
    expect(isAhsDetailsEditable({ ...ticket, warrantyType: "first_american" }, null)).toBe(false);
    expect(isAhsDetailsEditable({ ...ticket, requestType: "parts_nla" }, null)).toBe(false);
    expect(isAhsDetailsEditable(null, null)).toBe(false);
  });

  it("shows the editor in the Stage 1 card while the flag is on, with the new not-enrolled copy", () => {
    const html = renderEditorPanel({ bridge: null, submission: stageOneTicket({}), allowAhsEdit: true });
    expect(html).toContain('data-testid="ahs-details-editor"');
    expect(html).toContain(AHS_EDITOR_TITLE);
    expect(html).toContain(AHS_EDITOR_SAVE_LABEL.replace("&", "&amp;"));
    expect(html).toContain(AHS_EDITOR_REFRESH_LABEL);
    expect(html).not.toContain('data-testid="ahs-ticket-review"');
    expect(html).toMatch(
      /data-testid="vrs-ai-bridge-source"[^>]*>Source: Submitted by technician in VRS Express</,
    );
    expect(html).toContain("Complete the AHS details below and save them to send it to VRS AI.");
    expect(html).not.toContain("use the manual authorization flow");
  });

  it("opens the editor for a ticket with no stored draft at all", () => {
    const html = renderEditorPanel({ bridge: null, submission: stageOneTicket(null), allowAhsEdit: true });
    expect(html).toContain('data-testid="ahs-details-editor"');
  });

  it("waits for the detail fetch before opening the editor", () => {
    const { ahsDetails: _missing, ...slimRow } = stageOneTicket({});
    const html = renderEditorPanel({ bridge: null, submission: slimRow, allowAhsEdit: true });
    expect(html).toContain('data-testid="ahs-details-editor-loading"');
    expect(html).not.toContain('data-testid="ahs-details-editor"');
  });

  it("keeps the editor next to the bridge row until the request is dispatched", () => {
    const html = renderEditorPanel({
      bridge: appOriginBridge,
      submission: stageOneTicket(completeDraft),
      allowAhsEdit: true,
    });
    expect(html).toContain('data-testid="vrs-ai-bridge-status"');
    expect(html).toContain('data-testid="ahs-details-editor"');
    expect(html).toContain("Review the VRS AI request built from these details");
  });

  it.each([
    ["the flag is off", { bridge: null, submission: stageOneTicket(partialDraft), allowAhsEdit: true }, false],
    ["the caller is read-only", { bridge: null, submission: stageOneTicket(partialDraft) }, true],
    [
      "Stage 1 was decided",
      { bridge: null, submission: stageOneTicket(partialDraft, { stage1Status: "approved", submissionApproved: true }), allowAhsEdit: true },
      true,
    ],
    [
      "the request was dispatched",
      {
        bridge: { ...appOriginBridge, state: "queued", providerCallId: "provider-1", dispatchedAt: "2026-10-23T12:00:00Z" },
        submission: stageOneTicket(partialDraft),
        allowAhsEdit: true,
      },
      true,
    ],
  ] as const)("shows the read-only AHS view when %s", (_label, props, flag) => {
    const html = renderEditorPanel(props as EditorPanelProps, flag);
    expect(html).not.toContain('data-testid="ahs-details-editor"');
    expect(html).toContain('data-testid="ahs-ticket-review"');
    // A draft reads "Not provided" for what nobody filled in.
    expectField(html, "ahs-appliance-location", "Not provided");
    expectField(html, "ahs-labor", "Not provided");
    expectField(html, "ahs-brand", "brand-from-so-Whirlpool");
    expect(fieldSource(html, "ahs-part-0-number")).toBe("service_order");
    expect(prefillHint(html)).toContain(AHS_CHECK_PARTS);
  });

  it("tells the reader the manager can still complete the details when the view is read-only and nothing was sent", () => {
    const html = renderEditorPanel({ bridge: null, submission: stageOneTicket(partialDraft) });
    expect(html).toContain('data-testid="ahs-details-no-bridge"');
    expect(html).toContain("The VRS manager can complete the AHS details at Stage 1 to send it to VRS AI");
    expect(html).toContain("not enrolled in VRS AI");
  });
});

describe("Stage 1 AHS editor: rendering", () => {
  it("renders from an empty draft: blank inputs, no badges, required fields marked as the schema requires", () => {
    const html = renderEditorPanel({ bridge: null, submission: stageOneTicket({}), allowAhsEdit: true });
    expect(html).not.toContain('data-testid="badge-ahs-from-so-');
    for (const testId of [
      "input-ahs-contract-number",
      "input-ahs-customer-name",
      "input-ahs-customer-address",
      "select-ahs-appliance-kind",
      "input-ahs-brand",
      "input-ahs-model",
      "input-ahs-serial",
      "input-ahs-age",
      "select-ahs-location",
      "select-ahs-grade",
      "input-ahs-color",
      "select-ahs-failure-cause",
      "select-ahs-recommendation",
      "input-ahs-labor",
      "input-ahs-tax",
      "input-ahs-part-0-number",
      "input-ahs-part-0-quantity",
      "input-ahs-part-0-description",
      "input-ahs-part-0-price",
      "input-ahs-part-0-function",
      "input-ahs-part-0-failure-reason",
      "button-add-ahs-part",
    ]) {
      expect(html, testId).toContain(`data-testid="${testId}"`);
    }
    expect(html).toMatch(/data-testid="input-ahs-brand"[^>]*value=""|value=""[^>]*data-testid="input-ahs-brand"/);
    expect(requiredLabels(html)).toEqual([
      "Appliance Type *",
      "Appliance Location *",
      "Failure Cause *",
      "Part Number *",
      "Description *",
      "Price (each) *",
      "Labor Amount *",
    ]);
    expect(html).toContain(">Parts *<");
  });

  it("renders a partial draft with a \"From service order\" badge on each prefilled field, parts included", () => {
    const html = renderEditorPanel({ bridge: null, submission: stageOneTicket(partialDraft), allowAhsEdit: true });
    for (const field of ["contractNumber", "customerName", "brand", "parts"]) {
      expect(html, field).toContain(`data-testid="badge-ahs-from-so-${field}"`);
    }
    // Filled but not by the lookup, or not filled at all: no badge.
    for (const field of ["modelNumber", "serialNumber", "customerAddress", "laborAmount"]) {
      expect(html, field).not.toContain(`data-testid="badge-ahs-from-so-${field}"`);
    }
    for (const value of [
      "ahs-dispatch-77001",
      "so-customer-Maria",
      "brand-from-so-Whirlpool",
      "model-typed-WTW5000",
      "so-part-W10724237",
      "so-part-drum-roller",
      "19.99",
    ]) {
      expect(html).toContain(`value="${value}"`);
    }
    expect(html).toContain('data-testid="text-ahs-part-cost">$19.99<');
  });

  it("shows the tech's description, screenshots and videos beside the editor through the media-token components", () => {
    const html = renderEditorPanel({ bridge: null, submission: stageOneTicket(partialDraft), allowAhsEdit: true });
    const evidence = html.slice(html.indexOf('data-testid="ahs-editor-evidence"'), html.indexOf('data-testid="form-ahs-details"'));
    expect(evidence).toContain("evidence-desc: washer stops mid-cycle with F7E1");
    expect(evidence).toContain("Model, serial &amp; estimate screenshots (2)");
    expect(evidence).toContain('data-testid="ahs-review-estimate-photo-1"');
    expect(evidence).toContain("Videos (3)");
    expect(evidence).toContain('data-testid="ahs-review-video-2"');
    expect(html).not.toMatch(/src="\/objects\//);
  });
});

describe("AHS issue mapping", () => {
  it("maps client and server zod paths onto the editor's inputs", () => {
    expect(ahsIssueFieldName(["brand"])).toBe("ahsDetails.brand");
    expect(ahsIssueFieldName(["ahsDetails", "laborAmount"])).toBe("ahsDetails.laborAmount");
    expect(ahsIssueFieldName(["parts", 1, "unitPrice"])).toBe("ahsDetails.parts.1.unitPrice");
    expect(ahsIssueFieldName(["ahsDetails", "parts", "0", "partNumber"])).toBe("ahsDetails.parts.0.partNumber");
    expect(ahsIssueFieldName(["parts"])).toBe("ahsDetails.parts.root");
    expect(ahsIssueFieldName([])).toBeNull();
    expect(ahsIssueFieldName(["purchaseYear"])).toBeNull();
    expect(ahsIssueFieldName(["prefilledFields", 0])).toBeNull();
    expect(ahsIssueFieldName(["parts", 0, "sku"])).toBeNull();
    expect(groupAhsIssues([
      { path: ["brand"], message: "Brand too long" },
      { path: ["brand"], message: "second brand message" },
      { path: [], message: "Ticket already dispatched" },
      { path: ["purchaseYear"], message: "Ticket already dispatched" },
    ])).toEqual({
      fields: { "ahsDetails.brand": "Brand too long" },
      general: ["Ticket already dispatched"],
    });
    expect(groupAhsIssues(undefined)).toEqual({ fields: {}, general: [] });
  });
});

describe("VRS AI payload review tolerates missing values", () => {
  it('shows "Not provided" instead of crashing on a sparse review context', () => {
    const sparse = {
      ...v9Bridge,
      origin: "app" as const,
      reviewContext: {
        ...v9Bridge.reviewContext!,
        contract_number: undefined,
        cta_no: undefined,
        appliance_color: undefined,
        purchase_year: undefined,
        labor_amount: undefined as unknown as number,
        part_price: undefined as unknown as number,
        parts: undefined as unknown as [],
      },
    };
    const html = renderReview(sparse);
    expectField(html, "contract-number", "Not provided");
    expectField(html, "cta-number", "Not provided");
    expectField(html, "appliance-color", "Not provided");
    expectField(html, "purchase-year", "Not provided");
    expectField(html, "labor", "Not provided");
    expectField(html, "parts-total", "Not provided");
    expectField(html, "total", "Not provided");
    expectField(html, "parts", "Not provided");
    expectField(html, "tax", "$6.78");
  });
});

// ---------------------------------------------------------------------------
// Mounted editor (jsdom): validation, save, server issues, refresh
// ---------------------------------------------------------------------------

type FetchCall = { url: string; method: string; body: unknown };

let mountedRoot: Root | null = null;
let mountedContainer: HTMLDivElement | null = null;

afterEach(async () => {
  if (mountedRoot) await act(async () => mountedRoot!.unmount());
  mountedContainer?.remove();
  mountedRoot = null;
  mountedContainer = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url: "",
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Answers PATCH /ahs-details and POST /ahs-details/refresh; anything else
// fails the test.
function mockFetch(routes: { save?: () => ReturnType<typeof jsonResponse>; refresh?: () => ReturnType<typeof jsonResponse> }) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "PATCH" && url === "/api/submissions/44/ahs-details" && routes.save) return routes.save();
    if (method === "POST" && url === "/api/submissions/44/ahs-details/refresh" && routes.refresh) return routes.refresh();
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

async function mountEditor(draft: unknown, extra: Partial<EditorPanelProps> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = editorClient(true);
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  mountedContainer = document.createElement("div");
  document.body.append(mountedContainer);
  mountedRoot = createRoot(mountedContainer);
  await act(async () =>
    mountedRoot!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(reviewComponents.VrsAiBridgePanel, {
          bridge: null,
          submission: stageOneTicket(draft),
          allowAhsEdit: true,
          ...extra,
        } as never),
      ),
    ),
  );
  return { queryClient, invalidate };
}

function byTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
  const element = mountedContainer!.querySelector<T>(`[data-testid="${testId}"]`);
  expect(element, `missing ${testId}`).not.toBeNull();
  return element!;
}

function queryTestId(testId: string): HTMLElement | null {
  return mountedContainer!.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

async function typeInto(testId: string, value: string) {
  const element = byTestId<HTMLInputElement | HTMLTextAreaElement>(testId);
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(times = 10) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function clickTestId(testId: string) {
  await act(async () => byTestId(testId).click());
  await flush();
}

// The message FormMessage renders under one input.
function fieldMessage(testId: string): string | null {
  const item = byTestId(testId).closest(".space-y-2") as HTMLElement | null;
  return item?.querySelector('[id$="-form-item-message"]')?.textContent ?? null;
}

describe("Stage 1 AHS editor: mounted", () => {
  it("validates required fields on the client and sends nothing", async () => {
    const { fetchMock } = mockFetch({});
    await mountEditor({});
    await clickTestId("button-ahs-save");

    const text = mountedContainer!.textContent ?? "";
    for (const message of [
      "Select an appliance type",
      "Appliance location is required",
      "Select the failure cause",
      "Labor amount is required",
      "Part number is required",
      "Part description is required",
      "Part price is required",
    ]) {
      expect(text, message).toContain(message);
    }
    expect(fieldMessage("input-ahs-labor")).toBe("Labor amount is required");
    expect(fieldMessage("input-ahs-part-0-number")).toBe("Part number is required");
    // Optional fields carry no message.
    expect(fieldMessage("input-ahs-brand")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes the parsed details, invalidates the ticket queries and says VRS AI is ready", async () => {
    const saved = { ...completeDraft, brand: "brand-corrected", prefilledFields: ["contractNumber"] };
    const { calls } = mockFetch({ save: () => jsonResponse(200, { ok: true, ahsDetails: saved, enrolled: true }) });
    const { invalidate } = await mountEditor(completeDraft);

    expect(queryTestId("badge-ahs-from-so-brand")).not.toBeNull();
    await typeInto("input-ahs-brand", "brand-corrected");
    // A changed value is no longer the service order's.
    expect(queryTestId("badge-ahs-from-so-brand")).toBeNull();
    await clickTestId("button-ahs-save");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "/api/submissions/44/ahs-details",
      method: "PATCH",
      body: {
        ahsDetails: {
          contractNumber: "ahs-dispatch-77001",
          customerName: "so-customer-Maria",
          customerAddress: "so-address-742-Evergreen",
          applianceKind: "washer",
          brand: "brand-corrected",
          modelNumber: "model-from-so-WTW5000",
          serialNumber: "serial-from-so-C3129",
          applianceAge: 7,
          applianceLocation: "Laundry room",
          applianceGrade: "mid",
          applianceColor: "White",
          failureCause: "normal-wear",
          techRecommendation: "replace",
          laborAmount: 120,
          taxAmount: 8.5,
          parts: [{
            partNumber: "part-WPW10503278",
            quantity: 2,
            description: "part-desc-control-board",
            unitPrice: 50.25,
            partFunction: "Controls the cycle",
            failureReason: "Shorted",
          }],
        },
      },
    });
    // Server-only keys never go up.
    expect(JSON.stringify(calls[0].body)).not.toContain("prefilledFields");
    expect(JSON.stringify(calls[0].body)).not.toContain("purchaseYear");

    const predicate = invalidate.mock.calls[0]?.[0]?.predicate as ((query: { queryKey: unknown[] }) => boolean) | undefined;
    expect(predicate).toBeTypeOf("function");
    expect(predicate!({ queryKey: ["/api/submissions", 44] })).toBe(true);
    expect(predicate!({ queryKey: ["/api/agent/stats"] })).toBe(false);

    expect(byTestId("text-ahs-enrolled").textContent).toBe(AHS_EDITOR_ENROLLED_TEXT);
    expect(queryTestId("text-ahs-enroll-skipped")).toBeNull();
    // The saved provenance now drives the badges.
    expect(queryTestId("badge-ahs-from-so-contractNumber")).not.toBeNull();
    expect(queryTestId("badge-ahs-from-so-modelNumber")).toBeNull();
  });

  it("shows why the ticket was not enrolled", async () => {
    mockFetch({
      save: () => jsonResponse(200, {
        ok: true,
        ahsDetails: completeDraft,
        enrolled: false,
        enrollSkipReason: "skip-reason: technician phone missing",
      }),
    });
    await mountEditor(completeDraft);
    await clickTestId("button-ahs-save");
    expect(byTestId("text-ahs-enroll-skipped").textContent).toBe(
      `${AHS_EDITOR_SKIPPED_TEXT} skip-reason: technician phone missing`,
    );
    expect(queryTestId("text-ahs-enrolled")).toBeNull();
  });

  it("maps the server's zod issues to their fields and lists the rest", async () => {
    mockFetch({
      save: () => jsonResponse(400, {
        ok: false,
        error: "server-error: invalid AHS details",
        issues: [
          { path: ["ahsDetails", "modelNumber"], message: "server-issue: model unknown" },
          { path: ["parts", 0, "unitPrice"], message: "server-issue: price too low" },
          { path: ["parts", 3, "partNumber"], message: "server-issue: missing row" },
          { path: ["purchaseYear"], message: "server-issue: purchase year" },
        ],
      }),
    });
    await mountEditor(completeDraft);
    await clickTestId("button-ahs-save");

    expect(fieldMessage("input-ahs-model")).toBe("server-issue: model unknown");
    expect(fieldMessage("input-ahs-part-0-price")).toBe("server-issue: price too low");
    const general = byTestId("ahs-editor-errors").textContent ?? "";
    expect(general).toContain("server-error: invalid AHS details");
    expect(general).toContain("server-issue: missing row");
    expect(general).toContain("server-issue: purchase year");
    expect(queryTestId("text-ahs-enrolled")).toBeNull();
  });

  it("refreshes from the service order and fills only blank fields", async () => {
    const { calls } = mockFetch({
      refresh: () => jsonResponse(200, {
        ok: true,
        ahsDetails: {
          ...partialDraft,
          brand: "brand-from-refresh",
          serialNumber: "serial-from-refresh",
          prefilledFields: ["contractNumber", "customerName", "brand", "serialNumber", "parts"],
        },
        snowflake: "found",
        hssom: "not_found",
      }),
    });
    await mountEditor(partialDraft);
    await typeInto("input-ahs-brand", "brand-typed-by-manager");
    await clickTestId("button-ahs-refresh");

    expect(calls).toEqual([{ url: "/api/submissions/44/ahs-details/refresh", method: "POST", body: undefined }]);
    expect(byTestId<HTMLInputElement>("input-ahs-brand").value).toBe("brand-typed-by-manager");
    expect(byTestId<HTMLInputElement>("input-ahs-serial").value).toBe("serial-from-refresh");
    expect(queryTestId("badge-ahs-from-so-serialNumber")).not.toBeNull();
    expect(queryTestId("badge-ahs-from-so-brand")).toBeNull();
    const note = byTestId("text-ahs-refresh-note").textContent ?? "";
    expect(note).toContain("Service order lookup: found.");
    expect(note).toContain("HSSOM lookup: not found.");
    expect(note).toContain("Filled 1 blank field.");
  });

  it("enlarges a screenshot through the dashboard's lightbox callback", async () => {
    mockFetch({});
    const onOpenPhoto = vi.fn();
    await mountEditor(partialDraft, { onOpenPhoto });
    expect(byTestId("text-ahs-evidence-description").textContent).toBe(
      "evidence-desc: washer stops mid-cycle with F7E1",
    );
    await clickTestId("ahs-review-estimate-photo-1");
    expect(onOpenPhoto).toHaveBeenCalledWith(["/objects/model-tag.jpg", "/objects/estimate.jpg"], 1);
    expect(mountedContainer!.querySelectorAll('[data-testid^="ahs-review-video-"]')).toHaveLength(3);
  });

  it("adds and removes part rows", async () => {
    mockFetch({});
    await mountEditor({});
    await clickTestId("button-add-ahs-part");
    expect(queryTestId("ahs-part-1")).not.toBeNull();
    await clickTestId("button-remove-ahs-part-1");
    expect(queryTestId("ahs-part-1")).toBeNull();
  });
});
