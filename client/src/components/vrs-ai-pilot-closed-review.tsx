import React from "react";
import { Ban, CheckCircle2, Lock, ShieldX, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { VrsAiBridgePanel } from "@/components/vrs-ai-bridge-review";
import type { VrsAiBridgeStatus } from "@/lib/vrsAiBridge";
import {
  isVrsAiPilotClosedStatus,
  type VrsAiPilotClosedStatus,
} from "@shared/vrs-ai-pilot";

export interface VrsAiPilotClosedSubmission {
  ticketStatus: string;
  submissionApproved?: boolean | null;
  replacementReviewRecommended?: boolean | null;
  b2bApprovedReplacement?: boolean | null;
  agentNotes?: string | null;
  rejectionReasons?: string | string[] | null;
  stage1RejectionReason?: string | null;
  invalidReason?: string | null;
  declineReason?: string | null;
  reviewedAt?: string | Date | null;
}

function outcomeLabel(
  status: VrsAiPilotClosedStatus,
  submission: VrsAiPilotClosedSubmission,
): string {
  if (status === "completed") {
    if (submission.b2bApprovedReplacement) return "B2B Approved Replacement";
    if (submission.replacementReviewRecommended) return "Replacement Review";
    return "Approved to Repair";
  }
  if (status === "rejected_closed") return "Reject & Close";
  if (status === "invalid") return "Invalid";
  return submission.submissionApproved ? "Declined Repair" : "Reject";
}

function outcomeDescription(
  status: VrsAiPilotClosedStatus,
  submission: VrsAiPilotClosedSubmission,
): string {
  if (status === "completed") {
    if (submission.b2bApprovedReplacement) {
      return "B2B approved replacement was recorded and the ticket is closed.";
    }
    if (submission.replacementReviewRecommended) {
      return "Replacement Review was recorded and the ticket is closed.";
    }
    return "The submission was approved and the ticket is closed.";
  }
  if (status === "rejected_closed") {
    return "The ticket was rejected and permanently closed.";
  }
  if (status === "invalid") {
    return "The request was marked invalid and the ticket is closed.";
  }
  return submission.submissionApproved
    ? "The repair was declined and the ticket is closed."
    : "The submission was rejected.";
}

function rejectionDetail(submission: VrsAiPilotClosedSubmission): string | null {
  if (submission.invalidReason) return submission.invalidReason;
  if (submission.declineReason) return submission.declineReason;
  if (submission.stage1RejectionReason) return submission.stage1RejectionReason;
  if (Array.isArray(submission.rejectionReasons)) {
    return submission.rejectionReasons.length > 0
      ? submission.rejectionReasons.join(", ")
      : null;
  }
  if (submission.rejectionReasons) {
    try {
      const parsed = JSON.parse(submission.rejectionReasons);
      if (Array.isArray(parsed)) {
        const reasons = parsed.filter(
          (reason): reason is string => typeof reason === "string",
        );
        return reasons.length > 0 ? reasons.join(", ") : null;
      }
      if (typeof parsed === "string") return parsed;
    } catch {
      // Legacy rows also contain plain-text reasons.
    }
    return submission.rejectionReasons;
  }
  return null;
}

function OutcomeIcon({ status }: { status: VrsAiPilotClosedStatus }) {
  if (status === "completed") {
    return <CheckCircle2 className="h-4 w-4 text-green-600" />;
  }
  if (status === "invalid") {
    return <Ban className="h-4 w-4 text-muted-foreground" />;
  }
  return <ShieldX className="h-4 w-4 text-destructive" />;
}

/**
 * Read-only outcome surface for closed VRS AI Pilot rows.
 *
 * This deliberately owns no mutations.  The existing SubmissionNotesThread
 * below the detail cards is the only follow-up editor; approval/rejection
 * controls here are retained as disabled historical affordances so agents can
 * see the same decision vocabulary used by the pending workflow.
 */
export function VrsAiPilotClosedReview({
  submission,
  bridge,
}: {
  submission: VrsAiPilotClosedSubmission;
  bridge: VrsAiBridgeStatus | null | undefined;
}) {
  if (!isVrsAiPilotClosedStatus(submission.ticketStatus)) return null;

  const status = submission.ticketStatus;
  const outcome = outcomeLabel(status, submission);
  const detail = rejectionDetail(submission);
  const approvalLabel =
    status === "completed" && submission.b2bApprovedReplacement
      ? "B2B Approved Replacement"
      : status === "completed" && submission.replacementReviewRecommended
      ? "Replacement Review"
      : "Approved to Repair";
  const rejectionLabel =
    status === "rejected" && submission.submissionApproved
      ? "Declined Repair"
      : "Reject";

  const actions = [
    {
      key: "approve",
      label: approvalLabel,
      icon: <CheckCircle2 className="h-6 w-6 text-green-600" />,
      active: status === "completed",
      className: "border-green-200 dark:border-green-900",
    },
    {
      key: "reject",
      label: rejectionLabel,
      icon: <XCircle className="h-6 w-6 text-red-600" />,
      active: status === "rejected",
      className: "border-red-200 dark:border-red-900",
    },
    {
      key: "reject-and-close",
      label: "Reject & Close",
      icon: <XCircle className="h-6 w-6 text-orange-600" />,
      active: status === "rejected_closed",
      className: "border-orange-200 dark:border-orange-900",
    },
    {
      key: "invalid",
      label: "Invalid",
      icon: <Ban className="h-6 w-6 text-gray-600" />,
      active: status === "invalid",
      className: "border-gray-200 dark:border-gray-800",
    },
  ];

  return (
    <Card
      className="border-blue-200 bg-blue-50/30 dark:border-blue-900 dark:bg-blue-950/10"
      data-testid="card-vrs-ai-pilot-closed-review"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4" />
          Closed VRS AI Pilot review
        </CardTitle>
        <p
          className="text-xs text-muted-foreground"
          data-testid="text-vrs-ai-pilot-closed-note"
        >
          This ticket is closed. Its outcome and Bridge payload are read only;
          approval, rejection, reprocessing, claiming, reopening, and dispatch
          notifications are unavailable. Add any follow-up in Notes below.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          className="rounded-md border border-blue-200 bg-background/70 p-3 dark:border-blue-900"
          data-testid="panel-vrs-ai-pilot-outcome"
        >
          <div className="flex items-center gap-2">
            <OutcomeIcon status={status} />
            <span className="font-medium" data-testid="text-vrs-ai-pilot-outcome">
              {outcome}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {outcomeDescription(status, submission)}
          </p>
          {detail && (
            <p
              className="mt-2 text-sm whitespace-pre-wrap"
              data-testid="text-vrs-ai-pilot-outcome-detail"
            >
              {detail}
            </p>
          )}
          {submission.agentNotes && (
            <div
              className="mt-3 rounded-md bg-muted/60 p-3"
              data-testid="text-vrs-ai-pilot-agent-notes"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Saved AI agent notes
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {submission.agentNotes}
              </p>
            </div>
          )}
        </div>

        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          data-testid="vrs-ai-pilot-closed-actions"
        >
          {actions.map((action) => (
            <Button
              key={action.key}
              type="button"
              variant="outline"
              disabled
              className={`h-auto min-h-20 flex-col gap-1 py-3 ${action.className} ${
                action.active ? "ring-2 ring-blue-400 dark:ring-blue-600" : ""
              }`}
              data-testid={`vrs-ai-pilot-closed-action-${action.key}`}
              aria-label={`${action.label} (closed)`}
            >
              {action.icon}
              <span className="text-xs">{action.label}</span>
              {action.active && (
                <span className="text-[10px] text-muted-foreground">
                  Recorded
                </span>
              )}
            </Button>
          ))}
        </div>

        <VrsAiBridgePanel bridge={bridge} />
      </CardContent>
    </Card>
  );
}