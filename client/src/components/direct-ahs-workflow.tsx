import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Send } from "lucide-react";
import { apiRequest, friendlyApiErrorMessage } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type DirectAhsStatus = {
  eligible: boolean;
  reason: string | null;
  enabled: boolean;
  workflow: null | {
    id: string;
    state: "dispatching" | "awaiting_result" | "dispatch_unknown" | "awaiting_sms" | "failed" | "completed";
    error: string | null;
    decision: null | { state: "approved" | "denied"; code: string; notes: string };
    sms: null | { status: "pending" | "sent" | "delivered" | "failed"; providerMessageId?: string; reason?: string };
    womNotes: Record<string, unknown> | null;
  };
};

export type DirectAhsWorkflowState = {
  submissionId: number;
  ownsTicket: boolean;
  checking: boolean;
};

const stateLabels: Record<NonNullable<DirectAhsStatus["workflow"]>["state"], string> = {
  dispatching: "Sending to VRS AI",
  awaiting_result: "Awaiting AI decision",
  dispatch_unknown: "Dispatch unconfirmed",
  awaiting_sms: "Awaiting technician SMS",
  failed: "Workflow needs attention",
  completed: "Completed",
};

export function DirectAhsWorkflow({
  submissionId, onWorkflowState,
}: {
  submissionId: number;
  onWorkflowState: (state: DirectAhsWorkflowState) => void;
}) {
  const client = useQueryClient();
  const endpoint = `/api/submissions/${submissionId}/direct-ahs`;
  const queryKey = ["/api/submissions", submissionId, "direct-ahs"];
  const [reviewNotes, setReviewNotes] = useState("");
  const [confirmation, setConfirmation] = useState<"dispatch" | "retry" | null>(null);
  const [dispatchAttempted, setDispatchAttempted] = useState(false);
  const callbackRef = useRef(onWorkflowState);
  callbackRef.current = onWorkflowState;
  const status = useQuery<DirectAhsStatus>({
    queryKey,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) => {
      const workflow = query.state.data?.workflow;
      return workflow && workflow.state !== "completed" ? 10_000 : false;
    },
  });
  const workflow = status.data?.workflow;
  const checking = status.isPending || status.isError;
  const ownsTicket = !!workflow || dispatchAttempted;

  const refreshTicket = () => {
    void client.invalidateQueries({
      predicate: (query) => {
        const first = query.queryKey[0];
        return typeof first === "string" && (
          first.startsWith("/api/agent/stats") ||
          (first === "/api/submissions" && (query.queryKey.length === 1 ||
            (query.queryKey[1] === submissionId && query.queryKey.length === 2))) ||
          first.startsWith("/api/submissions?")
        );
      },
    });
  };
  const resultSignature = workflow ? JSON.stringify(workflow) : null;
  const lastResultRef = useRef<string | null>(null);
  useEffect(() => {
    if (resultSignature && resultSignature !== lastResultRef.current) {
      lastResultRef.current = resultSignature;
      refreshTicket();
    }
  }, [resultSignature]);
  useEffect(() => {
    callbackRef.current({ submissionId, ownsTicket, checking });
  }, [submissionId, ownsTicket, checking]);

  const dispatch = useMutation({
    mutationFn: async (kind: "dispatch" | "retry") => {
      if (status.isError || status.isPending || !status.data) throw new Error("Workflow status unavailable. Refresh status before continuing.");
      if (kind === "retry") {
        if (workflow?.state !== "dispatch_unknown" || !status.data.enabled) throw new Error("This request cannot be retried.");
      } else if (workflow || dispatchAttempted || !status.data.eligible || !status.data.enabled || !reviewNotes.trim() || reviewNotes.length > 4000) {
        throw new Error("This ticket is not ready to send to VRS AI.");
      }
      setDispatchAttempted(true);
      // Never automatically retry an authorization POST after a connection failure.
      await apiRequest("POST", kind === "retry" ? `${endpoint}/retry` : endpoint,
        kind === "retry" ? undefined : { reviewNotes: reviewNotes.trim() });
    },
    onSuccess: () => {
      setConfirmation(null);
      refreshTicket();
      void status.refetch();
    },
    onError: () => {
      setConfirmation(null);
      // A lost response may still mean the request was accepted. Reconcile first.
      void status.refetch().then((result) => {
        if (result.isSuccess && !result.data?.workflow) setDispatchAttempted(false);
      });
    },
  });
  const canDispatch = !!status.data?.eligible && !!status.data?.enabled && !checking && !ownsTicket && !dispatch.isPending && !!reviewNotes.trim() && reviewNotes.length <= 4000;
  const smsNeedsAttention = workflow?.state !== "completed" && (
    workflow?.state === "awaiting_sms" || workflow?.sms?.status === "pending" || workflow?.sms?.status === "failed"
  );

  return (
    <Card data-testid="direct-ahs-workflow">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><Send className="w-4 h-4" />Direct AHS → VRS AI</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isPending ? (
          <div aria-label="Loading direct AHS workflow" className="space-y-2"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-12 w-full" /></div>
        ) : null}
        {status.isError ? (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
            <p className="text-sm font-medium">Direct AHS status unavailable</p>
            <p className="text-xs text-muted-foreground">Refresh status before processing or sending this ticket. A request may already exist.</p>
            <Button variant="outline" size="sm" disabled={status.isFetching || dispatch.isPending} onClick={() => void status.refetch()}>Refresh status</Button>
          </div>
        ) : null}
        {status.data && !status.data.enabled ? (
          <p className="text-sm text-muted-foreground">{status.data.reason || "AI-side integration pending. Sending to VRS AI is not enabled yet."}</p>
        ) : null}
        {workflow ? (
          <div className="space-y-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              {workflow.state === "completed" ? <CheckCircle2 className="w-4 h-4 text-primary" /> : <Clock className="w-4 h-4 text-muted-foreground" />}
              <Badge variant="outline">{stateLabels[workflow.state]}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">This workflow owns the ticket. Normal processing is locked; ticket details and media remain available.</p>
            {workflow.error ? <p role="alert" className="text-sm text-destructive">{workflow.error}</p> : null}
            {workflow.state === "dispatch_unknown" ? (
              <div className="rounded-md border p-3 space-y-3">
                <p className="text-sm">AI receipt is unconfirmed. Do not start another authorization.</p>
                <Button variant="outline" disabled={checking || !status.data?.enabled || dispatch.isPending} onClick={() => setConfirmation("retry")}>Retry same AI request</Button>
              </div>
            ) : null}
            {workflow.state === "failed" && !smsNeedsAttention ? (
              <p className="text-sm">The ticket remains open and locked to this workflow. Contact support to reconcile the existing AI request; do not create another authorization.</p>
            ) : null}
            {smsNeedsAttention ? (
              <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
                <p className="text-sm font-medium flex gap-2 items-center"><AlertTriangle className="w-4 h-4 shrink-0" />Ticket remains open</p>
                <p className="mt-1 text-sm">VRS AI owns technician SMS delivery and should retry SMS only, not the authorization.</p>
                {workflow.sms?.reason ? <p className="mt-1 text-xs text-muted-foreground">{workflow.sms.reason}</p> : null}
              </div>
            ) : null}
            {workflow.sms ? <p className="text-xs text-muted-foreground">Technician SMS: {workflow.sms.status}</p> : null}
            {workflow.decision ? (
              <dl className="rounded-md border p-3 space-y-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">AI decision</dt><dd className="font-medium">{workflow.decision.state === "approved" ? "Approved" : "Denied"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">{workflow.decision.state === "approved" ? "Approval code" : "Denial code"}</dt><dd className="font-mono break-all">{workflow.decision.code || "Not provided"}</dd></div>
                <div><dt className="text-xs text-muted-foreground">Decision notes</dt><dd className="whitespace-pre-wrap break-words">{workflow.decision.notes || "No notes provided."}</dd></div>
              </dl>
            ) : null}
            {workflow.womNotes ? (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">WOM-ready notes</h4>
                <p className="text-xs text-muted-foreground">Prepared for reference only. These notes have not been written to WOM.</p>
                <pre className="rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto">{JSON.stringify(workflow.womNotes, null, 2)}</pre>
              </div>
            ) : null}
          </div>
        ) : status.data && !status.isError ? (
          <>
            {status.data.eligible ? (
              <>
                <p className="text-sm text-muted-foreground">Approve the submission for AI review. VRS AI returns the authorization decision and sends the technician SMS.</p>
                <div className="space-y-2">
                  <Label htmlFor={`direct-ahs-notes-${submissionId}`}>Review notes <span className="text-muted-foreground">(required)</span></Label>
                  <Textarea id={`direct-ahs-notes-${submissionId}`} value={reviewNotes} maxLength={4000} disabled={dispatch.isPending || dispatchAttempted} onChange={(event) => setReviewNotes(event.target.value)} placeholder="Summarize your review for VRS AI…" />
                  <p className="text-xs text-muted-foreground text-right">{reviewNotes.length}/4000</p>
                </div>
                <Button className="w-full h-auto min-h-9 whitespace-normal" disabled={!canDispatch} onClick={() => setConfirmation("dispatch")} data-testid="button-direct-ahs-dispatch">Approve and Send to VRS AI</Button>
              </>
            ) : <p className="text-sm text-muted-foreground">{status.data.reason || "This ticket is not eligible for direct AHS AI review. Normal processing remains available."}</p>}
            {dispatchAttempted ? <p className="text-sm" role="status">Reconciling the existing request. Refresh status before taking another action.</p> : null}
          </>
        ) : null}
        {dispatch.isPending ? <p role="status" className="text-sm text-muted-foreground">Sending the request. Please wait…</p> : null}
        {dispatch.isError ? <p role="alert" className="text-sm text-destructive">{friendlyApiErrorMessage(dispatch.error)}</p> : null}
        <AlertDialog open={confirmation !== null} onOpenChange={(open) => { if (!dispatch.isPending && !open) setConfirmation(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{confirmation === "retry" ? "Retry the same AI request?" : "Approve and send to VRS AI?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {confirmation === "retry"
                  ? "This retry reuses the same request ID. It does not create a new authorization. Use it only to reconcile an unconfirmed dispatch; VRS AI owns SMS delivery."
                  : "Your review notes will be sent to VRS AI. Normal ticket processing will be locked to this workflow. VRS AI will return an approval or denial and send the technician SMS."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={dispatch.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={dispatch.isPending || (confirmation === "dispatch" ? !canDispatch : checking || workflow?.state !== "dispatch_unknown" || !status.data?.enabled)} onClick={(event) => { event.preventDefault(); if (confirmation) dispatch.mutate(confirmation); }}>
                {confirmation === "retry" ? "Retry same AI request" : "Approve and Send to VRS AI"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
