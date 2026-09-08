import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  buildVrsAiCallResultAgentNotes,
  registerVrsAiCallResultApi,
  selectVrsAiCallResultTicket,
  type CloseVrsAiTicketOutcome,
  type VrsAiCallResult,
  type VrsAiCallResultCandidate,
} from "../server/vrs-ai-call-result";

const API_KEY = "test-vrs-api-key";

// The exact payload VRS AI posts for a completed approval.
const validCallResult = {
  version: 1,
  eventId: "8f3a5e10-58a4-4fe0-a3a1-95038a7e4ee6",
  callId: "vrs_536",
  soNo: "10866426",
  occurredAt: "2026-09-08T14:01:45.289Z",
  state: "approved",
  authNumber: "AHS-001",
  authorizedAmount: 380.6,
  durationSec: 187,
  partId: "EAD61906701",
  techId: "BCURTI",
  partDescription: "Dishwasher Wire Harness",
  recordingUrl:
    "https://agentic-vrs-agent-dev.stage.nextgen.shs.com/recordings/536_combined.wav",
} as const;

function pendingTicket(
  overrides: Partial<VrsAiCallResultCandidate> = {},
): VrsAiCallResultCandidate {
  return {
    submissionId: 4211,
    serviceOrder: "8175-10866426",
    ticketStatus: "pending",
    authCode: null,
    technicianLdapId: "BCURTI",
    createdAt: new Date("2026-09-08T13:40:00.000Z"),
    ...overrides,
  };
}

class FakeCloser {
  public calls: {
    ticket: VrsAiCallResultCandidate;
    result: VrsAiCallResult;
  }[] = [];

  constructor(
    private readonly outcome: CloseVrsAiTicketOutcome = {
      kind: "closed",
      ticketStatus: "completed",
      authCode: "AHS-001",
    },
  ) {}

  close = async (input: {
    ticket: VrsAiCallResultCandidate;
    result: VrsAiCallResult;
  }): Promise<CloseVrsAiTicketOutcome> => {
    this.calls.push(input);
    return this.outcome;
  };
}

function makeApp(options: {
  candidates?: readonly VrsAiCallResultCandidate[];
  closer?: FakeCloser;
  apiKey?: string | undefined;
  loadThrows?: boolean;
} = {}) {
  const closer = options.closer ?? new FakeCloser();
  const app = express();
  app.use(express.json());
  registerVrsAiCallResultApi(app, {
    apiKey: "apiKey" in options ? options.apiKey : API_KEY,
    loadTicketCandidates: async () => {
      if (options.loadThrows) throw new Error("db down");
      return options.candidates ?? [pendingTicket()];
    },
    closeTicket: closer.close,
  });
  return { app, closer };
}

describe("POST /api/integrations/vrs-ai/v1/call-result", () => {
  it("accepts the VRS AI call-result payload and closes the ticket", async () => {
    const { app, closer } = makeApp();

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      closed: true,
      deduped: false,
      submission_id: 4211,
      service_order: "8175-10866426",
      ticket_status: "completed",
      auth_number: "AHS-001",
      call_id: "vrs_536",
      event_id: "8f3a5e10-58a4-4fe0-a3a1-95038a7e4ee6",
    });

    expect(closer.calls).toHaveLength(1);
    expect(closer.calls[0].ticket.submissionId).toBe(4211);
    expect(closer.calls[0].result).toMatchObject({
      authNumber: "AHS-001",
      authorizedAmount: 380.6,
      partId: "EAD61906701",
      partDescription: "Dishwasher Wire Harness",
      techId: "BCURTI",
      durationSec: 187,
    });
  });

  it("rejects a missing or wrong API key and never touches the ticket", async () => {
    const { app, closer } = makeApp();

    const missing = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .send(validCallResult);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("UNAUTHORIZED");

    const wrong = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", "nope")
      .send(validCallResult);
    expect(wrong.status).toBe(401);

    expect(closer.calls).toHaveLength(0);
  });

  it("reports 503 when the API key is not configured", async () => {
    const { app } = makeApp({ apiKey: undefined });

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(503);
    expect(response.body.error).toBe("NOT_CONFIGURED");
  });

  it("closes the ticket when the optional recording fields are absent", async () => {
    const { app, closer } = makeApp();
    const { durationSec, recordingUrl, ...withoutOptional } = validCallResult;

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(withoutOptional);

    expect(response.status).toBe(200);
    expect(response.body.closed).toBe(true);
    expect(closer.calls[0].result.durationSec).toBeUndefined();
  });

  it("rejects an unknown field, a bad soNo, and a non-approved state", async () => {
    const { app, closer } = makeApp();

    const unknownField = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send({ ...validCallResult, contract_version: "v9" });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toBe("VALIDATION_ERROR");
    expect(unknownField.body.fields).toContain("contract_version");

    const badSo = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send({ ...validCallResult, soNo: "1086642" });
    expect(badSo.status).toBe(400);
    expect(badSo.body.fields).toContain("soNo");

    const denied = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send({ ...validCallResult, state: "denied" });
    expect(denied.status).toBe(400);
    expect(denied.body.fields).toContain("state");

    expect(closer.calls).toHaveLength(0);
  });

  it("rejects a missing required part/tech field", async () => {
    const { app } = makeApp();
    const { partId, ...withoutPartId } = validCallResult;

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(withoutPartId);

    expect(response.status).toBe(400);
    expect(response.body.fields).toContain("partId");
  });

  it("rejects an amount with sub-cent precision", async () => {
    const { app } = makeApp();

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send({ ...validCallResult, authorizedAmount: 380.605 });

    expect(response.status).toBe(400);
    expect(response.body.fields).toContain("authorizedAmount");
  });

  it("returns 404 when no ticket matches the service order", async () => {
    const { app, closer } = makeApp({ candidates: [] });

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("TICKET_NOT_FOUND");
    expect(response.body.message).toContain("10866426");
    expect(closer.calls).toHaveLength(0);
  });

  it("is idempotent — a replay of the same approval does not re-close", async () => {
    const { app, closer } = makeApp({
      candidates: [
        pendingTicket({ ticketStatus: "completed", authCode: "AHS-001" }),
      ],
    });

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      closed: false,
      deduped: true,
      submission_id: 4211,
    });
    expect(closer.calls).toHaveLength(0);
  });

  it("returns 409 when the ticket is not in a closable state", async () => {
    const { app, closer } = makeApp({
      candidates: [pendingTicket({ ticketStatus: "queued" })],
    });

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(409);
    expect(response.body.error).toBe("TICKET_NOT_CLOSABLE");
    expect(response.body.ticket_status).toBe("queued");
    expect(closer.calls).toHaveLength(0);
  });

  it("surfaces a close failure from the ticket process path", async () => {
    const closer = new FakeCloser({
      kind: "failed",
      status: 422,
      message: "No RGC code has been set for today. Please contact an administrator.",
    });
    const { app } = makeApp({ closer });

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(422);
    expect(response.body.error).toBe("TICKET_CLOSE_FAILED");
    expect(response.body.message).toContain("RGC code");
  });

  it("returns 500 when the ticket lookup itself fails", async () => {
    const { app } = makeApp({ loadThrows: true });

    const response = await request(app)
      .post("/api/integrations/vrs-ai/v1/call-result")
      .set("X-API-Key", API_KEY)
      .send(validCallResult);

    expect(response.status).toBe(500);
    expect(response.body.error).toBe("INTERNAL");
  });
});

describe("selectVrsAiCallResultTicket", () => {
  it("returns undefined with no candidates", () => {
    expect(selectVrsAiCallResultTicket([], "BCURTI")).toBeUndefined();
  });

  it("prefers the bridge-linked ticket over every service-order match", () => {
    const linked = pendingTicket({
      submissionId: 900,
      linkedByCallId: true,
      ticketStatus: "pending",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const newerUnlinked = pendingTicket({
      submissionId: 901,
      createdAt: new Date("2026-09-08T00:00:00.000Z"),
    });

    expect(
      selectVrsAiCallResultTicket([newerUnlinked, linked], "BCURTI")
        ?.submissionId,
    ).toBe(900);
  });

  it("narrows to the matching technician, case-insensitively", () => {
    const otherTech = pendingTicket({
      submissionId: 10,
      technicianLdapId: "AOTHER",
      createdAt: new Date("2026-09-08T14:00:00.000Z"),
    });
    const ourTech = pendingTicket({
      submissionId: 11,
      technicianLdapId: "bcurti",
      createdAt: new Date("2026-09-08T10:00:00.000Z"),
    });

    expect(
      selectVrsAiCallResultTicket([otherTech, ourTech], "BCURTI")?.submissionId,
    ).toBe(11);
  });

  it("falls back to all candidates when the tech id matches none", () => {
    const only = pendingTicket({ submissionId: 12, technicianLdapId: "ZZZZ" });

    expect(
      selectVrsAiCallResultTicket([only], "BCURTI")?.submissionId,
    ).toBe(12);
  });

  it("prefers a pending ticket over a newer non-pending one", () => {
    const newerCompleted = pendingTicket({
      submissionId: 20,
      ticketStatus: "completed",
      createdAt: new Date("2026-09-08T14:00:00.000Z"),
    });
    const olderPending = pendingTicket({
      submissionId: 21,
      ticketStatus: "pending",
      createdAt: new Date("2026-09-08T09:00:00.000Z"),
    });

    expect(
      selectVrsAiCallResultTicket([newerCompleted, olderPending], "BCURTI")
        ?.submissionId,
    ).toBe(21);
  });

  it("picks the newest pending ticket when several are pending", () => {
    const older = pendingTicket({
      submissionId: 30,
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
    });
    const newer = pendingTicket({
      submissionId: 31,
      createdAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(
      selectVrsAiCallResultTicket([older, newer], "BCURTI")?.submissionId,
    ).toBe(31);
  });

  it("returns the newest candidate when nothing is pending, so the caller can explain why", () => {
    const older = pendingTicket({
      submissionId: 40,
      ticketStatus: "rejected",
      createdAt: new Date("2026-09-08T08:00:00.000Z"),
    });
    const newer = pendingTicket({
      submissionId: 41,
      ticketStatus: "completed",
      createdAt: new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(
      selectVrsAiCallResultTicket([older, newer], "BCURTI")?.submissionId,
    ).toBe(41);
  });
});

describe("buildVrsAiCallResultAgentNotes", () => {
  it("carries the part, tech, duration, and recording into the audit note", () => {
    const notes = buildVrsAiCallResultAgentNotes(
      validCallResult as unknown as VrsAiCallResult,
    );

    expect(notes).toContain("$380.60");
    expect(notes).toContain("AHS-001");
    expect(notes).toContain("vrs_536");
    expect(notes).toContain("EAD61906701");
    expect(notes).toContain("Dishwasher Wire Harness");
    expect(notes).toContain("BCURTI");
    expect(notes).toContain("187s");
    expect(notes).toContain("536_combined.wav");
  });

  it("omits duration and recording when they are absent", () => {
    const { durationSec, recordingUrl, ...withoutOptional } = validCallResult;
    const notes = buildVrsAiCallResultAgentNotes(
      withoutOptional as unknown as VrsAiCallResult,
    );

    expect(notes).not.toContain("duration");
    expect(notes).not.toContain("Recording");
    expect(notes).toContain("$380.60");
  });
});
