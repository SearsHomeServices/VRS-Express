// @vitest-environment jsdom
// VRS no longer handles NLA parts. On the tech submit and resubmit forms,
// picking "Parts — No Longer Available (NLA)" shows the red TechHub
// instruction and disables the rest of the form, submit button included;
// the request type stays usable so the tech can switch back. Mounted DOM
// checks with mocked API (same harness as tech-appliance-details-form).
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TechSubmitPage from "../client/src/pages/tech-submit";
import TechResubmitPage from "../client/src/pages/tech-resubmit";
import { NLA_NO_LONGER_HANDLED_HEADING, NLA_OPTION_DESCRIPTION } from "../shared/nla-policy";

const fixtures = vi.hoisted(() => ({
  user: { id: 12, role: "technician", fullName: "Fixture Tech", racId: "RAC12", ldapId: "ldap12", phone: "5555550147" },
  apiRequestWithRetry: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => ({
  ...await importOriginal<typeof import("../client/src/lib/auth")>(),
  useAuth: () => ({ user: fixtures.user, logout: vi.fn() }),
  getToken: () => "fixture-session",
}));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...await importOriginal<typeof import("../client/src/lib/queryClient")>(),
  apiRequest: vi.fn(async (_method: string, path: string) => {
    if (!path.startsWith("/api/tech/lookup-warranty")) throw new Error(`Unexpected API request: ${path}`);
    return { json: async () => ({ serviceOrder: "8175-12345678", derived: null }) };
  }),
  apiRequestWithRetry: fixtures.apiRequestWithRetry,
}));
vi.mock("@/components/media", () => ({
  TechPhotoPreview: (props: any) => createElement("img", { "data-testid": props["data-testid"] }),
  MediaImage: (props: any) => createElement("img", { "data-testid": props["data-testid"] }),
  MediaVideo: () => createElement("video"),
  MediaAudio: () => createElement("audio"),
}));

const DRAFT_KEY = `vrs_tech_submit_draft_v1_${fixtures.user.id}`;
const BULLETS = [
  'After confirming a part is NLA through part inquiry, select "Needed for Repair."',
  "Follow all TH 2.0 prompts for SOM team research.",
  "Do not close the order until research is complete.",
];

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fixtures.apiRequestWithRetry.mockReset();
  fixtures.apiRequestWithRetry.mockImplementation(async () => ({
    json: async () => ({ submission: { id: 99, serviceOrder: "8175-12345678" } }),
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: {
        queryFn: async ({ queryKey }) => { throw new Error(`Unseeded query: ${JSON.stringify(queryKey)}`); },
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
    },
  });
  client.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: false,
    techApplianceDetailsEnabled: false,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function flush(ms = 0) {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

async function mount(element: ReturnType<typeof createElement>) {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, element)));
  await flush();
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const blockedFieldsets = () => Array.from(container.querySelectorAll<HTMLFieldSetElement>('[data-testid="fieldset-nla-blocked"]'));

async function click(id: string) {
  const el = byTestId(id);
  if (!el) throw new Error(`No element ${id}`);
  await act(async () => { el.click(); });
  await flush();
}

// Fires the form's submit event directly, bypassing the disabled button, as
// a stray Enter key or a stale handler would.
async function submitForm() {
  const form = container.querySelector("form");
  if (!form) throw new Error("No form");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush(10);
}

function expectNotice() {
  const notice = byTestId("nla-no-longer-handled");
  expect(notice).not.toBeNull();
  expect(notice!.getAttribute("role")).toBe("alert");
  expect(notice!.className).toContain("border-destructive");
  expect(notice!.className).toContain("bg-destructive/10");
  expect(byTestId("text-nla-no-longer-handled-heading")!.textContent).toBe(NLA_NO_LONGER_HANDLED_HEADING);
  expect(NLA_NO_LONGER_HANDLED_HEADING).toBe("VRS no longer handles NLA parts for all Clients, including SHW, SPHW, and PA.");
  const items = Array.from(byTestId("list-nla-techhub-steps")!.querySelectorAll("li"));
  expect(items.map((li) => li.textContent)).toEqual(BULLETS);
  expect(Array.from(notice!.querySelectorAll("strong"), (b) => b.textContent)).toEqual(['"Needed for Repair."', "Do not close the order"]);
  // Only the icon may move, and only for users who allow motion.
  const icon = notice!.querySelector("svg")!;
  expect(icon.getAttribute("class")).toContain("motion-safe:animate-pulse");
  expect(notice!.innerHTML).not.toMatch(/animate-(ping|bounce)|blink/);
  expect(notice!.querySelector("p")!.className).not.toContain("animate");
}

function expectBlocked() {
  const fieldsets = blockedFieldsets();
  expect(fieldsets.length).toBeGreaterThan(0);
  for (const fs of fieldsets) {
    expect(fs.disabled).toBe(true);
    expect(fs.className).toContain("opacity-50");
    expect(fs.className).toContain("pointer-events-none");
  }
}

describe("tech-submit with Parts NLA selected", () => {
  it("keeps the option selectable with the new description", async () => {
    await mount(createElement(TechSubmitPage));
    const option = byTestId("tab-parts-nla")!;
    expect(option.textContent).toContain("Parts — No Longer Available (NLA)");
    expect(option.textContent).toContain(NLA_OPTION_DESCRIPTION);
    expect(option.textContent).not.toMatch(/Submit for VRS parts team research/);
    expect(byTestId("nla-no-longer-handled")).toBeNull();
    expect(byTestId("nla-info-banner")).toBeNull();
  });

  it("shows the red notice, disables everything below the request type, and switches back", async () => {
    await mount(createElement(TechSubmitPage));
    expect(blockedFieldsets().every((fs) => !fs.disabled)).toBe(true);

    await click("tab-parts-nla");
    expectNotice();
    expectBlocked();
    const [fieldset] = blockedFieldsets();
    // Fields and the submit button sit inside the disabled fieldset.
    const submit = byTestId("button-submit-form") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(fieldset.contains(submit)).toBe(true);
    expect(submit.textContent).toContain("NLA parts are not handled by VRS");
    for (const id of ["input-phone", "input-service-order", "select-appliance-type"]) {
      const el = byTestId(id);
      if (el) expect(fieldset.contains(el)).toBe(true);
    }
    expect(fieldset.querySelectorAll("input, textarea, button, select").length).toBeGreaterThan(5);
    // The notice and the request type options are outside it, still usable.
    expect(fieldset.contains(byTestId("nla-no-longer-handled"))).toBe(false);
    for (const id of ["tab-authorization", "tab-parts-nla"]) {
      const option = byTestId(id) as HTMLButtonElement;
      expect(fieldset.contains(option)).toBe(false);
      expect(option.disabled).toBe(false);
    }

    await click("tab-authorization");
    expect(byTestId("nla-no-longer-handled")).toBeNull();
    expect(blockedFieldsets().every((fs) => !fs.disabled && !fs.className.includes("opacity-50"))).toBe(true);
    expect((byTestId("button-submit-form") as HTMLButtonElement).textContent).toContain("Submit for Review");
  });

  it("refuses to submit a complete NLA draft even if the form's submit event fires", async () => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      identity: { userId: fixtures.user.id, ldapId: fixtures.user.ldapId },
      formValues: {
        serviceOrder: "8175-12345678",
        phone: "5555550147",
        applianceType: "laundry",
        applianceKind: "washer",
        requestType: "parts_nla",
        warrantyType: "sears_protect",
        issueDescription: "Washer control board is NLA in TechHub and needed for the repair.",
      },
      partNumbers: ["W10321304"],
      estimatePhotoUrls: ["/objects/estimate-1", "/objects/estimate-2"],
      issuePhotoUrls: ["/objects/issue-1", "/objects/issue-2"],
    }));
    await mount(createElement(TechSubmitPage));
    await click("button-draft-prompt-resume");
    expectNotice();
    expectBlocked();
    await submitForm();
    expect(byTestId("dialog-submit-review")).toBeNull();
    expect(fixtures.apiRequestWithRetry).not.toHaveBeenCalled();
  });
});

describe("tech-resubmit of an existing NLA ticket", () => {
  const nlaTicket = {
    id: 5,
    serviceOrder: "8175-12345678",
    phone: "5555550147",
    applianceType: "laundry",
    applianceKind: "washer",
    requestType: "parts_nla",
    warrantyType: "sears_protect",
    warrantyProvider: "Sears Protect",
    issueDescription: "Washer control board is NLA in TechHub and needed for the repair.",
    ticketStatus: "rejected",
    partNumbers: JSON.stringify({ nla: ["W10321304"], available: [] }),
    photos: JSON.stringify({ estimate: ["/objects/estimate-1"], issue: ["/objects/issue-1"] }),
  };

  async function mountResubmit(submission: Record<string, unknown>) {
    window.history.pushState({}, "", "/tech/resubmit/5");
    client.setQueryData(["/api/submissions", 5], { submission });
    client.setQueryData(["/api/submissions", 5, "history"], {
      history: [], reviewerNames: {}, technicianName: "Fixture Tech", resubmissionCount: 0, maxResubmissions: 3,
    });
    await mount(createElement(TechResubmitPage));
  }

  it("shows the same notice, disables the form and resubmit, and sends nothing", async () => {
    await mountResubmit(nlaTicket);
    expectNotice();
    expectBlocked();
    const resubmit = byTestId("button-resubmit") as HTMLButtonElement;
    expect(resubmit.disabled).toBe(true);
    expect(resubmit.textContent).toContain("NLA parts are not handled by VRS");
    for (const id of ["input-appeal-notes", "input-phone-resubmit", "select-appliance-type-resubmit", "input-description-resubmit", "button-resubmit"]) {
      expect(blockedFieldsets().some((fs) => fs.contains(byTestId(id)))).toBe(true);
    }
    // The request type stays usable so the tech can change it.
    const requestType = byTestId("select-request-type-resubmit") as HTMLButtonElement;
    expect(blockedFieldsets().some((fs) => fs.contains(requestType))).toBe(false);
    expect(requestType.disabled).toBe(false);

    await submitForm();
    expect(fixtures.apiRequestWithRetry).not.toHaveBeenCalled();
  });

  it("does not show it for an authorization ticket", async () => {
    await mountResubmit({ ...nlaTicket, requestType: "authorization", partNumbers: null });
    expect(byTestId("nla-no-longer-handled")).toBeNull();
    expect(blockedFieldsets().every((fs) => !fs.disabled)).toBe(true);
    expect((byTestId("button-resubmit") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("tech-facing copy", () => {
  const help = readFileSync(path.resolve(__dirname, "../client/src/pages/help-center.tsx"), "utf8");
  const submit = readFileSync(path.resolve(__dirname, "../client/src/pages/tech-submit.tsx"), "utf8");

  it("help center no longer tells techs to submit NLA in VRS", () => {
    expect(help).not.toContain("Submitting an NLA Parts Request");
    expect(help).not.toContain("NLA: submit in VRS");
    expect(help).not.toContain("researched by the VRS parts team");
    expect(help).toContain(NLA_NO_LONGER_HANDLED_HEADING);
    expect(help).toContain('select \\"Needed for Repair.\\"');
    expect(help).toContain("Follow all TH 2.0 prompts for SOM team research.");
    expect(help).toContain("Do not close the order until research is complete.");
  });

  it("tech-submit drops the old NLA-only banner and its submit label", () => {
    expect(submit).not.toContain("NLA Submissions Only");
    expect(submit).not.toContain("Submit NLA Request");
    expect(submit).not.toContain("Submit for VRS parts team research");
  });
});
