import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  getQueueWaitEnd,
  isNlaReadyForOrder,
  type NlaReadyForOrderState,
} from "../shared/nla-ready-for-order";

const readyAt = "2026-09-20T14:30:00.000Z";
const canonical: NlaReadyForOrderState = {
  requestType: "parts_nla",
  ticketStatus: "queued",
  nlaResolution: "part_found_vrs_ordered",
  nlaEscalatedBy: 42,
  nlaReadyForOrderAt: readyAt,
};

describe("NLA ready-for-order state", () => {
  it.each([
    ["waiting research", { ...canonical, nlaEscalatedBy: null, nlaReadyForOrderAt: null }],
    ["pending research", { ...canonical, ticketStatus: "pending", nlaEscalatedBy: null, nlaReadyForOrderAt: null }],
    ["queued ready", canonical],
    ["claimed ready", { ...canonical, ticketStatus: "pending" }],
    ["order placed", { ...canonical, ticketStatus: "orderplaced" }],
    ["completed", { ...canonical, ticketStatus: "completed" }],
  ] as const)("%s has the expected badge state", (_label, state) => {
    const expected = _label === "queued ready" || _label === "claimed ready";
    expect(isNlaReadyForOrder(state)).toBe(expected);
  });

  it("does not infer readiness from retained escalation metadata alone", () => {
    expect(isNlaReadyForOrder({
      ...canonical,
      nlaEscalatedBy: null,
      nlaReadyForOrderAt: null,
    })).toBe(false);
    expect(isNlaReadyForOrder({
      ...canonical,
      nlaEscalatedBy: null,
      nlaResolution: "replacement_submitted",
    })).toBe(false);
  });

  it.each([
    "part_found_vrs_ordered",
    "part_found_tech_orders",
    "replacement_submitted",
    "replacement_tech_initiates",
    "rfr_eligible",
    "legacy_generic_order",
  ])("keeps a legacy canonical %s handoff ready without the new timestamp", (resolution) => {
    expect(isNlaReadyForOrder({
      ...canonical,
      nlaResolution: resolution,
      nlaReadyForOrderAt: null,
    })).toBe(true);
  });

  it("wires every readiness field into the real slim queue projection", () => {
    const storageSource = readFileSync(
      new URL("../server/storage.ts", import.meta.url),
      "utf8",
    );
    for (const field of [
      "requestType",
      "ticketStatus",
      "nlaResolution",
      "nlaEscalatedBy",
      "nlaReadyForOrderAt",
      "claimedAt",
      "statusChangedAt",
    ]) {
      expect(storageSource).toContain(`${field}: submissions.${field}`);
    }
  });
});

describe("queue-wait stop", () => {
  it("freezes legacy handoffs even when the old claim timestamp is missing", () => {
    const ticket = {
      requestType: "parts_nla", ticketStatus: "queued",
      nlaEscalatedBy: 42, statusChangedAt: readyAt,
    };
    expect(getQueueWaitEnd(ticket, new Date("2026-09-21T15:00:00Z"))).toBe(readyAt);
    expect(getQueueWaitEnd(ticket, new Date("2026-09-22T15:00:00Z"))).toBe(readyAt);
  });
  it("stays frozen at the research handoff across P-card claims and reassignments", () => {
    const firstRender = getQueueWaitEnd({
      ...canonical,
      claimedAt: "2026-09-20T14:45:00.000Z",
    }, new Date("2026-09-20T15:00:00.000Z"));
    const afterReloadAndReassign = getQueueWaitEnd({
      ...canonical,
      ticketStatus: "pending",
      claimedAt: "2026-09-20T16:00:00.000Z",
    }, new Date("2026-09-21T15:00:00.000Z"));

    expect(firstRender).toBe(readyAt);
    expect(afterReloadAndReassign).toBe(readyAt);
  });

  it("uses a stable persisted fallback for a legacy queued-ready row", () => {
    const legacyClaimedAt = "2026-09-20T14:10:00.000Z";
    const legacy = {
      ...canonical,
      nlaReadyForOrderAt: null,
      claimedAt: legacyClaimedAt,
    };
    expect(getQueueWaitEnd(legacy, new Date("2026-09-20T15:00:00.000Z")))
      .toBe(legacyClaimedAt);
    expect(getQueueWaitEnd(legacy, new Date("2026-09-21T15:00:00.000Z")))
      .toBe(legacyClaimedAt);
  });

  it("freezes an ordinary claimed ticket at claimedAt", () => {
    const claimedAt = "2026-09-20T14:15:00.000Z";
    expect(getQueueWaitEnd({
      requestType: "authorization",
      ticketStatus: "pending",
      claimedAt,
      statusChangedAt: claimedAt,
    }, new Date("2026-09-20T18:00:00.000Z"))).toBe(claimedAt);
  });

  it("uses the supplied clock only while a ticket is still unworked", () => {
    const now = new Date("2026-09-20T18:00:00.000Z");
    expect(getQueueWaitEnd({
      requestType: "parts_nla",
      ticketStatus: "queued",
    }, now)).toBe(now);
  });
});