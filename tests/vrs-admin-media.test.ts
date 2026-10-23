// @vitest-environment jsdom
// Runtime component regressions, NOT physical-device/real-expiration acceptance.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TicketDetailDialog } from "../client/src/pages/admin-dashboard";
import { VrsAiBridgePhotos } from "../client/src/components/vrs-ai-bridge-photos";

const media = vi.hoisted(() => ({
  buildMediaUrl: vi.fn(async (path: string) => `${path}?media-token=fixture`),
  buildMediaUrls: vi.fn(async (paths: string[]) => paths.map(path => `${path}?media-token=fixture`)),
  prefetchMediaTokens: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../client/src/lib/auth")>(),
  getToken: () => "fixture-session",
  ...media,
}));
// Legacy media signing is independently tested. Keep the real Admin grouping,
// thumbnail selection, lightbox callbacks, bridge component, loader and flags.
vi.mock("@/components/media", () => ({
  MediaImage: (props: any) => createElement("img", props),
  MediaVideo: (props: any) => createElement("video", props),
  MediaAudio: (props: any) => createElement("audio", props),
}));
vi.mock("@/components/submission-notes-thread", () => ({
  SubmissionNotesThread: () => null,
}));

const proxyPath = "/api/submissions/44/vrs-ai-photos/0";
const signedSource = "https://sender.example.test/photo.jpg?signature=private";
const legacy = "/objects/legacy-photo.jpg";
const techHub = "https://techhub.example.test/uploads/part.jpg";
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  fetchMock = vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(["fixture-image"], { type: "image/jpeg" }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  createObjectURL = vi.fn(() => "blob:fixture-photo");
  revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, `Missing clickable element ${selector}`).not.toBeNull();
  await act(async () => element!.click());
}

type GalleryOptions = {
  enabled?: boolean;
  photos?: string | null;
  bridgePhotos?: string[];
  thumbnails?: Record<string, string>;
  videoUrl?: string;
  voiceNoteUrl?: string;
};

async function renderGallery({
  enabled = true, photos = null, bridgePhotos, thumbnails, videoUrl, voiceNoteUrl,
}: GalleryOptions = {}) {
  client.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: enabled,
  });
  client.setQueryData(["/api/admin/submissions", 44, "audit"], {
    submission: {
      id: 44, serviceOrderNo: "fixture-order", stage1Status: "pending",
      createdAt: "2026-09-01T12:00:00Z",
      photos, photoThumbnails: JSON.stringify(thumbnails ?? {}), videoUrl, voiceNoteUrl,
    },
    timeline: [], userNames: {}, smsLogs: [],
    ...(bridgePhotos === undefined ? {} : {
      vrsAi: { reviewContext: { appliance_photos: bridgePhotos } },
    }),
  });
  await act(async () => root.render(
    createElement(QueryClientProvider, { client },
      createElement(TicketDetailDialog, { ticketId: 44, open: true, onClose: vi.fn() })),
  ));
  await click('[data-testid="tab-ticket-media"]');
}

function noPhotos() {
  return document.querySelector('[data-testid="text-admin-no-photos"]');
}

describe("Admin ticket Media gallery runtime", () => {
  it.each([null, "[]", '{"issue":[],"estimate":[]}', "not-json"])(
    "shows bridge-only photos instead of an empty message with legacy payload %s",
    async (photos) => {
      await renderGallery({ photos, bridgePhotos: [proxyPath] });
      expect(noPhotos()).toBeNull();
      expect(document.querySelector('img[alt="Sender appliance 1"]')?.getAttribute("src"))
        .toBe("blob:fixture-photo");
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(proxyPath, {
        headers: { Authorization: "Bearer fixture-session" },
      });
      expect(document.body.innerHTML).not.toContain(signedSource);
      expect(document.body.innerHTML).not.toContain(`src="${proxyPath}"`);
    },
  );

  it.each([null, "[]", "{}", '{"issue":[],"estimate":[]}', "not-json"])(
    "shows the empty message only when neither source has photos: %s",
    async (photos) => {
      await renderGallery({ photos, bridgePhotos: [] });
      expect(noPhotos()?.textContent).toBe("No photos attached");
      expect(document.body.textContent).not.toContain("Sender photos");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("preserves legacy/TechHub media when the flag is %s", async (enabled) => {
    await renderGallery({ enabled, photos: JSON.stringify([legacy, techHub]) });
    expect(noPhotos()).toBeNull();
    expect(document.querySelector('img[alt="Photos 1"]')?.getAttribute("src")).toBe(legacy);
    expect(document.querySelector('img[alt="Photos 2"]')?.getAttribute("src")).toBe(techHub);
    expect(document.body.textContent).not.toContain("Sender photos");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps thumbnail display separate from full-size legacy paths beside bridge photos", async () => {
    await renderGallery({
      photos: JSON.stringify([legacy, techHub]),
      thumbnails: { [legacy]: "/objects/legacy-thumb.jpg" },
      bridgePhotos: [proxyPath],
    });
    expect(noPhotos()).toBeNull();
    expect(document.querySelector('img[alt="Photos 1"]')?.getAttribute("src"))
      .toBe("/objects/legacy-thumb.jpg");
    expect(document.querySelector('img[alt="Photos 2"]')?.getAttribute("src")).toBe(techHub);
    expect(document.querySelector('img[alt="Sender appliance 1"]')).not.toBeNull();
    await click('[data-testid="admin-legacy-photos-photo-0"]');
    expect(media.buildMediaUrls).toHaveBeenCalledWith([legacy, techHub]);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    await click('[data-testid="admin-legacy-photos-download-0"]');
    expect(media.buildMediaUrl).toHaveBeenCalledWith(legacy);
    expect(open).toHaveBeenCalledWith(`${legacy}?media-token=fixture`, "_blank", "noopener,noreferrer");
  });

  it("keeps categorized issue/estimate photos and their lightbox offsets beside bridge photos", async () => {
    await renderGallery({
      photos: JSON.stringify({ issue: [legacy], estimate: [techHub] }),
      bridgePhotos: [proxyPath],
    });
    expect(noPhotos()).toBeNull();
    expect(document.querySelector('[data-testid="admin-media-issue-photos"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="admin-media-estimate-photos"]')).not.toBeNull();
    await click('[data-testid="admin-estimate-photos-photo-0"]');
    expect(media.buildMediaUrls).toHaveBeenCalledWith([legacy, techHub]);
    // The selected estimate photo is the second full-size photo, not the first.
    expect(document.querySelector(`img[src="${techHub}?media-token=fixture"]`)).not.toBeNull();
  });

  it("keeps the production-disabled audit shape empty without attempting bridge fetches", async () => {
    await renderGallery({ enabled: false });
    expect(noPhotos()?.textContent).toBe("No photos attached");
    expect(document.body.textContent).not.toContain("Sender photos");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps legacy video and voice attachments alongside the bridge gallery", async () => {
    await renderGallery({
      bridgePhotos: [proxyPath],
      videoUrl: JSON.stringify(["/objects/video-one.mp4", "/objects/video-two.mp4"]),
      voiceNoteUrl: "/objects/voice-note.webm",
    });
    expect(Array.from(document.querySelectorAll("video"), video => video.getAttribute("src")))
      .toEqual(["/objects/video-one.mp4", "/objects/video-two.mp4"]);
    expect(document.querySelector("audio")?.getAttribute("src")).toBe("/objects/voice-note.webm");
    expect(document.querySelector('[data-testid="text-admin-no-video"]')).toBeNull();
    expect(document.querySelector('[data-testid="text-admin-no-voice"]')).toBeNull();
    expect(noPhotos()).toBeNull();
  });

  it.each([true, false])("passes the runtime flag (%s) through for a stale signed source", async (enabled) => {
    await renderGallery({ enabled, bridgePhotos: [signedSource] });
    expect(noPhotos()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    if (enabled) {
      expect(document.querySelector('[data-testid="vrs-bridge-photo-error"]')).not.toBeNull();
      expect(document.querySelector('img[alt="Sender appliance 1"]')).toBeNull();
      expect(document.body.innerHTML).not.toContain(signedSource);
    } else {
      // Existing direct-link behavior is preserved; disabled audit responses
      // don't supply bridge context, but previously cached payloads may have it.
      expect(document.querySelector('img[alt="Sender appliance 1"]')?.getAttribute("src")).toBe(signedSource);
      expect(document.querySelector('[data-testid="vrs-bridge-photo-error"]')).toBeNull();
    }
  });

  it("reports an unavailable attached photo, not 'No photos attached', and retries it", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await renderGallery({ bridgePhotos: [proxyPath] });
    expect(noPhotos()).toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("sender photos are unavailable");
    expect(document.querySelector('img[alt="Sender appliance 1"]')).toBeNull();
    await click('[data-testid="vrs-bridge-photo-error"] button');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-testid="vrs-bridge-photo-error"]')).toBeNull();
    expect(document.querySelector('img[alt="Sender appliance 1"]')).not.toBeNull();
    expect(noPhotos()).toBeNull();
  });
});

describe("Bridge photo component runtime safety", () => {
  async function renderPhotos(photos: string[], proxyEnabled = true) {
    await act(async () => root.render(createElement(VrsAiBridgePhotos, { photos, proxyEnabled })));
  }

  it("retains direct sender links when disabled without authenticated fetches", async () => {
    await renderPhotos([signedSource], false);
    expect(container.querySelector("a")?.getAttribute("href")).toBe(signedSource);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(signedSource);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    signedSource,
    "//attacker.example.test/photo.jpg",
    `${proxyPath}?url=https://attacker.example.test`,
    "/api/submissions/44/vrs-ai-photos/../secret",
  ])("never fetches or embeds a stale unsafe source in enabled mode: %s", async (source) => {
    await renderPhotos([source]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("img, a")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
    expect(container.innerHTML).not.toContain(source);
  });

  it("keeps valid photos visible if another source fails and releases blobs on unmount", async () => {
    await renderPhotos([proxyPath, signedSource]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img[alt="Sender appliance 1"]')?.getAttribute("src"))
      .toBe("blob:fixture-photo");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => root.render(null));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fixture-photo");
  });

  it("continues using authenticated proxy loading for cached local paths when disabled", async () => {
    await renderPhotos([proxyPath], false);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(proxyPath, {
      headers: { Authorization: "Bearer fixture-session" },
    });
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixture-photo");
  });
});
describe("Admin ticket detail: service order product", () => {
  async function renderDetails(serviceOrderProduct: unknown) {
    client.setQueryData(["/api/config"], {
      portal1099Enabled: false,
      techHubPhotosEnabled: false,
      vrsBridgePhotoProxyEnabled: false,
    });
    client.setQueryData(["/api/admin/submissions", 45, "audit"], {
      submission: {
        id: 45, serviceOrder: "fixture-order-45", stage1Status: "pending", ticketStatus: "pending",
        applianceType: "laundry", createdAt: "2026-09-01T12:00:00Z", photos: null,
        photoThumbnails: JSON.stringify({}), serviceOrderProduct,
      },
      timeline: [], userNames: {}, smsLogs: [],
    });
    await act(async () => root.render(
      createElement(QueryClientProvider, { client },
        createElement(TicketDetailDialog, { ticketId: 45, open: true, onClose: vi.fn() })),
    ));
  }

  it("shows the WOM product on the Details tab", async () => {
    await renderDetails(JSON.stringify({ text: "WASHERDD - WASHER, DIRECT DRIVE", source: "wom" }));
    const row = document.querySelector('[data-testid="admin-service-order-product"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe("Service order productWASHERDD - WASHER, DIRECT DRIVE");
    expect(document.querySelector('[data-testid="text-service-order-product-source"]')).toBeNull();
  });

  it("adds a muted (Snowflake) suffix for the Snowflake fallback", async () => {
    await renderDetails(JSON.stringify({ text: "DRYERELE - DRYER, ELECTRIC", source: "snowflake" }));
    expect(document.querySelector('[data-testid="text-admin-service-order-product"]')?.textContent)
      .toBe("DRYERELE - DRYER, ELECTRIC (Snowflake)");
    expect(document.querySelector('[data-testid="text-service-order-product-source"]')?.className)
      .toContain("text-muted-foreground");
  });

  it.each([null, undefined, "not-json", "{}", JSON.stringify({ text: "", source: "wom" })])(
    "hides the row when the product is absent or unreadable: %s",
    async (raw) => {
      await renderDetails(raw);
      expect(document.querySelector('[data-testid="text-audit-status"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="admin-service-order-product"]')).toBeNull();
      expect(document.body.textContent).not.toContain("Service order product");
    },
  );
});
