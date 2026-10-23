// @vitest-environment jsdom
// Appliance Grade / Appliance Color / Part Function on the tech submit and
// resubmit forms: shown (and required, and sent) only for American Home
// Shield and First American authorization tickets with the
// techApplianceDetailsEnabled flag on. Mounted DOM checks with mocked API.
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TechSubmitPage, {
  TechApplianceDetailsFields,
  showTechApplianceDetails,
  techApplianceDetailsForPayload,
  techApplianceDetailsFormSchema,
  techApplianceDetailsFormValues,
  techApplianceDetailsResolver,
} from "../client/src/pages/tech-submit";
import TechResubmitPage from "../client/src/pages/tech-resubmit";
import { Form } from "../client/src/components/ui/form";
import { TECH_APPLIANCE_COLORS, TECH_APPLIANCE_GRADES } from "../shared/tech-appliance-details";

const fixtures = vi.hoisted(() => ({
  user: { id: 11, role: "technician", fullName: "Fixture Tech", racId: "RAC11", ldapId: "ldap11", phone: "5555550147" },
  apiRequestWithRetry: vi.fn(),
  derivedWarranty: null as null | { warrantyType: string; warrantyProvider: string; source: string },
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
    return { json: async () => ({ serviceOrder: "8175-12345678", derived: fixtures.derivedWarranty }) };
  }),
  apiRequestWithRetry: fixtures.apiRequestWithRetry,
}));
vi.mock("@/components/media", () => ({
  TechPhotoPreview: (props: any) => createElement("img", { "data-testid": props["data-testid"] }),
  MediaImage: (props: any) => createElement("img", { "data-testid": props["data-testid"] }),
  MediaVideo: () => createElement("video"),
  MediaAudio: () => createElement("audio"),
}));

const DETAILS = { applianceGrade: "medium", applianceColor: "Black Stainless Steel", partFunction: "Pumps water out of the tub" };
const DRAFT_KEY = `vrs_tech_submit_draft_v1_${fixtures.user.id}`;
const AHS_ERRORS = ["Select the appliance grade", "Select the appliance color", "Part function is required"];

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

function setConfig(techApplianceDetailsEnabled: boolean) {
  client.setQueryData(["/api/config"], {
    portal1099Enabled: false,
    techHubPhotosEnabled: false,
    vrsBridgePhotoProxyEnabled: false,
    techApplianceDetailsEnabled,
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fixtures.derivedWarranty = null;
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

async function click(id: string) {
  const el = byTestId(id);
  if (!el) throw new Error(`No element ${id}`);
  await act(async () => { el.click(); });
  await flush();
}

async function submitForm() {
  const form = container.querySelector("form");
  if (!form) throw new Error("No form");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await flush(10);
}

function labelsIn(el: Element) {
  return Array.from(el.querySelectorAll("label")).map((label) => label.textContent);
}

// ---------------------------------------------------------------------------

describe("tech appliance details gate", () => {
  it.each([
    ["american_home_shield", "authorization", true],
    ["first_american", "authorization", true],
    ["sears_protect", "authorization", false],
    ["american_home_shield", "infestation_non_accessible", false],
    ["first_american", "infestation_non_accessible", false],
    ["sears_protect", "parts_nla", false],
  ])("%s + %s → %s with the flag on, never with it off", (warranty, request, expected) => {
    expect(showTechApplianceDetails(true, warranty, request)).toBe(expected);
    expect(showTechApplianceDetails(false, warranty, request)).toBe(false);
  });
});

describe("techApplianceDetailsFormValues (draft and resubmit prefill)", () => {
  it("reads the server's JSON string column and plain objects", () => {
    expect(techApplianceDetailsFormValues(JSON.stringify(DETAILS))).toEqual(DETAILS);
    expect(techApplianceDetailsFormValues(DETAILS)).toEqual(DETAILS);
  });

  it.each([null, undefined, "", "not json", "[1,2]", "42", 7, ["low"]])("leaves the fields empty for %j", (raw) => {
    expect(techApplianceDetailsFormValues(raw)).toEqual({ applianceGrade: undefined, applianceColor: undefined, partFunction: "" });
  });

  it("keeps only the fields that are still valid choices", () => {
    expect(techApplianceDetailsFormValues(JSON.stringify({ applianceGrade: "entry", applianceColor: "Bisque", partFunction: 5 })))
      .toEqual({ applianceGrade: undefined, applianceColor: "Bisque", partFunction: "" });
    expect(techApplianceDetailsFormValues({ applianceGrade: "high", applianceColor: "Red", partFunction: "Heats" }))
      .toEqual({ applianceGrade: "high", applianceColor: undefined, partFunction: "Heats" });
  });
});

describe("techApplianceDetailsForPayload", () => {
  it("is exactly { applianceGrade, applianceColor, partFunction } (trimmed) when shown", () => {
    const payload = techApplianceDetailsForPayload(
      { warrantyType: "first_american", requestType: "authorization", techApplianceDetails: { ...DETAILS, partFunction: "  Heats the oven  " } },
      true,
    );
    expect(payload).toEqual({ applianceGrade: "medium", applianceColor: "Black Stainless Steel", partFunction: "Heats the oven" });
    expect(Object.keys(payload!).sort()).toEqual(["applianceColor", "applianceGrade", "partFunction"]);
  });

  it("is null when hidden, whatever the form still holds", () => {
    const techApplianceDetails = DETAILS;
    expect(techApplianceDetailsForPayload({ warrantyType: "sears_protect", requestType: "authorization", techApplianceDetails }, true)).toBeNull();
    expect(techApplianceDetailsForPayload({ warrantyType: "american_home_shield", requestType: "infestation_non_accessible", techApplianceDetails }, true)).toBeNull();
    expect(techApplianceDetailsForPayload({ warrantyType: "american_home_shield", requestType: "authorization", techApplianceDetails }, false)).toBeNull();
  });
});

describe("techApplianceDetailsResolver", () => {
  const schema = z.object({
    issueDescription: z.string().min(10, "Too short"),
    requestType: z.string(),
    warrantyType: z.string(),
    techApplianceDetails: techApplianceDetailsFormSchema,
  });
  const options = { fields: {}, shouldUseNativeValidation: false } as any;
  const run = (values: Record<string, unknown>, enabled = true) =>
    techApplianceDetailsResolver(zodResolver(schema) as any, () => enabled)(values as any, undefined, options);
  const empty = { applianceGrade: undefined, applianceColor: undefined, partFunction: "  " };

  it("requires all three, with the shared schema's messages, alongside the form's own errors", async () => {
    const result = await run({ issueDescription: "short", requestType: "authorization", warrantyType: "american_home_shield", techApplianceDetails: empty });
    expect(Object.keys(result.errors).sort()).toEqual(["issueDescription", "techApplianceDetails"]);
    const errors = result.errors.techApplianceDetails as any;
    expect(errors.applianceGrade.message).toBe("Select the appliance grade");
    expect(errors.applianceColor.message).toBe("Select the appliance color");
    expect(errors.partFunction.message).toBe("Part function is required");
  });

  it("rejects values outside the dropdowns and a part function over 200 characters", async () => {
    const result = await run({
      issueDescription: "long enough text",
      requestType: "authorization",
      warrantyType: "first_american",
      techApplianceDetails: { applianceGrade: "entry", applianceColor: "Red", partFunction: "x".repeat(201) },
    });
    const errors = result.errors.techApplianceDetails as any;
    expect(Object.keys(errors).sort()).toEqual(["applianceColor", "applianceGrade", "partFunction"]);
    expect(errors.partFunction.message).toBe("Part function must be 200 characters or less");
  });

  it("does not validate them when hidden", async () => {
    for (const [warrantyType, requestType, enabled] of [
      ["sears_protect", "authorization", true],
      ["american_home_shield", "infestation_non_accessible", true],
      ["american_home_shield", "authorization", false],
    ] as const) {
      const result = await run({ issueDescription: "long enough text", requestType, warrantyType, techApplianceDetails: empty }, enabled);
      expect(result.errors).toEqual({});
    }
  });

  it("passes the parsed details on when valid", async () => {
    const result = await run({
      issueDescription: "long enough text",
      requestType: "authorization",
      warrantyType: "american_home_shield",
      techApplianceDetails: { ...DETAILS, partFunction: " Drains " },
    });
    expect(result.errors).toEqual({});
    expect((result.values as any).techApplianceDetails).toEqual({ ...DETAILS, partFunction: "Drains" });
  });
});

describe("TechApplianceDetailsFields", () => {
  function Harness() {
    const form = useForm({ defaultValues: { techApplianceDetails: { applianceGrade: undefined, applianceColor: undefined, partFunction: "" } } });
    // Inside a <form>, as on the pages (Radix then renders its native select).
    return createElement(Form, {
      ...form,
      children: createElement("form", null, createElement(TechApplianceDetailsFields, { control: form.control })),
    });
  }

  it("renders Grade, Color, then Part Function with the exact labels, options and placeholder", async () => {
    await mount(createElement(Harness));
    const section = byTestId("section-tech-appliance-details")!;
    expect(labelsIn(section)).toEqual(["Appliance Grade *", "Appliance Color *", "Part Function *"]);
    expect(byTestId("input-part-function")!.getAttribute("placeholder")).toBe("What does the part do?");
    expect(byTestId("select-appliance-grade")!.textContent).toBe("Select appliance grade");
    expect(byTestId("select-appliance-color")!.textContent).toBe("Select appliance color");

    // Radix keeps a hidden native <select> per dropdown, one <option> per item.
    const [gradeSelect, colorSelect] = Array.from(section.querySelectorAll("select"));
    const options = (select: HTMLSelectElement) =>
      Array.from(select.options).filter((option) => option.value !== "").map((option) => [option.value, option.textContent]);
    expect(options(gradeSelect)).toEqual([["low", "Low"], ["medium", "Medium"], ["high", "High"]]);
    expect(options(colorSelect)).toEqual([
      ["Black", "Black"],
      ["White", "White"],
      ["Black Stainless Steel", "Black Stainless Steel"],
      ["Stainless Steel", "Stainless Steel"],
      ["Bisque", "Bisque"],
    ]);
    expect(TECH_APPLIANCE_GRADES.map((grade) => grade.label)).toEqual(["Low", "Medium", "High"]);
    expect([...TECH_APPLIANCE_COLORS]).toEqual(["Black", "White", "Black Stainless Steel", "Stainless Steel", "Bisque"]);
  });
});

// ---------------------------------------------------------------------------

describe("tech-submit page", () => {
  it("shows the fields only for AHS / First American + Authorization, after Warranty Provider", async () => {
    setConfig(true);
    await mount(createElement(TechSubmitPage));
    expect(byTestId("section-tech-appliance-details")).toBeNull(); // Sears Protect default

    await click("provider-american_home_shield");
    const section = byTestId("section-tech-appliance-details")!;
    expect(section).not.toBeNull();
    // Inside the APPLIANCE DETAILS card, right after the Warranty Provider block.
    const card = section.parentElement!;
    expect(card.querySelector("p")!.textContent).toBe("Appliance Details");
    expect(section.previousElementSibling!.querySelector('[data-testid="provider-first_american"]')).not.toBeNull();
    expect(section.nextElementSibling).toBeNull();
    expect(labelsIn(section)).toEqual(["Appliance Grade *", "Appliance Color *", "Part Function *"]);

    await click("provider-first_american");
    expect(byTestId("section-tech-appliance-details")).not.toBeNull();

    await click("provider-sears_protect");
    expect(byTestId("section-tech-appliance-details")).toBeNull();

    await click("provider-first_american");
    await click("tab-infestation-non-accessible");
    expect(byTestId("section-tech-appliance-details")).toBeNull();
    await click("tab-authorization");
    expect(byTestId("section-tech-appliance-details")).not.toBeNull();
  });

  it("shows them for an auto-detected AHS warranty", async () => {
    setConfig(true);
    fixtures.derivedWarranty = { warrantyType: "american_home_shield", warrantyProvider: "American Home Shield", source: "client_nm" };
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      identity: { userId: fixtures.user.id, ldapId: fixtures.user.ldapId },
      formValues: { serviceOrder: "8175-12345678", requestType: "authorization", warrantyType: "sears_protect" },
    }));
    await mount(createElement(TechSubmitPage));
    await click("button-draft-prompt-resume");
    await flush(10);
    expect(byTestId("badge-locked-american_home_shield")).not.toBeNull();
    expect(byTestId("section-tech-appliance-details")).not.toBeNull();
  });

  it("hides them with the flag off", async () => {
    setConfig(false);
    await mount(createElement(TechSubmitPage));
    await click("provider-american_home_shield");
    expect(byTestId("provider-american_home_shield")!.className).toContain("border-primary");
    expect(byTestId("section-tech-appliance-details")).toBeNull();
  });

  it("requires all three when shown, and not otherwise", async () => {
    setConfig(true);
    await mount(createElement(TechSubmitPage));
    await submitForm();
    for (const message of AHS_ERRORS) expect(container.textContent).not.toContain(message);
    expect(container.textContent).toContain("Select an appliance type");

    await click("provider-american_home_shield");
    await submitForm();
    for (const message of AHS_ERRORS) expect(container.textContent).toContain(message);
    expect(byTestId("dialog-submit-review")).toBeNull();
  });

  function seedDraft(formValues: Record<string, unknown>) {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      identity: { userId: fixtures.user.id, ldapId: fixtures.user.ldapId },
      formValues: {
        serviceOrder: "8175-12345678",
        phone: "5555550147",
        applianceType: "laundry",
        requestType: "authorization",
        issueDescription: "Washer will not drain; pump hums but does not turn.",
        ...formValues,
      },
      estimatePhotoUrls: ["/objects/estimate-1", "/objects/estimate-2"],
      issuePhotoUrls: ["/objects/issue-1", "/objects/issue-2"],
    }));
  }

  it("keeps them in the draft, shows them on review and sends techApplianceDetails", async () => {
    setConfig(true);
    seedDraft({ warrantyType: "first_american", warrantyProvider: "First American", techApplianceDetails: DETAILS, ahsDetails: { brand: "x" } });
    await mount(createElement(TechSubmitPage));
    await click("button-draft-prompt-resume");
    expect((byTestId("input-part-function") as HTMLInputElement).value).toBe(DETAILS.partFunction);
    expect(byTestId("select-appliance-grade")!.textContent).toBe("Medium");
    expect(byTestId("select-appliance-color")!.textContent).toBe("Black Stainless Steel");

    // Autosave keeps the three values (and still drops unknown keys).
    await flush(700);
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY)!);
    expect(saved.formValues.techApplianceDetails).toEqual(DETAILS);
    expect(saved.formValues).not.toHaveProperty("ahsDetails");

    await submitForm();
    expect(byTestId("review-appliance-grade")!.textContent).toBe("Medium");
    expect(byTestId("review-appliance-color")!.textContent).toBe("Black Stainless Steel");
    expect(byTestId("review-part-function")!.textContent).toBe(DETAILS.partFunction);

    await click("button-review-confirm");
    expect(fixtures.apiRequestWithRetry).toHaveBeenCalledTimes(1);
    const [method, path, body] = fixtures.apiRequestWithRetry.mock.calls[0];
    expect([method, path]).toEqual(["POST", "/api/submissions"]);
    expect(body.techApplianceDetails).toEqual(DETAILS);
    expect(body).not.toHaveProperty("ahsDetails");
    expect(body.warrantyType).toBe("first_american");
  });

  it("does not send them for another warranty, even when the draft still holds them", async () => {
    setConfig(true);
    seedDraft({ warrantyType: "sears_protect", techApplianceDetails: DETAILS });
    await mount(createElement(TechSubmitPage));
    await click("button-draft-prompt-resume");
    expect(byTestId("section-tech-appliance-details")).toBeNull();
    await submitForm();
    expect(byTestId("review-appliance-grade")).toBeNull();
    await click("button-review-confirm");
    const body = fixtures.apiRequestWithRetry.mock.calls[0][2];
    expect(body).not.toHaveProperty("techApplianceDetails");
  });
});

// ---------------------------------------------------------------------------

describe("tech-resubmit page", () => {
  function original(overrides: Record<string, unknown>) {
    return {
      id: 5,
      serviceOrder: "8175-12345678",
      phone: "5555550147",
      applianceType: "laundry",
      requestType: "authorization",
      warrantyType: "american_home_shield",
      warrantyProvider: "American Home Shield",
      issueDescription: "Washer will not drain; pump hums but does not turn.",
      ticketStatus: "rejected",
      photos: JSON.stringify({ estimate: ["/objects/estimate-1"], issue: ["/objects/issue-1"] }),
      techApplianceDetails: JSON.stringify(DETAILS),
      ...overrides,
    };
  }

  async function mountResubmit(submission: Record<string, unknown>, enabled = true) {
    window.history.pushState({}, "", "/tech/resubmit/5");
    setConfig(enabled);
    client.setQueryData(["/api/submissions", 5], { submission });
    client.setQueryData(["/api/submissions", 5, "history"], {
      history: [], reviewerNames: {}, technicianName: "Fixture Tech", resubmissionCount: 0, maxResubmissions: 3,
    });
    await mount(createElement(TechResubmitPage));
  }

  it("prefills the three fields from the original ticket and sends them", async () => {
    await mountResubmit(original({}));
    const section = byTestId("section-tech-appliance-details-resubmit")!;
    expect(labelsIn(section)).toEqual(["Appliance Grade *", "Appliance Color *", "Part Function *"]);
    expect(section.parentElement!.querySelector("p")!.textContent).toBe("Appliance Details");
    expect(byTestId("select-appliance-grade-resubmit")!.textContent).toBe("Medium");
    expect(byTestId("select-appliance-color-resubmit")!.textContent).toBe("Black Stainless Steel");
    expect((byTestId("input-part-function-resubmit") as HTMLInputElement).value).toBe(DETAILS.partFunction);

    await submitForm();
    expect(fixtures.apiRequestWithRetry).toHaveBeenCalledTimes(1);
    const body = fixtures.apiRequestWithRetry.mock.calls[0][2];
    expect(body.techApplianceDetails).toEqual(DETAILS);
    expect(body.resubmissionOf).toBe(5);
    expect(body).not.toHaveProperty("ahsDetails");
  });

  it.each([null, "{not json", JSON.stringify({ applianceGrade: "top" })])(
    "leaves them empty for a stored value of %j and requires them",
    async (stored) => {
      await mountResubmit(original({ warrantyType: "first_american", techApplianceDetails: stored }));
      expect(byTestId("select-appliance-grade-resubmit")!.textContent).toBe("Select appliance grade");
      expect((byTestId("input-part-function-resubmit") as HTMLInputElement).value).toBe("");
      await submitForm();
      for (const message of AHS_ERRORS) expect(container.textContent).toContain(message);
      expect(fixtures.apiRequestWithRetry).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["sears_protect", "authorization", true],
    ["american_home_shield", "infestation_non_accessible", true],
    ["american_home_shield", "authorization", false],
  ])("hides and does not send them for %s + %s (flag %s)", async (warrantyType, requestType, enabled) => {
    await mountResubmit(original({ warrantyType, requestType }), enabled);
    expect(byTestId("section-tech-appliance-details-resubmit")).toBeNull();
    await submitForm();
    expect(fixtures.apiRequestWithRetry).toHaveBeenCalledTimes(1);
    expect(fixtures.apiRequestWithRetry.mock.calls[0][2]).not.toHaveProperty("techApplianceDetails");
  });
});

describe("source wiring", () => {
  const submit = readFileSync(path.resolve(__dirname, "../client/src/pages/tech-submit.tsx"), "utf8");
  const resubmit = readFileSync(path.resolve(__dirname, "../client/src/pages/tech-resubmit.tsx"), "utf8");

  it.each([["tech-submit", submit], ["tech-resubmit", resubmit]])("%s gates, validates and sends with the shared helpers", (_name, src) => {
    expect(src).toContain("const { techApplianceDetailsEnabled } = useFeatureFlags();");
    expect(src).toContain("resolver: techApplianceDetailsResolver(");
    expect(src).toContain("techApplianceDetails: techApplianceDetailsFormSchema,");
    expect(src).toContain("delete payload.techApplianceDetails;");
    expect(src).toMatch(/techApplianceDetailsForPayload\((data|formData), techApplianceDetailsEnabled\)/);
  });

  it("the fields component maps the shared option lists", () => {
    expect(submit).toContain("{TECH_APPLIANCE_GRADES.map((grade) => (");
    expect(submit).toContain("{TECH_APPLIANCE_COLORS.map((color) => (");
    expect(submit).toContain('from "@shared/tech-appliance-details"');
  });
});
