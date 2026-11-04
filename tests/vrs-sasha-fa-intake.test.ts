import { describe, expect, it, vi } from "vitest";
import {
  createVrsSashaIntake,
  type VrsSashaIntakeDependencies,
} from "../server/vrs-sasha-intake";
import type { VrsBridgeIntakeStore } from "../server/vrs-sasha-store";
import type { VrsAuthorizeRequest } from "../server/vrs-sasha-contract";
import {
  validV5AuthorizePayload,
  validV8AuthorizePayload,
} from "./fixtures/vrs-authorize-payloads";

const createdAt = new Date("2026-08-11T21:15:00.000Z");

// Trimmed from makeHarness in vrs-sasha-intake.test.ts: a fresh service order
// with an active technician, recording every ticket body created.
function makeHarness() {
  const ticketBodies: unknown[] = [];
  const store: VrsBridgeIntakeStore = {
    findActiveByServiceOrder: vi.fn(async () => undefined),
    createIntake: vi.fn(async (input) => ({
      kind: "accepted" as const,
      record: {
        id: 91,
        submissionId: input.submissionId,
        callId: input.callId,
        providerCallId: null,
        state: "pending_review",
        requestPayload: input.requestPayload,
      },
      createdAt,
    })),
    findLocallyAppliedRetryableFailedV8SubmissionsByServiceOrder: vi.fn(
      async () => [],
    ),
  } as unknown as VrsBridgeIntakeStore;

  const deps: VrsSashaIntakeDependencies = {
    store,
    resolveTechnician: vi.fn(async () => ({
      ldapId: "0123456",
      name: "Directory Carlos",
      phone: "+19845550111",
      district: "1353",
      isActive: true,
    })),
    resolveTechUser: vi.fn(async () => ({
      id: 501,
      email: "carlos@example.test",
      name: "Directory Carlos",
      role: "technician",
      racId: "0123456",
      phone: "+19845550111",
    })),
    encryptCallbackSecret: vi.fn(() => ({
      cipher: "encrypted",
      iv: "new-iv",
      authTag: "new-tag",
      salt: "new-salt",
    })),
    generateCallId: vi.fn(() => "vrs_call_new"),
    createTicket: vi.fn(async ({ body }) => {
      ticketBodies.push(body);
      return { kind: "created" as const, submissionId: 42 };
    }),
  };

  return { intake: createVrsSashaIntake(deps), deps, ticketBodies };
}

function withPartner(
  base: VrsAuthorizeRequest,
  partnerId: string | undefined,
): VrsAuthorizeRequest {
  const { partner_id: _partnerId, ...rest } = base as VrsAuthorizeRequest & {
    partner_id?: string;
  };
  return (partnerId === undefined
    ? rest
    : { ...rest, partner_id: partnerId }) as VrsAuthorizeRequest;
}

describe("VRS SASHA intake partner_id → ticket warranty", () => {
  it.each(["FA", "fa", "First American", "FIRST_AMERICAN", "20730"])(
    "accepts partner_id %j and creates a First American ticket",
    async (partnerId) => {
      const harness = makeHarness();

      await expect(
        harness.intake.receive(withPartner(validV8AuthorizePayload, partnerId)),
      ).resolves.toMatchObject({ kind: "accepted", callId: "vrs_call_new" });
      expect(harness.ticketBodies).toHaveLength(1);
      expect(harness.ticketBodies[0]).toMatchObject({
        serviceOrder: "1353-13538277",
        warrantyType: "first_american",
        warrantyProvider: "First American",
      });
    },
  );

  it.each([
    ["ahs", validV5AuthorizePayload],
    ["American Home Shield", validV8AuthorizePayload],
    ["N/A", validV5AuthorizePayload],
    [undefined, validV5AuthorizePayload],
    ["61380", validV8AuthorizePayload],
  ] as const)(
    "keeps partner_id %j as an American Home Shield ticket",
    async (partnerId, base) => {
      const harness = makeHarness();

      await expect(
        harness.intake.receive(withPartner(base, partnerId)),
      ).resolves.toMatchObject({ kind: "accepted" });
      expect(harness.ticketBodies).toHaveLength(1);
      expect(harness.ticketBodies[0]).toMatchObject({
        warrantyType: "american_home_shield",
        warrantyProvider: "American Home Shield",
      });
    },
  );

  // SASHA's other two clients: Sears Protect (90550) and Assurant PA (61481).
  it.each(["SPHW", "90550", "61481", "SEARS_PROTECT", "ASSURANT"])(
    "still rejects partner_id %j as an unsupported partner before any ticket work",
    async (partnerId) => {
    const harness = makeHarness();

    await expect(
      harness.intake.receive(withPartner(validV8AuthorizePayload, partnerId)),
    ).resolves.toEqual({ kind: "unsupported_partner", partnerId });
    expect(harness.deps.store.findActiveByServiceOrder).not.toHaveBeenCalled();
    expect(harness.deps.createTicket).not.toHaveBeenCalled();
    expect(harness.ticketBodies).toHaveLength(0);
  },
  );
});
