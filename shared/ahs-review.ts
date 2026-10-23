// Stage 1 AHS review: the contract between the server
// (server/routes.ts, server/vrs-app-enroll.ts) and the VRS manager's editor
// in the agent dashboard.
//
// Flow for a technician-filed AHS authorization ticket:
//   1. The tech submits the normal form (no AHS section).
//   2. The server looks the service order up (Snowflake, HSSOM) and stores a
//      draft in submissions.ahs_details (AhsDetailsDraft, shared/ahs-details.ts),
//      with prefilledFields naming what the lookups filled. No VRS AI bridge
//      row is created yet.
//   3. The VRS manager opens the ticket, completes or corrects the draft and
//      saves it through PATCH /api/submissions/:id/ahs-details. The server
//      validates it against the full ahsDetailsSchema, stores it, and creates
//      (or replaces, if not yet dispatched) the VRS AI bridge row.
//   4. The existing "Approve & Send to VRS AI" Stage 1 action dispatches it.
import type { AhsDetails, AhsDetailsDraft } from "./ahs-details";

// PATCH /api/submissions/:id/ahs-details
// Roles: vrs_agent (assigned to the ticket), admin, super_admin.
// Allowed only for authorization tickets whose warranty is
// american_home_shield, before Stage 1 is decided and before dispatch.
export interface AhsReviewSaveRequest {
  ahsDetails: AhsDetails;
}

export type AhsReviewSaveResponse =
  | {
      ok: true;
      // The stored details (complete), with prefilledFields kept only for
      // fields whose value the manager left unchanged.
      ahsDetails: AhsDetails;
      // Whether a VRS AI bridge row now exists for the ticket (so the
      // "Approve & Send to VRS AI" action is available).
      enrolled: boolean;
      // Why enrollment did not happen, when enrolled is false.
      enrollSkipReason?: string;
    }
  | {
      ok: false;
      error: string;
      // zod issues for field-level messages in the editor.
      issues?: { path: (string | number)[]; message: string }[];
    };

// POST /api/submissions/:id/ahs-details/refresh
// Same roles and conditions. Re-runs the service-order lookups and fills only
// blank fields of the stored draft; returns the new draft.
export type AhsReviewRefreshResponse =
  | { ok: true; ahsDetails: AhsDetailsDraft; snowflake: string; hssom: string }
  | { ok: false; error: string };
