/**
 * Seed 9 test submissions for end-to-end VRS Agent flow verification.
 *
 * Run manually:  tsx scripts/seed-test-tickets.ts
 *
 * Idempotent: skips any submission whose service_order already exists.
 * All submissions are tagged with [TEST] in issue_description so they can be
 * easily identified and removed (see cleanup SQL in COMMITS.md).
 *
 * Tickets:
 * Branch coverage (Tyler 2026-04-29 — diversified so all 4 intake-form branches
 * are exercised by the test seed):
 *   - SPHW: SO 99999000001, SO 99999000003 (proc_id SPRCLL)
 *   - AHS:  SO 99999000002 (proc_id AHS000)
 *   - SHW:  SO 99999000004 (proc_id THM302 — warrantyType still sears_protect; see ticket comment)
 *   - SRW:  SO 99999000005 (proc_id SRW000 — warrantyType still sears_protect; see ticket comment)
 *
 *   1. SO 99999000001 — Sears Protect authorization, queued (claimable from queue).
 *      Walk Stage 1 -> Stage 2 -> Stage 3 (intake auto-opens after authorize+send).
 *   2. SO 99999000002 — AHS authorization, queued (claimable from queue).
 *      Verifies dual-code (AHS + RGC) path; intake auto-opens after authorize+send.
 *   3. SO 99999000003 — already-approved Sears Protect (auth_code populated,
 *      no intake_forms row). Lands directly on Stage 3 to verify auto-open
 *      and the "Re-open intake form" fallback button.
 *   4. SO 99999000004 — pending NLA (parts_nla queued, refrigeration, Sears
 *      Protect). Exercises the Task A NLA SMS copy (same-day turnaround +
 *      suppressed claim SMS).
 *   5. SO 99999000005 — rejected/resubmittable (Stage-1 rejected with a
 *      sample rejection reason). Drives the tech-resubmit flow + intake
 *      reopen on a previously-rejected ticket.
 *
 * 2026-04-29 batch B (Tyler ask: "seed 4 more test tickets") — fills coverage
 * gaps left by the original 5:
 *   6. SO 99999000006 — Sears Protect Authorization, HVAC, queued, AGED
 *      (created_at backdated to yesterday 09:00 ET so it crosses the
 *      ≥4h business-hours urgency threshold and renders the new red row
 *      highlight + amber pill aging colors). Use this to sanity-check
 *      that the business-hours timer pauses overnight — wall clock should
 *      be ~26 h, business clock should be ~14 h.
 *   7. SO 99999000007 — Sears Protect Authorization, cooking, queued, fresh
 *      (0m elapsed). Plain happy-path queue ticket for re-runs after
 *      claiming/clearing the others.
 *   8. SO 99999000008 — AHS Authorization, dishwasher, queued, fresh.
 *      Second AHS-branch ticket so the AHS+RGC dual-code path can be
 *      exercised twice in a single session without resetting.
 *   9. SO 99999000009 — Sears Protect Authorization, laundry, COMPLETED
 *      (auth_code populated, claimed_at + assigned_to=86 set, status
 *      changed to completed yesterday). Ensures the Completed-status
 *      filter on admin/agent dashboards has a row and exercises the
 *      handle-time + total-time timer columns end-to-end.
 *
 * All tickets 6-9 are pre-assigned to agent 86 (ZZTEST9) so they appear
 * directly under "My Tickets" without needing a queue-claim step (matches
 * the existing pre-assignment pattern documented in COMMITS.md ~line 1395).
 */

import bcryptjs from "bcryptjs";
import { eq, sql } from "drizzle-orm";
import { db } from "../server/storage";
import { users, technicians, submissions } from "../shared/schema";

const TECH_LDAP = "test_tech_1";
const TECH_NAME = "TEST_TECH_1";
const TECH_PHONE = "555-0100";
const TECH_RAC = "TEST_TECH_1";
// 2026-04-28 (Tyler request): use a real VRS Tech ID format (7-digit
// zero-padded numeric) so the intake-form IH Unit Number lookup
// resolves to a believable value during end-to-end testing. Reserved
// 9999xxx range is safely above the real-tech max (~0999706), so no
// collision with production data is possible.
const TECH_UN_NO = "9999001";
const DISTRICT = "8175";

const SO_1 = "99999000001";
const SO_2 = "99999000002";
const SO_3 = "99999000003";
const SO_4 = "99999000004";
const SO_5 = "99999000005";

async function ensureTechnicianUser() {
  const existing = await db.select().from(users).where(eq(users.racId, TECH_RAC)).limit(1);
  if (existing.length) {
    console.log(`[skip] users row for ${TECH_RAC} exists (id=${existing[0].id})`);
    return existing[0];
  }
  const placeholderHash = await bcryptjs.hash("disabled-test-account-no-login", 10);
  const [created] = await db
    .insert(users)
    .values({
      name: TECH_NAME,
      role: "technician",
      racId: TECH_RAC,
      phone: TECH_PHONE,
      password: placeholderHash,
      isActive: true,
      firstLogin: false,
      mustChangePassword: false,
      isSystemAccount: false,
    })
    .returning();
  console.log(`[create] users row for ${TECH_RAC} (id=${created.id})`);
  return created;
}

async function ensureTechnicianRow() {
  const existing = await db
    .select()
    .from(technicians)
    .where(eq(technicians.ldapId, TECH_LDAP))
    .limit(1);
  if (existing.length) {
    // Conform tech_un_no on existing row in case the seed constant changed
    // since the row was first created (e.g. switching from T_TEST_001 to a
    // real-format VRS Tech ID). Idempotent — no-op when already correct.
    if (existing[0].techUnNo !== TECH_UN_NO) {
      const [updated] = await db
        .update(technicians)
        .set({ techUnNo: TECH_UN_NO })
        .where(eq(technicians.ldapId, TECH_LDAP))
        .returning();
      console.log(`[update] technicians row for ${TECH_LDAP} (id=${updated.id}): tech_un_no ${existing[0].techUnNo} -> ${TECH_UN_NO}`);
      return updated;
    }
    console.log(`[skip] technicians row for ${TECH_LDAP} exists (id=${existing[0].id}, tech_un_no=${existing[0].techUnNo})`);
    return existing[0];
  }
  const [created] = await db
    .insert(technicians)
    .values({
      ldapId: TECH_LDAP,
      name: TECH_NAME,
      phone: TECH_PHONE,
      district: DISTRICT,
      techUnNo: TECH_UN_NO,
      isActive: true,
    })
    .returning();
  console.log(`[create] technicians row for ${TECH_LDAP} (id=${created.id}, tech_un_no=${TECH_UN_NO})`);
  return created;
}

interface TicketSpec {
  so: string;
  warrantyType: "sears_protect" | "american_home_shield";
  requestType?: "authorization" | "parts_nla";
  ticketStatus: "queued" | "approved" | "rejected" | "completed";
  stage1Status?: "pending" | "approved" | "rejected" | "invalid";
  stage1RejectionReason?: string;
  procId: string;
  clientNm: string;
  authCode: string | null;
  estimateAmount: string;
  scenario: string;
  // Optional 2026-04-29 batch B additions:
  applianceType?:
    | "cooking"
    | "dishwasher"
    | "microwave"
    | "laundry"
    | "refrigeration"
    | "hvac"
    | "all_other";
  // Pre-assign to an agent. Existing tickets 1-5 are post-assigned via the
  // hand-written UPDATE in COMMITS.md ~line 1395; tickets 6-9 set this at
  // insert time so a single seed-script run lands them on "My Tickets" for
  // ZZTEST9 (id=86) without a follow-up SQL step.
  assignedTo?: number;
  claimedMinutesAgo?: number;
  // Backdate created_at by N hours from now (used by the AGED ticket so it
  // crosses the business-hours urgency threshold).
  createdHoursAgo?: number;
  // For completed tickets: how long ago was the status changed (drives the
  // Total Time column in the dashboards).
  statusChangedHoursAgo?: number;
  // Free-form description override; defaults to the original refrigerator
  // copy so existing tickets are byte-identical.
  issueDescriptionOverride?: string;
}

async function ensureSubmission(spec: TicketSpec, technicianUserId: number) {
  const existing = await db
    .select()
    .from(submissions)
    .where(eq(submissions.serviceOrder, spec.so))
    .limit(1);
  if (existing.length) {
    console.log(`[skip] submission SO ${spec.so} exists (id=${existing[0].id}, status=${existing[0].ticketStatus})`);
    return existing[0];
  }

  const isApprovedLike = spec.ticketStatus === "approved" || spec.ticketStatus === "completed";
  const isCompleted = spec.ticketStatus === "completed";
  const appliance = spec.applianceType ?? "refrigeration";
  // Tailor the placeholder issue copy to the appliance type so the test
  // tickets read believably in the admin queue. Falls back to the original
  // refrigerator copy when no override + appliance unset.
  const defaultCopyByAppliance: Record<string, string> = {
    refrigeration: "Refrigerator not cooling, compressor running but no cold air.",
    hvac: "AC unit not turning on, thermostat shows error code E5; condenser fan inoperative.",
    cooking: "Range top burner clicks but won't ignite; oven heats but cycles off intermittently.",
    dishwasher: "Dishwasher won't drain; standing water after every cycle, drain pump suspect.",
    laundry: "Washer drum not spinning during agitation; bearings noisy on spin cycle.",
    microwave: "Microwave runs but doesn't heat; magnetron likely failed.",
    all_other: "Customer reports intermittent appliance failure; full diagnostic required.",
  };
  const copy = spec.issueDescriptionOverride ?? defaultCopyByAppliance[appliance] ?? defaultCopyByAppliance.refrigeration;
  const issueDescription = `[TEST] ${spec.scenario} — ${copy} SO ${spec.so}.`;

  // Compute optional backdated timestamps. Drizzle accepts JS Date directly
  // for timestamp columns. Using ms math (not SQL intervals) so the offsets
  // are computed against the script's clock, not the DB clock — same
  // semantics either way for our purposes.
  const now = Date.now();
  const createdAt = spec.createdHoursAgo
    ? new Date(now - spec.createdHoursAgo * 3600 * 1000)
    : undefined;
  const claimedAt = spec.claimedMinutesAgo
    ? new Date(now - spec.claimedMinutesAgo * 60 * 1000)
    : undefined;
  const statusChangedAt = spec.statusChangedHoursAgo
    ? new Date(now - spec.statusChangedHoursAgo * 3600 * 1000)
    : undefined;

  const [created] = await db
    .insert(submissions)
    .values({
      technicianId: technicianUserId,
      racId: TECH_RAC,
      phone: TECH_PHONE,
      serviceOrder: spec.so,
      districtCode: DISTRICT,
      applianceType: appliance,
      requestType: spec.requestType ?? "authorization",
      warrantyType: spec.warrantyType,
      issueDescription,
      estimateAmount: spec.estimateAmount,
      technicianLdapId: TECH_LDAP,
      procId: spec.procId,
      clientNm: spec.clientNm,
      ticketStatus: spec.ticketStatus,
      stage1Status: spec.stage1Status ?? (isApprovedLike ? "approved" : "pending"),
      stage2Status: isApprovedLike ? "approved" : "pending",
      stage1RejectionReason: spec.stage1RejectionReason ?? null,
      submissionApproved: isApprovedLike,
      submissionApprovedAt: isApprovedLike ? sql`now()` : null,
      authCode: spec.authCode,
      aiEnhanced: false,
      ...(spec.assignedTo !== undefined && { assignedTo: spec.assignedTo }),
      ...(claimedAt && { claimedAt }),
      ...(createdAt && { createdAt }),
      ...(statusChangedAt && { statusChangedAt }),
      // Completed tickets get a reviewedAt + reviewedBy so the admin's
      // completed filter populates the "Reviewed by" column.
      ...(isCompleted && {
        reviewedAt: statusChangedAt ?? new Date(now - 3600 * 1000),
        reviewedBy: spec.assignedTo ?? null,
      }),
    })
    .returning();
  console.log(`[create] submission SO ${spec.so} (id=${created.id}, ${spec.warrantyType}/${spec.ticketStatus}, appliance=${appliance})`);
  return created;
}

async function main() {
  console.log("=== Seeding VRS test tickets ===");

  const techUser = await ensureTechnicianUser();
  await ensureTechnicianRow();

  await ensureSubmission(
    {
      so: SO_1,
      warrantyType: "sears_protect",
      ticketStatus: "queued",
      procId: "SPRCLL",
      clientNm: "Sears Protect",
      authCode: null,
      estimateAmount: "475.00",
      scenario: "Sears Protect Authorization (Stage 1 -> 2 -> 3 full flow)",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: SO_2,
      warrantyType: "american_home_shield",
      ticketStatus: "queued",
      // Tyler 2026-04-29 — was "AHSCLL", which is a real Snowflake-emitted proc_id
      // BUT is not in PROC_ID_LABEL (server/services/smartsheet.ts:39-65), so the
      // intake form's "Proc ID/Third Part ID" combobox stayed blank for this
      // ticket. Swapped to "AHS000" — first AHS variant in the recognized map —
      // so the dropdown now populates as "AHS000-American Home Shield" and the
      // AHS-branch downstream renders end-to-end.
      procId: "AHS000",
      clientNm: "American Home Shield",
      authCode: null,
      estimateAmount: "525.00",
      scenario: "AHS Authorization (AHS branch UI, dual-code AHS+RGC on approval)",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: SO_3,
      warrantyType: "sears_protect",
      ticketStatus: "approved",
      procId: "SPRCLL",
      clientNm: "Sears Protect",
      authCode: "TEST-AUTH-001",
      estimateAmount: "612.50",
      scenario: "Pre-approved Sears Protect (Stage 3 landing, no intake_forms row)",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: SO_4,
      warrantyType: "sears_protect",
      requestType: "parts_nla",
      ticketStatus: "queued",
      // Tyler 2026-04-29 — was "SPRCLL" (SPHW branch). Swapped to "THM302" so
      // the intake form's branch detector (detectBranch in smartsheet.ts:67-76)
      // routes to SHW. warrantyType deliberately left at "sears_protect" — the
      // codebase does not yet model "sears_home_warranty" as a warrantyType
      // value, and changing it would render raw strings in admin tables and
      // misfire the cash-call SMS branch logic. detectBranch is keyed off
      // proc_id ALONE so the SHW intake-form UI still renders correctly; the
      // SMS/admin labels will say "Sears Protect" for this test ticket. See
      // COMMITS.md "Known limitations" for the rationale.
      procId: "THM302",
      clientNm: "Sears Home Warranty",
      authCode: null,
      estimateAmount: "0.00",
      scenario: "Pending NLA + SHW intake-form branch (THM302 → Sears Home Warranty)",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: SO_5,
      warrantyType: "sears_protect",
      ticketStatus: "rejected",
      stage1Status: "rejected",
      stage1RejectionReason: "Photos missing — please retake compressor closeup and model plate.",
      // Tyler 2026-04-29 — was "SPRCLL" (SPHW branch). Swapped to "SRW000" so
      // the intake form's branch detector routes to SRW (Kenmore-IW). Same
      // warrantyType caveat as SO_4 above: "kenmore" is not a modeled
      // warrantyType value, so we leave it at "sears_protect" and accept the
      // SMS/admin label mismatch as a known limitation in exchange for SRW
      // branch UI coverage. See COMMITS.md for full rationale.
      procId: "SRW000",
      clientNm: "Kenmore-IW",
      authCode: null,
      estimateAmount: "475.00",
      scenario: "Rejected/resubmittable + SRW intake-form branch (SRW000 → Kenmore-IW)",
    },
    techUser.id,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // 2026-04-29 batch B (Tyler ask: "seed 4 more test tickets") — coverage
  // gaps: aged ticket for the new business-hours timer, second AHS ticket,
  // a fresh laundry/cooking pair, a completed ticket for the Completed
  // filter. All pre-assigned to ZZTEST9 (id=86).
  // ─────────────────────────────────────────────────────────────────────────

  const TEST_AGENT_ID = 86; // ZZTEST9 — confirmed via DB lookup 2026-04-29.

  await ensureSubmission(
    {
      so: "99999000006",
      warrantyType: "sears_protect",
      ticketStatus: "queued",
      procId: "SPRCLL",
      clientNm: "Sears Protect",
      authCode: null,
      estimateAmount: "850.00",
      applianceType: "hvac",
      assignedTo: TEST_AGENT_ID,
      // Backdate ~26h so wall-clock elapsed ≫ business-hours elapsed. This
      // ticket is what proves the new business-hours timer pauses overnight:
      // wall = ~26h, business should cap at the day's open window minus
      // overnight gap. Triggers ≥4h red urgency highlight on admin dashboard.
      createdHoursAgo: 26,
      scenario: "AGED HVAC auth — sanity-check business-hours timer + red row urgency",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: "99999000007",
      warrantyType: "sears_protect",
      ticketStatus: "queued",
      procId: "SPRCLL",
      clientNm: "Sears Protect",
      authCode: null,
      estimateAmount: "395.00",
      applianceType: "cooking",
      assignedTo: TEST_AGENT_ID,
      scenario: "Fresh cooking auth — plain happy-path queue ticket",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: "99999000008",
      warrantyType: "american_home_shield",
      ticketStatus: "queued",
      // Same proc_id rationale as SO 99999000002 — AHS000 routes the
      // intake-form branch detector to the AHS UI. See COMMITS.md.
      procId: "AHS000",
      clientNm: "American Home Shield",
      authCode: null,
      estimateAmount: "612.00",
      applianceType: "dishwasher",
      assignedTo: TEST_AGENT_ID,
      scenario: "Second AHS auth (dishwasher) — repeat AHS+RGC dual-code path without resetting SO 99999000002",
    },
    techUser.id,
  );

  await ensureSubmission(
    {
      so: "99999000009",
      warrantyType: "sears_protect",
      ticketStatus: "completed",
      procId: "SPRCLL",
      clientNm: "Sears Protect",
      authCode: "TEST-AUTH-009",
      estimateAmount: "525.00",
      applianceType: "laundry",
      assignedTo: TEST_AGENT_ID,
      // Claimed ~5 h ago (wall), completed ~2 h ago (wall). Total Time +
      // Handle Time columns will round through the new business-hours
      // formatter so they read consistently with the on-screen badge.
      claimedMinutesAgo: 300,
      statusChangedHoursAgo: 2,
      createdHoursAgo: 5,
      scenario: "Completed laundry SP auth — exercises Completed filter + handle-time/total-time columns",
    },
    techUser.id,
  );

  console.log("=== Done ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  });
