// @vitest-environment jsdom
// Appliance Type on the tech submit form is preselected from GET
// /api/tech/lookup-warranty (derived.applianceType, from the service order's
// product code), with an "Auto-detected from service order" note. Unlike the
// warranty it stays editable, and it never overwrites the tech's own choice.
// When the lookup also returns the service order's product category
// (serviceOrderProduct), that line replaces the generic note.
// Mounted DOM checks with the lookup response mocked.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TechSubmitPage, { lookupApplianceType } from "../client/src/pages/tech-submit";

const fixtures = vi.hoisted(() => ({
  user: { id: 12, role: "technician", fullName: "Fixture Tech", racId: "RAC12", ldapId: "ldap12", phone: "5555550148" },
  // serviceOrder → `derived` of the lookup response, or "error" to fail it.
  // `serviceOrderProduct` on an entry goes to the top level, like the server.
  lookups: {} as Record<string, unknown>,
  lookupCalls: [] as string[],
  // serviceOrder → a promise the lookup waits on before answering.
  gates: {} as Record<string, Promise<void>>,
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
    const so = decodeURIComponent(path.split("serviceOrder=")[1] ?? "");
    fixtures.lookupCalls.push(so);
    if (fixtures.gates[so]) await fixtures.gates[so];
    const derived = so in fixtures.lookups ? fixtures.lookups[so] : null;
    if (derived === "error") throw new Error("503: Snowflake unavailable");
    // Mirror the server: `derived` only when the warranty is known; the
    // appliance type always at the top level (and inside `derived` too).
    const { serviceOrderProduct, ...entry } = (derived ?? {}) as any;
    return {
      json: async () => ({
        serviceOrder: so,
        derived: entry.warrantyType ? entry : null,
        ...(entry.applianceType !== undefined ? { applianceType: entry.applianceType } : {}),
        ...(serviceOrderProduct !== undefined ? { serviceOrderProduct } : {}),
      }),
    };
  }),
  apiRequestWithRetry: vi.fn(),
}));
vi.mock("@/components/media", () => ({
  TechPhotoPreview: (props: any) => createElement("img", { "data-testid": props["data-testid"] }),
  MediaImage: (props: any) => createElement("img", { "data-testid": props["data-testid"] }),
  MediaVideo: () => createElement("video"),
  MediaAudio: () => createElement("audio"),
}));

const SO_A = "8175-12345678";
const SO_B = "8175-87654321";
const AHS = { warrantyType: "american_home_shield", warrantyProvider: "American Home Shield", source: "client_nm" };
const NOTE = "text-appliance-type-auto-note";
const PRODUCT = "text-appliance-type-product";
const WOM_WASHER = { text: "WASHERDD - WASHER, DIRECT DRIVE", source: "wom" };
const SNOWFLAKE_FRIDGE = { text: "REFSBS - REFRIGERATOR, SIDE BY SIDE", source: "snowflake" };

let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  fixtures.lookups = {};
  fixtures.lookupCalls = [];
  fixtures.gates = {};
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

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount() {
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(TechSubmitPage))));
  await flush();
}

// React-controlled inputs need the native value setter plus an input event.
async function type(id: string, value: string) {
  const input = byTestId(id) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
  await flush(10);
}

async function enterServiceOrder(so: string) {
  const [district, number] = so.split("-");
  await type("input-district", district);
  await type("input-service-order", number);
  await flush(10);
}

// Radix keeps a hidden native <select> next to the trigger; a change on it
// goes through the same onValueChange as picking an item from the list.
function applianceSelect() {
  return byTestId("select-appliance-type")!.parentElement!.querySelector("select") as HTMLSelectElement;
}

async function pickApplianceType(value: string) {
  const select = applianceSelect();
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  await act(async () => { select.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush(10);
}

const applianceTypeText = () => byTestId("select-appliance-type")!.textContent;

// ---------------------------------------------------------------------------

describe("lookupApplianceType", () => {
  it.each(["refrigeration", "laundry", "cooking", "dishwasher", "microwave", "hvac", "all_other"])("accepts %s", (value) => {
    expect(lookupApplianceType({ applianceType: value })).toBe(value);
    expect(lookupApplianceType({ ...AHS, applianceType: value })).toBe(value);
    // Server shape when the warranty is unknown: derived null, type at the top level.
    expect(lookupApplianceType({ serviceOrder: "7995-11075199", derived: null, applianceType: value })).toBe(value);
  });

  it.each([null, undefined, {}, AHS, { applianceType: "toaster" }, { applianceType: "" }, { applianceType: 3 }, { applianceType: "Laundry" }, "laundry"])(
    "is null for %j",
    (derived) => {
      expect(lookupApplianceType(derived)).toBeNull();
    },
  );
});

describe("tech-submit Appliance Type auto-detection", () => {
  it("clears HVAC without resurrecting a prior selection when switching to Parts NLA", async () => {
    await mount();
    await pickApplianceType("washer");
    await pickApplianceType("dryer");
    await pickApplianceType("hvac");
    expect(applianceTypeText()).toBe("HVAC");
    await act(async () => byTestId("tab-parts-nla")!.click());
    await flush(10);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect([...applianceSelect().options].some(o => o.value === "hvac")).toBe(false);
    await pickApplianceType("washer");
    expect(applianceTypeText()).toBe("Washer");
  });

  it("fills the type from the lookup, shows the note, and keeps the dropdown editable", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry" };
    await mount();
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(NOTE)).toBeNull();

    await enterServiceOrder(SO_A);
    expect(fixtures.lookupCalls).toEqual([SO_A]);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId("select-appliance-type")!.hasAttribute("data-placeholder")).toBe(true);
    const note = byTestId(NOTE)!;
    expect(note.textContent).toBe("Laundry category detected — select the specific appliance");
    // Under the dropdown, styled like the warranty's lock note.
    expect(note.className).toBe("mt-1 text-xs text-muted-foreground flex items-center gap-1");
    expect(byTestId("select-appliance-type")!.closest("div")!.contains(note)).toBe(true);
    // Editable: not disabled, unlike the locked warranty.
    expect((byTestId("select-appliance-type") as HTMLButtonElement).disabled).toBe(false);
    expect(byTestId("select-appliance-type")!.hasAttribute("data-disabled")).toBe(false);
  });

  it("removes the note when the tech changes the type, and keeps their choice", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry" };
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId(NOTE)).not.toBeNull();

    await pickApplianceType("cooktop");
    expect(applianceTypeText()).toBe("Cooktop");
    expect(byTestId(NOTE)).toBeNull();

    // Picking the detected value back is still the tech's choice: no note.
    await pickApplianceType("washer");
    expect(applianceTypeText()).toBe("Washer");
    expect(byTestId(NOTE)).toBeNull();
  });

  it("never overwrites a type the tech chose before the lookup", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry" };
    await mount();
    await pickApplianceType("refrigerator");
    await enterServiceOrder(SO_A);
    expect(fixtures.lookupCalls).toEqual([SO_A]);
    expect(applianceTypeText()).toBe("Refrigerator");
    expect(byTestId(NOTE)).toBeNull();
  });

  it("never overwrites a type the tech chose after an earlier lookup, when the SO changes", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry" };
    fixtures.lookups[SO_B] = { applianceType: "dishwasher" };
    await mount();
    await enterServiceOrder(SO_A);
    await pickApplianceType("microwave");
    await type("input-service-order", SO_B.split("-")[1]);
    expect(fixtures.lookupCalls).toEqual([SO_A, SO_B]);
    expect(applianceTypeText()).toBe("Microwave");
    expect(byTestId(NOTE)).toBeNull();
  });

  it("updates a lookup-set type when the SO changes", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry" };
    fixtures.lookups[SO_B] = { ...AHS, applianceType: "dishwasher" };
    await mount();
    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(NOTE)!.textContent).toContain("Laundry category detected");

    await type("input-service-order", SO_B.split("-")[1]);
    expect(fixtures.lookupCalls).toEqual([SO_A, SO_B]);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(NOTE)!.textContent).toContain("Dishwasher / Compactor category detected");
    expect(byTestId(NOTE)).not.toBeNull();
  });

  it("clears a lookup-set type when the new SO has no known type", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry" };
    fixtures.lookups[SO_B] = AHS;
    await mount();
    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Select appliance type");

    await type("input-service-order", SO_B.split("-")[1]);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(NOTE)).toBeNull();
  });

  it("hides the note while the SO is incomplete", async () => {
    fixtures.lookups[SO_A] = { applianceType: "hvac" };
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId(NOTE)).not.toBeNull();
    await type("input-service-order", "1234");
    expect(byTestId(NOTE)).toBeNull();
  });

  it.each([
    ["no derived", null],
    ["a warranty only", AHS],
    ["an unknown type", { applianceType: "toaster" }],
    ["an empty type", { applianceType: "" }],
    ["a failed lookup", "error"],
  ])("leaves the dropdown empty for %s", async (_label, derived) => {
    fixtures.lookups[SO_A] = derived;
    await mount();
    await enterServiceOrder(SO_A);
    expect(fixtures.lookupCalls).toEqual([SO_A]);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId("select-appliance-type")!.hasAttribute("data-placeholder")).toBe(true);
    expect(byTestId(NOTE)).toBeNull();

    // The tech picks the type by hand, as before.
    await pickApplianceType("cooktop");
    expect(applianceTypeText()).toBe("Cooktop");
    expect(byTestId(NOTE)).toBeNull();
  });
});

describe("tech-submit warranty auto-detection still holds", () => {
  it("locks the detected warranty next to the detected appliance type", async () => {
    fixtures.lookups[SO_A] = { ...AHS, applianceType: "refrigeration" };
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId("text-warranty-locked-note")!.textContent).toContain("Auto-detected from service order — locked.");
    expect(byTestId("badge-locked-american_home_shield")).not.toBeNull();
    expect(byTestId("provider-american_home_shield")!.className).toContain("border-primary");
    expect(byTestId("provider-sears_protect")!.getAttribute("aria-disabled")).toBe("true");
    // A click on another provider does nothing while locked.
    await act(async () => { byTestId("provider-sears_protect")!.click(); });
    await flush();
    expect(byTestId("provider-american_home_shield")!.className).toContain("border-primary");
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(NOTE)!.textContent).toContain("Refrigerator category detected");
  });

  it("does not lock the warranty when the lookup knows only the appliance type", async () => {
    fixtures.lookups[SO_A] = { applianceType: "cooking" };
    await mount();
    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(NOTE)!.textContent).toContain("Cooking category detected");
    expect(byTestId("text-warranty-locked-note")).toBeNull();
    expect(byTestId("text-warranty-autodetect-note")!.textContent).toBe("Could not auto-detect — please select the warranty provider.");
    expect(byTestId("badge-locked-sears_protect")).toBeNull();
    // Still the default, and the tech can pick another provider.
    expect(byTestId("provider-sears_protect")!.className).toContain("border-primary");
    await act(async () => { byTestId("provider-first_american")!.click(); });
    await flush();
    expect(byTestId("provider-first_american")!.className).toContain("border-primary");
  });

  it("shows the lookup-unavailable message when the lookup fails", async () => {
    fixtures.lookups[SO_A] = "error";
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId("text-warranty-lookup-unavailable")).not.toBeNull();
    expect(byTestId("text-warranty-locked-note")).toBeNull();
  });
});

describe("tech-submit service order product line", () => {
  it("replaces the generic note with the WOM product, under the dropdown", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct: WOM_WASHER };
    await mount();
    expect(byTestId(PRODUCT)).toBeNull();

    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Laundry");
    const line = byTestId(PRODUCT)!;
    expect(line.textContent).toBe("From service order product: WASHERDD - WASHER, DIRECT DRIVE");
    expect(line.getAttribute("data-auto-detected")).toBe("true");
    expect(byTestId("text-appliance-type-product-text")!.textContent).toBe("WASHERDD - WASHER, DIRECT DRIVE");
    expect(byTestId("text-service-order-product-source")).toBeNull();
    expect(byTestId(NOTE)).toBeNull();
    expect(byTestId("select-appliance-type")!.closest("div")!.contains(line)).toBe(true);
  });

  it("adds a muted (Snowflake) suffix for the Snowflake fallback", async () => {
    fixtures.lookups[SO_A] = { ...AHS, applianceType: "refrigeration", serviceOrderProduct: SNOWFLAKE_FRIDGE };
    await mount();
    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Refrigerator");
    expect(byTestId(PRODUCT)!.textContent).toBe("From service order product: REFSBS - REFRIGERATOR, SIDE BY SIDE (Snowflake)");
    const suffix = byTestId("text-service-order-product-source")!;
    expect(suffix.textContent).toBe(" (Snowflake)");
    expect(suffix.className).toContain("text-muted-foreground");
    expect(byTestId(NOTE)).toBeNull();
    // The warranty still locks as before.
    expect(byTestId("text-warranty-locked-note")).not.toBeNull();
  });

  it("shows the text exactly as returned, as text, never as HTML", async () => {
    const text = '  <b>WASHER</b> & "DRYER" <img src=x onerror=alert(1)> ';
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct: { text, source: "wom" } };
    await mount();
    await enterServiceOrder(SO_A);
    const value = byTestId("text-appliance-type-product-text")!;
    expect(value.textContent).toBe(text);
    expect(value.querySelector("b, img")).toBeNull();
  });

  it.each([
    ["no product", undefined],
    ["a null product", null],
    ["a blank text", { text: "   ", source: "wom" }],
    ["an unknown source", { text: "WASHERDD - WASHER, DIRECT DRIVE", source: "hssom" }],
    ["a non-object", "WASHERDD - WASHER, DIRECT DRIVE"],
  ])("keeps the generic note for %s", async (_label, serviceOrderProduct) => {
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct };
    await mount();
    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Laundry");
    expect(byTestId(PRODUCT)).toBeNull();
    expect(byTestId(NOTE)!.textContent).toBe("Auto-detected from service order");
  });

  it("keeps the product but drops the auto-detected wording once the tech changes the type", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct: WOM_WASHER };
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId(PRODUCT)!.getAttribute("data-auto-detected")).toBe("true");

    await pickApplianceType("cooking");
    expect(applianceTypeText()).toBe("Cooking");
    const line = byTestId(PRODUCT)!;
    expect(line.textContent).toBe("Service order product: WASHERDD - WASHER, DIRECT DRIVE");
    expect(line.getAttribute("data-auto-detected")).toBe("false");
    expect(byTestId(NOTE)).toBeNull();

    // Back to the detected value: still the tech's choice.
    await pickApplianceType("laundry");
    expect(byTestId(PRODUCT)!.textContent).toBe("Service order product: WASHERDD - WASHER, DIRECT DRIVE");
  });

  it("shows the product without the auto-detected wording when the type was not mapped", async () => {
    fixtures.lookups[SO_A] = { serviceOrderProduct: { text: "GENERATR - GENERATOR", source: "wom" } };
    await mount();
    await enterServiceOrder(SO_A);
    expect(applianceTypeText()).toBe("Select appliance type");
    expect(byTestId(PRODUCT)!.textContent).toBe("Service order product: GENERATR - GENERATOR");
    expect(byTestId(NOTE)).toBeNull();
  });

  it("clears the line on a service order change until the new lookup settles", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct: WOM_WASHER };
    fixtures.lookups[SO_B] = { applianceType: "refrigeration", serviceOrderProduct: SNOWFLAKE_FRIDGE };
    let release!: () => void;
    fixtures.gates[SO_B] = new Promise<void>((resolve) => { release = resolve; });
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId(PRODUCT)!.textContent).toContain("WASHERDD");

    await type("input-service-order", SO_B.split("-")[1]);
    expect(fixtures.lookupCalls).toEqual([SO_A, SO_B]);
    // SO B's lookup is still in flight: nothing from SO A lingers.
    expect(byTestId(PRODUCT)).toBeNull();
    expect(byTestId(NOTE)).toBeNull();

    release();
    await flush(10);
    expect(applianceTypeText()).toBe("Refrigerator");
    expect(byTestId(PRODUCT)!.textContent).toBe("From service order product: REFSBS - REFRIGERATOR, SIDE BY SIDE (Snowflake)");
  });

  it("clears the line when the new service order has no product", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct: WOM_WASHER };
    fixtures.lookups[SO_B] = { applianceType: "dishwasher" };
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId(PRODUCT)).not.toBeNull();

    await type("input-service-order", SO_B.split("-")[1]);
    expect(applianceTypeText()).toBe("Dishwasher / Compactor");
    expect(byTestId(PRODUCT)).toBeNull();
    expect(byTestId(NOTE)!.textContent).toBe("Auto-detected from service order");
  });

  it("hides the line while the service order is incomplete and on a failed lookup", async () => {
    fixtures.lookups[SO_A] = { applianceType: "laundry", serviceOrderProduct: WOM_WASHER };
    fixtures.lookups[SO_B] = "error";
    await mount();
    await enterServiceOrder(SO_A);
    expect(byTestId(PRODUCT)).not.toBeNull();
    await type("input-service-order", "1234");
    expect(byTestId(PRODUCT)).toBeNull();
    await type("input-service-order", SO_B.split("-")[1]);
    expect(byTestId("text-warranty-lookup-unavailable")).not.toBeNull();
    expect(byTestId(PRODUCT)).toBeNull();
  });
});
