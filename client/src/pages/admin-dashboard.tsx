import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, getToken } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { safeDate, formatDate, formatDateShort } from "@/lib/utils";
import {
  getBusinessElapsedMs,
  formatBusinessElapsed,
  isWithinBusinessHours,
  VRS_OPEN_HOUR_ET,
  VRS_CLOSE_HOUR_ET,
} from "@/lib/business-hours";
import { useWebSocket, loadNotificationSettings, playNotificationDing, showBrowserNotification } from "@/lib/websocket";
import NotificationSettings from "@/components/notification-settings";
import type { User, TechnicianUserView } from "@shared/schema";
import { deriveIntakeFormStatus } from "@shared/intake-form-config";
import searsLogo from "@assets/sears-home-services-logo-brands_1770949137899.png";
import {
  SidebarProvider,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarHeader,
  SidebarFooter,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  GitBranch,
  BarChart3,
  LogOut,
  Plus,
  Pencil,
  UserPlus,
  Save,
  Shield,
  FileText,
  CheckCircle,
  CheckCircle2,
  XCircle,
  Clock,
  TrendingUp,
  Calendar,
  CalendarDays,
  CalendarRange,
  LifeBuoy,
  RotateCcw,
  Key,
  Database,
  Loader2,
  Trash2,
  ClipboardList,
  X,
  Search,
  Download,
  MessageSquare,
  ArrowRight,
  CircleDot,
  ArrowLeftRight,
  Undo2,
  ArrowUpDown,
  Wrench,
  Moon,
  Sun,
  Image as ImageIcon,
  Video,
  Mic,
  ZoomIn,
  ChevronLeft,
  ChevronRight,
  Package,
  CreditCard,
} from "lucide-react";
import HelpTooltip from "@/components/help-tooltip";
import { useTheme } from "@/components/theme-provider";

interface AnalyticsData {
  submissionsToday: number;
  submissionsThisWeek: number;
  submissionsThisMonth: number;
  totalSubmissions: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  avgTimeToStage1Ms: number | null;
  avgTimeToAuthCodeMs: number | null;
}

interface ResubmissionStats {
  totalResubmissions: number;
  resubmissionRate: number;
  topTechnicians: { technicianId: number; techName: string; techLdap: string; totalTickets: number; resubmissions: number; rate: number }[];
}

interface DistrictRollup {
  district: string;
  totalTickets: number;
  approved: number;
  rejected: number;
  pending: number;
  completed: number;
  avgTimeToStage1Ms: number | null;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms === 0) return "N/A";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type SafeUser = Omit<User, "password">;

type ActiveView = "users" | "divisions" | "rgc" | "analytics" | "technicians" | "agent-status" | "tickets" | "feedback";

const DIVISION_KEYS = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other", "nla"] as const;

const DIVISION_LABELS: Record<string, string> = {
  cooking: "Cooking",
  dishwasher: "Dishwasher / Compactor",
  microwave: "Microwave",
  laundry: "Laundry",
  refrigeration: "Refrigeration",
  hvac: "HVAC",
  all_other: "All Other",
  nla: "NLA Parts",
};

const ROLE_BADGE_VARIANT: Record<string, "default" | "secondary" | "destructive"> = {
  technician: "default",
  vrs_agent: "secondary",
  admin: "destructive",
  super_admin: "destructive",
};

const ROLE_LABELS: Record<string, string> = {
  technician: "Technician",
  vrs_agent: "VRS Agent",
  admin: "Admin",
  super_admin: "Super Admin",
};

type AgentStatusInfo = {
  id: number;
  name: string;
  racId: string | null;
  agentStatus: string;
  divisions: string[];
  updatedAt: string | null;
};

function AgentStatusSection() {
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ agents: AgentStatusInfo[] }>({
    queryKey: ["/api/admin/agent-status"],
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const toggleAgentStatusMutation = useMutation({
    mutationFn: async ({ agentId, status }: { agentId: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${agentId}/status`, { status });
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/agent-status"] });
      toast({ title: variables.status === "online" ? "Agent set to available" : "Agent set to unavailable" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    },
  });

  const agents = data?.agents || [];

  const statusDot = (status: string) => {
    if (status === "online") return "bg-green-500";
    if (status === "working") return "bg-yellow-500";
    return "bg-gray-400";
  };

  const statusLabel = (status: string) => {
    if (status === "online") return "Available";
    if (status === "working") return "Working";
    return "Unavailable";
  };

  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Live Agent Status</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active agents found.</p>
          ) : (
            <div className="overflow-x-auto">
            <Table className="min-w-[600px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>LDAP ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Divisions</TableHead>
                  <TableHead className="hidden sm:table-cell">Last Seen</TableHead>
                  <TableHead className="text-right">Availability</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map((agent) => (
                  <TableRow key={agent.id} data-testid={`agent-status-row-${agent.id}`}>
                    <TableCell className="font-medium">{agent.name}</TableCell>
                    <TableCell className="text-muted-foreground">{agent.racId || "—"}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${statusDot(agent.agentStatus)}`} />
                        <span className="text-sm">{statusLabel(agent.agentStatus)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {agent.divisions.length === 0 ? (
                          <span className="text-xs text-muted-foreground">None</span>
                        ) : agent.divisions.length >= DIVISION_KEYS.length ? (
                          <Badge variant="outline" className="text-xs">All Divisions</Badge>
                        ) : (
                          agent.divisions.map((d) => (
                            <Badge key={d} variant="outline" className="text-xs">
                              {DIVISION_LABELS[d] || d}
                            </Badge>
                          ))
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                      {formatDate(agent.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-xs text-muted-foreground">
                          {agent.agentStatus === "working" ? "Working" : agent.agentStatus === "online" ? "On" : "Off"}
                        </span>
                        <Switch
                          checked={agent.agentStatus === "online" || agent.agentStatus === "working"}
                          onCheckedChange={(checked) => {
                            toggleAgentStatusMutation.mutate({
                              agentId: agent.id,
                              status: checked ? "online" : "offline",
                            });
                          }}
                          disabled={toggleAgentStatusMutation.isPending || agent.agentStatus === "working"}
                          data-testid={`toggle-agent-status-${agent.id}`}
                          className="scale-90"
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// Tyler 2026-04-29 (VRS business-hours timer): all admin timer columns now
// route through `getBusinessElapsedMs` so after-hours windows (8 PM ET to
// 8 AM ET) don't accumulate against ticket TAT. Wall-clock subtraction was
// previously inflating overnight tickets by 12+ hours. Format string is
// unchanged so the column widths stay stable.
function getTimeInStatus(createdAt: string | Date | null | undefined, reviewedAt?: string | Date | null): string {
  const start = safeDate(createdAt);
  if (!start) return "—";
  const end = safeDate(reviewedAt) || new Date();
  const businessMs = getBusinessElapsedMs(start, end);
  return formatBusinessElapsed(businessMs);
}

function getStatusColor(status: string): string {
  switch (status) {
    case "queued": return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    case "pending": return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    case "completed": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
    case "rejected": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
    case "rejected_closed": return "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200";
    case "invalid": return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
    default: return "bg-gray-100 text-gray-700";
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case "queued": return "Queued";
    case "pending": return "Pending";
    case "completed": return "Approved";
    case "rejected": return "Rejected";
    case "rejected_closed": return "Closed";
    case "invalid": return "Invalid";
    default: return status;
  }
}

type TicketStatusFilter = "all" | "queued" | "pending" | "completed" | "rejected" | "rejected_closed" | "invalid";

interface AuditTimelineEntry {
  timestamp: string;
  event: string;
  actor: string;
  detail?: string;
}

function TicketDetailDialog({ ticketId, open, onClose }: { ticketId: number | null; open: boolean; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<"details" | "media" | "timeline">("details");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxPhotos, setLightboxPhotos] = useState<string[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const openLightbox = (photos: string[], index: number) => {
    setLightboxPhotos(photos);
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  useEffect(() => {
    if (!open) {
      setLightboxOpen(false);
      setActiveTab("details");
    }
  }, [open]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setLightboxOpen(false); e.stopPropagation(); }
      if (e.key === "ArrowLeft") setLightboxIndex((prev) => (prev - 1 + lightboxPhotos.length) % lightboxPhotos.length);
      if (e.key === "ArrowRight") setLightboxIndex((prev) => (prev + 1) % lightboxPhotos.length);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [lightboxOpen, lightboxPhotos.length]);

  const { data, isLoading } = useQuery<{
    submission: any;
    timeline: AuditTimelineEntry[];
    userNames: Record<number, string>;
    smsLogs: any[];
  }>({
    queryKey: ["/api/admin/submissions", ticketId, "audit"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/submissions/${ticketId}/audit`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("Failed to load ticket details");
      return res.json();
    },
    enabled: !!ticketId && open,
  });

  const sub = data?.submission;
  const timeline = data?.timeline || [];
  const userNames = data?.userNames || {};

  const getEventIcon = (event: string) => {
    if (event === "Submitted") return <CircleDot className="w-4 h-4 text-blue-500" />;
    if (event.includes("Claimed")) return <ArrowRight className="w-4 h-4 text-yellow-500" />;
    if (event.includes("Reassigned")) return <RotateCcw className="w-4 h-4 text-orange-500" />;
    if (event.includes("Approved")) return <CheckCircle className="w-4 h-4 text-green-500" />;
    if (event.includes("Rejected") || event.includes("Closed")) return <XCircle className="w-4 h-4 text-red-500" />;
    if (event.includes("Invalid")) return <XCircle className="w-4 h-4 text-gray-500" />;
    if (event.includes("SMS")) return <MessageSquare className="w-4 h-4 text-indigo-500" />;
    if (event.includes("Status")) return <Clock className="w-4 h-4 text-purple-500" />;
    return <Clock className="w-4 h-4 text-muted-foreground" />;
  };

  const formatTs = (ts: string) => {
    return formatDate(ts, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  };

  const formatTsFull = (ts: string | Date | null | undefined) => {
    return formatDate(ts as any, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  };

  let rejectionReasonsList: string[] = [];
  if (sub?.rejectionReasons) {
    try {
      rejectionReasonsList = typeof sub.rejectionReasons === "string" ? JSON.parse(sub.rejectionReasons) : sub.rejectionReasons;
    } catch { rejectionReasonsList = []; }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent
        className="max-w-3xl max-h-[85vh] flex flex-col"
        onPointerDownOutside={(e) => { if (lightboxOpen) e.preventDefault(); }}
        onInteractOutside={(e) => { if (lightboxOpen) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (lightboxOpen) e.preventDefault(); }}
      >
        <DialogHeader>
          <DialogTitle data-testid="text-audit-title">
            {sub ? `Ticket Detail — SO# ${sub.serviceOrder}` : "Ticket Detail"}
          </DialogTitle>
          <DialogDescription>
            View full ticket information, status changes, and audit trail.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-4">
            {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-14 w-full" />)}
          </div>
        ) : !sub ? (
          <p className="text-muted-foreground py-4">Ticket not found.</p>
        ) : (
          <div className="overflow-y-auto flex-1 pr-2">
            <div className="flex gap-1 mb-4 border-b">
              <button
                onClick={() => setActiveTab("details")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "details" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                data-testid="tab-ticket-details"
              >
                Details
              </button>
              <button
                onClick={() => setActiveTab("media")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "media" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                data-testid="tab-ticket-media"
              >
                Media
              </button>
              <button
                onClick={() => setActiveTab("timeline")}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "timeline" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                data-testid="tab-ticket-timeline"
              >
                Status History
              </button>
            </div>

            {activeTab === "details" && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Technician</p>
                    <p className="text-sm font-medium" data-testid="text-audit-tech">{userNames[sub.technicianId] || "—"}</p>
                    <p className="text-xs text-muted-foreground">{sub.technicianLdapId || sub.racId}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Current Status</p>
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold mt-1 ${getStatusColor(sub.ticketStatus)}`} data-testid="text-audit-status">
                      {getStatusLabel(sub.ticketStatus)}
                    </span>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Assigned Agent</p>
                    <p className="text-sm font-medium" data-testid="text-audit-agent">{sub.assignedTo ? userNames[sub.assignedTo] || "Agent" : "Unassigned"}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Division</p>
                    <p className="text-sm font-medium">{DIVISION_LABELS[sub.applianceType] || sub.applianceType}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Warranty</p>
                    <p className="text-sm font-medium">
                      {sub.warrantyType === "sears_protect" ? "Sears Protect" :
                       sub.warrantyType === "ahs" ? "AHS" :
                       sub.warrantyType === "first_american" ? "First American" :
                       sub.warrantyType || "—"}
                    </p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Request Type</p>
                    <p className="text-sm font-medium">{sub.requestType === "authorization" ? "Authorization" : sub.requestType === "parts_nla" ? "Parts — NLA" : sub.requestType === "infestation_non_accessible" ? "Infestation / Non-Accessible" : (sub.requestType || "—")}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">ProcID</p>
                    <p className="text-sm font-medium" data-testid="text-detail-proc-id">{sub.procId || "Not Found"}</p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Client</p>
                    <p className="text-sm font-medium" data-testid="text-detail-client-nm">{sub.clientNm || "Not Found"}</p>
                  </div>
                </div>

                {(sub as any).partNumbers && (() => {
                  try {
                    const parts = JSON.parse((sub as any).partNumbers);
                    if (Array.isArray(parts) && parts.length > 0) {
                      return (
                        <div className="rounded-lg border p-3">
                          <p className="text-xs text-muted-foreground">Part Number(s)</p>
                          <p className="text-sm font-mono font-medium" data-testid="text-admin-part-numbers">{parts.join(", ")}</p>
                        </div>
                      );
                    }
                  } catch {}
                  return null;
                })()}

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  <div className="rounded-lg border p-3 bg-muted/20">
                    <p className="text-xs text-muted-foreground">Submitted</p>
                    <p className="text-sm font-medium" data-testid="text-detail-created">{formatTsFull(sub.createdAt)}</p>
                  </div>
                  <div className="rounded-lg border p-3 bg-muted/20">
                    <p className="text-xs text-muted-foreground">Last Updated</p>
                    <p className="text-sm font-medium" data-testid="text-detail-updated">{formatTsFull(sub.updatedAt)}</p>
                  </div>
                  <div className="rounded-lg border p-3 bg-muted/20">
                    <p className="text-xs text-muted-foreground">Last Actioned</p>
                    <p className="text-sm font-medium" data-testid="text-detail-actioned">{formatTsFull(sub.statusChangedAt || sub.reviewedAt || sub.updatedAt)}</p>
                  </div>
                </div>

                {sub.phone && (
                  <div className="rounded-lg border p-3">
                    <p className="text-xs text-muted-foreground">Contact Phone</p>
                    <p className="text-sm font-medium">{sub.phoneOverride || sub.phone}</p>
                  </div>
                )}

                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground mb-1">Issue Description</p>
                  <p className="text-sm">{sub.issueDescription || "—"}</p>
                </div>

                {sub.authCode && (
                  <div className="rounded-lg border p-3 bg-green-50 dark:bg-green-950/20">
                    <p className="text-xs text-muted-foreground mb-1">Auth Code</p>
                    <p className="text-sm font-mono font-bold text-green-700 dark:text-green-400">{sub.authCode}</p>
                    {sub.rgcCode && (
                      <>
                        <p className="text-xs text-muted-foreground mt-2 mb-1">RGC Code</p>
                        <p className="text-sm font-mono font-bold text-green-700 dark:text-green-400">{sub.rgcCode}</p>
                      </>
                    )}
                  </div>
                )}

                {rejectionReasonsList.length > 0 && (
                  <div className="rounded-lg border p-3 bg-red-50 dark:bg-red-950/20">
                    <p className="text-xs text-muted-foreground mb-1">Rejection Reasons</p>
                    <ul className="text-sm space-y-0.5">
                      {rejectionReasonsList.map((r: string, i: number) => (
                        <li key={i} className="text-red-700 dark:text-red-400">&bull; {r}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {sub.technicianMessage && (
                  <div className="rounded-lg border p-3 bg-muted/30">
                    <p className="text-xs text-muted-foreground mb-1">Message to Technician</p>
                    <p className="text-sm">{sub.technicianMessage}</p>
                  </div>
                )}

                {sub.agentNotes && (
                  <div className="rounded-lg border p-3 bg-muted/30">
                    <p className="text-xs text-muted-foreground mb-1">Agent Notes</p>
                    <p className="text-sm">{sub.agentNotes}</p>
                  </div>
                )}

                {sub.invalidReason && (
                  <div className="rounded-lg border p-3 bg-gray-50 dark:bg-gray-950/20">
                    <p className="text-xs text-muted-foreground mb-1">Invalid Reason</p>
                    <p className="text-sm">{sub.invalidReason}</p>
                    {sub.invalidInstructions && (
                      <>
                        <p className="text-xs text-muted-foreground mt-2 mb-1">Instructions</p>
                        <p className="text-sm">{sub.invalidInstructions}</p>
                      </>
                    )}
                  </div>
                )}

                {sub.resubmissionOf && (
                  <div className="rounded-lg border p-3 bg-blue-50 dark:bg-blue-950/20">
                    <p className="text-xs text-muted-foreground">Resubmission of Ticket #{sub.resubmissionOf}</p>
                  </div>
                )}
              </div>
            )}

            {activeTab === "media" && (
              <div className="space-y-6">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-3 flex items-center gap-1.5">
                    <ImageIcon className="w-3.5 h-3.5" />
                    Photos
                  </p>
                  {(() => {
                    let parsed: any = null;
                    try { parsed = sub.photos ? JSON.parse(sub.photos) : null; } catch { parsed = null; }
                    if (!parsed) return <p className="text-sm text-muted-foreground" data-testid="text-admin-no-photos">No photos attached</p>;

                    const isNewFormat = parsed && typeof parsed === "object" && !Array.isArray(parsed);
                    const estimatePhotos: string[] = (isNewFormat ? (parsed.estimate || []) : []).filter((u: any) => typeof u === "string" && u);
                    const issuePhotos: string[] = (isNewFormat ? (parsed.issue || []) : []).filter((u: any) => typeof u === "string" && u);
                    const legacyPhotos: string[] = (Array.isArray(parsed) ? parsed : []).filter((u: any) => typeof u === "string" && u);
                    const allPhotos = [...issuePhotos, ...estimatePhotos, ...legacyPhotos];

                    const renderPhotoGrid = (photos: string[], label: string, offset: number, testIdPrefix: string) => {
                      if (photos.length === 0) return null;
                      return (
                        <div className="mb-4">
                          <p className="text-xs text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
                            <ImageIcon className="w-3 h-3" />
                            {label} ({photos.length})
                          </p>
                          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2" data-testid={`admin-media-${testIdPrefix}`}>
                            {photos.map((url: string, i: number) => (
                              <div
                                key={i}
                                className="relative aspect-square bg-muted rounded-md overflow-hidden cursor-pointer group"
                                onClick={() => openLightbox(allPhotos, offset + i)}
                                data-testid={`admin-${testIdPrefix}-photo-${i}`}
                              >
                                <img src={url} alt={`${label} ${i + 1}`} className="w-full h-full object-cover pointer-events-none" />
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <ZoomIn className="w-6 h-6 text-white" />
                                </div>
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="absolute top-1 right-1 bg-black/60 rounded-md p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 z-10"
                                  onClick={(e) => e.stopPropagation()}
                                  data-testid={`admin-${testIdPrefix}-download-${i}`}
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </a>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    };

                    return (
                      <div>
                        {renderPhotoGrid(issuePhotos, "Issue Photos", 0, "issue-photos")}
                        {renderPhotoGrid(estimatePhotos, "Model, Serial & Estimate Screenshots", issuePhotos.length, "estimate-photos")}
                        {renderPhotoGrid(legacyPhotos, "Photos", issuePhotos.length + estimatePhotos.length, "legacy-photos")}
                        {estimatePhotos.length === 0 && issuePhotos.length === 0 && legacyPhotos.length === 0 && (
                          <p className="text-sm text-muted-foreground" data-testid="text-admin-no-photos">No photos attached</p>
                        )}
                      </div>
                    );
                  })()}
                </div>

                <Separator />

                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-3 flex items-center gap-1.5">
                    <Video className="w-3.5 h-3.5" />
                    Video
                  </p>
                  {sub.videoUrl ? (
                    <div className="rounded-md overflow-hidden bg-muted" data-testid="admin-media-video">
                      <video
                        src={sub.videoUrl}
                        controls
                        className="w-full max-h-[300px]"
                        data-testid="admin-video-player"
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-admin-no-video">No video attached</p>
                  )}
                </div>

                <Separator />

                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-3 flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5" />
                    Voice Note
                  </p>
                  {sub.voiceNoteUrl ? (
                    <div className="rounded-md overflow-hidden bg-muted p-3" data-testid="admin-media-voice">
                      <audio
                        src={sub.voiceNoteUrl}
                        controls
                        className="w-full"
                        data-testid="admin-audio-player"
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground" data-testid="text-admin-no-voice">No voice note attached</p>
                  )}
                </div>
              </div>
            )}

            {activeTab === "timeline" && (
              <div>
                <div className="relative">
                  <div className="absolute left-[17px] top-3 bottom-3 w-px bg-border" />
                  <div className="space-y-0">
                    {timeline.map((entry, i) => (
                      <div key={i} className="relative flex items-start gap-3 py-2.5 pl-1" data-testid={`audit-entry-${i}`}>
                        <div className="relative z-10 mt-0.5 bg-background rounded-full p-0.5">
                          {getEventIcon(entry.event)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-sm font-medium">{entry.event}</p>
                            <p className="text-xs text-muted-foreground whitespace-nowrap">{formatTs(entry.timestamp)}</p>
                          </div>
                          <p className="text-xs text-muted-foreground">{entry.actor}</p>
                          {entry.detail && <p className="text-xs text-muted-foreground mt-0.5 break-words">{entry.detail}</p>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>

      <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogPortal>
          <DialogOverlay className="z-[200] bg-black/90" />
          <DialogPrimitive.Content
            className="fixed inset-0 z-[200] flex items-center justify-center focus:outline-none"
            onOpenAutoFocus={(e) => e.preventDefault()}
            aria-describedby={undefined}
          >
            <DialogPrimitive.Title className="sr-only">Photo viewer</DialogPrimitive.Title>
            <button
              type="button"
              className="absolute top-4 right-4 text-white/80 hover:text-white z-10"
              onClick={() => setLightboxOpen(false)}
              data-testid="admin-lightbox-close"
            >
              <X className="w-8 h-8" />
            </button>
            {lightboxPhotos.length > 1 && (
              <>
                <button
                  type="button"
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white z-10 bg-black/40 rounded-full p-2"
                  onClick={() =>
                    setLightboxIndex((prev) => (prev - 1 + lightboxPhotos.length) % lightboxPhotos.length)
                  }
                  data-testid="admin-lightbox-prev"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button
                  type="button"
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-white/80 hover:text-white z-10 bg-black/40 rounded-full p-2"
                  onClick={() =>
                    setLightboxIndex((prev) => (prev + 1) % lightboxPhotos.length)
                  }
                  data-testid="admin-lightbox-next"
                >
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}
            <img
              src={lightboxPhotos[lightboxIndex]}
              alt={`Photo ${lightboxIndex + 1}`}
              className="max-w-[90vw] max-h-[90vh] object-contain pointer-events-none"
              data-testid="admin-lightbox-image"
            />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/80 text-sm pointer-events-none">
              {lightboxIndex + 1} / {lightboxPhotos.length}
            </div>
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </Dialog>
  );
}

function TicketOverviewSection() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>("all");
  const [requestTypeFilter, setRequestTypeFilter] = useState<"all" | "auth" | "nla">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [reassignTicket, setReassignTicket] = useState<any | null>(null);
  const [reassignTarget, setReassignTarget] = useState<string>("");
  const [reassignNotes, setReassignNotes] = useState("");

  const { data: allData, isLoading: allLoading } = useQuery<{ submissions: any[] }>({
    queryKey: ["/api/submissions"],
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const { data: usersData } = useQuery<{ users: any[] }>({
    queryKey: ["/api/admin/users"],
  });

  const availableAgents = (usersData?.users || []).filter(
    (u: any) => (u.role === "vrs_agent" || u.role === "admin" || u.role === "super_admin") && u.isActive
  );

  const reassignMutation = useMutation({
    mutationFn: async ({ id, agentId, notes }: { id: number; agentId?: number; notes?: string }) => {
      const res = await apiRequest("PATCH", `/api/submissions/${id}/reassign`, { agentId, notes });
      return await res.json();
    },
    onSuccess: (_data: any, variables: { id: number; agentId?: number }) => {
      toast({
        title: variables.agentId ? "Ticket Reassigned" : "Ticket Reassigned to Queue",
        description: variables.agentId
          ? `Assigned to ${availableAgents.find((a: any) => a.id === variables.agentId)?.name || "agent"}.`
          : "Ticket is now available for any agent to claim.",
      });
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      setReassignTicket(null);
      setReassignTarget("");
      setReassignNotes("");
    },
    onError: (error: Error) => {
      toast({ title: "Reassign Failed", description: error.message, variant: "destructive" });
    },
  });

  function handleReassignSubmit() {
    if (!reassignTicket) return;
    if (reassignTarget === "queue") {
      reassignMutation.mutate({ id: reassignTicket.id, notes: reassignNotes || undefined });
    } else if (reassignTarget) {
      reassignMutation.mutate({ id: reassignTicket.id, agentId: parseInt(reassignTarget), notes: reassignNotes || undefined });
    }
  }

  const rawTickets = allData?.submissions || [];
  const allTickets = requestTypeFilter === "all"
    ? rawTickets
    : requestTypeFilter === "nla"
    ? rawTickets.filter((t: any) => t.requestType === "parts_nla")
    : rawTickets.filter((t: any) => t.requestType !== "parts_nla");

  const statusCounts = {
    all: allTickets.length,
    queued: allTickets.filter(t => t.ticketStatus === "queued").length,
    pending: allTickets.filter(t => t.ticketStatus === "pending").length,
    completed: allTickets.filter(t => t.ticketStatus === "completed").length,
    rejected: allTickets.filter(t => t.ticketStatus === "rejected").length,
    rejected_closed: allTickets.filter(t => t.ticketStatus === "rejected_closed").length,
    invalid: allTickets.filter(t => t.ticketStatus === "invalid").length,
  };

  let filteredTickets = statusFilter === "all"
    ? allTickets
    : allTickets.filter(t => t.ticketStatus === statusFilter);

  if (statusFilter === "queued") {
    filteredTickets = [...filteredTickets].sort((a, b) =>
      (safeDate(a.createdAt)?.getTime() || 0) - (safeDate(b.createdAt)?.getTime() || 0)
    );
  }

  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    filteredTickets = filteredTickets.filter(t =>
      t.serviceOrder?.toLowerCase().includes(q) ||
      t.technicianName?.toLowerCase().includes(q) ||
      t.technicianLdapId?.toLowerCase().includes(q) ||
      t.assignedAgentName?.toLowerCase().includes(q)
    );
  }

  const tabs: { key: TicketStatusFilter; label: string; color: string }[] = [
    { key: "all", label: "All Tickets", color: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200" },
    { key: "queued", label: "In Queue", color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
    { key: "pending", label: "Pending (In Progress)", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" },
    { key: "completed", label: "Approved", color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
    { key: "rejected", label: "Rejected", color: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  ];

  // Tyler 2026-04-29 (VRS business-hours timer): when we're outside the
  // 8 AM-8 PM ET window, surface a small inline indicator at the top of the
  // tickets view so admins understand the column timers aren't ticking. The
  // indicator only renders during after-hours.
  const businessHoursActive = isWithinBusinessHours();

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3 flex-wrap" data-testid="filter-and-status-row">
        <div className="flex items-center gap-1 border rounded-lg p-1 w-fit bg-muted/30" data-testid="request-type-filter">
          {([
            { key: "all" as const, label: "All Tickets" },
            { key: "auth" as const, label: "Authorization Only" },
            { key: "nla" as const, label: "NLA Only" },
          ]).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setRequestTypeFilter(opt.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                requestTypeFilter === opt.key
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`filter-request-type-${opt.key}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {!businessHoursActive && (
          <div
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-200"
            data-testid="badge-after-hours"
            title={`VRS hours are ${VRS_OPEN_HOUR_ET}:00 AM to ${VRS_CLOSE_HOUR_ET - 12}:00 PM Eastern Time. Ticket timers don't accumulate outside that window.`}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
            After hours — ticket timers paused until 8 AM ET
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setStatusFilter(tab.key)}
            className={`rounded-lg border p-3 text-left transition-all cursor-pointer ${
              statusFilter === tab.key
                ? "ring-2 ring-primary border-primary shadow-sm"
                : "hover:border-muted-foreground/30"
            }`}
            data-testid={`tab-tickets-${tab.key}`}
          >
            <div className="text-2xl font-bold" data-testid={`count-tickets-${tab.key}`}>
              {statusCounts[tab.key]}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">{tab.label}</div>
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by service order, technician, or agent..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
          data-testid="input-ticket-search"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          {allLoading ? (
            <div className="p-6 space-y-2">
              {[1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : filteredTickets.length === 0 ? (
            <div className="p-6 text-center text-muted-foreground">
              No {statusFilter === "all" ? "" : tabs.find(t => t.key === statusFilter)?.label.toLowerCase() || ""} tickets found.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[140px]">Service Order</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Assigned To</TableHead>
                    <TableHead>Technician</TableHead>
                    <TableHead>Division</TableHead>
                    <TableHead>Warranty</TableHead>
                    <TableHead>Intake Form Complete</TableHead>
                    <TableHead className="text-right">Last Updated</TableHead>
                    <TableHead className="text-right">Queue Wait</TableHead>
                    <TableHead className="text-right">Handle Time</TableHead>
                    <TableHead className="text-right">Total Time</TableHead>
                    {(statusFilter === "queued" || statusFilter === "pending" || statusFilter === "all") && (
                      <TableHead className="w-[80px]"></TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTickets.map((ticket: any) => {
                    // Tyler 2026-04-29: row-aging highlight (red = urgent
                    // ≥4h, amber = aging ≥2h) now uses business-hours
                    // elapsed too, so an overnight queued ticket isn't
                    // flagged urgent at 8 AM just because the wall clock
                    // says 11 hours have passed. Same source of truth as
                    // the column timers.
                    const created = safeDate(ticket.createdAt);
                    const ageHours = created ? getBusinessElapsedMs(created, new Date()) / 3600000 : 0;
                    const isUrgent = ageHours >= 4 && (ticket.ticketStatus === "queued" || ticket.ticketStatus === "pending");
                    const isAging = ageHours >= 2 && ageHours < 4 && (ticket.ticketStatus === "queued" || ticket.ticketStatus === "pending");

                    return (
                      <TableRow
                        key={ticket.id}
                        className={`cursor-pointer hover:bg-muted/50 transition-colors ${isUrgent ? "bg-red-50 dark:bg-red-950/20" : isAging ? "bg-amber-50 dark:bg-amber-950/20" : ""}`}
                        onClick={() => setSelectedTicketId(ticket.id)}
                        data-testid={`ticket-row-${ticket.id}`}
                      >
                        <TableCell className="font-mono font-semibold text-sm text-primary underline-offset-2 hover:underline" data-testid={`so-${ticket.id}`}>
                          {ticket.serviceOrder}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${getStatusColor(ticket.ticketStatus)}`}>
                              {getStatusLabel(ticket.ticketStatus)}
                            </span>
                            {ticket.requestType === "parts_nla" && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200 border border-amber-300 dark:border-amber-700">
                                NLA
                              </span>
                            )}
                            {isUrgent && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-red-500 text-white">
                                URGENT
                              </span>
                            )}
                            {isAging && (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500 text-white">
                                AGING
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell data-testid={`assigned-${ticket.id}`}>
                          {ticket.assignedAgentName
                            ? <span className="text-sm font-medium">{ticket.assignedAgentName}</span>
                            : <span className="text-sm text-muted-foreground italic">Unassigned</span>
                          }
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">{ticket.technicianName || "—"}</div>
                          <div className="text-xs text-muted-foreground">{ticket.technicianLdapId || ""}</div>
                        </TableCell>
                        <TableCell className="text-sm">
                          {DIVISION_LABELS[ticket.applianceType] || ticket.applianceType}
                        </TableCell>
                        <TableCell className="text-sm">
                          {ticket.warrantyType === "sears_protect" ? "Sears Protect" :
                           ticket.warrantyType === "ahs" ? "AHS" :
                           ticket.warrantyType === "first_american" ? "First American" :
                           ticket.warrantyType || "—"}
                        </TableCell>
                        <TableCell className="text-sm" data-testid={`intake-form-complete-${ticket.id}`}>
                          {/* Tyler 2026-04-30: Intake Form Complete column.
                              Derived status (see shared/intake-form-config.ts)
                              folds together completion timestamp, parts_nla
                              request type, the INTAKE_FORM_GO_LIVE_UTC cutoff
                              (8 AM Eastern May 1, 2026 — anything created
                              before pre-dates the workflow and was handled by
                              the prior separate intake form process), and the
                              ticket's approval state. The same helper backs
                              the server-side gate in routes.ts so the column
                              and the API stay in lockstep. */}
                          {(() => {
                            const intakeStatus = deriveIntakeFormStatus({
                              createdAt: ticket.createdAt,
                              ticketStatus: ticket.ticketStatus,
                              requestType: ticket.requestType,
                              intakeFormCompletedAt: ticket.intakeFormCompletedAt,
                            });
                            if (intakeStatus === "completed") {
                              return (
                                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
                                  <CheckCircle2 className="w-4 h-4" />
                                  <span className="text-xs">{getTimeInStatus(ticket.intakeFormCompletedAt)} ago</span>
                                </span>
                              );
                            }
                            if (intakeStatus === "not_applicable") {
                              const reason = ticket.requestType === "parts_nla"
                                ? "Not applicable for parts NLA tickets"
                                : "Pre-dates the intake form workflow — handled through the prior process";
                              return (
                                <span className="text-muted-foreground italic text-xs" title={reason}>N/A</span>
                              );
                            }
                            if (intakeStatus === "awaiting") {
                              return (
                                <span className="inline-flex items-center gap-1.5 text-amber-700 dark:text-amber-400 font-medium">
                                  <Clock className="w-4 h-4" />
                                  <span className="text-xs">Awaiting agent</span>
                                </span>
                              );
                            }
                            return <span className="text-muted-foreground text-xs">—</span>;
                          })()}
                        </TableCell>
                        <TableCell className="text-sm text-right whitespace-nowrap text-muted-foreground" data-testid={`last-updated-${ticket.id}`}>
                          {formatDate(ticket.updatedAt || ticket.statusChangedAt || ticket.createdAt, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
                        </TableCell>
                        <TableCell className="text-sm font-medium text-right whitespace-nowrap">
                          {ticket.claimedAt
                            ? getTimeInStatus(ticket.createdAt, ticket.claimedAt)
                            : ticket.ticketStatus === "queued"
                            ? <span className="text-amber-600 dark:text-amber-400">{getTimeInStatus(ticket.createdAt)} ⏳</span>
                            : getTimeInStatus(ticket.createdAt, ticket.statusChangedAt)
                          }
                        </TableCell>
                        <TableCell className="text-sm text-right whitespace-nowrap" data-testid={`handle-time-${ticket.id}`}>
                          {ticket.claimedAt
                            ? ticket.ticketStatus === "pending"
                              ? <span className="text-blue-600 dark:text-blue-400">{getTimeInStatus(ticket.claimedAt)} ⏳</span>
                              : getTimeInStatus(ticket.claimedAt, ticket.statusChangedAt)
                            : "—"
                          }
                        </TableCell>
                        <TableCell className="text-sm text-right whitespace-nowrap" data-testid={`total-time-${ticket.id}`}>
                          {["completed", "approved", "rejected", "rejected_closed", "invalid"].includes(ticket.ticketStatus)
                            ? getTimeInStatus(ticket.createdAt, ticket.statusChangedAt)
                            : <span className="text-muted-foreground">{getTimeInStatus(ticket.createdAt)}</span>
                          }
                        </TableCell>
                        {(statusFilter === "queued" || statusFilter === "pending" || statusFilter === "all") && (
                          <TableCell className="text-right">
                            {(ticket.ticketStatus === "queued" || ticket.ticketStatus === "pending") && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setReassignTicket(ticket);
                                  setReassignTarget("");
                                  setReassignNotes("");
                                }}
                                data-testid={`button-reassign-${ticket.id}`}
                              >
                                <ArrowLeftRight className="w-3.5 h-3.5 mr-1" />
                                Reassign
                              </Button>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {statusFilter === "queued" && filteredTickets.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Sorted oldest first (FIFO). Oldest tickets should be picked up first.
        </p>
      )}

      <TicketDetailDialog
        ticketId={selectedTicketId}
        open={selectedTicketId !== null}
        onClose={() => setSelectedTicketId(null)}
      />

      <Dialog open={reassignTicket !== null} onOpenChange={(open) => { if (!open) { setReassignTicket(null); setReassignTarget(""); setReassignNotes(""); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle data-testid="text-reassign-title">Reassign Ticket</DialogTitle>
            <DialogDescription>
              SO# {reassignTicket?.serviceOrder} — {DIVISION_LABELS[reassignTicket?.applianceType] || reassignTicket?.applianceType}
              {reassignTicket?.assignedAgentName && (
                <span className="block mt-1">Currently assigned to: <strong>{reassignTicket.assignedAgentName}</strong></span>
              )}
              {!reassignTicket?.assignedAgentName && reassignTicket?.ticketStatus === "queued" && (
                <span className="block mt-1">Currently unassigned (in queue)</span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Assign to</Label>
              <Select value={reassignTarget} onValueChange={setReassignTarget}>
                <SelectTrigger data-testid="select-reassign-target">
                  <SelectValue placeholder="Select an option..." />
                </SelectTrigger>
                <SelectContent>
                  {reassignTicket?.ticketStatus === "pending" && (
                    <SelectItem value="queue" data-testid="option-return-queue">
                      <span className="flex items-center gap-2">
                        <Undo2 className="w-3.5 h-3.5" />
                        Reassign to Queue (unassign)
                      </span>
                    </SelectItem>
                  )}
                  {availableAgents.map((agent: any) => (
                    <SelectItem
                      key={agent.id}
                      value={String(agent.id)}
                      data-testid={`option-agent-${agent.id}`}
                      disabled={reassignTicket?.assignedTo === agent.id}
                    >
                      {agent.name} ({agent.role === "vrs_agent" ? "Agent" : agent.role === "admin" ? "Admin" : "Super Admin"})
                      {reassignTicket?.assignedTo === agent.id ? " (current)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Input
                value={reassignNotes}
                onChange={(e) => setReassignNotes(e.target.value)}
                placeholder="Reason for reassignment..."
                data-testid="input-reassign-notes"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReassignTicket(null); setReassignTarget(""); setReassignNotes(""); }} data-testid="button-cancel-reassign">
              Cancel
            </Button>
            <Button
              onClick={handleReassignSubmit}
              disabled={!reassignTarget || reassignMutation.isPending}
              data-testid="button-confirm-reassign"
            >
              {reassignMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <ArrowLeftRight className="w-4 h-4 mr-2" />
              )}
              {reassignTarget === "queue" ? "Reassign to Queue" : "Reassign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TechnicianSyncSection() {
  const { toast } = useToast();
  const [syncResult, setSyncResult] = useState<{
    synced: number;
    added: number;
    updated: number;
    deactivated: number;
  } | null>(null);

  const metricsQuery = useQuery({
    queryKey: ["/api/admin/technician-metrics"],
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/sync-technicians");
      return await res.json();
    },
    onSuccess: (data: any) => {
      setSyncResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/admin/technician-metrics"] });
      toast({ title: "Sync Complete", description: `${data.synced} technicians synced from Snowflake.` });
    },
    onError: (error: Error) => {
      toast({ title: "Sync Failed", description: error.message, variant: "destructive" });
    },
  });

  const [backfillResult, setBackfillResult] = useState<{
    total: number;
    needingBackfill: number;
    updated: number;
    notFound: number;
  } | null>(null);

  const backfillMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/backfill-proc-ids");
      return await res.json();
    },
    onSuccess: (data: any) => {
      setBackfillResult(data);
      toast({ title: "Backfill Complete", description: `${data.updated} tickets updated with ProcID/Client data.` });
    },
    onError: (error: Error) => {
      toast({ title: "Backfill Failed", description: error.message, variant: "destructive" });
    },
  });

  const metrics = metricsQuery.data as { activeCount: number; lastSyncedAt: string | null } | undefined;

  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Snowflake Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-sm text-muted-foreground">Active Technicians</p>
              <p className="text-2xl font-bold" data-testid="text-tech-count">
                {metricsQuery.isLoading ? "..." : metrics?.activeCount || 0}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last Synced</p>
              <p className="text-sm font-medium" data-testid="text-last-sync">
                {metricsQuery.isLoading
                  ? "..."
                  : metrics?.lastSyncedAt
                    ? formatDate(metrics.lastSyncedAt)
                    : "Never"}
              </p>
            </div>
          </div>
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="button-sync-techs"
          >
            {syncMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Syncing from Snowflake...
              </>
            ) : (
              <>
                <Database className="w-4 h-4 mr-2" />
                Sync Now
              </>
            )}
          </Button>
          {syncResult && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-2">Sync Results</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Total Synced:</span>{" "}
                    <span className="font-medium" data-testid="text-sync-total">{syncResult.synced}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">New:</span>{" "}
                    <span className="font-medium text-green-600" data-testid="text-sync-added">{syncResult.added}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Updated:</span>{" "}
                    <span className="font-medium" data-testid="text-sync-updated">{syncResult.updated}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Deactivated:</span>{" "}
                    <span className="font-medium text-red-600" data-testid="text-sync-deactivated">{syncResult.deactivated}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">ProcID / Client Backfill</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Backfill ProcID and Client Name from Snowflake for existing tickets that are missing this data.
            New tickets are populated automatically at submission time.
          </p>
          <Button
            onClick={() => backfillMutation.mutate()}
            disabled={backfillMutation.isPending}
            data-testid="button-backfill-proc-ids"
          >
            {backfillMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Backfilling from Snowflake...
              </>
            ) : (
              <>
                <Database className="w-4 h-4 mr-2" />
                Backfill ProcIDs
              </>
            )}
          </Button>
          {backfillResult && (
            <Card>
              <CardContent className="p-4">
                <p className="text-sm font-medium mb-2">Backfill Results</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Total Tickets:</span>{" "}
                    <span className="font-medium" data-testid="text-backfill-total">{backfillResult.total}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Needed Backfill:</span>{" "}
                    <span className="font-medium" data-testid="text-backfill-missing">{backfillResult.needingBackfill}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Updated:</span>{" "}
                    <span className="font-medium text-green-600" data-testid="text-backfill-updated">{backfillResult.updated}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Not Found:</span>{" "}
                    <span className="font-medium text-muted-foreground" data-testid="text-backfill-notfound">{backfillResult.notFound}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How Technician Login Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p>Field technicians sign in using only their LDAP ID — no password required.</p>
          <p>Technician records are synced from Snowflake. Only active technicians that appear in the Snowflake query can sign in.</p>
          <p>On sign-in, technicians can flag if their phone number has changed and provide an updated number for SMS notifications.</p>
        </CardContent>
      </Card>
    </div>
  );
}

const FEEDBACK_TYPE_LABELS: Record<string, string> = {
  issue: "Issue",
  improvement: "Improvement Request",
  general: "General Feedback",
};

const FEEDBACK_STATUS_LABELS: Record<string, string> = {
  new: "New",
  in_progress: "In Progress",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

function FeedbackSection() {
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [adminNotes, setAdminNotes] = useState("");

  const { data: feedbackData, isLoading } = useQuery<{ feedback: any[] }>({
    queryKey: ["/api/feedback"],
    refetchInterval: 30000,
    staleTime: 20000,
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, status, adminNotes }: { id: number; status?: string; adminNotes?: string }) => {
      const res = await apiRequest("PATCH", `/api/feedback/${id}`, { status, adminNotes });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/feedback"] });
      toast({ title: "Feedback Updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update Failed", description: err.message, variant: "destructive" });
    },
  });

  const items = feedbackData?.feedback || [];
  const filtered = statusFilter === "all" ? items : items.filter((f: any) => f.status === statusFilter);

  const counts = {
    all: items.length,
    new: items.filter((f: any) => f.status === "new").length,
    in_progress: items.filter((f: any) => f.status === "in_progress").length,
    resolved: items.filter((f: any) => f.status === "resolved").length,
    dismissed: items.filter((f: any) => f.status === "dismissed").length,
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        {[
          { key: "all", label: "All" },
          { key: "new", label: "New" },
          { key: "in_progress", label: "In Progress" },
          { key: "resolved", label: "Resolved" },
          { key: "dismissed", label: "Dismissed" },
        ].map((tab) => (
          <Button
            key={tab.key}
            variant={statusFilter === tab.key ? "default" : "outline"}
            size="sm"
            onClick={() => setStatusFilter(tab.key)}
            data-testid={`filter-feedback-${tab.key}`}
          >
            {tab.label} ({counts[tab.key as keyof typeof counts]})
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-20 bg-muted rounded-md animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground" data-testid="text-no-feedback">
            No feedback items found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((fb: any) => {
            const isExpanded = expandedId === fb.id;
            return (
              <Card key={fb.id} data-testid={`feedback-item-${fb.id}`}>
                <CardContent className="p-4">
                  <div
                    className="cursor-pointer"
                    onClick={() => {
                      if (isExpanded) {
                        setExpandedId(null);
                      } else {
                        setExpandedId(fb.id);
                        setAdminNotes(fb.adminNotes || "");
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm" data-testid={`text-feedback-tech-${fb.id}`}>
                            {fb.technicianName}
                          </span>
                          <span className="text-xs text-muted-foreground">({fb.technicianRacId})</span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2" data-testid={`text-feedback-desc-${fb.id}`}>
                          {fb.description}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <Badge
                          variant={fb.status === "new" ? "default" : fb.status === "in_progress" ? "secondary" : fb.status === "resolved" ? "outline" : "destructive"}
                          data-testid={`badge-feedback-status-${fb.id}`}
                        >
                          {FEEDBACK_STATUS_LABELS[fb.status] || fb.status}
                        </Badge>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="outline" className="text-xs">
                            {FEEDBACK_TYPE_LABELS[fb.feedbackType] || fb.feedbackType}
                          </Badge>
                          <Badge
                            variant="outline"
                            className={`text-xs ${
                              fb.priority === "high" ? "border-red-300 text-red-700 dark:border-red-700 dark:text-red-400" :
                              fb.priority === "medium" ? "border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-400" :
                              ""
                            }`}
                          >
                            {fb.priority}
                          </Badge>
                        </div>
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground mt-2">
                      {formatDate(fb.createdAt)}
                      {fb.resolvedByName && (
                        <span> - Resolved by {fb.resolvedByName}</span>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-4 pt-4 border-t space-y-3">
                      <div>
                        <Label className="text-xs font-medium text-muted-foreground">Full Description</Label>
                        <p className="text-sm mt-1 whitespace-pre-wrap" data-testid={`text-feedback-full-desc-${fb.id}`}>{fb.description}</p>
                      </div>

                      {fb.attachmentUrl && (
                        <div>
                          <Label className="text-xs font-medium text-muted-foreground">Attachment</Label>
                          <a
                            href={fb.attachmentUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-primary hover:underline block mt-1"
                            data-testid={`link-feedback-attachment-${fb.id}`}
                          >
                            View Attachment
                          </a>
                        </div>
                      )}

                      <div className="space-y-1.5">
                        <Label className="text-xs font-medium text-muted-foreground">Admin Notes</Label>
                        <Textarea
                          value={adminNotes}
                          onChange={(e) => setAdminNotes(e.target.value)}
                          placeholder="Add notes about this feedback..."
                          rows={2}
                          data-testid={`input-admin-notes-${fb.id}`}
                        />
                      </div>

                      <div className="flex items-center gap-2 flex-wrap">
                        <Label className="text-xs font-medium text-muted-foreground shrink-0">Set Status:</Label>
                        {(["new", "in_progress", "resolved", "dismissed"] as const).map((s) => (
                          <Button
                            key={s}
                            size="sm"
                            variant={fb.status === s ? "default" : "outline"}
                            disabled={updateMutation.isPending}
                            onClick={() => updateMutation.mutate({ id: fb.id, status: s, adminNotes })}
                            data-testid={`button-set-status-${s}-${fb.id}`}
                          >
                            {FEEDBACK_STATUS_LABELS[s]}
                          </Button>
                        ))}
                      </div>

                      {adminNotes !== (fb.adminNotes || "") && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={updateMutation.isPending}
                          onClick={() => updateMutation.mutate({ id: fb.id, adminNotes })}
                          data-testid={`button-save-notes-${fb.id}`}
                        >
                          Save Notes
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [activeView, setActiveView] = useState<ActiveView>("users");
  useEffect(() => {
    loadNotificationSettings();
  }, []);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<SafeUser | null>(null);
  const [formName, setFormName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formRole, setFormRole] = useState("technician");
  const [formPhone, setFormPhone] = useState("");
  const [formRacId, setFormRacId] = useState("");
  const [formDivisions, setFormDivisions] = useState<string[]>([]);
  const [formCanOrderParts, setFormCanOrderParts] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [selectedDivisions, setSelectedDivisions] = useState<string[]>([]);
  const [deactivateConfirm, setDeactivateConfirm] = useState<{ id: number; name: string; isActive: boolean } | null>(null);
  const [resetPwConfirm, setResetPwConfirm] = useState<{ id: number; name: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; name: string } | null>(null);
  const [rgcDate, setRgcDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rgcDigits, setRgcDigits] = useState("");
  const [adminStatus, setAdminStatus] = useState<string>((user as any)?.agentStatus || "offline");

  useEffect(() => {
    if (user && (user as any).agentStatus) {
      setAdminStatus((user as any).agentStatus);
    }
  }, [user]);

  const { subscribe } = useWebSocket(user?.role);

  useEffect(() => {
    const unsub = subscribe("agent_status_changed", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/agent-status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    });

    const unsub2 = subscribe("new_ticket", (payload: any) => {
      playNotificationDing();
      const title = `New ${payload.applianceLabel} ticket, ${payload.warrantyLabel}`;
      const desc = `SO #${payload.serviceOrder}`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/analytics"] });
    });

    const unsub3 = subscribe("ticket_queued", (payload: any) => {
      playNotificationDing();
      const title = `Ticket returned to queue`;
      const desc = `${payload.applianceLabel} - ${payload.warrantyLabel} (SO #${payload.serviceOrder})`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/analytics"] });
    });

    const unsub4 = subscribe("pending_tickets", (payload: any) => {
      const title = `Queued ${payload.applianceLabel} ticket, ${payload.warrantyLabel}`;
      const desc = `SO #${payload.serviceOrder} waiting in queue`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/analytics"] });
    });

    return () => { unsub(); unsub2(); unsub3(); unsub4(); };
  }, [subscribe]);

  const [userTab, setUserTab] = useState<"staff" | "technicians">("staff");
  const [techSearchQuery, setTechSearchQuery] = useState("");
  const [techSortField, setTechSortField] = useState<"name" | "district" | "totalTickets">("name");
  const [techSortDir, setTechSortDir] = useState<"asc" | "desc">("asc");

  const { data: usersData, isLoading: usersLoading } = useQuery<{ users: SafeUser[] }>({
    queryKey: ["/api/admin/users"],
  });

  const users = usersData?.users || [];
  const vrsAgents = users.filter((u) => u.role === "vrs_agent");

  const { data: techUsersData, isLoading: techUsersLoading } = useQuery<{ technicians: TechnicianUserView[] }>({
    queryKey: ["/api/admin/technician-users"],
    enabled: activeView === "users",
  });

  const { data: specData, isLoading: specLoading } = useQuery<{
    specializations: { id: number; userId: number; division: string }[];
  }>({
    queryKey: ["/api/admin/users", selectedAgentIds.length === 1 ? String(selectedAgentIds[0]) : "", "specializations"],
    enabled: selectedAgentIds.length === 1,
  });

  const { data: analyticsData, isLoading: analyticsLoading } = useQuery<AnalyticsData>({
    queryKey: ["/api/admin/analytics"],
    enabled: activeView === "analytics",
  });

  const { data: resubmissionData } = useQuery<ResubmissionStats>({
    queryKey: ["/api/admin/analytics/resubmissions"],
    enabled: activeView === "analytics",
  });

  const { data: districtData } = useQuery<DistrictRollup[]>({
    queryKey: ["/api/admin/analytics/districts"],
    enabled: activeView === "analytics",
  });

  const { data: nlaAnalytics } = useQuery<{ today: number; week: number; month: number; allTime: number }>({
    queryKey: ["/api/admin/nla-analytics"],
    enabled: activeView === "analytics",
  });

  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [exportTechLdap, setExportTechLdap] = useState("");

  const setExportPreset = (preset: string) => {
    const now = new Date();
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    if (preset === "today") {
      setExportStartDate(fmt(now));
      setExportEndDate(fmt(now));
    } else if (preset === "week") {
      const day = now.getDay();
      const start = new Date(now);
      start.setDate(now.getDate() - day);
      setExportStartDate(fmt(start));
      setExportEndDate(fmt(now));
    } else if (preset === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      setExportStartDate(fmt(start));
      setExportEndDate(fmt(now));
    } else {
      setExportStartDate("");
      setExportEndDate("");
    }
  };

  const handleExportCsv = async () => {
    try {
      setExportingRange("exporting");
      const token = getToken();
      const params = new URLSearchParams();
      if (exportStartDate) params.set("startDate", exportStartDate);
      if (exportEndDate) params.set("endDate", exportEndDate);
      if (exportTechLdap.trim()) params.set("techLdap", exportTechLdap.trim());
      if (!exportStartDate && !exportEndDate) params.set("range", "all");
      const res = await fetch(`/api/admin/export-csv?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || "vrs-export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: "Export Complete", description: "CSV file downloaded successfully." });
    } catch {
      toast({ title: "Export Failed", description: "Could not export CSV file.", variant: "destructive" });
    } finally {
      setExportingRange(null);
    }
  };

  const handleExportXlsx = async () => {
    try {
      setExportingRange("exporting_xlsx");
      const token = getToken();
      const params = new URLSearchParams();
      if (exportStartDate) params.set("startDate", exportStartDate);
      if (exportEndDate) params.set("endDate", exportEndDate);
      if (exportTechLdap.trim()) params.set("techLdap", exportTechLdap.trim());
      if (!exportStartDate && !exportEndDate) params.set("range", "all");
      const res = await fetch(`/api/admin/export-xlsx?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || "vrs-export.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: "Export Complete", description: "XLSX file downloaded successfully (2 sheets: Authorization + NLA)." });
    } catch {
      toast({ title: "Export Failed", description: "Could not export XLSX file.", variant: "destructive" });
    } finally {
      setExportingRange(null);
    }
  };

  const rgcQueryUrl = `/api/admin/rgc-code?date=${rgcDate}`;
  const { data: currentRgc, isLoading: rgcLoading } = useQuery<{
    rgcCode: { id: number; code: string; validDate: string; createdBy: number | null; createdAt: string } | null;
    createdByName?: string;
  }>({
    queryKey: [rgcQueryUrl],
    enabled: activeView === "rgc",
  });

  useEffect(() => {
    if (selectedAgentIds.length === 1 && specData?.specializations) {
      setSelectedDivisions(specData.specializations.map((s) => s.division));
    } else if (selectedAgentIds.length !== 1) {
      setSelectedDivisions([]);
    }
  }, [specData, selectedAgentIds]);

  const saveDivisionsForUser = async (userId: number, divisions: string[]) => {
    await apiRequest("PATCH", `/api/admin/users/${userId}/specializations`, { divisions });
    queryClient.invalidateQueries({
      predicate: (q) => (q.queryKey[0] as string)?.includes("/api/admin/users") && q.queryKey[2] === "specializations",
    });
  };

  const createUserMutation = useMutation({
    mutationFn: async (data: {
      name: string;
      email: string;
      password: string;
      role: string;
      phone?: string;
      racId?: string;
    }) => {
      const res = await apiRequest("POST", "/api/admin/users", data);
      return res.json();
    },
    onSuccess: async (result: any) => {
      if (formRole === "vrs_agent" && result?.user?.id) {
        try {
          await saveDivisionsForUser(result.user.id, formDivisions);
        } catch {
          toast({ title: "Warning", description: "User created but division assignment failed.", variant: "destructive" });
        }
      }
      toast({ title: "User Created", description: "New user has been created successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      closeDialog();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateUserMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}`, data);
      return res.json();
    },
    onSuccess: async (_result: any, variables: { id: number; data: Record<string, unknown> }) => {
      if (formRole === "vrs_agent") {
        try {
          await saveDivisionsForUser(variables.id, formDivisions);
        } catch {
          toast({ title: "Warning", description: "User updated but division assignment failed.", variant: "destructive" });
        }
      }
      toast({ title: "User Updated", description: "User has been updated successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      closeDialog();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Status Updated", description: "User status has been updated." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const adminStatusMutation = useMutation({
    mutationFn: async (status: string) => {
      const res = await apiRequest("PATCH", "/api/agent/status", { status });
      return res.json();
    },
    onSuccess: (_: any, status: string) => {
      setAdminStatus(status);
      toast({ title: status === "online" ? "You are now Online" : "You are now Offline" });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const resetPasswordMutation = useMutation({
    mutationFn: async ({ id }: { id: number }) => {
      const res = await apiRequest("PATCH", `/api/admin/users/${id}`, { resetPassword: true });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Password Reset", description: "User must change password on next login." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setResetPwConfirm(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteUserMutation = useMutation({
    mutationFn: async ({ id }: { id: number }) => {
      const res = await apiRequest("DELETE", `/api/admin/users/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "User Deleted", description: "User deleted successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setDeleteConfirm(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const importUsersMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/import-users");
      return res.json();
    },
    onSuccess: (data: any) => {
      toast({
        title: "Import Complete",
        description: `Imported: ${data.imported}, Skipped: ${data.skipped}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
    },
    onError: (err: Error) => {
      toast({ title: "Import Failed", description: err.message, variant: "destructive" });
    },
  });

  const saveDivisionsMutation = useMutation({
    mutationFn: async ({ ids, divisions }: { ids: number[]; divisions: string[] }) => {
      const results = await Promise.all(
        ids.map((id) => apiRequest("PATCH", `/api/admin/users/${id}/specializations`, { divisions }))
      );
      const res = results[0];
      return res.json();
    },
    onSuccess: () => {
      const agentCount = selectedAgentIds.length;
      toast({ title: "Divisions Saved", description: `Division assignments updated for ${agentCount} agent${agentCount > 1 ? "s" : ""}.` });
      queryClient.invalidateQueries({
        predicate: (q) => (q.queryKey[0] as string)?.includes("/api/admin/users") && (q.queryKey[2] === "specializations"),
      });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const setRgcMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/rgc-code", {
        code: rgcDigits,
        date: rgcDate,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "RGC Code Set", description: `Code RGC${rgcDigits} set for ${rgcDate}` });
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/admin/rgc-code") });
      setRgcDigits("");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const openCreateDialog = () => {
    setEditingUser(null);
    setFormName("");
    setFormEmail("");
    setFormPassword("");
    setFormRole("technician");
    setFormPhone("");
    setFormRacId("");
    setFormDivisions([]);
    setFormCanOrderParts(false);
    setDialogOpen(true);
  };

  const openEditDialog = async (u: SafeUser) => {
    setEditingUser(u);
    setFormName(u.name);
    setFormEmail(u.email);
    setFormPassword("");
    setFormRole(u.role);
    setFormPhone(u.phone || "");
    setFormRacId(u.racId || "");
    setFormCanOrderParts(u.canOrderParts || false);
    if (u.role === "vrs_agent") {
      try {
        const res = await fetch(`/api/admin/users/${u.id}/specializations`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (res.ok) {
          const data = await res.json();
          setFormDivisions(data.specializations?.map((s: any) => s.division) || []);
        } else {
          toast({ title: "Warning", description: "Could not load division assignments.", variant: "destructive" });
        }
      } catch {
        toast({ title: "Warning", description: "Could not load division assignments.", variant: "destructive" });
      }
    } else {
      setFormDivisions([]);
    }
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditingUser(null);
  };

  const handleFormSubmit = () => {
    if (editingUser) {
      const data: Record<string, unknown> = {
        name: formName,
        role: formRole,
        phone: formPhone || null,
        racId: formRacId || null,
        canOrderParts: formCanOrderParts,
      };
      if (formPassword) {
        data.password = formPassword;
      }
      updateUserMutation.mutate({ id: editingUser.id, data });
    } else {
      createUserMutation.mutate({
        name: formName,
        password: formPassword,
        role: formRole,
        phone: formPhone || undefined,
        racId: formRacId || undefined,
      });
    }
  };

  const toggleDivision = (division: string) => {
    setSelectedDivisions((prev) =>
      prev.includes(division) ? prev.filter((d) => d !== division) : [...prev, division]
    );
  };

  const toggleAllDivisions = () => {
    if (selectedDivisions.length === DIVISION_KEYS.length) {
      setSelectedDivisions([]);
    } else {
      setSelectedDivisions([...DIVISION_KEYS]);
    }
  };

  const isGeneralist = selectedDivisions.length === DIVISION_KEYS.length;
  const isFormPending = createUserMutation.isPending || updateUserMutation.isPending;

  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full" data-testid="admin-dashboard">
        <Sidebar>
          <SidebarHeader className="p-4">
            <div className="flex items-center gap-2">
              <img src={searsLogo} alt="Sears Home Services" className="h-7" data-testid="img-logo" />
              <span className="font-semibold text-sm" data-testid="text-sidebar-title">Admin Panel</span>
            </div>
            <div className="flex items-center justify-between mt-1">
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${adminStatus === "online" ? "bg-green-500" : "bg-gray-400"}`}
                  data-testid="indicator-admin-status"
                />
                <span className="text-xs text-muted-foreground" data-testid="text-admin-name">{user?.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">{adminStatus === "online" ? "Online" : "Offline"}</span>
                <Switch
                  checked={adminStatus === "online"}
                  onCheckedChange={(checked) => adminStatusMutation.mutate(checked ? "online" : "offline")}
                  disabled={adminStatusMutation.isPending}
                  data-testid="toggle-admin-status"
                  className="scale-75"
                />
              </div>
            </div>
          </SidebarHeader>

          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Management</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("users")}
                      data-active={activeView === "users"}
                      data-testid="nav-users"
                    >
                      <Users className="w-4 h-4" />
                      <span>User Management</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("divisions")}
                      data-active={activeView === "divisions"}
                      data-testid="nav-divisions"
                    >
                      <GitBranch className="w-4 h-4" />
                      <span>Division Assignments</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("rgc")}
                      data-active={activeView === "rgc"}
                      data-testid="nav-rgc"
                    >
                      <Key className="w-4 h-4" />
                      <span>RGC Codes</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("analytics")}
                      data-active={activeView === "analytics"}
                      data-testid="nav-analytics"
                    >
                      <BarChart3 className="w-4 h-4" />
                      <span>Analytics</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("technicians")}
                      data-active={activeView === "technicians"}
                      data-testid="nav-technicians"
                    >
                      <Database className="w-4 h-4" />
                      <span>Technician Sync</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("agent-status")}
                      data-active={activeView === "agent-status"}
                      data-testid="nav-agent-status"
                    >
                      <Users className="w-4 h-4" />
                      <span>Agent Status</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Views</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("tickets")}
                      data-active={activeView === "tickets"}
                      data-testid="nav-tickets"
                    >
                      <FileText className="w-4 h-4" />
                      <span>Ticket Overview</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("feedback")}
                      data-active={activeView === "feedback"}
                      data-testid="nav-feedback"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span>Technician Feedback</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => navigate("/agent/dashboard")}
                      data-testid="nav-agent-view"
                    >
                      <ClipboardList className="w-4 h-4" />
                      <span>Agent Queue View</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => navigate("/admin/communications")}
                      data-testid="nav-communication-templates"
                    >
                      <MessageSquare className="w-4 h-4" />
                      <span>Communication Templates</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>

          <SidebarFooter className="p-4 space-y-1">
            <NotificationSettings />
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={() => navigate("/help")}
              data-testid="nav-help"
            >
              <LifeBuoy className="w-4 h-4" />
              <span>Help Center</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={toggleTheme}
              data-testid="button-toggle-theme"
            >
              {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
              <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={async () => {
                await apiRequest("PATCH", "/api/users/me", { firstLogin: true });
                toast({ title: "Tutorial will show on next login" });
              }}
              data-testid="button-restart-tutorial"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Restart Tutorial</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-2"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4" />
              <span>Logout</span>
            </Button>
          </SidebarFooter>
        </Sidebar>

        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between gap-2 p-3 border-b sticky top-0 z-50 bg-background">
            <div className="flex items-center gap-2">
              <SidebarTrigger data-testid="button-sidebar-toggle" />
              <h1 className="text-lg font-semibold" data-testid="text-page-title">
                {activeView === "users" && "User Management"}
                {activeView === "divisions" && "Division Assignments"}
                {activeView === "rgc" && "Daily RGC Code"}
                {activeView === "analytics" && "Analytics"}
                {activeView === "technicians" && "Technician Sync"}
                {activeView === "agent-status" && "Agent Status"}
                {activeView === "tickets" && "Ticket Overview"}
                {activeView === "feedback" && "Technician Feedback"}
              </h1>
            </div>
            {activeView === "users" && userTab === "staff" && (
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="secondary"
                  onClick={() => importUsersMutation.mutate()}
                  disabled={importUsersMutation.isPending}
                  data-testid="button-import-users"
                >
                  {importUsersMutation.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <FileText className="w-4 h-4 mr-2" />
                  )}
                  Import Users
                </Button>
                <Button onClick={openCreateDialog} data-testid="button-create-user">
                  <UserPlus className="w-4 h-4 mr-2" />
                  Create User
                </Button>
              </div>
            )}
          </header>

          <div className="flex-1 overflow-auto">
            {activeView === "users" && (
              <div className="p-4">
                <div className="flex items-center gap-1 mb-4 border-b" data-testid="user-management-tabs">
                  <div
                    onClick={() => setUserTab("staff")}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer select-none ${userTab === "staff" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    data-testid="tab-staff"
                    role="tab"
                    aria-selected={userTab === "staff"}
                  >
                    <div className="flex items-center gap-2">
                      <Users className="w-4 h-4" />
                      Staff
                      <span className="inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground" data-testid="badge-staff-count">{users.length}</span>
                    </div>
                  </div>
                  <div
                    onClick={() => setUserTab("technicians")}
                    className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors cursor-pointer select-none ${userTab === "technicians" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                    data-testid="tab-field-technicians"
                    role="tab"
                    aria-selected={userTab === "technicians"}
                  >
                    <div className="flex items-center gap-2">
                      <Wrench className="w-4 h-4" />
                      Field Technicians
                      <span className="inline-flex items-center rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground" data-testid="badge-tech-count">{techUsersData?.technicians?.length ?? 0}</span>
                    </div>
                  </div>
                </div>

                {userTab === "staff" && (
                  <>
                    <div className="relative mb-4">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="Search users by name, LDAP ID, role, or phone..."
                        value={userSearchQuery}
                        onChange={(e) => setUserSearchQuery(e.target.value)}
                        className="pl-9 pr-9"
                        data-testid="input-user-search"
                      />
                      {userSearchQuery && (
                        <button
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() => setUserSearchQuery("")}
                          data-testid="button-clear-user-search"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {usersLoading ? (
                      <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                          <div key={i} className="h-14 bg-muted rounded-md animate-pulse" />
                        ))}
                      </div>
                    ) : (
                      <div className="overflow-x-auto -mx-4 pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
                        <Table data-testid="table-users" className="min-w-[700px] mx-4">
                        <TableHeader>
                          <TableRow>
                            <TableHead>Name</TableHead>
                            <TableHead>Role</TableHead>
                            <TableHead className="hidden sm:table-cell">Phone</TableHead>
                            <TableHead>RAC ID</TableHead>
                            <TableHead className="hidden sm:table-cell">Password Status</TableHead>
                            <TableHead>
                              <div className="flex items-center gap-1.5">
                                Status
                                <HelpTooltip content="Deactivated users cannot log in. Their pending submissions remain in the queue." />
                              </div>
                            </TableHead>
                            <TableHead>Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {users.filter((u) => {
                            if (!userSearchQuery) return true;
                            const q = userSearchQuery.toLowerCase();
                            return (
                              u.name?.toLowerCase().includes(q) ||
                              u.racId?.toLowerCase().includes(q) ||
                              u.role?.toLowerCase().includes(q) ||
                              u.phone?.toLowerCase().includes(q) ||
                              u.email?.toLowerCase().includes(q)
                            );
                          }).map((u) => (
                            <TableRow key={u.id} data-testid={`row-user-${u.id}`}>
                              <TableCell data-testid={`text-user-name-${u.id}`}>{u.name}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1.5">
                                  <Badge
                                    variant={ROLE_BADGE_VARIANT[u.role] || "default"}
                                    data-testid={`badge-role-${u.id}`}
                                  >
                                    {ROLE_LABELS[u.role] || u.role}
                                  </Badge>
                                  {u.canOrderParts && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-emerald-500 text-emerald-700 dark:text-emerald-400 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-pcard-${u.id}`}>
                                      <CreditCard className="w-3 h-3 mr-0.5" />P-Card
                                    </Badge>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell className="hidden sm:table-cell" data-testid={`text-user-phone-${u.id}`}>{u.phone || "-"}</TableCell>
                              <TableCell data-testid={`text-user-racid-${u.id}`}>{u.racId || "-"}</TableCell>
                              <TableCell className="hidden sm:table-cell" data-testid={`text-pw-status-${u.id}`}>
                                {u.mustChangePassword ? (
                                  <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 no-default-hover-elevate no-default-active-elevate">Must Change</Badge>
                                ) : u.passwordChangedAt ? (
                                  <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 no-default-hover-elevate no-default-active-elevate">Changed {formatDateShort(u.passwordChangedAt)}</Badge>
                                ) : (
                                  <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate">Active</Badge>
                                )}
                              </TableCell>
                              <TableCell>
                                <Switch
                                  checked={u.isActive}
                                  onCheckedChange={(checked) => {
                                    if (!checked) {
                                      setDeactivateConfirm({ id: u.id, name: u.name, isActive: false });
                                    } else {
                                      toggleStatusMutation.mutate({ id: u.id, isActive: true });
                                    }
                                  }}
                                  data-testid={`switch-status-${u.id}`}
                                />
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openEditDialog(u)}
                                    data-testid={`button-edit-${u.id}`}
                                  >
                                    <Pencil className="w-4 h-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => setResetPwConfirm({ id: u.id, name: u.name })}
                                    data-testid={`button-reset-pw-${u.id}`}
                                  >
                                    <Key className="w-4 h-4" />
                                  </Button>
                                  {!u.isSystemAccount && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="text-red-600 dark:text-red-400 hover-elevate"
                                      onClick={() => setDeleteConfirm({ id: u.id, name: u.name })}
                                      data-testid={`button-delete-user-${u.id}`}
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      </div>
                    )}
                  </>
                )}

                {userTab === "technicians" && (
                  <>
                    <div className="relative mb-4">
                      <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="Search technicians by name, RAC ID, or district..."
                        value={techSearchQuery}
                        onChange={(e) => setTechSearchQuery(e.target.value)}
                        className="pl-9 pr-9"
                        data-testid="input-tech-search"
                      />
                      {techSearchQuery && (
                        <button
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() => setTechSearchQuery("")}
                          data-testid="button-clear-tech-search"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    {techUsersLoading ? (
                      <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                          <div key={i} className="h-14 bg-muted rounded-md animate-pulse" />
                        ))}
                      </div>
                    ) : (techUsersData?.technicians?.length ?? 0) === 0 ? (
                      <div className="flex flex-col items-center justify-center py-12 text-center" data-testid="tech-empty-state">
                        <Wrench className="w-12 h-12 text-muted-foreground mb-4" />
                        <h3 className="text-lg font-medium mb-2">No field technicians have logged in yet</h3>
                        <p className="text-sm text-muted-foreground max-w-md">Technicians will appear here after their first login.</p>
                      </div>
                    ) : (
                      <div className="overflow-x-auto -mx-4 pb-2" style={{ WebkitOverflowScrolling: "touch" }}>
                        <Table data-testid="table-technicians" className="min-w-[800px] mx-4">
                          <TableHeader>
                            <TableRow>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => { if (techSortField === "name") { setTechSortDir(d => d === "asc" ? "desc" : "asc"); } else { setTechSortField("name"); setTechSortDir("asc"); } }} data-testid="sort-tech-name">
                                  Name <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>RAC ID</TableHead>
                              <TableHead>Phone</TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => { if (techSortField === "district") { setTechSortDir(d => d === "asc" ? "desc" : "asc"); } else { setTechSortField("district"); setTechSortDir("asc"); } }} data-testid="sort-tech-district">
                                  District <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>Manager</TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => { if (techSortField === "totalTickets") { setTechSortDir(d => d === "asc" ? "desc" : "asc"); } else { setTechSortField("totalTickets"); setTechSortDir("desc"); } }} data-testid="sort-tech-tickets">
                                  Total Tickets <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>Pending</TableHead>
                              <TableHead>Approved</TableHead>
                              <TableHead>Rejected</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {(techUsersData?.technicians ?? [])
                              .filter((t) => {
                                if (!techSearchQuery) return true;
                                const q = techSearchQuery.toLowerCase();
                                return (
                                  t.name?.toLowerCase().includes(q) ||
                                  t.racId?.toLowerCase().includes(q) ||
                                  t.district?.toLowerCase().includes(q)
                                );
                              })
                              .sort((a, b) => {
                                const dir = techSortDir === "asc" ? 1 : -1;
                                if (techSortField === "totalTickets") {
                                  return (a.totalTickets - b.totalTickets) * dir;
                                }
                                const aVal = (a[techSortField] || "").toLowerCase();
                                const bVal = (b[techSortField] || "").toLowerCase();
                                return aVal < bVal ? -dir : aVal > bVal ? dir : 0;
                              })
                              .map((t) => (
                                <TableRow key={t.id} data-testid={`row-tech-${t.id}`}>
                                  <TableCell data-testid={`text-tech-name-${t.id}`}>{t.name}</TableCell>
                                  <TableCell data-testid={`text-tech-racid-${t.id}`}>{t.racId || "-"}</TableCell>
                                  <TableCell data-testid={`text-tech-phone-${t.id}`}>{t.phone || "-"}</TableCell>
                                  <TableCell data-testid={`text-tech-district-${t.id}`}>{t.district || "-"}</TableCell>
                                  <TableCell data-testid={`text-tech-manager-${t.id}`}>{t.managerName || "-"}</TableCell>
                                  <TableCell data-testid={`text-tech-total-${t.id}`}>
                                    <Badge variant="secondary" className="no-default-hover-elevate no-default-active-elevate">{t.totalTickets}</Badge>
                                  </TableCell>
                                  <TableCell data-testid={`text-tech-pending-${t.id}`}>
                                    <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 no-default-hover-elevate no-default-active-elevate">{t.pendingCount}</Badge>
                                  </TableCell>
                                  <TableCell data-testid={`text-tech-approved-${t.id}`}>
                                    <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 no-default-hover-elevate no-default-active-elevate">{t.approvedCount}</Badge>
                                  </TableCell>
                                  <TableCell data-testid={`text-tech-rejected-${t.id}`}>
                                    <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 no-default-hover-elevate no-default-active-elevate">{t.rejectedCount}</Badge>
                                  </TableCell>
                                </TableRow>
                              ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {activeView === "divisions" && (
              <div className="p-4 space-y-4">
                <Card className="max-w-lg">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <CardTitle className="text-base">Select VRS Agents</CardTitle>
                      {selectedAgentIds.length > 0 && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" data-testid="badge-selected-count">
                            {selectedAgentIds.length} selected
                          </Badge>
                          {selectedAgentIds.length > 1 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-xs text-muted-foreground"
                              onClick={() => setSelectedAgentIds([])}
                              data-testid="button-clear-agents"
                            >
                              Clear all
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex items-center border rounded-md bg-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1">
                      <Search className="w-4 h-4 ml-3 text-muted-foreground shrink-0" />
                      <Input
                        placeholder="Search agents by name..."
                        value={agentSearchQuery}
                        onChange={(e) => setAgentSearchQuery(e.target.value)}
                        className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                        data-testid="input-agent-search"
                      />
                      {agentSearchQuery && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="mr-1"
                          onClick={() => setAgentSearchQuery("")}
                          data-testid="button-clear-search"
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                    <ScrollArea className="h-64 border rounded-md">
                      <div className="p-1">
                        {vrsAgents
                          .filter((a) =>
                            a.name.toLowerCase().includes(agentSearchQuery.toLowerCase())
                          )
                          .map((agent) => {
                            const isSelected = selectedAgentIds.includes(agent.id);
                            return (
                              <button
                                key={agent.id}
                                type="button"
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md text-left hover-elevate ${
                                  isSelected ? "bg-primary/10 font-medium" : ""
                                }`}
                                onClick={() => {
                                  setSelectedAgentIds((prev) =>
                                    isSelected
                                      ? prev.filter((id) => id !== agent.id)
                                      : [...prev, agent.id]
                                  );
                                }}
                                data-testid={`option-agent-${agent.id}`}
                              >
                                <Checkbox
                                  checked={isSelected}
                                  className="pointer-events-none"
                                />
                                <span>{agent.name}</span>
                                {agent.racId && (
                                  <span className="text-muted-foreground ml-auto text-xs">{agent.racId}</span>
                                )}
                              </button>
                            );
                          })}
                        {vrsAgents.filter((a) =>
                          a.name.toLowerCase().includes(agentSearchQuery.toLowerCase())
                        ).length === 0 && (
                          <div className="px-3 py-2 text-sm text-muted-foreground">No agents found</div>
                        )}
                      </div>
                    </ScrollArea>
                    {selectedAgentIds.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {selectedAgentIds.map((id) => {
                          const agent = vrsAgents.find((a) => a.id === id);
                          if (!agent) return null;
                          return (
                            <Badge key={id} variant="secondary" data-testid={`badge-agent-${id}`}>
                              {agent.name}
                              <button
                                type="button"
                                className="ml-1 rounded-full"
                                onClick={() =>
                                  setSelectedAgentIds((prev) => prev.filter((aid) => aid !== id))
                                }
                                data-testid={`button-remove-agent-${id}`}
                              >
                                <X className="w-3 h-3" />
                              </button>
                            </Badge>
                          );
                        })}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {selectedAgentIds.length > 0 && (
                  <>
                    {specLoading && selectedAgentIds.length === 1 ? (
                      <div className="space-y-3">
                        {[1, 2, 3].map((i) => (
                          <div key={i} className="h-10 bg-muted rounded-md animate-pulse" />
                        ))}
                      </div>
                    ) : (
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-1.5">
                              <CardTitle className="text-base">Division Assignments</CardTitle>
                              <HelpTooltip content="Agents receive submissions matching their assigned divisions. Generalist agents receive all types." />
                            </div>
                            <div className="flex items-center gap-2 flex-wrap">
                              {selectedAgentIds.length > 1 && (
                                <Badge variant="outline" data-testid="badge-multi-agent-count">
                                  {selectedAgentIds.length} agents selected
                                </Badge>
                              )}
                              {isGeneralist && (
                                <Badge variant="secondary" data-testid="badge-generalist">
                                  <Shield className="w-3 h-3 mr-1" />
                                  Generalist
                                </Badge>
                              )}
                            </div>
                          </div>
                          {selectedAgentIds.length > 1 && (
                            <p className="text-sm text-muted-foreground mt-1">
                              Selected divisions will be applied to all {selectedAgentIds.length} agents.
                            </p>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="flex items-center gap-2">
                            <Checkbox
                              id="select-all"
                              checked={isGeneralist}
                              onCheckedChange={toggleAllDivisions}
                              data-testid="checkbox-select-all"
                            />
                            <Label htmlFor="select-all" className="text-sm font-medium">
                              Select All
                            </Label>
                          </div>

                          <Separator />

                          <div className="grid grid-cols-2 gap-3">
                            {DIVISION_KEYS.map((key) => (
                              <div key={key} className="flex items-center gap-2">
                                <Checkbox
                                  id={`division-${key}`}
                                  checked={selectedDivisions.includes(key)}
                                  onCheckedChange={() => toggleDivision(key)}
                                  data-testid={`checkbox-division-${key}`}
                                />
                                <Label htmlFor={`division-${key}`} className="text-sm">
                                  {DIVISION_LABELS[key]}
                                </Label>
                              </div>
                            ))}
                          </div>

                          <div className="flex justify-end pt-2">
                            <Button
                              onClick={() =>
                                saveDivisionsMutation.mutate({
                                  ids: selectedAgentIds,
                                  divisions: selectedDivisions,
                                })
                              }
                              disabled={saveDivisionsMutation.isPending}
                              data-testid="button-save-divisions"
                            >
                              {saveDivisionsMutation.isPending ? (
                                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                              ) : (
                                <Save className="w-4 h-4 mr-2" />
                              )}
                              Save{selectedAgentIds.length > 1 ? ` for ${selectedAgentIds.length} Agents` : ""}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </>
                )}
              </div>
            )}

            {activeView === "rgc" && (
              <div className="p-4 space-y-6 max-w-2xl">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Key className="w-4 h-4" />
                      Set Daily RGC Code
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="rgc-date">Date</Label>
                      <Input
                        id="rgc-date"
                        type="date"
                        value={rgcDate}
                        onChange={(e) => setRgcDate(e.target.value)}
                        data-testid="input-rgc-date"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="rgc-code">RGC Code</Label>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-mono font-semibold text-muted-foreground">RGC</span>
                        <Input
                          id="rgc-code"
                          placeholder="12345"
                          value={rgcDigits}
                          onChange={(e) => {
                            const val = e.target.value.replace(/\D/g, '').slice(0, 5);
                            setRgcDigits(val);
                          }}
                          maxLength={5}
                          className="font-mono"
                          data-testid="input-rgc-code"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">Enter exactly 5 digits after "RGC" prefix</p>
                    </div>
                    <Button
                      onClick={() => setRgcMutation.mutate()}
                      disabled={rgcDigits.length !== 5 || setRgcMutation.isPending}
                      data-testid="button-set-rgc"
                    >
                      {setRgcMutation.isPending ? "Setting..." : "Set Code"}
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Current Code for {rgcDate}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {rgcLoading ? (
                      <Skeleton className="h-10 w-48" />
                    ) : currentRgc?.rgcCode ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-3">
                          <Badge variant="outline" className="text-lg font-mono px-4 py-1" data-testid="text-current-rgc">
                            {currentRgc.rgcCode.code}
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground" data-testid="text-rgc-set-by">
                          Set by {currentRgc.createdByName || "Unknown"} on {formatDate(currentRgc.rgcCode.createdAt)}
                        </p>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground" data-testid="text-no-rgc">No code set for this date</p>
                    )}
                  </CardContent>
                </Card>
              </div>
            )}

            {activeView === "analytics" && (
              <div className="p-4 space-y-4" data-testid="analytics-view">
                {analyticsLoading ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      {[1, 2, 3, 4].map((i) => (
                        <Skeleton key={i} className="h-24" />
                      ))}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Skeleton className="h-48" />
                      <Skeleton className="h-48" />
                    </div>
                  </div>
                ) : analyticsData ? (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">Today</CardTitle>
                          <Calendar className="w-4 h-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <p className="text-2xl font-bold" data-testid="text-submissions-today">{analyticsData.submissionsToday}</p>
                          <p className="text-xs text-muted-foreground">submissions</p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">This Week</CardTitle>
                          <CalendarDays className="w-4 h-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <p className="text-2xl font-bold" data-testid="text-submissions-week">{analyticsData.submissionsThisWeek}</p>
                          <p className="text-xs text-muted-foreground">submissions</p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">This Month</CardTitle>
                          <CalendarRange className="w-4 h-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <p className="text-2xl font-bold" data-testid="text-submissions-month">{analyticsData.submissionsThisMonth}</p>
                          <p className="text-xs text-muted-foreground">submissions</p>
                        </CardContent>
                      </Card>
                      <Card>
                        <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
                          <CardTitle className="text-sm font-medium text-muted-foreground">Total</CardTitle>
                          <FileText className="w-4 h-4 text-muted-foreground" />
                        </CardHeader>
                        <CardContent>
                          <p className="text-2xl font-bold" data-testid="text-submissions-total">{analyticsData.totalSubmissions}</p>
                          <p className="text-xs text-muted-foreground">all time</p>
                        </CardContent>
                      </Card>
                    </div>

                    {nlaAnalytics && (
                      <Card data-testid="card-nla-analytics">
                        <CardHeader className="pb-3">
                          <div className="flex items-center gap-2">
                            <Package className="w-4 h-4 text-amber-500" />
                            <CardTitle className="text-base">NLA Parts Submissions</CardTitle>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="rounded-lg border p-3 bg-amber-50 dark:bg-amber-950/20">
                              <p className="text-2xl font-bold" data-testid="text-nla-today">{nlaAnalytics.today}</p>
                              <p className="text-xs text-muted-foreground">Today</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-amber-50 dark:bg-amber-950/20">
                              <p className="text-2xl font-bold" data-testid="text-nla-week">{nlaAnalytics.week}</p>
                              <p className="text-xs text-muted-foreground">This Week</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-amber-50 dark:bg-amber-950/20">
                              <p className="text-2xl font-bold" data-testid="text-nla-month">{nlaAnalytics.month}</p>
                              <p className="text-xs text-muted-foreground">This Month</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-amber-50 dark:bg-amber-950/20">
                              <p className="text-2xl font-bold" data-testid="text-nla-alltime">{nlaAnalytics.allTime}</p>
                              <p className="text-xs text-muted-foreground">All Time</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <CardTitle className="text-base">Approval Rate</CardTitle>
                            <TrendingUp className="w-4 h-4 text-muted-foreground" />
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-3">
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                              <span className="text-sm">Approved</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold" data-testid="text-approved-count">{analyticsData.approvedCount}</span>
                              <Badge variant="secondary" className="text-xs">
                                {analyticsData.totalSubmissions > 0
                                  ? Math.round((analyticsData.approvedCount / analyticsData.totalSubmissions) * 100)
                                  : 0}%
                              </Badge>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
                              <span className="text-sm">Rejected</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold" data-testid="text-rejected-count">{analyticsData.rejectedCount}</span>
                              <Badge variant="secondary" className="text-xs">
                                {analyticsData.totalSubmissions > 0
                                  ? Math.round((analyticsData.rejectedCount / analyticsData.totalSubmissions) * 100)
                                  : 0}%
                              </Badge>
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div className="flex items-center gap-2">
                              <Clock className="w-4 h-4 text-yellow-600 dark:text-yellow-400" />
                              <span className="text-sm">Pending</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold" data-testid="text-pending-count">{analyticsData.pendingCount}</span>
                              <Badge variant="secondary" className="text-xs">
                                {analyticsData.totalSubmissions > 0
                                  ? Math.round((analyticsData.pendingCount / analyticsData.totalSubmissions) * 100)
                                  : 0}%
                              </Badge>
                            </div>
                          </div>
                          {analyticsData.totalSubmissions > 0 && (
                            <div className="mt-2">
                              <div className="h-2 rounded-full bg-muted overflow-hidden flex">
                                <div
                                  className="bg-green-600 dark:bg-green-400"
                                  style={{ width: `${(analyticsData.approvedCount / analyticsData.totalSubmissions) * 100}%` }}
                                />
                                <div
                                  className="bg-red-600 dark:bg-red-400"
                                  style={{ width: `${(analyticsData.rejectedCount / analyticsData.totalSubmissions) * 100}%` }}
                                />
                                <div
                                  className="bg-yellow-600 dark:bg-yellow-400"
                                  style={{ width: `${(analyticsData.pendingCount / analyticsData.totalSubmissions) * 100}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <CardTitle className="text-base">Processing Times</CardTitle>
                            <Clock className="w-4 h-4 text-muted-foreground" />
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div>
                            <p className="text-sm text-muted-foreground mb-1">Avg. Submission to Stage 1</p>
                            <p className="text-xl font-bold" data-testid="text-avg-stage1-time">
                              {formatDuration(analyticsData.avgTimeToStage1Ms)}
                            </p>
                            <p className="text-xs text-muted-foreground">from submission to initial review</p>
                          </div>
                          <Separator />
                          <div>
                            <p className="text-sm text-muted-foreground mb-1">Avg. Stage 1 to Auth Code</p>
                            <p className="text-xl font-bold" data-testid="text-avg-authcode-time">
                              {formatDuration(analyticsData.avgTimeToAuthCodeMs)}
                            </p>
                            <p className="text-xs text-muted-foreground">from approval to auth code sent</p>
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <CardTitle className="text-base">Export Tickets</CardTitle>
                          <Download className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <p className="text-sm text-muted-foreground">Download tickets as CSV or XLSX. XLSX includes separate sheets for Authorization and NLA Parts tickets. Use presets or pick custom dates. Optionally filter by technician LDAP ID for coaching review.</p>
                        <div className="flex flex-wrap gap-2">
                          {[
                            { preset: "today", label: "Today" },
                            { preset: "week", label: "This Week" },
                            { preset: "month", label: "This Month" },
                            { preset: "all", label: "All Time" },
                          ].map(({ preset, label }) => (
                            <Button
                              key={preset}
                              variant="outline"
                              size="sm"
                              onClick={() => setExportPreset(preset)}
                              data-testid={`button-preset-${preset}`}
                            >
                              <Calendar className="w-3 h-3 mr-1" />
                              {label}
                            </Button>
                          ))}
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Start Date</Label>
                            <Input
                              type="date"
                              value={exportStartDate}
                              onChange={(e) => setExportStartDate(e.target.value)}
                              data-testid="input-export-start-date"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">End Date</Label>
                            <Input
                              type="date"
                              value={exportEndDate}
                              onChange={(e) => setExportEndDate(e.target.value)}
                              data-testid="input-export-end-date"
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground mb-1 block">Technician LDAP ID</Label>
                            <Input
                              type="text"
                              placeholder="e.g. tmorri1"
                              value={exportTechLdap}
                              onChange={(e) => setExportTechLdap(e.target.value)}
                              data-testid="input-export-tech-ldap"
                            />
                          </div>
                        </div>
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            onClick={handleExportCsv}
                            disabled={exportingRange !== null}
                            variant="outline"
                            data-testid="button-export-csv"
                          >
                            {exportingRange === "exporting" ? (
                              <Loader2 className="w-4 h-4 animate-spin mr-2" />
                            ) : (
                              <Download className="w-4 h-4 mr-2" />
                            )}
                            Export CSV
                          </Button>
                          <Button
                            onClick={handleExportXlsx}
                            disabled={exportingRange !== null}
                            data-testid="button-export-xlsx"
                          >
                            {exportingRange === "exporting_xlsx" ? (
                              <Loader2 className="w-4 h-4 animate-spin mr-2" />
                            ) : (
                              <Download className="w-4 h-4 mr-2" />
                            )}
                            Export XLSX
                            <span className="ml-1 text-[10px] font-normal opacity-70">(2 sheets)</span>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>

                    {resubmissionData && (
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <CardTitle className="text-base">Resubmission Rate Tracking</CardTitle>
                            <RotateCcw className="w-4 h-4 text-muted-foreground" />
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <div className="grid grid-cols-2 gap-4">
                            <div>
                              <p className="text-sm text-muted-foreground">Total Resubmissions</p>
                              <p className="text-2xl font-bold" data-testid="text-total-resubmissions">{resubmissionData.totalResubmissions}</p>
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Overall Resubmission Rate</p>
                              <p className="text-2xl font-bold" data-testid="text-resubmission-rate">{resubmissionData.resubmissionRate}%</p>
                            </div>
                          </div>
                          {resubmissionData.topTechnicians.length > 0 && (
                            <>
                              <Separator />
                              <p className="text-sm font-medium text-muted-foreground">Technicians with Resubmissions</p>
                              <div className="rounded-md border overflow-hidden">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="bg-muted/50 border-b">
                                      <th className="text-left p-2 font-medium">Technician</th>
                                      <th className="text-left p-2 font-medium">LDAP</th>
                                      <th className="text-center p-2 font-medium">Total</th>
                                      <th className="text-center p-2 font-medium">Resubs</th>
                                      <th className="text-center p-2 font-medium">Rate</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {resubmissionData.topTechnicians.map((t, i) => (
                                      <tr key={t.technicianId} className={i % 2 === 0 ? "" : "bg-muted/20"} data-testid={`resub-row-${t.technicianId}`}>
                                        <td className="p-2">{t.techName}</td>
                                        <td className="p-2 font-mono text-xs">{t.techLdap}</td>
                                        <td className="p-2 text-center">{t.totalTickets}</td>
                                        <td className="p-2 text-center">{t.resubmissions}</td>
                                        <td className="p-2 text-center">
                                          <Badge variant={t.rate >= 50 ? "destructive" : t.rate >= 25 ? "secondary" : "outline"} className="text-xs">
                                            {t.rate}%
                                          </Badge>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {districtData && districtData.length > 0 && (
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <CardTitle className="text-base">District-Level Rollup</CardTitle>
                            <GitBranch className="w-4 h-4 text-muted-foreground" />
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="rounded-md border overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="bg-muted/50 border-b">
                                  <th className="text-left p-2 font-medium">District</th>
                                  <th className="text-center p-2 font-medium">Total</th>
                                  <th className="text-center p-2 font-medium">Completed</th>
                                  <th className="text-center p-2 font-medium">Approved</th>
                                  <th className="text-center p-2 font-medium">Rejected</th>
                                  <th className="text-center p-2 font-medium">Pending</th>
                                  <th className="text-center p-2 font-medium">Avg. Review Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {districtData.map((d, i) => (
                                  <tr key={d.district} className={i % 2 === 0 ? "" : "bg-muted/20"} data-testid={`district-row-${d.district}`}>
                                    <td className="p-2 font-mono font-medium">{d.district}</td>
                                    <td className="p-2 text-center font-bold">{d.totalTickets}</td>
                                    <td className="p-2 text-center">
                                      <span className="text-green-600 dark:text-green-400">{d.completed}</span>
                                    </td>
                                    <td className="p-2 text-center">
                                      <span className="text-blue-600 dark:text-blue-400">{d.approved}</span>
                                    </td>
                                    <td className="p-2 text-center">
                                      <span className="text-red-600 dark:text-red-400">{d.rejected}</span>
                                    </td>
                                    <td className="p-2 text-center">
                                      <span className="text-yellow-600 dark:text-yellow-400">{d.pending}</span>
                                    </td>
                                    <td className="p-2 text-center text-xs">{formatDuration(d.avgTimeToStage1Ms)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </CardContent>
                      </Card>
                    )}
                  </>
                ) : (
                  <div className="flex items-center justify-center min-h-[400px]">
                    <p className="text-muted-foreground">No analytics data available.</p>
                  </div>
                )}
              </div>
            )}

            {activeView === "technicians" && (
              <TechnicianSyncSection />
            )}
            {activeView === "agent-status" && (
              <AgentStatusSection />
            )}
            {activeView === "tickets" && (
              <TicketOverviewSection />
            )}
            {activeView === "feedback" && (
              <FeedbackSection />
            )}
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle data-testid="text-dialog-title">
              {editingUser ? "Edit User" : "Create User"}
            </DialogTitle>
            <DialogDescription>
              {editingUser ? "Update user details below." : "Fill in the details to create a new user."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="user-name">Name</Label>
              <Input
                id="user-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Full name"
                data-testid="input-user-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-password">
                Password{editingUser ? " (leave blank to keep current)" : ""}
              </Label>
              <Input
                id="user-password"
                type="password"
                value={formPassword}
                onChange={(e) => setFormPassword(e.target.value)}
                placeholder={editingUser ? "Leave blank to keep current" : "Password"}
                data-testid="input-user-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select value={formRole} onValueChange={setFormRole}>
                <SelectTrigger data-testid="select-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="technician">Technician</SelectItem>
                  <SelectItem value="vrs_agent">VRS Agent</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  {user?.role === "super_admin" && (
                    <SelectItem value="super_admin">Super Admin</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-phone">Phone</Label>
              <Input
                id="user-phone"
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value)}
                placeholder="Phone number"
                data-testid="input-user-phone"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-racid">LDAP ID</Label>
              <Input
                id="user-racid"
                value={formRacId}
                onChange={(e) => setFormRacId(e.target.value.replace(/[^a-zA-Z0-9]/g, ''))}
                placeholder="MTHOMA2"
                data-testid="input-user-racid"
              />
            </div>

            {formRole === "vrs_agent" && (
              <div className="space-y-2">
                <Label>Division Assignments</Label>
                <div className="border rounded-md p-3 space-y-2 max-h-48 overflow-y-auto">
                  <div className="flex items-center space-x-2 pb-2 border-b">
                    <Checkbox
                      id="form-div-all"
                      checked={formDivisions.length === DIVISION_KEYS.length}
                      onCheckedChange={() => {
                        if (formDivisions.length === DIVISION_KEYS.length) {
                          setFormDivisions([]);
                        } else {
                          setFormDivisions([...DIVISION_KEYS]);
                        }
                      }}
                      data-testid="checkbox-form-division-all"
                    />
                    <label htmlFor="form-div-all" className="text-sm font-medium cursor-pointer">
                      Generalist (All Divisions)
                    </label>
                  </div>
                  {DIVISION_KEYS.map((key) => (
                    <div key={key} className="flex items-center space-x-2">
                      <Checkbox
                        id={`form-div-${key}`}
                        checked={formDivisions.includes(key)}
                        onCheckedChange={() => {
                          setFormDivisions((prev) =>
                            prev.includes(key) ? prev.filter((d) => d !== key) : [...prev, key]
                          );
                        }}
                        data-testid={`checkbox-form-division-${key}`}
                      />
                      <label htmlFor={`form-div-${key}`} className="text-sm cursor-pointer">
                        {DIVISION_LABELS[key]}
                      </label>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(formRole === "vrs_agent" || formRole === "admin") && editingUser && (
              <div className="space-y-2">
                <div className="flex items-center justify-between rounded-md border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="pcard-toggle" className="flex items-center gap-1.5 cursor-pointer">
                      <CreditCard className="w-4 h-4 text-emerald-600" />
                      Can Order Parts (P-Card)
                    </Label>
                    <p className="text-xs text-muted-foreground">Enable for agents who have a P-card and can place parts orders.</p>
                  </div>
                  <Switch
                    id="pcard-toggle"
                    checked={formCanOrderParts}
                    onCheckedChange={setFormCanOrderParts}
                    data-testid="switch-pcard"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} data-testid="button-cancel-dialog">
              Cancel
            </Button>
            <Button
              onClick={handleFormSubmit}
              disabled={isFormPending}
              data-testid="button-submit-user"
            >
              {isFormPending ? (
                <span className="animate-spin mr-2">
                  <Plus className="w-4 h-4" />
                </span>
              ) : editingUser ? (
                <Pencil className="w-4 h-4 mr-2" />
              ) : (
                <UserPlus className="w-4 h-4 mr-2" />
              )}
              {editingUser ? "Update" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deactivateConfirm} onOpenChange={(open) => !open && setDeactivateConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-deactivate-title">Deactivate User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to deactivate <strong>{deactivateConfirm?.name}</strong>? They will no longer be able to log in until reactivated.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-deactivate">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deactivateConfirm) {
                  toggleStatusMutation.mutate({ id: deactivateConfirm.id, isActive: false });
                  setDeactivateConfirm(null);
                }
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-deactivate"
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resetPwConfirm} onOpenChange={(open) => !open && setResetPwConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-reset-pw-title">Reset Password</AlertDialogTitle>
            <AlertDialogDescription>
              Reset password for <strong>{resetPwConfirm?.name}</strong>? They will need to change it on next login.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-reset-pw">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (resetPwConfirm) {
                  resetPasswordMutation.mutate({ id: resetPwConfirm.id });
                }
              }}
              data-testid="button-confirm-reset-pw"
            >
              Reset Password
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <AlertDialogContent data-testid="dialog-delete-user">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete User</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete <strong>{deleteConfirm?.name}</strong>? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteConfirm) {
                  deleteUserMutation.mutate({ id: deleteConfirm.id });
                }
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
