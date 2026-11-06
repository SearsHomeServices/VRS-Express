// First American auth codes: FA + MMDD (Eastern) + VRS + initials. VRS AI
// approvals carry "AI"; human agents get their own initials pre-filled at
// Stage 2. AHS and every other warranty keep the partner's number.
import fs from "node:fs";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentInitials,
  buildFirstAmericanAuthCode,
  firstAmericanAuthCodePrefill,
  isFirstAmericanWarranty,
  vrsAiTicketAuthCode,
} from "../shared/fa-auth-code";
import {
  buildVrsAiWebhookAgentNotes,
  mapVrsAiWebhookToSubmissionDecision,
} from "../server/vrs-sasha-queue";
import {
  buildVrsAiCallResultAgentNotes,
  registerVrsAiCallResultApi,
  type CloseVrsAiTicketOutcome,
  type VrsAiCallResult,
  type VrsAiCallResultCandidate,
} from "../server/vrs-ai-call-result";
import { createVrsWebhookSignature } from "../server/vrs-sasha-contract";
import { testReceipts } from "./helpers/direct-result-receipts";
import { approvalFixture, createHandlerHarness } from "./helpers/vrs-handler-harness";

// 23:30 Eastern on Nov 6 2026 (EST, UTC-5) is already Nov 7 in UTC.
const LATE_EVENING_ET = "2026-11-07T04:30:00.000Z";

describe("buildFirstAmericanAuthCode", () => {
  it("composes FA + MMDD + VRS + initials", () => {
    expect(buildFirstAmericanAuthCode(new Date("2026-07-28T16:00:00Z"), "HJ")).toBe("FA0728VRSHJ");
    expect(buildFirstAmericanAuthCode(new Date("2026-11-06T15:00:00Z"), "AI")).toBe("FA1106VRSAI");
  });

  it("uses the Eastern calendar day, not UTC", () => {
    expect(buildFirstAmericanAuthCode(new Date(LATE_EVENING_ET), "AI")).toBe("FA1106VRSAI");
    // 23:30 EDT on July 28 is 03:30 UTC July 29.
    expect(buildFirstAmericanAuthCode(new Date("2026-07-29T03:30:00Z"), "HJ")).toBe("FA0728VRSHJ");
    // 00:30 EST Jan 1 is still Jan 1.
    expect(buildFirstAmericanAuthCode(new Date("2027-01-01T05:30:00Z"), "AI")).toBe("FA0101VRSAI");
  });

  it("uppercases the initials and keeps letters only", () => {
    expect(buildFirstAmericanAuthCode(new Date("2026-03-05T15:00:00Z"), " h.j ")).toBe("FA0305VRSHJ");
  });
});

describe("agentInitials", () => {
  it.each([
    ["Hamed Jabarkhail", "HJ"],
    ["Tyler Morrison", "TM"],
    ["hamed jabarkhail", "HJ"],
    ["  Hamed    Jabarkhail  ", "HJ"],
    ["Mary Ann Smith", "MS"],
    ["Jabarkhail, Hamed", "HJ"],
    ["Smith,Mary Ann", "MS"],
    ["John Smith Jr.", "JS"],
    ["Pat O'Brien", "PO"],
    ["Jean-Luc Picard", "JP"],
  ])("%s -> %s", (name, initials) => {
    expect(agentInitials(name)).toBe(initials);
  });

  it.each([["Madonna"], [""], ["   "], [null], [undefined], [", Hamed"], ["Smith,"]])(
    "returns null when two letters cannot be found: %j",
    (name) => {
      expect(agentInitials(name as string | null | undefined)).toBeNull();
    },
  );
});

describe("First American detection and the VRS AI ticket code", () => {
  it("recognizes First American by warranty type or provider", () => {
    expect(isFirstAmericanWarranty({ warrantyType: "first_american" })).toBe(true);
    expect(isFirstAmericanWarranty({ warrantyProvider: "First American" })).toBe(true);
    expect(isFirstAmericanWarranty({ warrantyProvider: "first_american" })).toBe(true);
    expect(isFirstAmericanWarranty({ warrantyType: "american_home_shield", warrantyProvider: "AHS" })).toBe(false);
    expect(isFirstAmericanWarranty({ warrantyProvider: "Sears Protect" })).toBe(false);
  });

  it("FA gets FA+MMDD+VRS+AI from occurredAt; AHS keeps the authNumber", () => {
    const result = { authNumber: "VRSAI-123", occurredAt: LATE_EVENING_ET };
    expect(vrsAiTicketAuthCode({ warrantyType: "first_american" }, result)).toBe("FA1106VRSAI");
    expect(vrsAiTicketAuthCode({ warrantyProvider: "AHS" }, result)).toBe("VRSAI-123");
  });
});

describe("mapVrsAiWebhookToSubmissionDecision", () => {
  const approved = {
    version: 1 as const,
    eventId: "evt-fa-1",
    callId: "call-fa-1",
    soNo: "99090801",
    occurredAt: LATE_EVENING_ET,
    state: "approved" as const,
    authNumber: "FA-RAW-77",
    authorizedAmount: 250,
  };
  const partial = {
    version: 1 as const,
    eventId: "evt-fa-2",
    callId: "call-fa-2",
    soNo: "99090801",
    occurredAt: "2026-07-28T18:00:00Z",
    state: "partial" as const,
    authNumber: "FA-RAW-88",
    authorizedAmount: 100,
    requestedAmount: 250,
  };

  it("First American approved -> FA<MMDD>VRSAI on the Eastern date, raw number kept in notes", () => {
    const decision = mapVrsAiWebhookToSubmissionDecision(approved, "First American");
    expect(decision.kind).toBe("process");
    if (decision.kind !== "process") return;
    expect(decision.body.authCode).toBe("FA1106VRSAI");
    expect(decision.body.agentNotes).toContain("auth FA-RAW-77");
    expect(decision.body.agentNotes).toBe(buildVrsAiWebhookAgentNotes(approved));
  });

  it("AHS approved keeps VRS AI's authNumber", () => {
    for (const decision of [
      mapVrsAiWebhookToSubmissionDecision(approved),
      mapVrsAiWebhookToSubmissionDecision(approved, "AHS"),
    ]) {
      expect(decision.kind === "process" && decision.body.authCode).toBe("FA-RAW-77");
    }
  });

  it("First American partial -> FA<MMDD>VRSAI", () => {
    const decision = mapVrsAiWebhookToSubmissionDecision(partial, "First American");
    expect(decision.kind === "process" && decision.body.authCode).toBe("FA0728VRSAI");
    expect(decision.kind === "process" && decision.body.technicianMessage).toBe(
      "First American partially authorized $100.00 of $250.00.",
    );
    const ahs = mapVrsAiWebhookToSubmissionDecision(partial, "AHS");
    expect(ahs.kind === "process" && ahs.body.authCode).toBe("FA-RAW-88");
  });

  it("the same event always maps to the same code (retries are deterministic)", () => {
    const first = mapVrsAiWebhookToSubmissionDecision(approved, "First American");
    const again = mapVrsAiWebhookToSubmissionDecision({ ...approved }, "First American");
    expect(first).toEqual(again);
  });
});

// Direct call-result route, with a fake closer.
const API_KEY = "fa-test-key";
const faResult = {
  version: 1,
  eventId: "fa-direct-event",
  callId: "fa-direct-call",
  soNo: "99090801",
  occurredAt: LATE_EVENING_ET,
  state: "approved",
  authNumber: "FA-RAW-55",
  authorizedAmount: 380.6,
  partId: "EAD61906701",
  techId: "TESTTECH",
  partDescription: "Dishwasher Wire Harness",
} as const;

function faTicket(overrides: Partial<VrsAiCallResultCandidate> = {}): VrsAiCallResultCandidate {
  return {
    requestType: "authorization",
    submissionApproved: true,
    stage1Status: "approved",
    warrantyProvider: "First American",
    warrantyType: "first_american",
    partNumbers: '["EAD61906701"]',
    submissionId: 5100,
    serviceOrder: "0001-99090801",
    ticketStatus: "pending",
    authCode: null,
    technicianLdapId: "TESTTECH",
    createdAt: new Date("2026-11-06T20:00:00.000Z"),
    ...overrides,
  };
}

function makeDirectApp(ticket: VrsAiCallResultCandidate, outcome: CloseVrsAiTicketOutcome, boundSubmissionId?: number) {
  const calls: { ticket: VrsAiCallResultCandidate; result: VrsAiCallResult }[] = [];
  const app = express();
  app.use(express.json());
  registerVrsAiCallResultApi(app, {
    receipts: testReceipts(boundSubmissionId),
    apiKey: API_KEY,
    loadTicketCandidates: async () => [ticket],
    closeTicket: async (input) => {
      calls.push(input);
      return outcome;
    },
  });
  return { app, calls };
}

const postDirect = (app: express.Express) =>
  request(app).post("/api/integrations/vrs-ai/v1/call-result").set("X-API-Key", API_KEY).send(faResult);

describe("POST /api/integrations/vrs-ai/v1/call-result for First American", () => {
  it("accepts a close that stored FA<MMDD>VRSAI", async () => {
    const { app, calls } = makeDirectApp(faTicket(), { kind: "closed", ticketStatus: "completed", authCode: "FA1106VRSAI" });
    const res = await postDirect(app);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ closed: true, auth_number: "FA1106VRSAI" });
    expect(calls).toHaveLength(1);
  });

  it("treats a raw-number close on an FA ticket as unexpected", async () => {
    const { app } = makeDirectApp(faTicket(), { kind: "closed", ticketStatus: "completed", authCode: "FA-RAW-55" });
    const res = await postDirect(app);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error).toBe("UNEXPECTED_CLOSE_RESULT");
  });

  it.each([["FA1106VRSAI"], ["FA-RAW-55"]])(
    "a duplicate delivery on an FA ticket already closed with %s is deduped",
    async (authCode) => {
      const { app, calls } = makeDirectApp(
        faTicket({ ticketStatus: "completed", authCode, agentNotes: buildVrsAiCallResultAgentNotes(faResult) }),
        { kind: "closed", ticketStatus: "completed", authCode: "unused" },
        5100,
      );
      const res = await postDirect(app);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ closed: false, deduped: true, auth_number: authCode });
      expect(calls).toHaveLength(0);
    },
  );
});

// The real routes.ts handlers through the shared harness.
describe("real handler: First American VRS AI approvals", () => {
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = {
      VRS_AI_WEBHOOK_SECRET: process.env.VRS_AI_WEBHOOK_SECRET,
      VRS_SASHA_API_KEY: process.env.VRS_SASHA_API_KEY,
      VRS_AI_CALL_RESULT_ENABLED: process.env.VRS_AI_CALL_RESULT_ENABLED,
    };
    process.env.VRS_AI_WEBHOOK_SECRET = "signed-handler-key";
    process.env.VRS_SASHA_API_KEY = "handler-test-key";
    delete process.env.VRS_AI_CALL_RESULT_ENABLED;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const faOverrides = { warrantyProvider: "First American", warrantyType: "first_american" };
  // approvalFixture.occurredAt is 2026-09-08T14:00:00Z -> Sept 8 Eastern.
  const expected = "FA0908VRSAI";

  const signed = (app: any, event: Record<string, unknown>) => {
    const body = JSON.stringify(event);
    return request(app)
      .post("/api/integrations/vrs-ai/v1/webhook")
      .set("Content-Type", "application/json")
      .set("X-VRS-Signature", createVrsWebhookSignature(body, "signed-handler-key"))
      .set("X-VRS-Event-Id", String(event.eventId))
      .set("X-VRS-Timestamp", String(Date.now()))
      .send(body);
  };

  it("signed webhook: FA ticket gets FA<MMDD>VRSAI and a duplicate is idempotent", async () => {
    const f = createHandlerHarness(faOverrides);
    expect((await signed(f.app, approvalFixture)).status).toBe(200);
    expect(f.row.ticketStatus).toBe("completed");
    expect(f.row.authCode).toBe(expected);
    expect(f.row.agentNotes).toContain("auth TEST-AUTH");
    expect((await signed(f.app, approvalFixture)).status).toBe(200);
    expect(f.updates).toHaveLength(1);
    expect(f.sms).toHaveLength(1);
    expect(f.row.authCode).toBe(expected);
  });

  it("signed webhook: AHS ticket keeps VRS AI's authNumber", async () => {
    const f = createHandlerHarness();
    expect((await signed(f.app, approvalFixture)).status).toBe(200);
    expect(f.row.authCode).toBe("TEST-AUTH");
  });

  it("direct call-result: FA ticket gets FA<MMDD>VRSAI and a duplicate is idempotent", async () => {
    // A receipt that keeps its ticket binding across deliveries, as the
    // durable store does, so the retry reaches the already-applied check.
    let boundId: number | null = null;
    const receipts = {
      execute: async (_result: unknown, work: (binding: any) => Promise<any>) => {
        const binding = {
          submissionId: boundId,
          bind: async (id: number) => {
            binding.submissionId = id;
            boundId = id;
          },
        };
        return work(binding);
      },
    };
    const f = createHandlerHarness(faOverrides, { receipts });
    const post = () =>
      request(f.app).post("/api/integrations/vrs-ai/v1/call-result").set("X-API-Key", "handler-test-key").send(approvalFixture);
    const first = await post();
    expect(first.status).toBe(200);
    expect(first.body.auth_number).toBe(expected);
    expect(f.row.authCode).toBe(expected);
    expect(f.row.agentNotes).toContain("auth TEST-AUTH");
    const again = await post();
    expect(again.status).toBe(200);
    expect(again.body.auth_number).toBe(expected);
    expect(f.updates).toHaveLength(1);
    expect(f.sms).toHaveLength(1);
  });
});

describe("Stage 2 pre-fill for human agents", () => {
  const at = new Date("2026-07-28T16:00:00Z");

  it("First American pre-fills today's code with the agent's initials", () => {
    expect(firstAmericanAuthCodePrefill({ warrantyType: "first_american" }, "Hamed Jabarkhail", at)).toBe("FA0728VRSHJ");
    expect(firstAmericanAuthCodePrefill({ warrantyProvider: "First American" }, "Jabarkhail, Hamed", at)).toBe("FA0728VRSHJ");
  });

  it("AHS (and anything else) does not pre-fill", () => {
    expect(firstAmericanAuthCodePrefill({ warrantyType: "american_home_shield", warrantyProvider: "AHS" }, "Hamed Jabarkhail", at)).toBeNull();
    expect(firstAmericanAuthCodePrefill({ warrantyProvider: "Sears Protect" }, "Hamed Jabarkhail", at)).toBeNull();
    expect(firstAmericanAuthCodePrefill(null, "Hamed Jabarkhail", at)).toBeNull();
  });

  it("leaves the input empty when initials cannot be derived", () => {
    expect(firstAmericanAuthCodePrefill({ warrantyType: "first_american" }, "Madonna", at)).toBeNull();
    expect(firstAmericanAuthCodePrefill({ warrantyType: "first_american" }, undefined, at)).toBeNull();
  });

  it("the dashboard pre-fills only on selecting Approved to Repair with an empty input", () => {
    const source = fs.readFileSync("client/src/pages/agent-dashboard.tsx", "utf8");
    const start = source.indexOf("// Stage 2 — Approved to Repair (issues the auth/RGC code).");
    const end = source.indexOf("} else if (isTwoStageWarranty(selectedSubmission))", start);
    expect(start).toBeGreaterThan(0);
    const stage2 = source.slice(start, end);
    expect(stage2).toContain('nextAction === "approve" && !authCode.trim()');
    expect(stage2).toContain("firstAmericanAuthCodePrefill(selectedSubmission as any, user?.name, new Date())");
    expect(stage2).toContain("if (faCode) setAuthCode(faCode);");
  });
});
