import { describe, expect, it } from "vitest";
import {
  getVrsAiApprovalCopy,
  type VrsAiBridgeStatus,
} from "../client/src/lib/vrsAiBridge";

describe("VRS AI bridge agent approval copy", () => {
  it("makes the human-to-AI handoff explicit for bridge tickets", () => {
    const bridge: VrsAiBridgeStatus = {
      callId: "vrs_call_bridge_123",
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
