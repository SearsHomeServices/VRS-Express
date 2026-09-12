// ---------------------------------------------------------------------------
// Submission Notes Thread — Tyler 2026-09-11
//
// Shared note thread for a single ticket, rendered on the VRS agent dashboard
// (and reusable anywhere an agent/admin can open a ticket).
//
// Why this exists: the agent dashboard had NO note UI at all. The only place a
// submission_notes row could be written was the technician's own detail page,
// so once the AI (or a human) closed a ticket, agents had nowhere to record
// follow-up. Notes are internal — posting one never texts the technician and
// never calls back to VRS AI. See the RBAC note in server/routes.ts.
// ---------------------------------------------------------------------------
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatDate } from "@/lib/utils";

const MAX_NOTE_LENGTH = 2000;

export interface SubmissionNote {
  id: number;
  body: string;
  authorName: string | null;
  authorRole: string;
  visibility: "shared" | "staff_only" | null;
  createdAt: string;
}

// Human label for the author_role column ('technician' | 'vrs_agent' | 'admin'
// | 'super_admin' | 'provider_1099'). Unknown roles fall through unchanged so a
// future role shows up as itself rather than silently reading as an agent.
function roleLabel(role: string): string {
  switch (role) {
    case "vrs_agent":
      return "VRS Agent";
    case "technician":
      return "Technician";
    case "provider_1099":
      return "1099 Provider";
    case "admin":
      return "Admin";
    case "super_admin":
      return "Admin";
    default:
      return role;
  }
}

export function SubmissionNotesThread({
  submissionId,
  ticketStatus,
  statusChangedAt,
}: {
  submissionId: number;
  /**
   * When the ticket was closed, if it is closed. Notes created after this
   * timestamp are flagged "after close" so a reader can tell at a glance that
   * the note landed on an already-closed order.
   */
  ticketStatus: string;
  statusChangedAt?: string | Date | null;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);

  const id = String(submissionId);
  const notesQuery = useQuery<{ notes: SubmissionNote[] }>({
    queryKey: ["/api/submissions", id, "notes"],
    enabled: Number.isFinite(submissionId),
  });

  const terminal = ["completed", "approved", "rejected", "rejected_closed", "invalid"].includes(ticketStatus);
  const closedMs = terminal && statusChangedAt ? new Date(statusChangedAt).getTime() : NaN;

  async function postNote() {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      await apiRequest("POST", `/api/submissions/${submissionId}/notes`, { body });
      setDraft("");
      await queryClient.invalidateQueries({
        queryKey: ["/api/submissions", id, "notes"],
      });
      toast({ title: "Note added" });
    } catch (err: any) {
      toast({
        title: "Failed to add note",
        description: String(err?.message || err),
        variant: "destructive",
      });
    } finally {
      setPosting(false);
    }
  }

  const notes = notesQuery.data?.notes ?? [];

  return (
    <Card className="mt-4" data-testid="card-agent-submission-notes">
      <CardContent className="p-4 space-y-3">
        <h3 className="font-semibold flex items-center gap-2">
          <ScrollText className="w-4 h-4" /> Notes
          {notes.length > 0 && (
            <span className="text-xs font-normal text-muted-foreground">
              ({notes.length})
            </span>
          )}
        </h3>

        {notesQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading notes…</p>
        )}
        {notesQuery.isError && (
          <p className="text-sm text-destructive" data-testid="text-notes-error">
            Couldn't load notes.
          </p>
        )}
        {!notesQuery.isLoading && !notesQuery.isError && notes.length === 0 && (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        )}

        {notes.map((n) => {
          const afterClose = n.visibility === "staff_only" ||
            (n.visibility == null && Number.isFinite(closedMs) && new Date(n.createdAt).getTime() > closedMs);
          return (
            <div
              key={n.id}
              className="rounded-md border p-2 text-sm"
              data-testid={`agent-note-${n.id}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="font-medium">
                  {n.authorName || "Unknown"}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {roleLabel(n.authorRole)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  {afterClose && (
                    <Badge
                      variant="outline"
                      className="text-[10px] gap-1"
                      data-testid={`agent-note-after-close-${n.id}`}
                    >
                      <Lock className="w-3 h-3" /> after close
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(n.createdAt)}
                  </span>
                </span>
              </div>
              <div className="whitespace-pre-wrap mt-1">{n.body}</div>
            </div>
          );
        })}

        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground" data-testid="text-note-audience">
            {terminal ? "Audience: admin-panel users only" : "Audience: staff and the ticket owner"}
          </p>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note — follow-up, correction, or additional context…"
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            data-testid="input-agent-note-body"
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              size="sm"
              onClick={postNote}
              disabled={!draft.trim() || posting}
              data-testid="button-post-agent-note"
            >
              {posting ? "Posting…" : "Add note"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {draft.length}/{MAX_NOTE_LENGTH}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
