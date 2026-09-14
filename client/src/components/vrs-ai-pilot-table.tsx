import { useMemo, useState } from "react";
import type { SubmissionListItemWithTech } from "@shared/schema";
import { filterVrsAiPilotRows, hasVrsAiBridgeLink } from "@shared/vrs-ai-pilot";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Search, Sparkles } from "lucide-react";

export type VrsAiPilotRow = SubmissionListItemWithTech;
export type PilotTicketStatus =
  | "all"
  | "queued"
  | "pending"
  | "completed"
  | "rejected"
  | "rejected_closed"
  | "invalid";

const TERMINAL_AI_STATES = new Set(["approved", "partial", "denied", "failed"]);

function ticketStatusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Approved";
    case "rejected_closed":
      return "Rejected & Closed";
    default:
      return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

function aiStateLabel(state: string | null | undefined): string {
  if (!state) return "Unknown";
  return state.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ticketStatusClass(status: string): string {
  switch (status) {
    case "queued":
      return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "pending":
      return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    case "completed":
      return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "rejected":
    case "rejected_closed":
      return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
    case "invalid":
      return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
    default:
      return "bg-gray-100 text-gray-700";
  }
}

function aiStateClass(state: string | null | undefined): string {
  if (state === "failed" || state === "dispatch_failed") {
    return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
  }
  if (state === "approved") {
    return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
  }
  if (state === "denied" || state === "partial") {
    return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200";
  }
  return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
}

function searchText(row: VrsAiPilotRow): string {
  return [
    row.serviceOrder,
    row.technicianName,
    row.technicianLdapId,
    row.assignedAgentName,
    row.vrsAi?.callId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

export function VrsAiPilotTable({
  rows,
  isLoading = false,
  errorMessage,
  onOpenSubmission,
  testIdPrefix = "vrs-ai-pilot",
}: {
  rows: readonly VrsAiPilotRow[];
  isLoading?: boolean;
  errorMessage?: string;
  onOpenSubmission: (submissionId: number) => void;
  testIdPrefix?: string;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PilotTicketStatus>("all");

  const visibleRows = useMemo(() => {
    const linkedRows = filterVrsAiPilotRows(rows);
    const needle = search.trim().toLowerCase();
    return linkedRows.filter((row) => {
      if (status !== "all" && row.ticketStatus !== status) return false;
      return !needle || searchText(row).includes(needle);
    });
  }, [rows, search, status]);

  return (
    <div className="space-y-4 p-4" data-testid={`${testIdPrefix}-view`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search service order, technician, or agent..."
            className="pl-9"
            data-testid={`${testIdPrefix}-search`}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Ticket status</span>
          <Select value={status} onValueChange={(value) => setStatus(value as PilotTicketStatus)}>
            <SelectTrigger className="h-9 w-[180px]" data-testid={`${testIdPrefix}-status-filter`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="completed">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="rejected_closed">Rejected &amp; Closed</SelectItem>
              <SelectItem value="invalid">Invalid</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <span className="text-sm text-muted-foreground" data-testid={`${testIdPrefix}-count`}>
          {visibleRows.length} pilot ticket{visibleRows.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="rounded-lg border">
        {errorMessage ? (
          <div className="p-8 text-center text-sm text-destructive" data-testid={`${testIdPrefix}-error`}>
            {errorMessage}
          </div>
        ) : isLoading ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Loading VRS AI Pilot tickets…
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>
            No VRS AI Pilot tickets found.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Service order</TableHead>
                  <TableHead>Technician</TableHead>
                  <TableHead>Assigned agent</TableHead>
                  <TableHead>Ticket status</TableHead>
                  <TableHead>AI handoff</TableHead>
                  <TableHead>AI result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => {
                  // The API applies the same predicate. Keep this guard here
                  // as a defensive client boundary so a legacy/manual payload
                  // can never render an unlinked ticket in this tab.
                  if (!hasVrsAiBridgeLink(row)) return null;
                  const aiState = row.vrsAi?.state;
                  const terminal = Boolean(aiState && TERMINAL_AI_STATES.has(aiState));
                  return (
                    <TableRow
                      key={row.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onOpenSubmission(row.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onOpenSubmission(row.id);
                        }
                      }}
                      tabIndex={0}
                      data-testid={`${testIdPrefix}-row-${row.id}`}
                    >
                      <TableCell className="font-mono font-semibold text-primary">
                        {row.serviceOrder}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{row.technicianName || "—"}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.technicianLdapId || ""}
                        </div>
                      </TableCell>
                      <TableCell>
                        {row.assignedAgentName || (
                          <span className="italic text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={ticketStatusClass(row.ticketStatus)}>
                          {ticketStatusLabel(row.ticketStatus)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200">
                          <Sparkles className="mr-1 h-3 w-3" />
                          Sent
                        </Badge>
                        {row.vrsAi?.dispatchedAt && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {formatDate(row.vrsAi.dispatchedAt)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge className={aiStateClass(aiState)}>
                          {terminal ? aiStateLabel(aiState) : "Pending"}
                        </Badge>
                        {row.vrsAi?.failureReason && (
                          <div className="mt-1 max-w-[180px] truncate text-xs text-destructive" title={row.vrsAi.failureReason}>
                            {row.vrsAi.failureReason}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
