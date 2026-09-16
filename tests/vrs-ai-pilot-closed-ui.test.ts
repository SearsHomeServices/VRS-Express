import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { VrsAiPilotClosedReview } from "../client/src/components/vrs-ai-pilot-closed-review";
import type { VrsAiBridgeStatus } from "../client/src/lib/vrsAiBridge";

const bridge: VrsAiBridgeStatus = {
  callId: "pilot-closed-call",
  contractVersion: "v9",
  state: "approved",
  providerCallId: "provider-call",
  dispatchError: null,
  failureReason: null,
  retryable: null,
  dispatchedAt: "2026-09-15T15:00:00Z",
  reviewContext: {
    service_order: "8175-12345678",
    reason_for_call: "authorization",
    tech_id: "tech-001",
    tech_phone: "N/A",
    tech_name: "Pilot Tech",
    parts: [],
    customer_name: "Pilot Customer",
    customer_address: "Customer Address",
    service_address: "Service Address",
    brand: "Whirlpool",
    model_number: "MODEL-1",
    serial_number: "SERIAL-1",
    appliance_type: "Washer",
    appliance_age: 4,
    labor_amount: 100,
    tax_amount: 8,
    part_price: 20,
    appliance_location: "Laundry room",
    failure_cause: "Failed pump",
    tech_recommendation: "Repair",
    repair_replace_rationale: "Repair is appropriate",
    appliance_photos: ["/api/submissions/1/vrs-ai-photos/0"],
    comments: [],
    cta_no: "CTA-1",
    district_number: "8206",
  },
};

function renderReview(
  submission: React.ComponentProps<typeof VrsAiPilotClosedReview>["submission"],
  pilotBridge: VrsAiBridgeStatus | null = bridge,
): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: true,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(VrsAiPilotClosedReview, {
        submission,
        bridge: pilotBridge,
      }),
    ),
  );
}

describe("VRS AI Pilot closed review", () => {
  it.each(["completed", "rejected", "rejected_closed", "invalid"] as const)(
    "renders the read-only review for terminal status %s",
    (ticketStatus) => {
      const html = renderReview({
        ticketStatus,
        agentNotes: "Saved AI note for this closed ticket",
      });

      expect(html).toContain('data-testid="card-vrs-ai-pilot-closed-review"');
      expect(html).toContain("Saved AI agent notes");
      expect(html).toContain("Saved AI note for this closed ticket");
      expect(html).toContain('data-testid="vrs-ai-bridge-status"');
    },
  );

  it("does not render closed controls for a pending ticket", () => {
    expect(renderReview({
      ticketStatus: "pending",
      agentNotes: "Pending workflow note",
    })).toBe("");
  });

  it("keeps every outcome control visible and disabled without adding a note thread", () => {
    const html = renderReview({
      ticketStatus: "rejected_closed",
      agentNotes: "Closed outcome context",
    });

    for (const [testId, label] of [
      ["vrs-ai-pilot-closed-action-approve", "Approved to Repair"],
      ["vrs-ai-pilot-closed-action-reject", "Reject"],
      ["vrs-ai-pilot-closed-action-reject-and-close", "Reject &amp; Close"],
      ["vrs-ai-pilot-closed-action-invalid", "Invalid"],
    ]) {
      const controlStart = html.indexOf(`data-testid="${testId}"`);
      const controlEnd = html.indexOf("</button>", controlStart);
      expect(controlStart).toBeGreaterThanOrEqual(0);
      expect(html.slice(Math.max(0, controlStart - 300), controlEnd)).toContain(
        "disabled",
      );
      expect(html).toContain(label);
    }

    expect(html).toContain("reprocessing");
    expect(html).toContain("dispatch notifications");
    expect(html).not.toContain("input-agent-note-body");
    expect(html).not.toContain("button-post-agent-note");
  });

  it("keeps Bridge details in the panel while Photos & Media owns proxy photos", () => {
    const html = renderReview({
      ticketStatus: "completed",
      agentNotes: null,
    });

    expect(html).toContain("Review SASHA / Tech Hub details");
    expect(html).toContain("Service Address");
    expect(html).not.toContain("Sender photos");
  });

  it("parses legacy JSON rejection reasons before rendering them", () => {
    const html = renderReview({
      ticketStatus: "rejected",
      rejectionReasons: JSON.stringify([
        "Photos do not meet submission criteria",
        "Missing required photos",
      ]),
    });

    expect(html).toContain(
      "Photos do not meet submission criteria, Missing required photos",
    );
    expect(html).not.toContain("[&quot;Photos do not meet submission criteria&quot;");
  });
});