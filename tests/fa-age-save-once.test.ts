// @vitest-environment jsdom
// First American ticket, Stage 1 details editor: picking an appliance age
// from the dropdown and clicking Save once sends that age (mouse and
// keyboard). Guards the "had to save twice" report.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ bodies: [] as any[] }));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client/src/lib/queryClient")>()),
  apiRequest: vi.fn(async (_method: string, _path: string, body: any) => {
    sent.bodies.push(JSON.parse(JSON.stringify(body)));
    return {
      json: async () => ({ ok: true, ahsDetails: JSON.stringify(body.ahsDetails), enrolled: true }),
    };
  }),
}));
vi.mock("@/components/media", () => ({
  MediaImage: (props: any) => createElement("img", props),
  MediaVideo: (props: any) => createElement("video", props),
  MediaAudio: (props: any) => createElement("audio", props),
}));

import { AhsDetailsEditor } from "../client/src/components/ahs-details-editor";

const stored = JSON.stringify({
  contractNumber: "C-1",
  brand: "Whirlpool",
  modelNumber: "M-1",
  serialNumber: "S-1",
  customerName: "",
  applianceKind: "dishwasher",
  applianceLocation: "Kitchen",
  failureCause: "normal-wear",
  techRecommendation: "repair",
  laborAmount: 100,
  taxAmount: 0,
  parts: [{ partNumber: "P-1", quantity: 1, description: "Pump", unitPrice: 50 }],
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
  sent.bodies = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(AhsDetailsEditor, {
          submissionId: 812,
          storedDetails: stored,
          media: { issuePhotos: [], estimatePhotos: [], videos: [], voiceNote: null } as any,
          partner: "First American",
        }),
      ),
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 10; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function pointer(el: Element, type: string, at = 0) {
  const Ctor: any = (globalThis as any).PointerEvent ?? MouseEvent;
  const ev = new Ctor(type, { bubbles: true, cancelable: true, button: 0, pointerType: "mouse", pointerId: 1, clientX: at, clientY: at, pageX: at, pageY: at });
  if (!("pointerType" in ev)) Object.defineProperty(ev, "pointerType", { value: "mouse" });
  el.dispatchEvent(ev);
}

describe("FA age: pick then save once", () => {
  it("mouse: sends the picked age on the first click", async () => {
    const trigger = document.querySelector<HTMLElement>('[data-testid="select-ahs-age"]')!;
    act(() => { pointer(trigger, "pointerdown"); });
    await flush();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent === "6 years",
    );
    expect(option, "dropdown must open").toBeTruthy();
    act(() => { pointer(option!, "pointermove", 200); pointer(option!, "pointerup", 200); });
    await flush();
    const save = document.querySelector<HTMLButtonElement>('[data-testid="button-ahs-save"]')!;
    act(() => { pointer(save, "pointerdown", 400); pointer(save, "pointerup", 400); save.click(); });
    await flush();
    expect(sent.bodies.length).toBe(1);
    expect(sent.bodies[0].ahsDetails.applianceAge).toBe(6);
  });

  it("sends the picked age on the first click", async () => {
    const trigger = document.querySelector<HTMLElement>('[data-testid="select-ahs-age"]')!;
    expect(trigger).not.toBeNull();
    act(() => { trigger.focus(); });
    act(() => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (el) => el.textContent === "6 years",
    );
    expect(option, "dropdown must open").toBeTruthy();
    act(() => { option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    await flush();

    const save = document.querySelector<HTMLButtonElement>('[data-testid="button-ahs-save"]')!;
    act(() => { save.click(); });
    await flush();
    expect(sent.bodies.length).toBe(1);
    expect(sent.bodies[0].ahsDetails.applianceAge).toBe(6);
  });
});
