// @vitest-environment jsdom
// Mounted Agent dashboard: the read-only "Technician appliance details" block
// in Submission Details (grade, color and part function the tech entered on
// AHS and First American authorization tickets). Queries are seeded and
// fetch is mocked; nothing reaches a server. Harness follows
// tests/vrs-agent-media.test.ts.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDashboard from "../client/src/pages/agent-dashboard";
import { DEFAULT_BUSINESS_HOURS_CONFIG } from "../client/src/lib/business-hours";

const fixtures = vi.hoisted(() => ({
  user: { id: 7, role: "vrs_agent", fullName: "Fixture Agent", agentStatus: "online" },
  subscribe: vi.fn(() => () => {}),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../client/src/lib/auth")>(),
  useAuth: () => ({ user: fixtures.user, logout: vi.fn() }),
  getToken: () => "fixture-session",
  buildMediaUrl: vi.fn(async (path: string) => path),
  buildMediaUrls: vi.fn(async (paths: string[]) => paths),
  prefetchMediaTokens: vi.fn(),
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
  apiRequest: vi.fn(async (_method: string, path: string) => {
    if (path !== "/api/shsai/query") throw new Error(`Unexpected API request: ${path}`);
    return { json: async () => ({ success: false, error: "Not part of this fixture" }) };
  }),
}));
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

const listUrl = "/api/submissions?ticketStatus=pending&excludeRequestType=parts_nla";
const techDetailsJson = JSON.stringify({
  applianceGrade: "medium",
  applianceColor: "Bisque",
  partFunction: "tech-fn: heats the oven cavity",
});

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

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
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    throw new Error(`Unexpected fetch: ${path}`);
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: async ({ queryKey }) => {
          throw new Error(`Unseeded query: ${JSON.stringify(queryKey)}`);
        },
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
    },
  });
  client.setQueryData(["/api/business-hours"], DEFAULT_BUSINESS_HOURS_CONFIG);
  client.setQueryData(["/api/agent/specializations"], { divisions: ["appliances"] });
  client.setQueryData(["/api/agent/stats"], { queueCount: 0, pendingCount: 1, completedToday: 0 });
  for (const status of ["queued", "pending"]) {
    client.setQueryDefaults([`/api/submissions?vrsAiOnly=true&ticketStatus=${status}`], {
      queryFn: async () => ({ submissions: [] }),
    });
  }
  client.setQueryData(["/api/agent/rgc-status"], { needsEntry: false, missingCode: false, code: "fixture" });
  client.setQueryData(["/api/submissions?ticketStatus=queued&excludeRequestType=parts_nla"], { submissions: [] });
  client.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: false,
    vrsAiAppEnrollEnabled: false,
    techApplianceDetailsEnabled: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function ticket(warrantyType: string, techApplianceDetails: string | null) {
  return {
    submission: {
      id: 61, serviceOrder: "fixture-order-61", technicianId: 8,
      technicianName: "Fixture Technician", applianceType: "cooking",
      warrantyType, requestType: "authorization", ticketStatus: "pending",
      stage1Status: "pending", assignedTo: 7,
      issueDescription: "evidence-desc: oven will not heat",
      createdAt: "2026-09-01T12:00:00Z", photos: null,
      photoThumbnails: JSON.stringify({}), ahsDetails: null,
      techApplianceDetails,
    },
    vrsAi: null,
  };
}

async function renderDashboard(detail: ReturnType<typeof ticket>) {
  const id = detail.submission.id;
  client.setQueryData(["/api/submissions", id], detail);
  client.setQueryData(["/api/submissions", id, "history"], { history: [], reviewerNames: {} });
  client.setQueryData(["/api/submissions", id, "intake-form-status"], { required: false, recorded: false });
  client.setQueryData(["/api/submissions", id, "techhub-photos"], { enabled: false, photos: [] });
  // The slim list row never carries the details; the detail fetch does.
  const { techApplianceDetails: _omit, ...slim } = detail.submission;
  client.setQueryData([listUrl], { submissions: [slim] });
  await act(async () => root.render(
    createElement(QueryClientProvider, { client }, createElement(AgentDashboard)),
  ));
  for (const selector of ['[data-testid="nav-mytickets"]', `[data-testid="text-so-${id}"]`]) {
    const element = document.querySelector<HTMLElement>(selector);
    expect(element, `Missing clickable element: ${selector}`).not.toBeNull();
    await act(async () => element!.click());
  }
  expect(document.querySelector('[data-testid="text-detail-description"]')?.textContent)
    .toBe("evidence-desc: oven will not heat");
}

function submissionDetailsCard(): HTMLElement {
  const description = document.querySelector<HTMLElement>('[data-testid="text-detail-description"]');
  const card = description?.closest<HTMLElement>(".shadcn-card");
  expect(card, "Submission Details card must be mounted").toBeTruthy();
  return card!;
}

function text(testId: string): string | null | undefined {
  return document.querySelector(`[data-testid="${testId}"]`)?.textContent;
}

describe("Agent dashboard: technician appliance details", () => {
  it.each(["first_american", "american_home_shield"])(
    "shows grade, color and part function in Submission Details for %s",
    async (warrantyType) => {
      await renderDashboard(ticket(warrantyType, techDetailsJson));
      const block = submissionDetailsCard().querySelector('[data-testid="tech-appliance-details"]');
      expect(block, "block sits in the Submission Details card").not.toBeNull();
      expect(block!.textContent).toContain("Technician appliance details");
      expect(block!.textContent).toContain("From technician");
      expect(block!.textContent).not.toContain("From service order");
      expect(text("text-tech-appliance-grade")).toBe("Medium");
      expect(text("text-tech-appliance-color")).toBe("Bisque");
      expect(text("text-tech-part-function")).toBe("tech-fn: heats the oven cavity");
      // The tech's grade label, not the AHS value.
      expect(block!.textContent).not.toContain("mid");
    },
  );

  it.each([null, "not-json", "{}"])("hides the block when the details are absent or unreadable: %s", async (raw) => {
    await renderDashboard(ticket("first_american", raw));
    expect(document.querySelector('[data-testid="tech-appliance-details"]')).toBeNull();
  });

  it("hides the block for other warranties", async () => {
    await renderDashboard(ticket("sears_protect", techDetailsJson));
    expect(document.querySelector('[data-testid="tech-appliance-details"]')).toBeNull();
  });
});
