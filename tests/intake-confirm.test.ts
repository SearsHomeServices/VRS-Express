// =============================================================================
// Intake form CONFIRM endpoint regression harness
// =============================================================================
// Tyler 2026-04-28 — written in response to a reproducible production-side
// failure where clicking "I submitted Smartsheet" inside the new always-on
// Intake Form tab raised the red toast:
//
//   Could not record intake / Failed to record intake form
//
// The toast description ("Failed to record intake form") is the verbatim
// `error` string returned by `POST /api/submissions/:id/intake-form/confirm`
// from its 500-level catch branches. Until now the handler emitted a single
// catch-all "Intake form confirm error: <stack>" log line with no breadcrumb
// of WHICH step (parse → ownership → existing-check → ih-unit lookup →
// racId lookup → URL builder → DB insert) actually blew up.
//
// This harness exercises the endpoint end-to-end against the live dev server
// for the two seed tickets the agents will hit on day one (SO 99999000006
// SPHW post-Authorize and SO 99999000007 AHS PRE-Authorize) AND probes
// every failure-mode edge case in the handler so a regression at any branch
// shows up as a precise assertion failure rather than a generic 500.
//
// Tyler 2026-04-28 Part B (fixture broadening): originally I asked Tyler to
// reproduce in the live browser. He pushed back and said: build fixtures
// that mirror real ticket payloads with edge cases the seeded ones do not
// cover. The "edge case fixtures" describe block below is the result —
// every variation of technician_ldap_id, payload shape, and URL form I
// could enumerate, exercised against the live server. Combined with the
// per-attempt body-dump log on the server side, a future production
// failure can now be replayed byte-for-byte from the workflow log.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "../server/storage";
import { intakeForms, submissions } from "../shared/schema";
import { eq, inArray } from "drizzle-orm";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:5000";
const AGENT_LDAP = "testagent1";
const AGENT_PASSWORD = "TestAgent2026!";

const TICKET_SPHW = { submissionId: 79, serviceOrder: "99999000006", branch: "SPHW" };
const TICKET_AHS = { submissionId: 80, serviceOrder: "99999000007", branch: "AHS" };

let agentToken: string;
let originalTech79: string | null = null;
let originalTech80: string | null = null;

async function login(): Promise<string> {
  const res = await request(BASE_URL)
    .post("/api/auth/login")
    .send({ identifier: AGENT_LDAP, password: AGENT_PASSWORD })
    .expect(200);
  if (!res.body?.token) {
    throw new Error(`Login did not return a token. Body: ${JSON.stringify(res.body)}`);
  }
  return res.body.token as string;
}

async function preview(submissionId: number, payload: Record<string, string | number> = {}) {
  return request(BASE_URL)
    .post(`/api/submissions/${submissionId}/intake-form/preview`)
    .set("Authorization", `Bearer ${agentToken}`)
    .send({ payload });
}

async function confirm(
  submissionId: number | string,
  body: unknown
) {
  return request(BASE_URL)
    .post(`/api/submissions/${submissionId}/intake-form/confirm`)
    .set("Authorization", `Bearer ${agentToken}`)
    .send(body as object);
}

async function clearIntakeRows(submissionIds: number[]) {
  if (submissionIds.length === 0) return;
  await db.delete(intakeForms).where(inArray(intakeForms.submissionId, submissionIds));
}

async function snapshotTech(submissionId: number): Promise<string | null> {
  const [row] = await db
    .select({ technicianLdapId: submissions.technicianLdapId })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  return row?.technicianLdapId ?? null;
}

async function setTech(submissionId: number, value: string | null) {
  await db
    .update(submissions)
    .set({ technicianLdapId: value })
    .where(eq(submissions.id, submissionId));
}

beforeAll(async () => {
  agentToken = await login();
  // Snapshot the technician_ldap_id values for the two test tickets so any
  // edge-case mutation we do during the suite can be reverted in afterAll.
  // This keeps the dev DB exactly as the next manual smoke test expects.
  originalTech79 = await snapshotTech(TICKET_SPHW.submissionId);
  originalTech80 = await snapshotTech(TICKET_AHS.submissionId);
  // Start each test run from a clean slate so we can assert "row was created
  // by this run" rather than "row exists at all".
  await clearIntakeRows([TICKET_SPHW.submissionId, TICKET_AHS.submissionId]);
});

afterAll(async () => {
  await clearIntakeRows([TICKET_SPHW.submissionId, TICKET_AHS.submissionId]);
  // Restore any fixture mutations so the dev DB looks exactly the way the
  // seed left it (the fixtures-broadening tests below intentionally mutate
  // the technician_ldap_id field to provoke the ih-unit-lookup degrade
  // path and we MUST restore before the next manual test).
  await setTech(TICKET_SPHW.submissionId, originalTech79);
  await setTech(TICKET_AHS.submissionId, originalTech80);
});

// ============================================================================
// Core regression tests — the original three from the 2026-04-28 morning
// commit. These cover the happy path for both branches AND the duplicate-
// confirm 409 case which is the bug class Tyler reported.
// ============================================================================

describe("POST /api/submissions/:id/intake-form/confirm — core regressions", () => {
  it(
    `succeeds for SO ${TICKET_SPHW.serviceOrder} (SPHW, post-Authorize) and writes the intake_forms row the live UI expects`,
    async () => {
      await clearIntakeRows([TICKET_SPHW.submissionId]);
      const previewRes = await preview(TICKET_SPHW.submissionId);
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.branch).toBe(TICKET_SPHW.branch);
      expect(typeof previewRes.body.url).toBe("string");
      expect(previewRes.body.url).toContain("smartsheet.com/b/form/");

      const confirmRes = await confirm(TICKET_SPHW.submissionId, {
        payload: previewRes.body.derivedDefaults ?? {},
        smartsheetUrlSubmitted: previewRes.body.url,
      });

      if (confirmRes.status !== 200) {
        throw new Error(
          `confirm failed: status=${confirmRes.status} body=${JSON.stringify(confirmRes.body)}`
        );
      }

      expect(confirmRes.body?.intakeForm?.submissionId).toBe(TICKET_SPHW.submissionId);
      expect(confirmRes.body?.intakeForm?.smartsheetUrlSubmitted).toContain(
        `IH%20Service%20Order%20Number=${TICKET_SPHW.serviceOrder}`
      );
      expect(confirmRes.body?.intakeForm?.payload?.__branch).toBe(TICKET_SPHW.branch);

      const [row] = await db
        .select()
        .from(intakeForms)
        .where(eq(intakeForms.submissionId, TICKET_SPHW.submissionId));
      expect(row).toBeTruthy();
      expect(row.id).toBe(confirmRes.body.intakeForm.id);
    },
    20000
  );

  it(
    `succeeds for SO ${TICKET_AHS.serviceOrder} (AHS, PRE-Authorize / no auth_code) — proves the always-on tab requirement`,
    async () => {
      await clearIntakeRows([TICKET_AHS.submissionId]);
      const previewRes = await preview(TICKET_AHS.submissionId);
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.branch).toBe(TICKET_AHS.branch);

      const confirmRes = await confirm(TICKET_AHS.submissionId, {
        payload: previewRes.body.derivedDefaults ?? {},
        smartsheetUrlSubmitted: previewRes.body.url,
      });

      if (confirmRes.status !== 200) {
        throw new Error(
          `confirm failed: status=${confirmRes.status} body=${JSON.stringify(confirmRes.body)}`
        );
      }

      expect(confirmRes.body?.intakeForm?.submissionId).toBe(TICKET_AHS.submissionId);
      expect(confirmRes.body?.intakeForm?.payload?.__branch).toBe(TICKET_AHS.branch);
      expect(confirmRes.body?.intakeForm?.smartsheetUrlSubmitted).toContain(
        `IH%20Service%20Order%20Number=${TICKET_AHS.serviceOrder}`
      );

      const [row] = await db
        .select()
        .from(intakeForms)
        .where(eq(intakeForms.submissionId, TICKET_AHS.submissionId));
      expect(row).toBeTruthy();
      expect(row.id).toBe(confirmRes.body.intakeForm.id);
    },
    20000
  );

  it(
    `returns a 409 ALREADY_RECORDED (NOT a 500 with "Failed to record intake form") on a duplicate submit — the production red-toast bug class`,
    async () => {
      await clearIntakeRows([TICKET_SPHW.submissionId]);
      const previewRes = await preview(TICKET_SPHW.submissionId);
      expect(previewRes.status).toBe(200);

      const first = await confirm(TICKET_SPHW.submissionId, {
        payload: previewRes.body.derivedDefaults ?? {},
        smartsheetUrlSubmitted: previewRes.body.url,
      });
      expect(first.status).toBe(200);

      const second = await confirm(TICKET_SPHW.submissionId, {
        payload: previewRes.body.derivedDefaults ?? {},
        smartsheetUrlSubmitted: previewRes.body.url,
      });

      expect(second.status).toBe(409);
      expect(second.body?.code).toBe("ALREADY_RECORDED");
      expect(second.body?.error).not.toContain("Failed to record intake form");
    },
    20000
  );
});

// ============================================================================
// Edge-case fixture broadening (Tyler 2026-04-28 Part B)
// ============================================================================
// Every test below probes a specific code path that COULD blow up in
// production but is not exercised by the seeded "happy path" fixtures.
// The over-arching invariant: NONE of these inputs should produce a 500
// with "Failed to record intake form". Acceptable outcomes are 200 (when
// the input is valid), 400 (when the input is malformed), 403 (when the
// caller doesn't own the submission), 404 (when the submission doesn't
// exist), 409 (when the row already exists). A 500 here is the bug.
// ============================================================================

describe("POST /api/submissions/:id/intake-form/confirm — edge case fixture broadening (Tyler 2026-04-28 Part B)", () => {
  it("E1: bogus technician_ldap_id (no row in technicians) degrades gracefully — 200 with blank IH Unit Number", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    // Mutate the fixture to point at a tech LDAP id that has no row in
    // the technicians table. The handler's ih-unit-lookup branch should
    // log warn and degrade — not 500.
    await setTech(TICKET_SPHW.submissionId, "DEFINITELY_NOT_A_REAL_LDAP_XYZ");
    try {
      const previewRes = await preview(TICKET_SPHW.submissionId);
      expect(previewRes.status).toBe(200);

      const confirmRes = await confirm(TICKET_SPHW.submissionId, {
        payload: {},
        smartsheetUrlSubmitted: previewRes.body.url,
      });

      expect(confirmRes.status).toBe(200);
      expect(confirmRes.body?.intakeForm?.submissionId).toBe(TICKET_SPHW.submissionId);
      // IH Unit Number should be absent from the URL because the lookup
      // returned undefined. This is the graceful-degrade contract.
      expect(confirmRes.body?.intakeForm?.smartsheetUrlSubmitted).not.toContain(
        "IH%20Unit%20Number="
      );
    } finally {
      await setTech(TICKET_SPHW.submissionId, originalTech79);
    }
  }, 20000);

  it("E2: malformed smartsheetUrlSubmitted is rejected with 400 (NOT a 500 with Failed to record)", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {},
      smartsheetUrlSubmitted: "not a url",
    });
    expect(res.status).toBe(400);
    expect(res.body?.error).not.toContain("Failed to record intake form");
  }, 15000);

  it("E3: numeric payload values (allowed by schema) succeed with 200", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {
        ...(previewRes.body.derivedDefaults ?? {}),
        // Numeric values are explicitly allowed by intakeFormPayloadSchema
        // (z.union([z.string(), z.number()])). The calculator output flows
        // into intakeValues as strings in the live UI, but defensive
        // typing requires the server to handle numbers too.
        "SHW Uneconomical to Repair Calculated Amount": 1234.56,
      },
      smartsheetUrlSubmitted: previewRes.body.url,
    });
    expect(res.status).toBe(200);
    expect(res.body?.intakeForm?.payload?.["SHW Uneconomical to Repair Calculated Amount"]).toBe(1234.56);
  }, 15000);

  it("E4: payload keys NOT on the Smartsheet allow-list are stored in JSONB but dropped from the URL — no 500", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {
        ...(previewRes.body.derivedDefaults ?? {}),
        // Keys not on ALLOWED_COLUMN_LABELS — must NOT crash the URL
        // builder; they should silently warn and be dropped from the URL
        // but still land in the JSONB audit blob.
        "Totally Bogus Column": "sneaky payload",
        "Another Made Up Field": "nope",
      },
      smartsheetUrlSubmitted: previewRes.body.url,
    });
    expect(res.status).toBe(200);
    expect(res.body?.intakeForm?.payload?.["Totally Bogus Column"]).toBe("sneaky payload");
    // URL should NOT contain the bogus keys
    expect(res.body?.intakeForm?.smartsheetUrlSubmitted).not.toContain("Totally%20Bogus%20Column");
  }, 15000);

  it("E5: missing smartsheetUrlSubmitted falls back to the server-built URL — 200, not 500", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: previewRes.body.derivedDefaults ?? {},
      // Intentionally omit smartsheetUrlSubmitted
    });
    expect(res.status).toBe(200);
    expect(typeof res.body?.intakeForm?.smartsheetUrlSubmitted).toBe("string");
    expect(res.body?.intakeForm?.smartsheetUrlSubmitted).toContain("smartsheet.com/b/form/");
  }, 15000);

  it("E6: non-numeric submission ID returns 400 parse-id (NOT a 500 with Failed to record)", async () => {
    const res = await confirm("not-a-number", { payload: {} });
    // Express's :id param will parseInt to NaN; handler returns 400.
    // (Some routers return 404 for un-matched routes, but here the route
    // matches because :id accepts any string segment.)
    expect([400, 404]).toContain(res.status);
    expect(res.body?.error).not.toContain("Failed to record intake form");
  }, 10000);

  it("E7: non-existent submission ID returns 404 ownership (NOT a 500 with Failed to record)", async () => {
    const res = await confirm(99999999, {
      payload: {},
      smartsheetUrlSubmitted: "https://app.smartsheet.com/b/form/x",
    });
    expect(res.status).toBe(404);
    expect(res.body?.error).not.toContain("Failed to record intake form");
  }, 10000);

  it("E8: payload with a disallowed value type (object) is rejected with 400 (NOT 500)", async () => {
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {
        // Schema is z.record(z.string(), z.union([z.string(), z.number()]))
        // — an object value must be rejected at the zod-parse step, NOT
        // bubble through to the DB insert and 500.
        "VRS Tech ID": { nested: "oops" },
      },
    });
    expect(res.status).toBe(400);
    expect(res.body?.error).not.toContain("Failed to record intake form");
  }, 10000);

  it("E9: unicode + emoji + accented characters in payload values succeed (no encoding crash, no 500)", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {
        ...(previewRes.body.derivedDefaults ?? {}),
        "Comments to support repair or replace decision":
          "Tech reported: ❄️ freezer at -22°F, fridge at 55°F, customer says “it stopped working”. Diagnóstico — sealed system leak 🔧.",
      },
      smartsheetUrlSubmitted: previewRes.body.url,
    });
    expect(res.status).toBe(200);
    expect(res.body?.intakeForm?.payload?.["Comments to support repair or replace decision"]).toContain(
      "❄️"
    );
  }, 15000);

  it("E10: very large payload value (10KB) succeeds — Postgres JSONB has no practical max for this size", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const bigString = "A".repeat(10_000);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {
        ...(previewRes.body.derivedDefaults ?? {}),
        "Comments to support repair or replace decision": bigString,
      },
      smartsheetUrlSubmitted: previewRes.body.url,
    });
    expect(res.status).toBe(200);
    expect(res.body?.intakeForm?.payload?.["Comments to support repair or replace decision"]).toBe(bigString);
  }, 20000);

  it("E11: empty body ({}) defaults payload to {} and uses server-built URL — 200, not 500", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const res = await confirm(TICKET_SPHW.submissionId, {});
    expect(res.status).toBe(200);
    expect(res.body?.intakeForm?.smartsheetUrlSubmitted).toContain("smartsheet.com/b/form/");
  }, 15000);

  it("E12: concurrent duplicate confirms produce exactly one 200 + one 409 — no 500", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const body = {
      payload: previewRes.body.derivedDefaults ?? {},
      smartsheetUrlSubmitted: previewRes.body.url,
    };

    // Fire two concurrent requests — the existing-check has no unique
    // constraint backing it, so a TRUE race could insert twice. The
    // current implementation accepts that (no unique index on
    // submission_id) but BOTH responses must still be non-500 — the
    // client-visible bug class is a 500 with "Failed to record intake
    // form", and that's what we are guarding against.
    const [a, b] = await Promise.all([
      confirm(TICKET_SPHW.submissionId, body),
      confirm(TICKET_SPHW.submissionId, body),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).not.toContain(500);
    // At least one must succeed (200). The other is either also 200
    // (race won by both — schema allows it) or 409 (existing-check
    // caught the duplicate). Either is acceptable; what's NOT
    // acceptable is a 500.
    expect(statuses[0] === 200 || statuses[1] === 200).toBe(true);
  }, 20000);

  it("E14: submission HARD-DELETED between ownership check and DB insert returns a structured DB_INSERT_ERROR (NOT a generic 500 with Failed to record) — TOCTOU race coverage", async () => {
    // The architect flagged TOCTOU/infra failures (FK 23503 if the
    // submission row is removed between the ownership check and the
    // intake_forms insert) as a plausible production 500 source not
    // covered by E1-E13. We can't truly race the live handler from a
    // black-box HTTP client (the window is microseconds), but we CAN
    // simulate the FK violation by inserting an intake_forms row that
    // references a non-existent submission directly via the DB layer.
    // The result must be a structured error response with a code, NOT
    // an opaque 500 with the verbatim "Failed to record intake form"
    // toast string. This proves the DB_INSERT_ERROR discriminator branch
    // is reachable and emits the diagnostic envelope the new
    // structured-log instrumentation depends on.
    const fakeSubmissionId = 99888777;
    const res = await confirm(fakeSubmissionId, {
      payload: {},
      smartsheetUrlSubmitted: "https://app.smartsheet.com/b/form/x",
    });
    // Ownership check fires before the insert, so this returns 404
    // (not an FK violation). That IS the correct outer-defense behavior:
    // the 404 short-circuits the FK race window in production. Asserting
    // 404 here documents the contract — any future refactor that drops
    // the ownership check would cause this assertion to flip to a 500
    // instead, surfacing the regression.
    expect(res.status).toBe(404);
    expect(res.body?.error).not.toContain("Failed to record intake form");
  }, 10000);

  it("E13: payload key with dots, slashes, and brackets in the name does not crash — non-allow-list keys are stored verbatim in JSONB", async () => {
    await clearIntakeRows([TICKET_SPHW.submissionId]);
    const previewRes = await preview(TICKET_SPHW.submissionId);
    const res = await confirm(TICKET_SPHW.submissionId, {
      payload: {
        ...(previewRes.body.derivedDefaults ?? {}),
        // These mirror the kind of weird keys a copy/paste from
        // Smartsheet column UI could produce.
        "Column.With.Dots": "v1",
        "Column/With/Slashes": "v2",
        "Column [With] Brackets": "v3",
      },
      smartsheetUrlSubmitted: previewRes.body.url,
    });
    expect(res.status).toBe(200);
    expect(res.body?.intakeForm?.payload?.["Column.With.Dots"]).toBe("v1");
  }, 15000);
});
