// @vitest-environment jsdom
// Mounted DOM regressions only; not physical-device or real-expiration acceptance.
import { act, createElement, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDashboard from "../client/src/pages/agent-dashboard";
import { DEFAULT_BUSINESS_HOURS_CONFIG } from "../client/src/lib/business-hours";
import type { VrsAiBridgeStatus } from "../client/src/lib/vrsAiBridge";

const fixtures = vi.hoisted(() => ({
  user: { id: 7, role: "vrs_agent", fullName: "Fixture Agent", agentStatus: "online" },
  subscribe: vi.fn(() => () => {}),
  buildMediaUrl: vi.fn(async (path: string) => `${path}?media-token=fixture`),
  buildMediaUrls: vi.fn(async (paths: string[]) => paths.map(path => `${path}?media-token=fixture`)),
  prefetchMediaTokens: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../client/src/lib/auth")>(),
  useAuth: () => ({ user: fixtures.user, logout: vi.fn() }),
  getToken: () => "fixture-session",
  buildMediaUrl: fixtures.buildMediaUrl,
  buildMediaUrls: fixtures.buildMediaUrls,
  prefetchMediaTokens: fixtures.prefetchMediaTokens,
}));
vi.mock("@/lib/websocket", () => ({
  useWebSocket: () => ({ subscribe: fixtures.subscribe }),
  disconnectWs: vi.fn(),
  getNotificationPermission: () => "unsupported",
  requestNotificationPermission: vi.fn(),
  loadNotificationSettings: vi.fn(),
  playNotificationDing: vi.fn(),
  playPilotNewTicketAlert: vi.fn(),
  showBrowserNotification: vi.fn(),
}));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("../client/src/lib/queryClient")>(),
  // Selecting My Tickets also queries the unrelated service-order assistant.
  apiRequest: vi.fn(async (_method: string, path: string) => {
    if (path !== "/api/shsai/query") throw new Error(`Unexpected API request: ${path}`);
    return { json: async () => ({ success: false, error: "Not part of media fixture" }) };
  }),
}));
// Keep the real dashboard, query observers, runtime flag hook, bridge gallery,
// authenticated loader and lightboxes. Only isolate unrelated services and
// legacy signing (covered separately), following the Admin media test pattern.
vi.mock("@/components/media", () => ({
  MediaImage: (props: any) => createElement("img", props),
  MediaVideo: (props: any) => createElement("video", props),
  MediaAudio: (props: any) => createElement("audio", props),
}));
vi.mock("@/components/submission-notes-thread", () => ({ SubmissionNotesThread: () => null }));
vi.mock("@/components/notification-settings", () => ({ default: () => null }));
vi.mock("@/components/intake-form-tab", () => ({ IntakeFormTab: () => null }));
vi.mock("@/components/calculator-iframe", () => ({ CalculatorIframe: () => null }));
vi.mock("@/components/calculator-settings-dialog", () => ({ CalculatorSettingsDialog: () => null }));

const proxyPath = "/api/submissions/44/vrs-ai-photos/0";
const nextProxyPath = "/api/submissions/45/vrs-ai-photos/0";
const signedSource = "https://sender.example.test/photo.jpg?signature=private";
const legacy = "/objects/legacy-photo.jpg";
const techHub = "https://techhub.example.test/uploads/part.jpg";
const listUrl = "/api/submissions?ticketStatus=pending&excludeRequestType=parts_nla";
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let commits: string[][];
let unexpectedQuery: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  unexpectedQuery = vi.fn(async ({ queryKey }) => {
    throw new Error(`Unseeded query: ${JSON.stringify(queryKey)}`);
  });
  client = new QueryClient({
    defaultOptions: {
      queries: { queryFn: unexpectedQuery, retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  client.setQueryData(["/api/business-hours"], DEFAULT_BUSINESS_HOURS_CONFIG);
  client.setQueryData(["/api/agent/specializations"], { divisions: ["appliances"] });
  client.setQueryData(["/api/agent/stats"], { queueCount: 0, pendingCount: 2, completedToday: 0 });
  // The persistent navigation now observes both Pilot status counts. Keep
  // those read-only queries local to this media fixture (no live requests).
  for (const status of ["queued", "pending"]) {
    client.setQueryDefaults([`/api/submissions?vrsAiOnly=true&ticketStatus=${status}`], {
      queryFn: async () => ({ submissions: [] }),
    });
  }
  client.setQueryData(["/api/agent/rgc-status"], { needsEntry: false, missingCode: false, code: "fixture" });
  client.setQueryData(["/api/submissions?ticketStatus=queued&excludeRequestType=parts_nla"], { submissions: [] });
  fetchMock = vi.fn(async (path: string) => {
    if (path !== proxyPath && path !== nextProxyPath) throw new Error(`Unexpected fetch: ${path}`);
    return photoResponse();
  });
  vi.stubGlobal("fetch", fetchMock);
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:agent-photo-${++sequence}`);
  revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  commits = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function photoResponse() {
  return { ok: true, blob: async () => new Blob(["fixture-image"], { type: "image/jpeg" }) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForCondition(condition: () => boolean, failureMessage: string) {
  const maxAttempts = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) return;
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
  if (!condition()) throw new Error(failureMessage);
}

type TicketOptions = {
  id?: number;
  photos?: string | null;
  bridgePhotos?: string[];
  thumbnails?: Record<string, string>;
  videoUrl?: string;
  voiceNoteUrl?: string;
};

function ticket({
  id = 44, photos = null, bridgePhotos, thumbnails, videoUrl, voiceNoteUrl,
}: TicketOptions = {}) {
  return {
    submission: {
      id, serviceOrder: `fixture-order-${id}`, technicianId: 8,
      technicianName: "Fixture Technician", applianceType: "washer",
      warrantyType: "ahs", requestType: "authorization", ticketStatus: "pending",
      stage1Status: "pending", assignedTo: 7, description: "Fixture repair",
      createdAt: "2026-09-01T12:00:00Z", photos,
      photoThumbnails: JSON.stringify(thumbnails ?? {}), videoUrl, voiceNoteUrl,
    },
    vrsAi: bridgePhotos === undefined ? null : {
      callId: `fixture-call-${id}`, contractVersion: "v9", state: "pending_review",
      providerCallId: null, dispatchError: null, failureReason: null,
      retryable: null, dispatchedAt: null,
      reviewContext: {
        service_order: `fixture-order-${id}`, parts: [], comments: [],
        reason_for_call: "authorization", tech_id: "fixture-tech", tech_phone: "N/A",
        tech_name: "Fixture Technician", customer_name: "Fixture Customer",
        customer_address: "Fixture address", service_address: "Fixture address",
        brand: "Fixture", model_number: "Fixture model", serial_number: "Fixture serial",
        appliance_type: "washer", appliance_age: 5, labor_amount: 100,
        tax_amount: 0, part_price: 50, appliance_location: "Laundry",
        failure_cause: "Fixture fault", tech_recommendation: "repair",
        repair_replace_rationale: "Fixture repair",
        appliance_photos: bridgePhotos,
      },
    } satisfies VrsAiBridgeStatus,
  };
}

function seedTicket(detail: ReturnType<typeof ticket>) {
  const id = detail.submission.id;
  client.setQueryData(["/api/submissions", id], detail);
  client.setQueryData(["/api/submissions", id, "direct-ahs"], { eligible: true, reason: "AI-side integration pending.", enabled: false, workflow: null });
  client.setQueryDefaults(["/api/submissions", id, "direct-ahs"], {
    queryFn: async () => ({ eligible: true, reason: "AI-side integration pending.", enabled: false, workflow: null }),
  });
  client.setQueryData(["/api/submissions", id, "history"], { history: [], reviewerNames: {} });
  client.setQueryData(["/api/submissions", id, "intake-form-status"], { required: false, recorded: false });
  client.setQueryData(["/api/submissions", id, "techhub-photos"], { enabled: false, photos: [] });
}

function setFlag(enabled: boolean) {
  client.setQueryData(["/api/config"], {
    portal1099Enabled: false, techHubPhotosEnabled: false, vrsBridgePhotoProxyEnabled: enabled,
  });
}

async function click(selector: string) {
  const element = document.querySelector<HTMLElement>(selector);
  expect(element, `Missing clickable element: ${selector}`).not.toBeNull();
  await act(async () => element!.click());
}

async function selectTicket(id: number) {
  await click(`[data-testid="text-so-${id}"]`);
}

async function renderDashboard(details = [ticket()], enabled = true) {
  setFlag(enabled);
  details.forEach(seedTicket);
  // Real detail-query merging must supply bridge context: slim rows omit it.
  client.setQueryData([listUrl], { submissions: details.map(detail => detail.submission) });
  await act(async () => root.render(
    createElement(QueryClientProvider, { client },
      createElement(Profiler, {
        id: "agent-media",
        // Capture EVERY committed DOM, including before passive photo effects
        // clear state. Final-DOM-only assertions can miss a stale-image flash.
        onRender: () => { commits.push(imageSources()); },
      }, createElement(AgentDashboard))),
  ));
  await click('[data-testid="nav-mytickets"]');
  await selectTicket(details[0].submission.id);
  expect(mediaCard().textContent).toContain("Photos & Media");
  expect(unexpectedQuery).not.toHaveBeenCalled();
}

function mediaCard() {
  const card = Array.from(container.querySelectorAll<HTMLElement>(".shadcn-card"))
    .find(element => element.textContent?.includes("Photos & Media"));
  expect(card, "Real Agent Photos & Media card must be mounted").toBeDefined();
  return card!;
}

function noPhotos() {
  return mediaCard().querySelector('[data-testid="text-no-photos"]');
}

function senderImage() {
  return mediaCard().querySelector('img[alt="Sender appliance 1"]');
}

function imageSources() {
  return Array.from(document.querySelectorAll("img"), image => image.getAttribute("src") ?? "");
}

describe("Agent Photos & Media mounted runtime", () => {
  it.each([null, "[]", '{"issue":[],"estimate":[]}', "not-json"])(
    "renders bridge-only attachments from ticket detail with legacy payload %s",
    async (photos) => {
      await renderDashboard([ticket({ photos, bridgePhotos: [proxyPath] })]);
      expect(noPhotos()).toBeNull();
      expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-1");
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(proxyPath, {
        headers: { Authorization: "Bearer fixture-session" },
      });
      expect(document.querySelectorAll('img[alt="Sender appliance 1"]')).toHaveLength(1);
      expect(document.body.innerHTML).not.toContain(`src="${proxyPath}"`);
    },
  );

  it.each([null, "[]", "{}", '{"issue":[],"estimate":[]}', "not-json"])(
    "shows no photos only when both sources are empty: %s", async (photos) => {
      await renderDashboard([ticket({ photos, bridgePhotos: [] })]);
      expect(noPhotos()?.textContent).toBe("No photos attached");
      expect(mediaCard().textContent).not.toContain("Sender photos");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, JSON.stringify([legacy])])(
    "forwards the enabled runtime flag, rejecting stale signed URLs with legacy payload %s",
    async (photos) => {
      // Local proxy paths alone do not prove forwarding: the gallery detects
      // those even without a flag. An external source MUST be rejected here.
      await renderDashboard([ticket({ photos, bridgePhotos: [signedSource] })]);
      expect(noPhotos()).toBeNull();
      expect(mediaCard().querySelector('[role="alert"]')?.textContent).toContain("sender photos are unavailable");
      expect(senderImage()).toBeNull();
      expect(document.body.innerHTML).not.toContain(signedSource);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])("preserves legacy-only media with the runtime flag %s", async (enabled) => {
    await renderDashboard([ticket({
      photos: JSON.stringify([legacy, techHub]),
      videoUrl: JSON.stringify(["/objects/video-one.mp4", "/objects/video-two.mp4"]),
      voiceNoteUrl: "/objects/voice.webm",
    })], enabled);
    expect(noPhotos()).toBeNull();
    expect(mediaCard().querySelector('img[alt="Photos 1"]')?.getAttribute("src")).toBe(legacy);
    expect(mediaCard().querySelector('img[alt="Photos 2"]')?.getAttribute("src")).toBe(techHub);
    expect(Array.from(mediaCard().querySelectorAll("video"), video => video.getAttribute("src")))
      .toEqual(["/objects/video-one.mp4", "/objects/video-two.mp4"]);
    expect(mediaCard().querySelector("audio")?.getAttribute("src")).toBe("/objects/voice.webm");
    expect(mediaCard().textContent).not.toContain("Sender photos");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["array", "categorized"])(
    "keeps %s legacy thumbnails and full-size lightbox identities beside bridge photos", async (format) => {
      const photos = format === "array" ? [legacy, techHub] : { issue: [legacy], estimate: [techHub] };
      await renderDashboard([ticket({
        photos: JSON.stringify(photos), bridgePhotos: [proxyPath],
        thumbnails: { [legacy]: "/objects/legacy-thumb.jpg" },
        videoUrl: "/objects/video.mp4", voiceNoteUrl: "/objects/voice.webm",
      })]);
      expect(noPhotos()).toBeNull();
      expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-1");
      expect(mediaCard().querySelector('img[src="/objects/legacy-thumb.jpg"]')).not.toBeNull();
      expect(mediaCard().querySelector(`img[src="${techHub}"]`)).not.toBeNull();
      expect(mediaCard().querySelector("video")?.getAttribute("src")).toBe("/objects/video.mp4");
      expect(mediaCard().querySelector("audio")?.getAttribute("src")).toBe("/objects/voice.webm");
      await click(format === "array" ? '[data-testid="photos-photo-1"]' : '[data-testid="estimate-photos-photo-0"]');
      expect(fixtures.buildMediaUrls).toHaveBeenCalledWith([legacy, techHub]);
      expect(document.querySelector('[data-testid="img-lightbox-photo"]')?.getAttribute("src"))
        .toBe(`${techHub}?media-token=fixture`);
    },
  );

  it("preserves production-disabled empty and direct-link behavior without proxy fetches", async () => {
    await renderDashboard([ticket(), ticket({ id: 45, bridgePhotos: [signedSource] })], false);
    expect(noPhotos()?.textContent).toBe("No photos attached");
    expect(document.querySelector('[data-testid="vrs-ai-bridge-status"]')).toBeNull();
    await selectTicket(45);
    expect(noPhotos()?.textContent).toBe("No photos attached");
    expect(mediaCard().textContent).not.toContain("Sender photos");
    // Flag-off bridge photos stay in the existing payload review, not this card.
    expect(document.querySelector('a img[alt="Sender appliance 1"]')?.getAttribute("src")).toBe(signedSource);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reacts to runtime config changes without remounting the dashboard", async () => {
    await renderDashboard([ticket({ photos: JSON.stringify([legacy]), bridgePhotos: [signedSource] })], false);
    expect(senderImage()).toBeNull();
    expect(document.querySelector(`img[src="${signedSource}"]`)).not.toBeNull();
    await act(async () => {
      setFlag(true);
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(mediaCard().querySelector('[role="alert"]')).not.toBeNull();
    expect(document.body.innerHTML).not.toContain(signedSource);
    expect(mediaCard().querySelector(`img[src="${legacy}"]`)).not.toBeNull();
    expect(noPhotos()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("distinguishes an unavailable attachment from no photos and retries", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false });
    await renderDashboard([ticket({ bridgePhotos: [proxyPath] })]);
    expect(noPhotos()).toBeNull();
    expect(mediaCard().querySelector('[role="alert"]')?.textContent).toContain("sender photos are unavailable");
    expect(senderImage()).toBeNull();
    await click('[data-testid="vrs-bridge-photo-error"] button');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mediaCard().querySelector('[role="alert"]')).toBeNull();
    expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-1");
    expect(noPhotos()).toBeNull();
  });

  it.each([null, "[]", JSON.stringify([legacy])])(
    "does not commit previous-ticket photos or its open lightbox while the next photo loads: %s",
    async (photos) => {
      const nextPhoto = deferred<ReturnType<typeof photoResponse>>();
      fetchMock.mockImplementation(async (path: string) =>
        path === nextProxyPath ? nextPhoto.promise : photoResponse());
      await renderDashboard([
        ticket({ photos, bridgePhotos: [proxyPath] }),
        ticket({
          id: 45, photos: photos?.replace(legacy, "/objects/next-legacy.jpg"),
          bridgePhotos: [nextProxyPath],
        }),
      ]);
      await click('[aria-label="Open sender appliance 1"]');
      expect(document.querySelector('[data-testid="img-lightbox-photo"]')?.getAttribute("src"))
        .toBe("blob:agent-photo-1");
      commits = [];
      await selectTicket(45);
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.flat()).not.toContain("blob:agent-photo-1");
      expect(commits.flat()).not.toContain(legacy);
      expect(senderImage()).toBeNull();
      expect(document.querySelector('[data-testid="lightbox-overlay"]')).toBeNull();
      expect(noPhotos()).toBeNull();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:agent-photo-1");
      await act(async () => nextPhoto.resolve(photoResponse()));
      expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-2");
      expect(document.querySelector('[data-testid="lightbox-overlay"]')).toBeNull();
    },
  );

  it("shows loading, not previous-ticket images or no photos, until the next detail arrives", async () => {
    const nextDetail = ticket({ id: 45, bridgePhotos: [nextProxyPath] });
    const detailResponse = deferred<typeof nextDetail>();
    await renderDashboard([ticket({ bridgePhotos: [proxyPath] }), nextDetail]);
    // The next slim row has no bridge context. Its full detail is now uncached.
    client.removeQueries({ queryKey: ["/api/submissions", 45], exact: true });
    client.setQueryDefaults(["/api/submissions", 45], { queryFn: () => detailResponse.promise });
    commits = [];
    await selectTicket(45);
    expect(mediaCard().querySelector('[data-testid="photos-loading"]')).not.toBeNull();
    expect(noPhotos()).toBeNull();
    expect(commits.flat()).not.toContain("blob:agent-photo-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => detailResponse.resolve(nextDetail));
    await waitForCondition(
      () => mediaCard().querySelector('[data-testid="photos-loading"]') === null
        && senderImage()?.getAttribute("src") === "blob:agent-photo-2",
      "next ticket photo did not finish loading after its detail resolved",
    );
    expect(mediaCard().querySelector('[data-testid="photos-loading"]')).toBeNull();
    expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-2");
    expect(noPhotos()).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(nextProxyPath, {
      headers: { Authorization: "Bearer fixture-session" },
    });
  });

  it("does not replace the new ticket's photo with an old response that finishes later", async () => {
    const oldPhoto = deferred<ReturnType<typeof photoResponse>>();
    fetchMock.mockReturnValueOnce(oldPhoto.promise);
    await renderDashboard([
      ticket({ bridgePhotos: [proxyPath] }),
      ticket({ id: 45, bridgePhotos: [nextProxyPath] }),
    ]);
    await selectTicket(45);
    expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-1");
    commits = [];
    await act(async () => oldPhoto.resolve(photoResponse()));
    expect(senderImage()?.getAttribute("src")).toBe("blob:agent-photo-1");
    expect(commits.flat()).not.toContain("blob:agent-photo-2");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:agent-photo-2");
    expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:agent-photo-1");
  });

  it("ignores a previous ticket's late response after switching to a ticket with no photos", async () => {
    const oldPhoto = deferred<ReturnType<typeof photoResponse>>();
    fetchMock.mockReturnValueOnce(oldPhoto.promise);
    await renderDashboard([ticket({ bridgePhotos: [proxyPath] }), ticket({ id: 45 })]);
    expect(senderImage()).toBeNull();
    expect(noPhotos()).toBeNull();
    commits = [];
    await selectTicket(45);
    expect(noPhotos()?.textContent).toBe("No photos attached");
    await act(async () => oldPhoto.resolve(photoResponse()));
    expect(noPhotos()?.textContent).toBe("No photos attached");
    expect(commits.flat()).not.toContain("blob:agent-photo-1");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:agent-photo-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});