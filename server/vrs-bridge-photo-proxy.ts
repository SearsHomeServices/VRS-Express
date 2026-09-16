import type { Express, NextFunction, Request, Response } from "express";
import type { AuthenticatedRequest } from "./middleware/auth";
import type { VrsAiBridgeStatus } from "./vrs-sasha-store";
import type { VrsBridgeRecord } from "./vrs-sasha-queue";

export const SHSAI_DEV_PHOTO_HOST = "sasha-dev.stage.nextgen.shs.com";
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const IMAGE_CONTENT_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type SubmissionAccessRecord = {
  id: number;
  technicianId: number;
  assignedTo: number | null;
  ticketStatus: string;
  reviewedBy: number | null;
  requestType: string | null;
  applianceType: string | null;
};

type ProxyDependencies = {
  authenticate: (req: Request, res: Response, next: NextFunction) => unknown;
  getSubmission: (id: number) => Promise<SubmissionAccessRecord | undefined>;
  getBridge: (submissionId: number) => Promise<VrsBridgeRecord | undefined>;
  getSpecializations: (userId: number) => Promise<Array<{ division: string }>>;
  allDivisionCount: number;
  isEnabled: () => boolean;
  fetchImpl?: typeof fetch;
  fetchTimeoutMs?: number;
};

export function bridgePhotoProxyPath(submissionId: number, photoIndex: number): string {
  return `/api/submissions/${submissionId}/vrs-ai-photos/${photoIndex}`;
}

// The stored payload remains server-only. Only non-sensitive same-origin
// paths are returned to the agent detail API while the DEV proxy is enabled.
export function sanitizeBridgeReviewPhotoUrls(
  status: VrsAiBridgeStatus,
  submissionId: number,
): VrsAiBridgeStatus {
  const photos = status.reviewContext.appliance_photos;
  if (!Array.isArray(photos)) return status;
  return {
    ...status,
    reviewContext: {
      ...status.reviewContext,
      appliance_photos: photos.map((_, index) =>
        bridgePhotoProxyPath(submissionId, index),
      ),
    },
  };
}

export function browserBridgeStatus(
  status: VrsAiBridgeStatus | null,
  submissionId: number,
  proxyEnabled: boolean,
): VrsAiBridgeStatus | null {
  if (!status || !proxyEnabled) return status;
  return sanitizeBridgeReviewPhotoUrls(status, submissionId);
}

function isAllowedPhotoUrl(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  try {
    // URL normalizes an explicit default port away, so reject a colon in the
    // supplied authority before parsing as well as checking URL.port below.
    const authority = value
      .slice(value.indexOf("://") + 3)
      .split(/[/?#]/, 1)[0];
    if (authority.includes(":") || authority.includes("@")) return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === SHSAI_DEV_PHOTO_HOST &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

async function cancelResponseBody(response: globalThis.Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort resource release only. Do not replace a safe proxy error.
  }
}

async function readReaderWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error("aborted");
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel();
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedImage(
  response: globalThis.Response,
  signal: AbortSignal,
): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_PHOTO_BYTES) {
      throw new ProxyPhotoError("PHOTO_TOO_LARGE", 413);
    }
  }

  if (!response.body) throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await readReaderWithAbort(reader, signal);
      if (done) break;
      if (!value) continue;
      byteCount += value.byteLength;
      if (byteCount > MAX_PHOTO_BYTES) {
        throw new ProxyPhotoError("PHOTO_TOO_LARGE", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // The body may already have been aborted; releasing the lock below is
      // still required.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

class ProxyPhotoError extends Error {
  constructor(
    public readonly code: "PHOTO_UNAVAILABLE" | "PHOTO_TOO_LARGE",
    public readonly status: 413 | 502 | 504,
  ) {
    super(code);
  }
}

async function fetchAllowedImage(
  originalUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ contentType: string; body: Buffer }> {
  let currentUrl = originalUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      let response: globalThis.Response;
      try {
        response = await fetchImpl(currentUrl, {
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        throw new ProxyPhotoError(
          "PHOTO_UNAVAILABLE",
          controller.signal.aborted ? 504 : 502,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === MAX_REDIRECTS) {
          await cancelResponseBody(response);
          throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
        }
        let redirectUrl: string;
        try {
          redirectUrl = new URL(location, currentUrl).toString();
        } catch {
          await cancelResponseBody(response);
          throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
        }
        if (!isAllowedPhotoUrl(redirectUrl)) {
          await cancelResponseBody(response);
          throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
        }
        await cancelResponseBody(response);
        currentUrl = redirectUrl;
        continue;
      }

      if (!response.ok) {
        await cancelResponseBody(response);
        throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
      }
      const contentType = (response.headers.get("content-type") ?? "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (!IMAGE_CONTENT_TYPES.has(contentType)) {
        await cancelResponseBody(response);
        throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
      }
      try {
        return {
          contentType,
          body: await readBoundedImage(response, controller.signal),
        };
      } catch (error) {
        if (error instanceof ProxyPhotoError) throw error;
        throw new ProxyPhotoError(
          "PHOTO_UNAVAILABLE",
          controller.signal.aborted ? 504 : 502,
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
  throw new ProxyPhotoError("PHOTO_UNAVAILABLE", 502);
}

async function canAccessSubmission(
  req: AuthenticatedRequest,
  submission: SubmissionAccessRecord,
  deps: ProxyDependencies,
): Promise<boolean> {
  const user = req.user!;
  if (
    (user.role === "technician" || user.role === "provider_1099") &&
    submission.technicianId !== user.id
  ) {
    return false;
  }
  if (user.role !== "vrs_agent") return true;

  const isAssignedToAgent = submission.assignedTo === user.id;
  const isQueued = submission.ticketStatus === "queued";
  const isReviewer = submission.reviewedBy === user.id;
  if (!isAssignedToAgent && !isQueued && !isReviewer) return false;
  if (!isQueued) return true;

  const divisions = (await deps.getSpecializations(user.id)).map(
    (specialization) => specialization.division,
  );
  const isGeneralist = divisions.length >= deps.allDivisionCount;
  const isNlaTicket = submission.requestType === "parts_nla";
  return (
    isGeneralist ||
    (isNlaTicket
      ? divisions.includes("nla")
      : divisions.includes(submission.applianceType ?? ""))
  );
}

function safeProxyError(
  res: Response,
  status: number,
  error: string,
): Response {
  // Do not include upstream status text, URL, redirect Location, or fetch
  // errors: SHSAI signed URLs and query strings must remain server-only.
  return res.status(status).json({ error, message: "Photo is unavailable." });
}

export function registerVrsBridgePhotoProxy(
  app: Express,
  deps: ProxyDependencies,
): void {
  app.get(
    "/api/submissions/:submissionId/vrs-ai-photos/:photoIndex",
    deps.authenticate,
    async (req, res) => {
      if (!deps.isEnabled()) return res.status(404).json({ error: "Not found" });

      const submissionIdParam = req.params.submissionId;
      const photoIndexParam = req.params.photoIndex;
      const submissionId =
        typeof submissionIdParam === "string" ? Number(submissionIdParam) : NaN;
      const photoIndex =
        typeof photoIndexParam === "string" ? Number(photoIndexParam) : NaN;
      if (
        !Number.isSafeInteger(submissionId) ||
        submissionId < 1 ||
        typeof photoIndexParam !== "string" ||
        !/^\d+$/.test(photoIndexParam) ||
        !Number.isSafeInteger(photoIndex)
      ) {
        return res.status(400).json({ error: "Invalid photo request" });
      }

      try {
        const submission = await deps.getSubmission(submissionId);
        if (!submission) return res.status(404).json({ error: "Submission not found" });
        if (!(await canAccessSubmission(req as AuthenticatedRequest, submission, deps))) {
          return res.status(403).json({ error: "Access denied" });
        }

        const bridge = await deps.getBridge(submissionId);
        const photos = bridge?.requestPayload.appliance_photos;
        const originalUrl = Array.isArray(photos) ? photos[photoIndex] : undefined;
        if (typeof originalUrl !== "string") {
          return res.status(404).json({ error: "Photo not found" });
        }
        if (!isAllowedPhotoUrl(originalUrl)) {
          return safeProxyError(res, 422, "PHOTO_SOURCE_NOT_ALLOWED");
        }

        const image = await fetchAllowedImage(
          originalUrl,
          deps.fetchImpl ?? fetch,
          deps.fetchTimeoutMs,
        );
        res.setHeader("Content-Type", image.contentType);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        return res.status(200).send(image.body);
      } catch (error) {
        if (error instanceof ProxyPhotoError) {
          return safeProxyError(res, error.status, error.code);
        }
        // This may include a database failure, never an upstream URL. Keep the
        // response and logs URL-free rather than serializing the exception.
        return safeProxyError(res, 502, "PHOTO_UNAVAILABLE");
      }
    },
  );
}