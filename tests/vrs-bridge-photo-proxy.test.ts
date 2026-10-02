import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { isVrsBridgePhotoProxyEnabled } from "../server/featureFlags";
import {
  registerVrsBridgePhotoProxy,
  sanitizeBridgeReviewPhotoUrls,
  SHSAI_DEV_PHOTO_HOST,
  SHSAI_PROD_PHOTO_HOST,
} from "../server/vrs-bridge-photo-proxy";

const safePhotoUrl = `https://${SHSAI_DEV_PHOTO_HOST}/photo.jpg`;
const originalProxyFlag = process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED;

function makeApp(options: {
  enabled?: boolean;
  user?: { id: number; role: string };
  submission?: Record<string, unknown>;
  photoUrl?: string;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
} = {}) {
  const app = express();
  const user = options.user ?? { id: 17, role: "vrs_agent" };
  const submission = {
    id: 44,
    technicianId: 17,
    assignedTo: 17,
    ticketStatus: "pending",
    reviewedBy: null,
    requestType: "authorization",
    applianceType: "laundry",
    ...options.submission,
  };
  const authenticate = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = user;
    next();
  };
  registerVrsBridgePhotoProxy(app, {
    authenticate,
    getSubmission: async () => submission as any,
    getBridge: async () => ({
      requestPayload: { appliance_photos: [options.photoUrl ?? safePhotoUrl] },
    }) as any,
    getSpecializations: async () => [{ division: "laundry" }],
    allDivisionCount: 8,
    isEnabled: () => options.enabled ?? true,
    fetchImpl:
      options.fetchImpl ??
      (async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "3" },
        })) as typeof fetch,
    fetchTimeoutMs: options.fetchTimeoutMs,
  });
  return app;
}

afterEach(() => {
  if (originalProxyFlag === undefined) {
    delete process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED;
  } else {
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = originalProxyFlag;
  }
});

describe("DEV Bridge photo proxy", () => {
  it("is disabled unless the environment flag is exactly true", () => {
    delete process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED;
    expect(isVrsBridgePhotoProxyEnabled()).toBe(false);
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = " true";
    expect(isVrsBridgePhotoProxyEnabled()).toBe(false);
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "TRUE";
    expect(isVrsBridgePhotoProxyEnabled()).toBe(false);
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "true";
    expect(isVrsBridgePhotoProxyEnabled()).toBe(true);
  });

  it("is enabled in production when explicitly enabled", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "true";
    expect(isVrsBridgePhotoProxyEnabled()).toBe(true);
    process.env.VRS_BRIDGE_PHOTO_PROXY_ENABLED = "false";
    expect(isVrsBridgePhotoProxyEnabled()).toBe(false);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("does not register usable media while disabled", async () => {
    const response = await request(makeApp({ enabled: false }))
      .get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Not found" });
  });

  it("returns allowed images from the VRS origin without upstream CORP", async () => {
    const response = await request(
      makeApp({
        fetchImpl: (async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "cross-origin-resource-policy": "same-origin",
            },
          })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers["cross-origin-resource-policy"]).toBeUndefined();
  });

  it("enforces the existing submission authorization boundary", async () => {
    const response = await request(
      makeApp({
        user: { id: 99, role: "technician" },
        submission: { technicianId: 17 },
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Access denied" });
  });

  it("rejects invalid indexes without reading the stored URL", async () => {
    const response = await request(makeApp())
      .get("/api/submissions/44/vrs-ai-photos/1");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Photo not found" });
  });

  it("accepts the production Sasha photo host", async () => {
    const response = await request(
      makeApp({
        photoUrl: `https://${SHSAI_PROD_PHOTO_HOST}/photo.jpg`,
        fetchImpl: (async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
  });

  it("rejects every source host except the exact SHSAI hosts", async () => {
    const response = await request(
      makeApp({ photoUrl: "https://sasha.stage.nextgen.shs.com/photo.jpg" }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      error: "PHOTO_SOURCE_NOT_ALLOWED",
      message: "Photo is unavailable.",
    });

    for (const unsafeUrl of [
      `https://${SHSAI_DEV_PHOTO_HOST}:443/photo.jpg`,
      `https://user:password@${SHSAI_DEV_PHOTO_HOST}/photo.jpg`,
      "http://sasha-dev.stage.nextgen.shs.com/photo.jpg",
      `http://${SHSAI_PROD_PHOTO_HOST}/photo.jpg`,
      `https://${SHSAI_PROD_PHOTO_HOST}:443/photo.jpg`,
      "not a url",
    ]) {
      const unsafeResponse = await request(makeApp({ photoUrl: unsafeUrl }))
        .get("/api/submissions/44/vrs-ai-photos/0");
      expect(unsafeResponse.status).toBe(422);
      expect(JSON.stringify(unsafeResponse.body)).not.toContain(unsafeUrl);
    }
  });

  it("does not follow redirects to an unapproved host", async () => {
    const response = await request(
      makeApp({
        fetchImpl: (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://attacker.example/photo.jpg" },
          })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain("attacker.example");
  });

  it("returns a safe timeout error", async () => {
    const response = await request(
      makeApp({
        fetchTimeoutMs: 1,
        fetchImpl: ((_: string, init?: RequestInit) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          )) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      error: "PHOTO_UNAVAILABLE",
      message: "Photo is unavailable.",
    });
  });

  it("aborts a stalled response body and returns the same safe timeout", async () => {
    let bodyCancelled = false;
    const stalledBody = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        bodyCancelled = true;
      },
    });
    const response = await request(
      makeApp({
        fetchTimeoutMs: 1,
        fetchImpl: (async () =>
          new Response(stalledBody, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(504);
    expect(response.body).toEqual({
      error: "PHOTO_UNAVAILABLE",
      message: "Photo is unavailable.",
    });
    expect(bodyCancelled).toBe(true);
  });

  it("rejects oversized and non-image responses", async () => {
    const oversized = await request(
      makeApp({
        fetchImpl: (async () =>
          new Response(null, {
            status: 200,
            headers: {
              "content-type": "image/jpeg",
              "content-length": String(11 * 1024 * 1024),
            },
          })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(oversized.status).toBe(413);
    expect(oversized.body.error).toBe("PHOTO_TOO_LARGE");

    const nonImage = await request(
      makeApp({
        fetchImpl: (async () =>
          new Response("not an image", {
            status: 200,
            headers: { "content-type": "text/html" },
          })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(nonImage.status).toBe(502);
    expect(nonImage.body.error).toBe("PHOTO_UNAVAILABLE");
  });

  it("turns an expired upstream response into a URL-free error", async () => {
    const response = await request(
      makeApp({
        fetchImpl: (async () => new Response(null, { status: 403 })) as typeof fetch,
      }),
    ).get("/api/submissions/44/vrs-ai-photos/0");
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toBe(
      JSON.stringify({
        error: "PHOTO_UNAVAILABLE",
        message: "Photo is unavailable.",
      }),
    );
  });

  it("sanitizes review-context photos to index-only proxy paths", () => {
    const status = {
      callId: "bridge-call",
      contractVersion: "v8",
      state: "pending_review",
      providerCallId: null,
      dispatchError: null,
      failureReason: null,
      retryable: null,
      dispatchedAt: null,
      reviewContext: {
        appliance_photos: [`${safePhotoUrl}?opaque=redacted`],
      },
    } as any;
    const result = sanitizeBridgeReviewPhotoUrls(status, 44);
    expect(result.reviewContext.appliance_photos).toEqual([
      "/api/submissions/44/vrs-ai-photos/0",
    ]);
    expect(JSON.stringify(result)).not.toContain("?opaque");
  });
});