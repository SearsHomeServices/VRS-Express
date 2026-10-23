import { applianceLabel } from "@shared/appliance-types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatDateShort } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { Submission } from "@shared/schema";

export default function TechHistoryPage() {
  const { data, isLoading } = useQuery<{ submissions: Submission[] }>({
    queryKey: ["/api/submissions"],
  });

  const submissions = data?.submissions || [];

  return (
    <div className="min-h-screen pb-20">
      <div className="bg-primary text-primary-foreground p-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold" data-testid="text-history-title">Submission History</h1>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))
        ) : submissions.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              No submissions found.
            </CardContent>
          </Card>
        ) : (
          submissions.map((sub) => {
            const status = sub.ticketStatus || sub.stage1Status;
            const rejectionReason = getRejectionReason(sub);
            return (
              <Link key={sub.id} href={`/tech/submissions/${sub.id}`}>
                <Card className="hover-elevate cursor-pointer">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <p className="text-sm font-medium" data-testid={`text-history-so-${sub.id}`}>
                        SO #{sub.serviceOrder}
                      </p>
                      <StatusBadge status={status} />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground capitalize">
                        {applianceLabel(sub)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateShort(sub.createdAt)}
                      </p>
                    </div>
                    <div className="mt-0.5">
                      <RequestTypeBadge requestType={sub.requestType} />
                    </div>
                    {(status === "rejected" || status === "rejected_closed") && rejectionReason && (
                      <p
                        className="text-xs text-destructive mt-1.5 line-clamp-2"
                        data-testid={`text-history-reason-${sub.id}`}
                      >
                        <span className="font-medium">Reason:</span> {rejectionReason}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}

function getRejectionReason(sub: Submission): string {
  if (sub.rejectionReasons) {
    try {
      const parsed = typeof sub.rejectionReasons === "string"
        ? JSON.parse(sub.rejectionReasons)
        : sub.rejectionReasons;
      if (Array.isArray(parsed) && parsed.length > 0) {
        const joined = parsed.filter((r: unknown) => typeof r === "string" && r.trim().length > 0).join(", ");
        if (joined) return joined;
      }
    } catch {
      // fall through to stage1RejectionReason
    }
  }
  return sub.stage1RejectionReason || "";
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "queued":
    case "pending":
      return <Badge variant="secondary">Pending</Badge>;
    case "completed":
    case "approved":
      return <Badge className="bg-green-600 text-white border-green-600">Approved</Badge>;
    case "rejected":
      return <Badge variant="destructive">Rejected</Badge>;
    case "rejected_closed":
      return <Badge variant="destructive">Closed — Not Covered</Badge>;
    case "invalid":
      return <Badge variant="secondary">Not Applicable</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function RequestTypeBadge({ requestType }: { requestType: string }) {
  switch (requestType) {
    case "authorization":
      return <Badge variant="outline" className="text-blue-700 border-blue-300 bg-blue-50 dark:text-blue-300 dark:border-blue-700 dark:bg-blue-950">Authorization</Badge>;
    case "infestation_non_accessible":
      return <Badge variant="outline" className="text-yellow-700 border-yellow-300 bg-yellow-50 dark:text-yellow-300 dark:border-yellow-700 dark:bg-yellow-950">Infestation</Badge>;
    case "parts_nla":
      return <Badge variant="outline" className="text-orange-700 border-orange-300 bg-orange-50 dark:text-orange-300 dark:border-orange-700 dark:bg-orange-950">NLA Parts</Badge>;
    default:
      return <Badge variant="outline">{requestType.replace(/_/g, " ")}</Badge>;
  }
}
