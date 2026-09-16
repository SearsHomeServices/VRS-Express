import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createHandlerHarness } from "./helpers/vrs-handler-harness";

const originalProxyFlag = process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED;

afterEach(() => {
  if (originalProxyFlag === undefined) {
    delete process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED;
  } else {
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = originalProxyFlag;
  }
});

describe("Bridge Stage 1 browser response", () => {
  it("sanitizes the approve_submission Bridge status when the proxy is enabled", async () => {
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "true";
    const bridgeStatus = {
      callId: "bridge-call",
      contractVersion: "v8",
      state: "queued",
      providerCallId: null,
      dispatchError: null,
      failureReason: null,
      retryable: null,
      dispatchedAt: null,
      reviewContext: {
        appliance_photos: [
          "https://sasha-dev.stage.nextgen.shs.com/photo.jpg?opaque=redacted",
        ],
      },
    };
    const fixture = createHandlerHarness(
      { submissionApproved: false, stage1Status: "pending" },
      {
        bridge: {
          getStatusBySubmissionId: async () => bridgeStatus,
        },
      },
    );
    const response = await request(fixture.app)
      .post("/manual")
      .send({ action: "approve_submission" });

    expect(response.status).toBe(200);
    expect(response.body.vrsAi.reviewContext.appliance_photos).toEqual([
      "/api/submissions/1/vrs-ai-photos/0",
    ]);
    expect(JSON.stringify(response.body)).not.toContain("?opaque");
  });
});