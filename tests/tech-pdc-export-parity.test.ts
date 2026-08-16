// =============================================================================
// Tech PDC filter ↔ coaching-export parity harness (Task #45)
// =============================================================================
// The Tech PDC filter is defined twice:
//   - CLIENT: the admin Ticket Overview table filter, whose predicate now
//     lives in shared/tech-pdc-filter.ts (matchesTechPdcFilter).
//   - SERVER: the `pdc` param inside getCoachingRecords (server/routes.ts),
//     used by GET /api/admin/export-coaching (CSV/XLSX) and the bulk
//     POST /api/tech-pdc/export push.
//
// If the two definitions drift (e.g. how "missing coaching notes" treats
// whitespace-only notes, or how "not sent" treats null vs empty status), the
// export silently stops matching the visible table. This harness seeds
// negative-outcome tickets across EVERY Tech PDC state (null / pending /
// sent / failed × null / "" / whitespace / real coaching notes), plus
// non-negative controls, and asserts — for every `pdc` value, alone and in
// combination with the status tab, request-type toggle, and date range —
// that the CSV export's row set is exactly what the client-side table
// pipeline would show (intersected with negative outcomes, which is the
// export's documented scope).
//
// Runs against the live dev server (same pattern as intake-confirm.test.ts):
//   npx vitest run tests/tech-pdc-export-parity.test.ts
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "../server/storage";
import { submissions, users } from "../shared/schema";
import { eq, like } from "drizzle-orm";
import {
  matchesTechPdcFilter,
  NEGATIVE_TICKET_STATUSES,
  TECH_PDC_FILTER_VALUES,
  type TechPdcFilterValue,
} from "../shared/tech-pdc-filter";

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:5000";

// All fixture service orders share this prefix so setup/teardown can sweep
// them with a single LIKE. 13-char column; prefix + 4-digit index = 11.
const SO_PREFIX = "9994500";

// Seed admin (server/seed.ts). Password candidates cover both the original
// seed value and the periodic dev-password reset.
const ADMIN_ID = "TESTADMIN";
const ADMIN_PASSWORDS = ["TestAdmin2026!", "VRS2026!", "admin123"];

let adminToken: string;
let technicianId: number;

// ---------------------------------------------------------------------------
// Fixture matrix
// ---------------------------------------------------------------------------
type Fixture = {
  serviceOrder: string;
  ticketStatus: string;
  techPdcStatus: string | null;
  coachingNotes: string | null;
  requestType: string; // 'authorization' | 'parts_nla'
  createdAt: Date;
};

const NOW = Date.now();
const RECENT = new Date(NOW - 2 * 24 * 60 * 60 * 1000); // 2 days ago
const OLD = new Date(NOW - 40 * 24 * 60 * 60 * 1000); // 40 days ago

const PDC_STATES: (string | null)[] = [null, "pending", "sent", "failed"];
// null / empty / whitespace-only / real — the exact drift risk called out in
// the task ("missing_notes" must treat whitespace-only as missing on BOTH
// sides; "" and null must both count as not_sent for techPdcStatus).
const NOTES_STATES: (string | null)[] = [null, "", "   \t ", "Real coaching note"];
const NEGATIVES = ["rejected", "rejected_closed", "invalid"];

function buildFixtures(): Fixture[] {
  const rows: Fixture[] = [];
  let i = 0;
  // Full PDC-state × notes-state cross product over negative outcomes,
  // cycling ticket status / request type / created-at so every combination
  // dimension has both matching and non-matching rows.
  for (const pdc of PDC_STATES) {
    for (const notes of NOTES_STATES) {
      for (const status of NEGATIVES) {
        rows.push({
          serviceOrder: `${SO_PREFIX}${String(i).padStart(4, "0")}`,
          ticketStatus: status,
          techPdcStatus: pdc,
          coachingNotes: notes,
          requestType: i % 2 === 0 ? "authorization" : "parts_nla",
          createdAt: i % 3 === 0 ? OLD : RECENT,
        });
        i++;
      }
    }
  }
  // Non-negative controls — must NEVER appear in the export, even when they
  // carry PDC state or missing notes.
  for (const status of ["queued", "pending", "completed"]) {
    rows.push({
      serviceOrder: `${SO_PREFIX}${String(i).padStart(4, "0")}`,
      ticketStatus: status,
      techPdcStatus: "sent",
      coachingNotes: null,
      requestType: i % 2 === 0 ? "authorization" : "parts_nla",
      createdAt: RECENT,
    });
    i++;
  }
  return rows;
}

const FIXTURES = buildFixtures();

// ---------------------------------------------------------------------------
// Reference implementation of the CLIENT table pipeline (admin-dashboard.tsx)
// applied to the fixture set. Order matches the dashboard exactly:
//   createdAfter window (server list) → createdBefore cutoff → request-type
//   toggle → Tech PDC predicate (shared module) → status tab.
// The export's documented scope is negative outcomes only, so the expected
// export set is the visible table intersected with NEGATIVE_TICKET_STATUSES.
// ---------------------------------------------------------------------------
type Filters = {
  pdc: TechPdcFilterValue;
  status?: string;
  requestType?: "all" | "nla" | "auth";
  createdAfter?: Date;
  createdBefore?: Date;
};

function expectedExportSet(f: Filters): Set<string> {
  let rows = FIXTURES;
  if (f.createdAfter) rows = rows.filter(r => r.createdAt.getTime() >= f.createdAfter!.getTime());
  if (f.createdBefore) rows = rows.filter(r => r.createdAt.getTime() <= f.createdBefore!.getTime());
  const rt = f.requestType || "all";
  if (rt === "nla") rows = rows.filter(r => r.requestType === "parts_nla");
  else if (rt === "auth") rows = rows.filter(r => r.requestType !== "parts_nla");
  if (f.pdc !== "all") rows = rows.filter(r => matchesTechPdcFilter(r, f.pdc));
  const status = f.status || "all";
  if (status !== "all") rows = rows.filter(r => r.ticketStatus === status);
  // Export scope: negative outcomes only.
  rows = rows.filter(r => NEGATIVE_TICKET_STATUSES.includes(r.ticketStatus));
  return new Set(rows.map(r => r.serviceOrder));
}

// ---------------------------------------------------------------------------
// Export fetch + CSV parsing (Service Order = first column; fixture SOs are
// numeric, so neither the formula guard nor CSV quoting rewrites them).
// ---------------------------------------------------------------------------
async function fetchExportSet(f: Filters): Promise<Set<string>> {
  const params = new URLSearchParams({ format: "csv", pdc: f.pdc });
  if (f.status && f.status !== "all") params.set("status", f.status);
  if (f.requestType && f.requestType !== "all") params.set("requestType", f.requestType);
  if (f.createdAfter) params.set("createdAfter", f.createdAfter.toISOString());
  if (f.createdBefore) params.set("createdBefore", f.createdBefore.toISOString());
  const res = await request(BASE_URL)
    .get(`/api/admin/export-coaching?${params.toString()}`)
    .set("Authorization", `Bearer ${adminToken}`)
    .expect(200);
  const body = res.text ?? res.body.toString("utf-8");
  const lines = body.split(/\r?\n/).slice(1).filter((l: string) => l.trim());
  const set = new Set<string>();
  for (const line of lines) {
    const so = line.split(",")[0];
    // Only fixture rows — the dev DB has unrelated negative tickets.
    if (so.startsWith(SO_PREFIX)) set.add(so);
  }
  return set;
}

async function assertParity(f: Filters) {
  const actual = await fetchExportSet(f);
  const expected = expectedExportSet(f);
  expect(
    Array.from(actual).sort(),
    `export mismatch for filters ${JSON.stringify({ ...f, createdAfter: f.createdAfter?.toISOString(), createdBefore: f.createdBefore?.toISOString() })}`,
  ).toEqual(Array.from(expected).sort());
  return expected.size;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  // Login (try candidate passwords).
  let lastBody: any = null;
  for (const pw of ADMIN_PASSWORDS) {
    const res = await request(BASE_URL)
      .post("/api/auth/login")
      .send({ identifier: ADMIN_ID, password: pw });
    lastBody = res.body;
    if (res.status === 200 && res.body?.token) {
      adminToken = res.body.token;
      break;
    }
  }
  if (!adminToken) {
    throw new Error(`Could not log in as ${ADMIN_ID}. Last body: ${JSON.stringify(lastBody)}`);
  }

  const [tech] = await db.select().from(users).where(eq(users.racId, "testtech1"));
  if (!tech) throw new Error("Seed user testtech1 not found");
  technicianId = tech.id;

  // Sweep any leftovers from a previous run, then insert the matrix.
  await db.delete(submissions).where(like(submissions.serviceOrder, `${SO_PREFIX}%`));
  for (const f of FIXTURES) {
    await db.insert(submissions).values({
      technicianId,
      racId: "testtech1",
      technicianLdapId: "testtech1",
      phone: "5550001111",
      serviceOrder: f.serviceOrder,
      applianceType: "refrigeration",
      requestType: f.requestType,
      issueDescription: "Task #45 parity fixture",
      ticketStatus: f.ticketStatus,
      stage1Status: f.ticketStatus === "queued" ? "pending" : f.ticketStatus,
      techPdcStatus: f.techPdcStatus,
      coachingNotes: f.coachingNotes,
      createdAt: f.createdAt,
      statusChangedAt: f.createdAt,
      updatedAt: f.createdAt,
    } as any);
  }
}, 60000);

afterAll(async () => {
  await db.delete(submissions).where(like(submissions.serviceOrder, `${SO_PREFIX}%`));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Tech PDC filter ↔ export parity", () => {
  it("sanity: fixture matrix covers every PDC state and notes variant", () => {
    // 4 pdc states × 4 notes states × 3 negative statuses + 3 controls
    expect(FIXTURES.length).toBe(4 * 4 * 3 + 3);
  });

  for (const pdc of TECH_PDC_FILTER_VALUES) {
    it(`pdc=${pdc}: export matches the table filter`, async () => {
      const matched = await assertParity({ pdc });
      // Every pdc value must actually select fixture rows (a filter that
      // matches nothing would make the parity assertion vacuous).
      expect(matched).toBeGreaterThan(0);
    });
  }

  it("non-negative controls never appear in any export", async () => {
    const all = await fetchExportSet({ pdc: "all" });
    const controls = FIXTURES.filter(f => !NEGATIVE_TICKET_STATUSES.includes(f.ticketStatus));
    expect(controls.length).toBe(3);
    for (const c of controls) expect(all.has(c.serviceOrder)).toBe(false);
  });

  describe("combined with the status tab", () => {
    for (const pdc of ["not_sent", "missing_notes", "sent"] as const) {
      for (const status of ["rejected", "rejected_closed", "invalid"]) {
        it(`pdc=${pdc} + status=${status}`, async () => {
          await assertParity({ pdc, status });
        });
      }
    }
    it("explicit non-negative status tab exports zero rows for every pdc value", async () => {
      for (const pdc of TECH_PDC_FILTER_VALUES) {
        const actual = await fetchExportSet({ pdc, status: "completed" });
        expect(actual.size, `pdc=${pdc} status=completed`).toBe(0);
      }
    });
  });

  describe("combined with the request-type toggle", () => {
    for (const pdc of ["not_sent", "missing_notes", "failed", "pending"] as const) {
      for (const rt of ["nla", "auth"] as const) {
        it(`pdc=${pdc} + requestType=${rt}`, async () => {
          const matched = await assertParity({ pdc, requestType: rt });
          expect(matched).toBeGreaterThan(0);
        });
      }
    }
  });

  describe("combined with the date range", () => {
    const mid = new Date(NOW - 10 * 24 * 60 * 60 * 1000); // between OLD and RECENT
    for (const pdc of ["not_sent", "missing_notes", "sent", "failed"] as const) {
      it(`pdc=${pdc} + createdAfter (recent window only)`, async () => {
        await assertParity({ pdc, createdAfter: mid });
      });
      it(`pdc=${pdc} + createdAfter+createdBefore (old window only)`, async () => {
        await assertParity({
          pdc,
          createdAfter: new Date(NOW - 60 * 24 * 60 * 60 * 1000),
          createdBefore: mid,
        });
      });
    }
  });

  it("kitchen sink: pdc + status + requestType + date range together", async () => {
    await assertParity({
      pdc: "missing_notes",
      status: "rejected",
      requestType: "auth",
      createdAfter: new Date(NOW - 60 * 24 * 60 * 60 * 1000),
      createdBefore: new Date(NOW),
    });
  });
});
