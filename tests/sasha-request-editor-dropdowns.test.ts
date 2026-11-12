// @vitest-environment jsdom
// The Stage 1 "request from SASHA" editor: failure cause is a dropdown of the
// values VRS AI accepts, and the First American age dropdown saves on the
// first click without turning SASHA's own age into the bucket's lower bound.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ bodies: [] as any[] }));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/src/lib/queryClient")>()),
  apiRequest: vi.fn(async (_method: string, _path: string, body: any) => {
    sent.bodies.push(JSON.parse(JSON.stringify(body)));
    return { json: async () => ({ ok: true, changed: Object.keys(body.fields ?? {}) }) };
  }),
}));

import { SashaRequestEditor } from "../client/src/components/sasha-request-editor";

function context(overrides: Record<string, unknown> = {}) {
  return {
    service_order: "12345678",
    contract_number: "C-1",
    brand: "Fixture brand",
    appliance_type: "RANGE",
    appliance_location: "kitchen",
    appliance_grade: "top",
    failure_cause: "normal-wear",
    tech_recommendation: "repair",
    repair_replace_rationale: "Fixture rationale",
    symptom: "OTHER",
    appliance_age: 1,
    labor_amount: 100,
    tax_amount: 10,
    part_price: 50,
    parts: [{ part_id: "P-1", part_description: "Fixture part", sell_price: 50, part_function: "" }],
    ...overrides,
  } as any;
}

let root: Root;
let container: HTMLDivElement;

function render(partner: string, ctx = context()) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SashaRequestEditor, { submissionId: 812, context: ctx, partner }),
      ),
    );
  });
}

function select(testId: string) {
  return container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`)!;
}

function choose(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function save() {
  act(() => container.querySelector<HTMLButtonElement>('[data-testid="button-sasha-save"]')!.click());
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sent.bodies = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("failure cause dropdown", () => {
  it("lists the technicians' six causes, starting on SASHA's value", () => {
    render("First American");
    const el = select("input-sasha-failure_cause");
    expect(el.tagName).toBe("SELECT");
    expect(el.value).toBe("normal-wear");
    expect(Array.from(el.options).map((o) => [o.value, o.text])).toEqual([
      ["power-surge", "Electronic Failure/power surge"],
      ["abuse", "Customer neglect/abuse"],
      ["mechanical-failure", "Mechanical Failure"],
      ["infestation", "Infestation"],
      ["normal-wear", "Normal wear and tear"],
      ["other", "Other"],
    ]);
  });

  it("sends the picked contract value on one Save", async () => {
    render("AHS");
    choose(select("input-sasha-failure_cause"), "power-surge");
    await save();
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0].fields).toEqual({ failure_cause: "power-surge" });
  });

  it("sends a new cause (mechanical failure) that passes the contract", async () => {
    render("AHS");
    choose(select("input-sasha-failure_cause"), "mechanical-failure");
    await save();
    expect(sent.bodies[0].fields).toEqual({ failure_cause: "mechanical-failure" });
  });

  it("keeps a no-longer-offered value SASHA sent selectable, with its label", () => {
    render("AHS", context({ failure_cause: "impact" }));
    const el = select("input-sasha-failure_cause");
    expect(el.value).toBe("impact");
    expect(el.options[0].text).toBe("Impact");
  });

  it("keeps an unlisted value SASHA sent selectable instead of dropping it", () => {
    render("AHS", context({ failure_cause: "legacy-value" }));
    const el = select("input-sasha-failure_cause");
    expect(el.value).toBe("legacy-value");
    expect(el.options[0].value).toBe("legacy-value");
  });
});

describe("AHS age box", () => {
  it("flags SASHA's 0 as a missing age", () => {
    render("AHS", context({ appliance_age: 0 }));
    expect(container.querySelector('[data-testid="text-sasha-age-required"]')).not.toBeNull();
  });

  it("shows no flag for a real age", () => {
    render("AHS", context({ appliance_age: 7 }));
    expect(container.querySelector('[data-testid="text-sasha-age-required"]')).toBeNull();
  });
});

describe("First American age dropdown", () => {
  it("shows SASHA's 0 (unknown) as unanswered, and 0 - 2 years saves 1", async () => {
    render("First American", context({ appliance_age: 0 }));
    const el = select("input-sasha-appliance_age");
    expect(el.value).toBe("");
    expect(el.options[el.selectedIndex].text).toBe("Select appliance age");
    choose(el, "1 - 2 years");
    expect(container.querySelector('[data-testid="text-sasha-age-required"]')).toBeNull();
    await save();
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0].fields).toEqual({ appliance_age: 1 });
  });

  it("sends the picked age on the first Save", async () => {
    render("First American");
    choose(select("input-sasha-appliance_age"), "6 years");
    await save();
    expect(sent.bodies).toHaveLength(1);
    expect(sent.bodies[0].fields).toEqual({ appliance_age: 6 });
  });

  it("keeps SASHA's age when the agent re-picks the bucket it falls in", async () => {
    render("First American", context({ appliance_age: 2 }));
    const el = select("input-sasha-appliance_age");
    expect(el.value).toBe("1 - 2 years");
    choose(el, "6 years");
    choose(el, "1 - 2 years");
    await save();
    // Nothing changed: SASHA's 2 is kept, not replaced by the bucket's 1.
    expect(sent.bodies).toHaveLength(0);
    expect(container.querySelector('[data-testid="text-sasha-edit-error"]')).toBeNull();
  });
});

describe("new failure causes pass the VRS contract", () => {
  it.each(["mechanical-failure", "infestation"])("accepts %s on SASHA V9 and app requests", async (cause) => {
    const { safeParseVrsAuthorizeRequest } = await import("../server/vrs-sasha-contract");
    const { validV9AuthorizePayload } = await import("./fixtures/vrs-authorize-payloads");
    expect(safeParseVrsAuthorizeRequest({ ...validV9AuthorizePayload, failure_cause: cause }).success).toBe(true);
  });

  it("still refuses free text", async () => {
    const { safeParseVrsAuthorizeRequest } = await import("../server/vrs-sasha-contract");
    const { validV9AuthorizePayload } = await import("./fixtures/vrs-authorize-payloads");
    expect(safeParseVrsAuthorizeRequest({ ...validV9AuthorizePayload, failure_cause: "Mechanical Failure" }).success).toBe(false);
  });
});
