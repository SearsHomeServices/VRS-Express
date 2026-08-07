import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useQuery, useMutation, keepPreviousData } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth, getToken, buildMediaUrl, buildMediaUrls, prefetchMediaTokens, collectSubmissionMediaPaths } from "@/lib/auth";
import { MediaImage, MediaVideo, MediaAudio } from "@/components/media";
import { apiRequest, queryClient, scheduleWsInvalidate, JITTERED_POLL_INTERVAL_MS } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { usePortal1099Enabled } from "@/hooks/use-feature-flags";
import { safeDate, formatDate, formatDateShort, cn } from "@/lib/utils";
import {
  getBusinessElapsedMs,
  formatBusinessElapsed,
  isWithinBusinessHours,
  getEtDateString,
  formatHoursLabel,
  useBusinessHoursConfig,
  categoryForApplianceType,
  type BusinessHoursProfile,
} from "@/lib/business-hours";
import BusinessHoursSection from "@/components/business-hours-section";
import { useWebSocket, loadNotificationSettings, playNotificationDing, showBrowserNotification } from "@/lib/websocket";
import NotificationSettings from "@/components/notification-settings";
import type { User, TechnicianUserView, SubmissionListItemWithTech } from "@shared/schema";
import { PROVIDER_1099_COMPANIES } from "@shared/provider1099";
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
  Circle,
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
  Activity,
  AlertTriangle,
  GraduationCap,
  Headset,
  Check,
  ChevronsUpDown,
  Send,
} from "lucide-react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import HelpTooltip from "@/components/help-tooltip";
import { useTheme } from "@/components/theme-provider";
import { parseVideoUrls } from "@/lib/videoUrls";

interface AnalyticsData {
  submissionsToday: number;
  submissionsThisWeek: number;
  submissionsThisMonth: number;
  totalSubmissions: number;
  approvedCount: number;
  rejectedCount: number;
  pendingCount: number;
  otherStatusCounts?: Record<string, number>;
  avgTimeToStage1Ms: number | null;
  avgTimeToAuthCodeMs: number | null;
}

const STAGE1_STATUS_LABELS: Record<string, string> = {
  not_reviewed: "Not Reviewed",
  invalid: "Invalid",
  closed: "Closed",
  rejected_closed: "Rejected (Closed)",
};
const formatStage1Status = (key: string): string =>
  STAGE1_STATUS_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

interface ResubmissionStats {
  totalResubmissions: number;
  resubmissionRate: number;
  topTechnicians: { technicianId: number; techName: string; techLdap: string; totalTickets: number; resubmissions: number; rate: number }[];
}

interface CoachingDuplicateNewTicket {
  id: number;
  status: string;
  at: string;
  minutesAfter: number;
}

interface CoachingDuplicate {
  technicianId: number;
  techName: string;
  techLdap: string;
  serviceOrder: string;
  previousId: number;
  previousStatus: string;
  previousAt: string;
  newTickets: CoachingDuplicateNewTicket[];
  newCount: number;
  minutesBetween: number;
  latestNewAt: string;
}

interface CoachingDuplicatesResponse {
  days: number;
  rows: CoachingDuplicate[];
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

type ActiveView = "users" | "divisions" | "rgc" | "analytics" | "technicians" | "agent-status" | "business-hours" | "tickets" | "feedback" | "health";

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
  provider_1099: "1099 Provider",
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

  // Tyler 2026-05-05 (perf): see paired comment on the /api/submissions
  // useQuery below. The `agent_status_changed` WS event already
  // invalidates this query on every status flip, so polling is a
  // safety net — bumped 15s → 60s to cut tab/server churn.
  const { data, isLoading } = useQuery<{ agents: AgentStatusInfo[] }>({
    queryKey: ["/api/admin/agent-status"],
    // Tyler 2026-07-08 (perf) — jittered so polling clients drift apart
    // instead of all hitting the server in the same second.
    refetchInterval: JITTERED_POLL_INTERVAL_MS,
    staleTime: 45000,
    refetchOnWindowFocus: false,
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

  // Tyler 2026-05-09 (VRS request): sort Available agents to the top so
  // an admin scanning this page during peak can see who's actually
  // pickable at a glance, then Working, then Unavailable/offline at the
  // bottom. Within each status bucket, fall back to alphabetical by name
  // for a stable, predictable order (no jitter on every WS refresh).
  const STATUS_RANK: Record<string, number> = {
    online: 0,   // Available
    working: 1,  // Working
    offline: 2,  // Unavailable
  };
  const agents = useMemo(() => {
    const list = data?.agents || [];
    return [...list].sort((a, b) => {
      const ra = STATUS_RANK[a.agentStatus] ?? 3;
      const rb = STATUS_RANK[b.agentStatus] ?? 3;
      if (ra !== rb) return ra - rb;
      return (a.name || "").localeCompare(b.name || "");
    });
  }, [data?.agents]);

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
// Tyler 2026-05-01 (architect fix): now profile-aware. HVAC rows (Mon–Fri
// 8a–5:30p) need a tighter window than non-HVAC (Mon–Sat 8a–8p) or the
// timers double-count after-hours minutes.
function getTimeInStatus(
  createdAt: string | Date | null | undefined,
  reviewedAt?: string | Date | null,
  profile?: BusinessHoursProfile,
): string {
  const start = safeDate(createdAt);
  if (!start) return "—";
  const end = safeDate(reviewedAt) || new Date();
  const businessMs = getBusinessElapsedMs(start, end, profile);
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
    priorSubmissions?: any[];
  }>({
    queryKey: ["/api/admin/submissions", ticketId, "audit"],
    queryFn: async () => {
      const res = await fetch(`/api/admin/submissions/${ticketId}/audit`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("Failed to load ticket details");
      const json = await res.json();
      // Tyler 2026-07-08 (perf) — batch-prefetch media tokens as soon as the
      // ticket detail lands, so the Media tab's grid mounts against warm
      // tokens instead of firing one GET /api/media-token per image.
      // Fire-and-forget; failures fall back to per-path fetches.
      if (json?.submission) {
        prefetchMediaTokens(collectSubmissionMediaPaths(json.submission));
      }
      return json;
    },
    enabled: !!ticketId && open,
  });

  const sub = data?.submission;
  const timeline = data?.timeline || [];
  const userNames = data?.userNames || {};
  const priorSubmissions = data?.priorSubmissions || [];

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

  // 2026-08-06 (Rejection & Coaching Report) — editable coaching fields +
  // Tech PDC delivery status/retry, shown for negative-outcome tickets.
  const { toast: coachingToast } = useToast();
  const isNegativeOutcome = sub && ["rejected", "rejected_closed", "invalid"].includes(sub.ticketStatus);
  const [coachingDraft, setCoachingDraft] = useState("");
  const [expectedDraft, setExpectedDraft] = useState("");
  useEffect(() => {
    setCoachingDraft(sub?.coachingNotes || "");
    setExpectedDraft(sub?.expectedVsActual || "");
  }, [sub?.id, sub?.coachingNotes, sub?.expectedVsActual]);
  const coachingDirty = sub && (coachingDraft !== (sub.coachingNotes || "") || expectedDraft !== (sub.expectedVsActual || ""));
  const saveCoachingMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/submissions/${sub.id}/coaching`, {
        coachingNotes: coachingDraft || null,
        expectedVsActual: expectedDraft || null,
      });
      return await res.json();
    },
    onSuccess: () => {
      coachingToast({ title: "Coaching Notes Saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", ticketId, "audit"] });
    },
    onError: (error: Error) => {
      coachingToast({ title: "Save Failed", description: error.message, variant: "destructive" });
    },
  });
  const techPdcPushMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/submissions/${sub.id}/tech-pdc-push`, {});
      return await res.json();
    },
    onSuccess: () => {
      coachingToast({ title: "Sent to Tech PDC" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", ticketId, "audit"] });
    },
    onError: (error: Error) => {
      coachingToast({ title: "Tech PDC Push Failed", description: error.message, variant: "destructive" });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/submissions", ticketId, "audit"] });
    },
  });

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
                       sub.warrantyType === "ahs" || sub.warrantyType === "american_home_shield" ? "AHS" :
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
                    <p className="text-sm whitespace-pre-wrap" data-testid="text-detail-agent-notes">{sub.agentNotes}</p>
                  </div>
                )}

                {isNegativeOutcome && (
                  <div className="rounded-lg border p-3 bg-amber-50/50 dark:bg-amber-950/10 border-amber-200 dark:border-amber-900 space-y-3" data-testid="section-coaching">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-xs uppercase tracking-wider font-medium text-amber-800 dark:text-amber-300">Coaching & Tech PDC</p>
                      <div className="flex items-center gap-2">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            sub.techPdcStatus === "sent"
                              ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                              : sub.techPdcStatus === "failed"
                              ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                              : sub.techPdcStatus === "pending"
                              ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200"
                              : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                          }`}
                          data-testid="badge-tech-pdc-status"
                          title={sub.techPdcStatus === "failed" && sub.techPdcError ? sub.techPdcError : undefined}
                        >
                          {sub.techPdcStatus === "sent"
                            ? `Sent to Tech PDC${sub.techPdcSentAt ? ` · ${formatTsFull(sub.techPdcSentAt)}` : ""}`
                            : sub.techPdcStatus === "failed"
                            ? "Tech PDC Failed"
                            : sub.techPdcStatus === "pending"
                            ? "Sending to Tech PDC…"
                            : "Not sent to Tech PDC"}
                        </span>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={techPdcPushMutation.isPending}
                          onClick={() => techPdcPushMutation.mutate()}
                          data-testid="button-tech-pdc-push"
                        >
                          {techPdcPushMutation.isPending ? "Sending…" : sub.techPdcStatus === "failed" ? "Retry Push" : "Push to Tech PDC"}
                        </Button>
                      </div>
                    </div>
                    {sub.techPdcStatus === "failed" && sub.techPdcError && (
                      <p className="text-xs text-red-700 dark:text-red-400" data-testid="text-tech-pdc-error">{sub.techPdcError}</p>
                    )}
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">Expected vs. Actual Behavior</Label>
                      <Textarea
                        value={expectedDraft}
                        onChange={(e) => setExpectedDraft(e.target.value)}
                        placeholder="What the technician should have done vs. what they did..."
                        className="resize-none bg-background"
                        rows={2}
                        data-testid="input-detail-expected-vs-actual"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground mb-1 block">Coaching Notes</Label>
                      <Textarea
                        value={coachingDraft}
                        onChange={(e) => setCoachingDraft(e.target.value)}
                        placeholder="Coaching guidance for this technician — included in the Coaching & Rejection report and Tech PDC push..."
                        className="resize-none bg-background"
                        rows={3}
                        data-testid="input-detail-coaching-notes"
                      />
                    </div>
                    {coachingDirty && (
                      <Button
                        size="sm"
                        disabled={saveCoachingMutation.isPending}
                        onClick={() => saveCoachingMutation.mutate()}
                        data-testid="button-save-coaching"
                      >
                        {saveCoachingMutation.isPending ? "Saving…" : "Save Coaching Notes"}
                      </Button>
                    )}
                  </div>
                )}

                {sub.appealNotes && (
                  <div className="rounded-lg border p-3 bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900">
                    <p className="text-xs text-blue-700 dark:text-blue-300 mb-1 uppercase tracking-wider font-medium">Technician Appeal Notes (Resubmission)</p>
                    <p className="text-sm whitespace-pre-wrap text-blue-900 dark:text-blue-100" data-testid="text-detail-appeal-notes">{sub.appealNotes}</p>
                  </div>
                )}

                {priorSubmissions.length > 0 && (
                  <div className="rounded-lg border p-3 space-y-3" data-testid="panel-prior-submissions">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium flex items-center gap-1.5">
                      <RotateCcw className="w-3.5 h-3.5" />
                      Previous Submissions in this Thread ({priorSubmissions.length})
                    </p>
                    {priorSubmissions.map((p: any) => {
                      let pReasons: string[] = [];
                      if (p.rejectionReasons) {
                        try { pReasons = typeof p.rejectionReasons === "string" ? JSON.parse(p.rejectionReasons) : p.rejectionReasons; } catch {}
                      }
                      const reviewer = p.reviewedBy ? userNames[p.reviewedBy] : (p.stage1ReviewedBy ? userNames[p.stage1ReviewedBy] : null);
                      return (
                        <div key={p.id} className="rounded-md border p-3 bg-muted/10 space-y-2" data-testid={`prior-submission-${p.id}`}>
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium">Ticket #{p.id}</span>
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${getStatusColor(p.ticketStatus)}`}>
                                {getStatusLabel(p.ticketStatus)}
                              </span>
                            </div>
                            <span className="text-[10px] text-muted-foreground">
                              {formatTsFull(p.createdAt)}
                              {reviewer ? ` • Reviewed by ${reviewer}` : ""}
                            </span>
                          </div>
                          {p.issueDescription && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Tech Issue Description</p>
                              <p className="text-xs whitespace-pre-wrap">{p.issueDescription}</p>
                            </div>
                          )}
                          {p.appealNotes && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-blue-700 dark:text-blue-300 mb-0.5">Tech Appeal Notes</p>
                              <p className="text-xs whitespace-pre-wrap text-blue-900 dark:text-blue-100">{p.appealNotes}</p>
                            </div>
                          )}
                          {pReasons.length > 0 && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-red-700 dark:text-red-400 mb-0.5">Rejection Reasons</p>
                              <ul className="text-xs text-red-700 dark:text-red-400 list-disc list-inside space-y-0.5">
                                {pReasons.map((r, i) => <li key={i}>{r}</li>)}
                              </ul>
                            </div>
                          )}
                          {p.technicianMessage && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Message Sent to Technician</p>
                              <p className="text-xs whitespace-pre-wrap">{p.technicianMessage}</p>
                            </div>
                          )}
                          {p.agentNotes && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Internal Agent Notes</p>
                              <p className="text-xs whitespace-pre-wrap">{p.agentNotes}</p>
                            </div>
                          )}
                          {p.invalidReason && (
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">Invalid Reason</p>
                              <p className="text-xs whitespace-pre-wrap">{p.invalidReason}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
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
                    // Tyler 2026-07-08 — thumb map; grid src only. Full paths
                    // remain the identity for lightbox + open-in-new-tab.
                    let thumbs: Record<string, string> = {};
                    try {
                      const rawT = (sub as any).photoThumbnails ? JSON.parse((sub as any).photoThumbnails) : null;
                      if (rawT && typeof rawT === "object" && !Array.isArray(rawT)) {
                        for (const [k, v] of Object.entries(rawT)) {
                          if (typeof k === "string" && typeof v === "string") thumbs[k] = v;
                        }
                      }
                    } catch {}

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
                                onClick={async () => openLightbox(await buildMediaUrls(allPhotos), offset + i)}
                                data-testid={`admin-${testIdPrefix}-photo-${i}`}
                              >
                                <MediaImage
                                  src={thumbs[url] ?? url}
                                  alt={`${label} ${i + 1}`}
                                  decoding="async"
                                  className="w-full h-full object-cover pointer-events-none"
                                />
                                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                  <ZoomIn className="w-6 h-6 text-white" />
                                </div>
                                <button
                                  className="absolute top-1 right-1 bg-black/60 rounded-md p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 z-10"
                                  onClick={async (e) => { e.stopPropagation(); const t = await buildMediaUrl(url); window.open(t, "_blank", "noopener,noreferrer"); }}
                                  data-testid={`admin-${testIdPrefix}-download-${i}`}
                                >
                                  <Download className="w-3.5 h-3.5" />
                                </button>
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
                    {(() => {
                      const n = parseVideoUrls(sub.videoUrl).length;
                      return n > 1 ? `Videos (${n})` : "Video";
                    })()}
                  </p>
                  {(() => {
                    // Tyler 2026-05-01 (P1 fix): video_url stores a JSON
                    // array of object-storage paths since the multi-video
                    // ship on 2026-04-30 (see client/src/lib/videoUrls.ts
                    // for the format and the legacy single-URL fallback).
                    // The admin page was still binding the raw column to
                    // <video src> which made the browser try to load the
                    // literal string `["..."]` and fail. Mirror the agent
                    // dashboard's parseVideoUrls + per-video <video> tile
                    // approach so admins/agents can play any of the up-to-
                    // 3 attached videos.
                    const videoList = parseVideoUrls(sub.videoUrl);
                    if (videoList.length === 0) {
                      return (
                        <p className="text-sm text-muted-foreground" data-testid="text-admin-no-video">
                          No video attached
                        </p>
                      );
                    }
                    return (
                      <div className="space-y-2">
                        {videoList.map((vurl, vi) => (
                          <div
                            key={vi}
                            className="rounded-md overflow-hidden bg-muted"
                            data-testid={videoList.length === 1 ? "admin-media-video" : `admin-media-video-${vi}`}
                          >
                            <MediaVideo
                              src={vurl}
                              controls
                              preload="metadata"
                              className="w-full max-h-[300px]"
                              data-testid={videoList.length === 1 ? "admin-video-player" : `admin-video-player-${vi}`}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </div>

                <Separator />

                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-3 flex items-center gap-1.5">
                    <Mic className="w-3.5 h-3.5" />
                    Voice Note
                  </p>
                  {sub.voiceNoteUrl ? (
                    <div className="rounded-md overflow-hidden bg-muted p-3" data-testid="admin-media-voice">
                      <MediaAudio
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
  // Tyler 2026-07-08 — search covers ALL tickets, not just the visible
  // window. The table defaults to the last 30 days ("auto-archive"), but
  // typing a search switches the data source to a debounced server-side
  // all-time search so older tickets are still findable without widening
  // the default view. Debounce keeps us from firing a request per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setDebouncedSearch("");
      return;
    }
    const t = setTimeout(() => setDebouncedSearch(trimmed), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);
  const searchActive = debouncedSearch.length > 0;
  // Tyler 2026-05-06 (Task #4 perf): default the admin Ticket Overview to
  // the last 30 days of created tickets. Pre-change this view pulled every
  // submission in the database (~500+ rows in prod, soon many more) on a
  // 60s poll, with every heavy JSON column inlined. The slim list method
  // already cuts payload ~5-10x; this window cuts row count too. Widen via
  // the selector beside the request-type filter. The CSV/XLSX export
  // endpoints are unaffected (different endpoints with their own scopes).
  const [createdAfterWindow, setCreatedAfterWindow] = useState<"30d" | "60d" | "90d" | "all">("30d");
  // Tyler 2026-05-15 — every column in the Ticket Overview table is sortable.
  // Default (null) preserves the existing FIFO behavior on the queue tab.
  type TicketSortField = "serviceOrder" | "status" | "assigned" | "technician" | "division" | "warranty" | "intakeForm" | "lastUpdated" | "queueWait" | "handleTime" | "totalTime";
  const TICKET_NUMERIC_FIELDS: TicketSortField[] = ["intakeForm", "lastUpdated", "queueWait", "handleTime", "totalTime"];
  const [ticketSortField, setTicketSortField] = useState<TicketSortField | null>(null);
  const [ticketSortDir, setTicketSortDir] = useState<"asc" | "desc">("desc");
  const handleTicketSort = (field: TicketSortField) => {
    if (ticketSortField === field) {
      setTicketSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setTicketSortField(field);
      setTicketSortDir(TICKET_NUMERIC_FIELDS.includes(field) ? "desc" : "asc");
    }
  };
  const createdAfterIso = useMemo(() => {
    if (createdAfterWindow === "all") return null;
    const days = createdAfterWindow === "60d" ? 60 : createdAfterWindow === "90d" ? 90 : 30;
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }, [createdAfterWindow]);
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [reassignTicket, setReassignTicket] = useState<any | null>(null);
  const [reassignTarget, setReassignTarget] = useState<string>("");
  const [reassignNotes, setReassignNotes] = useState("");

  // Tyler 2026-05-05 (perf): users were reporting the app feeling
  // "extremely slow." This is the worst offender — admin loads ALL
  // submissions with no filter, every JSON column included
  // (photos, partNumbers, agentNotes, issueDescription, rejectedMedia,
  // etc.). At 506 prod rows the response is ~500KB-1MB and prod logs
  // showed it taking 1.3-1.5s. With a 15s poll + 10s staleTime the
  // admin tab was choking on a full re-fetch + JSON parse + ticket
  // overview table re-render four times every minute.
  //
  // The WebSocket already invalidates this query on every meaningful
  // event (new_ticket, ticket_queued, pending_tickets — see the
  // subscribe() block in this file ~L1810-1840). Mutations also
  // invalidate. So polling is a missed-WS-event safety net, not the
  // primary refresh. Stretching to 60s + disabling refocus refetch
  // cuts server + client load ~4x. WS push remains instant.
  // Tyler 2026-05-06 (Task #4): scope by createdAfter window. The query key
  // includes the param so widening the window cleanly triggers a refetch
  // and the WS-driven invalidation predicate (matches anything starting
  // with "/api/submissions") still hits this entry.
  const adminSubmissionsUrl = createdAfterIso
    ? `/api/submissions?createdAfter=${encodeURIComponent(createdAfterIso)}`
    : "/api/submissions";
  // Tyler 2026-05-06 (Task #4): typed against the slim list shape from
  // shared/schema.ts. The list table only reads slim columns; the detail
  // dialog drills into /api/submissions/:id for heavy fields.
  const { data: allData, isLoading: allLoading } = useQuery<{ submissions: SubmissionListItemWithTech[] }>({
    queryKey: [adminSubmissionsUrl],
    // Tyler 2026-07-08 (perf) — jittered so polling clients drift apart
    // instead of all hitting the server in the same second.
    refetchInterval: JITTERED_POLL_INTERVAL_MS,
    staleTime: 45000,
    refetchOnWindowFocus: false,
  });

  // Tyler 2026-07-08 — all-time search (no createdAfter param, so the server
  // applies its own generous floor + row cap). Only fetches while a search
  // term is present; results replace the windowed rows as the table source.
  const { data: searchData, isLoading: searchLoading } = useQuery<{ submissions: SubmissionListItemWithTech[] }>({
    queryKey: [`/api/submissions?search=${encodeURIComponent(debouncedSearch)}`],
    enabled: searchActive,
    staleTime: 30000,
    refetchOnWindowFocus: false,
    // Each debounced term is a distinct query key; keep the previous term's
    // rows on screen while the new fetch resolves (no skeleton flash per key).
    placeholderData: keepPreviousData,
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

  // While searching, the all-time server results are the source of truth;
  // otherwise the windowed (default 30d) list is. The client-side filter
  // below still runs over whichever source is active — it matches the same
  // fields the server search does, so it only ever narrows, never hides.
  const rawTickets = (searchActive ? searchData?.submissions : allData?.submissions) || [];
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

  // Tyler 2026-05-15 — every column in the Ticket Overview table is sortable.
  // When ticketSortField is null we keep the existing FIFO behavior for the
  // "queued" tab so the live queue stays oldest-first by default.
  if (ticketSortField === null) {
    if (statusFilter === "queued") {
      filteredTickets = [...filteredTickets].sort((a, b) =>
        (safeDate(a.createdAt)?.getTime() || 0) - (safeDate(b.createdAt)?.getTime() || 0)
      );
    }
  } else {
    const dir = ticketSortDir === "asc" ? 1 : -1;
    const field = ticketSortField;
    const ts = (v: any) => safeDate(v)?.getTime() || 0;
    const num = (t: any): number => {
      switch (field) {
        case "lastUpdated": return ts(t.updatedAt || t.statusChangedAt || t.createdAt);
        case "intakeForm": return ts(t.intakeFormCompletedAt);
        case "queueWait": return t.claimedAt ? ts(t.claimedAt) - ts(t.createdAt) : Infinity;
        case "handleTime": return t.claimedAt && t.statusChangedAt ? ts(t.statusChangedAt) - ts(t.claimedAt) : -1;
        case "totalTime": return t.statusChangedAt ? ts(t.statusChangedAt) - ts(t.createdAt) : -1;
        default: return 0;
      }
    };
    const str = (t: any): string => {
      switch (field) {
        case "serviceOrder": return (t.serviceOrder || "").toString().toLowerCase();
        case "status": return (t.ticketStatus || "").toString().toLowerCase();
        case "assigned": return (t.assignedAgentName || "").toString().toLowerCase();
        case "technician": return (t.technicianName || "").toString().toLowerCase();
        case "division": return (t.applianceType || "").toString().toLowerCase();
        case "warranty": return (t.warrantyType || "").toString().toLowerCase();
        default: return "";
      }
    };
    filteredTickets = [...filteredTickets].sort((a, b) => {
      if (TICKET_NUMERIC_FIELDS.includes(field)) {
        const av = num(a); const bv = num(b);
        if (av === Infinity && bv === Infinity) return 0;
        if (av === Infinity) return 1;
        if (bv === Infinity) return -1;
        return (av - bv) * dir;
      }
      const av = str(a); const bv = str(b);
      return av < bv ? -dir : av > bv ? dir : 0;
    });
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

  // 2026-08-06 (Rejection & Coaching Report) — export the coaching/rejection
  // report honoring the active table filters (created window, status tab,
  // request-type toggle, search). Server limits rows to negative outcomes.
  const [coachingExporting, setCoachingExporting] = useState(false);
  const [pdcPushing, setPdcPushing] = useState(false);
  const coachingFilterParams = () => {
    const params = new URLSearchParams();
    if (createdAfterIso) params.set("createdAfter", createdAfterIso);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (requestTypeFilter !== "all") params.set("requestType", requestTypeFilter);
    if (debouncedSearch) params.set("search", debouncedSearch);
    return params;
  };
  const handleCoachingExport = async (format: "csv" | "xlsx") => {
    try {
      setCoachingExporting(true);
      const params = coachingFilterParams();
      params.set("format", format);
      const res = await fetch(`/api/admin/export-coaching?${params.toString()}`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || `coaching-report.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: "Export Complete", description: `Coaching & Rejection report downloaded (${format.toUpperCase()}).` });
    } catch {
      toast({ title: "Export Failed", description: "Could not export the coaching report.", variant: "destructive" });
    } finally {
      setCoachingExporting(false);
    }
  };
  const handlePushToTechPdc = async () => {
    try {
      setPdcPushing(true);
      const body: Record<string, string> = {};
      coachingFilterParams().forEach((v, k) => { body[k] = v; });
      const res = await apiRequest("POST", "/api/tech-pdc/export", body);
      const json = await res.json();
      toast({
        title: "Tech PDC Push Complete",
        description: `${json.sent} sent, ${json.failed} failed${json.skippedAlreadySent ? `, ${json.skippedAlreadySent} already delivered` : ""}.`,
        variant: json.failed > 0 ? "destructive" : undefined,
      });
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
    } catch (error: any) {
      toast({ title: "Tech PDC Push Failed", description: error?.message || "Could not push records.", variant: "destructive" });
    } finally {
      setPdcPushing(false);
    }
  };

  // Tyler 2026-04-29 (VRS business-hours timer): when we're outside the
  // configured ET window, surface a small inline indicator at the top of the
  // tickets view so admins understand the column timers aren't ticking. The
  // indicator only renders during after-hours.
  // 2026-05-01: now driven by the admin-configured Standard profile (HVAC
  // tickets render alongside in this view but the indicator uses the default
  // window since most rows are non-HVAC).
  const { config: bhConfig } = useBusinessHoursConfig();
  const defaultProfile = bhConfig.default;
  const businessHoursActive = isWithinBusinessHours(new Date(), defaultProfile);
  const defaultHoursLabel = formatHoursLabel(defaultProfile);

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
        {/* Tyler 2026-05-06 (Task #4): created-window selector for the
            Ticket Overview. Defaults to last 30 days; widen as needed. */}
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">Created</Label>
          <Select value={createdAfterWindow} onValueChange={(v) => setCreatedAfterWindow(v as typeof createdAfterWindow)}>
            <SelectTrigger className="h-8 w-[140px] text-xs" data-testid="select-created-window">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30d" data-testid="option-created-window-30d">Last 30 days</SelectItem>
              <SelectItem value="60d" data-testid="option-created-window-60d">Last 60 days</SelectItem>
              <SelectItem value="90d" data-testid="option-created-window-90d">Last 90 days</SelectItem>
              <SelectItem value="all" data-testid="option-created-window-all">All time</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={coachingExporting}
            onClick={() => handleCoachingExport("csv")}
            data-testid="button-export-coaching-csv"
          >
            {coachingExporting ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Download className="w-3 h-3 mr-1.5" />}
            Coaching Report CSV
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={coachingExporting}
            onClick={() => handleCoachingExport("xlsx")}
            data-testid="button-export-coaching-xlsx"
          >
            {coachingExporting ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Download className="w-3 h-3 mr-1.5" />}
            XLSX
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            disabled={pdcPushing}
            onClick={handlePushToTechPdc}
            data-testid="button-push-tech-pdc"
          >
            {pdcPushing ? <Loader2 className="w-3 h-3 animate-spin mr-1.5" /> : <Send className="w-3 h-3 mr-1.5" />}
            Push to Tech PDC
          </Button>
        </div>
        {!businessHoursActive && (
          <div
            className="inline-flex items-center gap-1.5 rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1 text-xs font-medium text-amber-800 dark:text-amber-200"
            data-testid="badge-after-hours"
            title={`VRS hours are ${defaultHoursLabel}. Ticket timers don't accumulate outside that window.`}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
            After hours — ticket timers paused (open: {defaultHoursLabel})
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

      <div>
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
        {searchActive && (
          <p className="text-xs text-muted-foreground mt-1 pl-1" data-testid="text-search-scope">
            Searching all tickets, including those outside the {createdAfterWindow === "all" ? "current" : createdAfterWindow.replace("d", "-day")} view.
          </p>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {(searchActive ? searchLoading : allLoading) ? (
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
              <Table className="text-xs [&_th]:px-2 [&_th]:py-2 [&_td]:px-2 [&_td]:py-2">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("serviceOrder")} data-testid="sort-ticket-so" title="Service Order">
                        SO # <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("status")} data-testid="sort-ticket-status">
                        Status <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("assigned")} data-testid="sort-ticket-assigned" title="Assigned To">
                        Assigned <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("technician")} data-testid="sort-ticket-tech">
                        Tech <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("division")} data-testid="sort-ticket-division">
                        Division <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("warranty")} data-testid="sort-ticket-warranty">
                        Warranty <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button className="flex items-center gap-1 hover:text-foreground whitespace-nowrap" onClick={() => handleTicketSort("intakeForm")} data-testid="sort-ticket-intake" title="Intake Form Complete">
                        Intake <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button className="inline-flex items-center gap-1 hover:text-foreground ml-auto whitespace-nowrap" onClick={() => handleTicketSort("lastUpdated")} data-testid="sort-ticket-updated" title="Last Updated">
                        Updated <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button className="inline-flex items-center gap-1 hover:text-foreground ml-auto whitespace-nowrap" onClick={() => handleTicketSort("queueWait")} data-testid="sort-ticket-queuewait" title="Queue Wait — created → claimed">
                        Queue <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button className="inline-flex items-center gap-1 hover:text-foreground ml-auto whitespace-nowrap" onClick={() => handleTicketSort("handleTime")} data-testid="sort-ticket-handletime" title="Handle Time — claimed → status change">
                        Handle <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">
                      <button className="inline-flex items-center gap-1 hover:text-foreground ml-auto whitespace-nowrap" onClick={() => handleTicketSort("totalTime")} data-testid="sort-ticket-totaltime" title="Total Time — created → status change">
                        Total <ArrowUpDown className="w-3 h-3" />
                      </button>
                    </TableHead>
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
                    // Tyler 2026-05-01 (architect fix): per-row HVAC awareness.
                    // HVAC tickets use the hvac profile (Mon–Fri 8a–5:30p);
                    // every other row uses default (Mon–Sat 8a–8p). Without
                    // this, HVAC totals double-counted minutes between 5:30p
                    // and 8p on weekdays AND every Saturday hour as
                    // "in business hours".
                    const rowProfile = bhConfig[categoryForApplianceType(ticket.applianceType)];
                    const ageHours = created ? getBusinessElapsedMs(created, new Date(), rowProfile) / 3600000 : 0;
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
                            {(ticket as any).replacementReviewRecommended && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 border border-purple-300 dark:border-purple-700"
                                data-testid={`badge-replacement-review-${ticket.id}`}
                              >
                                REPLACEMENT REVIEW
                              </span>
                            )}
                            {(ticket as any).b2bApprovedReplacement && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200 border border-indigo-300 dark:border-indigo-700"
                                data-testid={`badge-b2b-replacement-${ticket.id}`}
                              >
                                B2B REPLACEMENT
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
                           ticket.warrantyType === "ahs" || ticket.warrantyType === "american_home_shield" ? "AHS" :
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
                                  <span className="text-xs">{getTimeInStatus(ticket.intakeFormCompletedAt, undefined, rowProfile)} ago</span>
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
                            ? getTimeInStatus(ticket.createdAt, ticket.claimedAt, rowProfile)
                            : ticket.ticketStatus === "queued"
                            ? <span className="text-amber-600 dark:text-amber-400">{getTimeInStatus(ticket.createdAt, undefined, rowProfile)} ⏳</span>
                            : getTimeInStatus(ticket.createdAt, ticket.statusChangedAt, rowProfile)
                          }
                        </TableCell>
                        <TableCell className="text-sm text-right whitespace-nowrap" data-testid={`handle-time-${ticket.id}`}>
                          {ticket.claimedAt
                            ? ticket.ticketStatus === "pending"
                              ? <span className="text-blue-600 dark:text-blue-400">{getTimeInStatus(ticket.claimedAt, undefined, rowProfile)} ⏳</span>
                              : getTimeInStatus(ticket.claimedAt, ticket.statusChangedAt, rowProfile)
                            : "—"
                          }
                        </TableCell>
                        <TableCell className="text-sm text-right whitespace-nowrap" data-testid={`total-time-${ticket.id}`}>
                          {["completed", "approved", "rejected", "rejected_closed", "invalid"].includes(ticket.ticketStatus)
                            ? getTimeInStatus(ticket.createdAt, ticket.statusChangedAt, rowProfile)
                            : <span className="text-muted-foreground">{getTimeInStatus(ticket.createdAt, undefined, rowProfile)}</span>
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

// Removed per request 2026-05-07: backend audit logs to deployment logs only.
// No UI surface — see [suspicious-rejection] warnings in /api/submissions/:id/process.

// ============================================================================
// HealthSection — admin-only system health / regression-watch view.
// Shows real-time results of the named regression checks plus the recent
// audit history of opened/cleared incidents from system_health_log.
// ============================================================================
type HealthCheck = {
  checkName: string;
  severity: string;
  currentCount: number;
  opened: number;
  touched: number;
  cleared: number;
  sample: Array<{ entityType: string; entityId: number; finding: any }>;
};
type HealthCheckResponse = {
  ranAt: string;
  overallStatus: "green" | "issues_detected";
  totalActiveFindings: number;
  checks: HealthCheck[];
};
type HealthIncident = {
  id: number;
  checkName: string;
  severity: string;
  entityType: string;
  entityId: number;
  finding: any;
  detectedAt: string;
  lastSeenAt: string;
  clearedAt: string | null;
  clearedBy: number | null;
  clearReason: string | null;
};

const CHECK_LABELS: Record<string, { title: string; description: string }> = {
  send_to_nla_status_stuck: {
    title: "Agent Status Stuck on Working",
    description: "VRS agents/admins shown as Working but with no pending tickets and idle > 10 min. Watches Rob's send-to-NLA status fix.",
  },
  escalate_audit_gap: {
    title: "NLA Escalate Audit Gap",
    description: "Completed P-card NLA tickets missing the prior escalate breadcrumb. Watches Zorn's escalate retry-wrapper fix (ticket #985 footprint).",
  },
  stale_pending_nla: {
    title: "Abandoned NLA Tickets",
    description: "NLA tickets pending > 4 hours assigned to an offline agent. Catches orphaned escalates.",
  },
};

function HealthSection() {
  const { toast } = useToast();
  const [filterCheck, setFilterCheck] = useState<string>("");
  const [openOnly, setOpenOnly] = useState(true);
  const [clearTarget, setClearTarget] = useState<HealthIncident | null>(null);
  const [clearReasonInput, setClearReasonInput] = useState("");

  // Lookup table for "Cleared by" display name. Reuses the same /api/admin/users
  // cache the rest of the dashboard already populates — usually a cache hit.
  const { data: usersData } = useQuery<{ users: SafeUser[] }>({
    queryKey: ["/api/admin/users"],
    refetchOnWindowFocus: false,
  });
  const userNameById = useMemo(() => {
    const map = new Map<number, string>();
    (usersData?.users || []).forEach((u) => map.set(u.id, u.name));
    return map;
  }, [usersData]);

  const checkQuery = useQuery<HealthCheckResponse>({
    queryKey: ["/api/admin/health/regression-check"],
    refetchOnWindowFocus: false,
  });

  const clearMutation = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason?: string }) => {
      return apiRequest("POST", `/api/admin/health/incidents/${id}/clear`, reason ? { reason } : {});
    },
    onSuccess: () => {
      toast({ title: "Incident cleared" });
      setClearTarget(null);
      setClearReasonInput("");
      queryClient.invalidateQueries({ queryKey: ["/api/admin/health/incidents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/health/regression-check"] });
    },
    onError: (err: any) => {
      toast({
        title: "Failed to clear",
        description: err?.message || "Unknown error",
        variant: "destructive",
      });
    },
  });

  const incidentsQuery = useQuery<{ incidents: HealthIncident[]; count: number }>({
    queryKey: ["/api/admin/health/incidents", { checkName: filterCheck || undefined, openOnly, limit: 100 }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterCheck) params.set("checkName", filterCheck);
      if (openOnly) params.set("openOnly", "true");
      params.set("limit", "100");
      const url = `/api/admin/health/incidents?${params.toString()}`;
      const token = localStorage.getItem("vrs_token");
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try { msg = JSON.parse(text).error || msg; } catch {}
        throw new Error(msg);
      }
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/admin/health/regression-check"] });
    queryClient.invalidateQueries({ queryKey: ["/api/admin/health/incidents"] });
  };

  // One-time video recovery. Re-encodes already-stored iPhone HEVC/10-bit
  // videos that the old conversion silently failed on, so admins/agents can
  // play them in ticket detail again.
  const [recoverResult, setRecoverResult] = useState<{
    dryRun: boolean;
    scannedSubmissions: number;
    scannedVideos: number;
    reconverted: number;
    wouldReconvert: number;
  } | null>(null);
  const recoverMutation = useMutation({
    mutationFn: async (dryRun: boolean) => {
      const res = await apiRequest("POST", "/api/admin/reconvert-videos", { dryRun, sinceHours: 24 * 30 });
      return res.json();
    },
    onSuccess: (data: any) => {
      setRecoverResult(data);
      if (data.dryRun) {
        toast({
          title: "Scan complete",
          description: `${data.wouldReconvert} of ${data.scannedVideos} video(s) need recovery across ${data.scannedSubmissions} ticket(s).`,
        });
      } else {
        toast({
          title: "Recovery complete",
          description: `${data.reconverted} video(s) re-encoded and now playable.`,
        });
      }
    },
    onError: (err: any) => {
      toast({ title: "Video recovery failed", description: err?.message || "Unknown error", variant: "destructive" });
    },
  });

  const data = checkQuery.data;
  const isError = checkQuery.isError;
  const errorMessage = checkQuery.error instanceof Error ? checkQuery.error.message : "Failed to load health checks";

  return (
    <div className="space-y-6" data-testid="health-section">
      {/* Overall status banner */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle data-testid="text-health-title">Regression Watch</CardTitle>
            <CardDescription>
              Active monitoring of shipped bug-fix areas. Each check corresponds to a real production fix.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={checkQuery.isFetching}
            data-testid="button-refresh-health"
          >
            {checkQuery.isFetching ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4 mr-2" />
            )}
            Run Checks
          </Button>
        </CardHeader>
        <CardContent>
          {checkQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground" data-testid="text-health-loading">
              <Loader2 className="w-4 h-4 animate-spin" />
              Running checks…
            </div>
          ) : isError ? (
            <div
              className="flex items-start gap-2 p-3 rounded-md border border-destructive/30 bg-destructive/10 text-destructive"
              data-testid="text-health-error"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5" />
              <div className="text-sm">
                <div className="font-medium">Health checks unavailable</div>
                <div className="text-xs opacity-80">
                  {errorMessage}. The <code className="font-mono">system_health_log</code> table may not exist in this environment yet.
                </div>
              </div>
            </div>
          ) : data ? (
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                {data.overallStatus === "green" ? (
                  <>
                    <CheckCircle2 className="w-8 h-8 text-green-600 dark:text-green-500" />
                    <div>
                      <div className="text-lg font-semibold text-green-700 dark:text-green-400" data-testid="text-health-status">
                        All Clear
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last run {new Date(data.ranAt).toLocaleString()}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-8 h-8 text-amber-600 dark:text-amber-500" />
                    <div>
                      <div className="text-lg font-semibold text-amber-700 dark:text-amber-400" data-testid="text-health-status">
                        {data.totalActiveFindings} Active Finding{data.totalActiveFindings === 1 ? "" : "s"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last run {new Date(data.ranAt).toLocaleString()}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* One-time video recovery */}
      <Card data-testid="card-video-recovery">
        <CardHeader>
          <CardTitle data-testid="text-video-recovery-title">Recover Unplayable Videos</CardTitle>
          <CardDescription>
            Re-encode iPhone videos already stored in an unplayable format (HEVC / 10-bit) so they
            play again in ticket detail. Scans tickets from the last 30 days. Run a scan first to
            see how many are affected, then recover.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => recoverMutation.mutate(true)}
              disabled={recoverMutation.isPending}
              data-testid="button-video-recovery-scan"
            >
              {recoverMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Search className="w-4 h-4 mr-2" />
              )}
              Scan
            </Button>
            <Button
              size="sm"
              onClick={() => recoverMutation.mutate(false)}
              disabled={recoverMutation.isPending}
              data-testid="button-video-recovery-run"
            >
              {recoverMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Video className="w-4 h-4 mr-2" />
              )}
              Recover Now
            </Button>
          </div>
          {recoverResult && (
            <div className="mt-4 text-sm text-muted-foreground" data-testid="text-video-recovery-result">
              {recoverResult.dryRun ? (
                <span>
                  Scanned {recoverResult.scannedVideos} video(s) across {recoverResult.scannedSubmissions} ticket(s):{" "}
                  <span className="font-semibold text-foreground">{recoverResult.wouldReconvert}</span> need recovery.
                </span>
              ) : (
                <span>
                  Recovered <span className="font-semibold text-foreground">{recoverResult.reconverted}</span> video(s)
                  out of {recoverResult.scannedVideos} scanned across {recoverResult.scannedSubmissions} ticket(s).
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-check breakdown */}
      {data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.checks.map((check) => {
            const meta = CHECK_LABELS[check.checkName] || {
              title: check.checkName,
              description: "Custom regression check.",
            };
            const isClean = check.currentCount === 0;
            return (
              <Card
                key={check.checkName}
                className={isClean ? "border-green-200 dark:border-green-900" : "border-amber-300 dark:border-amber-800"}
                data-testid={`card-check-${check.checkName}`}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{meta.title}</CardTitle>
                    {isClean ? (
                      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
                        OK
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">
                        {check.currentCount}
                      </Badge>
                    )}
                  </div>
                  <CardDescription className="text-xs">{meta.description}</CardDescription>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span data-testid={`text-opened-${check.checkName}`}>
                      Opened: <span className="font-mono font-medium text-foreground">{check.opened}</span>
                    </span>
                    <span data-testid={`text-touched-${check.checkName}`}>
                      Still present: <span className="font-mono font-medium text-foreground">{check.touched}</span>
                    </span>
                    <span data-testid={`text-cleared-${check.checkName}`}>
                      Cleared: <span className="font-mono font-medium text-foreground">{check.cleared}</span>
                    </span>
                  </div>
                  {check.sample.length > 0 && (
                    <div className="border-t pt-2 mt-2 space-y-1">
                      <div className="text-xs font-medium text-muted-foreground">Sample findings:</div>
                      {check.sample.slice(0, 3).map((s, i) => (
                        <div
                          key={`${s.entityType}-${s.entityId}-${i}`}
                          className="text-xs font-mono bg-muted/40 rounded px-2 py-1"
                          data-testid={`sample-${check.checkName}-${i}`}
                        >
                          {s.entityType} #{s.entityId}
                          {s.finding && typeof s.finding === "object" && (
                            <span className="text-muted-foreground">
                              {" — "}
                              {Object.entries(s.finding)
                                .slice(0, 2)
                                .map(([k, v]) => `${k}: ${typeof v === "string" && v.length > 24 ? v.slice(0, 24) + "…" : String(v)}`)
                                .join(", ")}
                            </span>
                          )}
                        </div>
                      ))}
                      {check.sample.length > 3 && (
                        <div className="text-xs text-muted-foreground italic">+ {check.sample.length - 3} more</div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Incident history */}
      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle>Incident History</CardTitle>
            <CardDescription>Audit log of every detection, kept indefinitely. Cleared incidents stay for retro analysis.</CardDescription>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Select value={filterCheck || "all"} onValueChange={(v) => setFilterCheck(v === "all" ? "" : v)}>
              <SelectTrigger className="w-[280px]" data-testid="select-incident-check">
                <SelectValue placeholder="Filter by check" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All checks</SelectItem>
                {Object.entries(CHECK_LABELS).map(([key, meta]) => (
                  <SelectItem key={key} value={key}>{meta.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="health-open-only"
                checked={openOnly}
                onChange={(e) => setOpenOnly(e.target.checked)}
                data-testid="checkbox-open-only"
                className="rounded"
              />
              <label htmlFor="health-open-only" className="text-sm cursor-pointer select-none">
                Open incidents only
              </label>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {incidentsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground" data-testid="text-incidents-loading">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading history…
            </div>
          ) : incidentsQuery.isError ? (
            <div className="text-sm text-muted-foreground" data-testid="text-incidents-error">
              History unavailable. The audit table may not exist in this environment yet.
            </div>
          ) : !incidentsQuery.data || incidentsQuery.data.count === 0 ? (
            <div className="text-sm text-muted-foreground py-8 text-center" data-testid="text-incidents-empty">
              No incidents recorded {openOnly ? "are currently open" : "in the audit log"}.
            </div>
          ) : (
            <div className="border rounded-md">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Check</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Detected</TableHead>
                    <TableHead>Last Seen</TableHead>
                    <TableHead>Cleared</TableHead>
                    <TableHead>Cleared By</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incidentsQuery.data.incidents.map((inc) => {
                    const isOpen = inc.clearedAt === null;
                    const meta = CHECK_LABELS[inc.checkName];
                    const clearedByName = inc.clearedBy ? (userNameById.get(inc.clearedBy) || `user #${inc.clearedBy}`) : null;
                    return (
                      <TableRow key={inc.id} data-testid={`row-incident-${inc.id}`}>
                        <TableCell>
                          {isOpen ? (
                            <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800">
                              Open
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300 dark:bg-green-950 dark:text-green-400 dark:border-green-800">
                              Cleared
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          <div className="font-medium">{meta?.title || inc.checkName}</div>
                          <div className="text-muted-foreground font-mono text-[10px]">{inc.checkName}</div>
                        </TableCell>
                        <TableCell className="text-xs font-mono">
                          {inc.entityType} #{inc.entityId}
                        </TableCell>
                        <TableCell className="text-xs">{new Date(inc.detectedAt).toLocaleString()}</TableCell>
                        <TableCell className="text-xs">{new Date(inc.lastSeenAt).toLocaleString()}</TableCell>
                        <TableCell className="text-xs">{inc.clearedAt ? new Date(inc.clearedAt).toLocaleString() : "—"}</TableCell>
                        <TableCell className="text-xs">
                          {clearedByName ? (
                            <div>
                              <div className="font-medium" data-testid={`text-cleared-by-${inc.id}`}>{clearedByName}</div>
                              {inc.clearReason && (
                                <div className="text-muted-foreground italic mt-0.5" data-testid={`text-clear-reason-${inc.id}`}>
                                  "{inc.clearReason}"
                                </div>
                              )}
                            </div>
                          ) : inc.clearedAt ? (
                            <span className="text-muted-foreground italic">auto</span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {isOpen ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => { setClearTarget(inc); setClearReasonInput(""); }}
                              data-testid={`button-clear-incident-${inc.id}`}
                            >
                              Mark Resolved
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Manual clear dialog */}
      <Dialog open={!!clearTarget} onOpenChange={(o) => { if (!o) { setClearTarget(null); setClearReasonInput(""); } }}>
        <DialogContent data-testid="dialog-clear-incident">
          <DialogHeader>
            <DialogTitle>Mark Incident Resolved</DialogTitle>
            <DialogDescription>
              {clearTarget && (
                <>
                  Manually clear <span className="font-mono">{CHECK_LABELS[clearTarget.checkName]?.title || clearTarget.checkName}</span> for {clearTarget.entityType} #{clearTarget.entityId}.
                  This silences the alert immediately. The audit row stays in history with your name and reason recorded.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="clear-reason">Reason (optional)</Label>
            <Textarea
              id="clear-reason"
              value={clearReasonInput}
              onChange={(e) => setClearReasonInput(e.target.value)}
              placeholder="e.g. Data fixed manually, known accepted exception, ticket reassigned offline…"
              maxLength={500}
              rows={3}
              data-testid="textarea-clear-reason"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setClearTarget(null); setClearReasonInput(""); }}
              disabled={clearMutation.isPending}
              data-testid="button-cancel-clear"
            >
              Cancel
            </Button>
            <Button
              onClick={() => clearTarget && clearMutation.mutate({ id: clearTarget.id, reason: clearReasonInput.trim() || undefined })}
              disabled={clearMutation.isPending || !clearTarget}
              data-testid="button-confirm-clear"
            >
              {clearMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Mark Resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function AdminDashboard() {
  const { user, logout } = useAuth();
  const portal1099Enabled = usePortal1099Enabled();
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
  const [formCompanyName, setFormCompanyName] = useState("");
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const [formDivisions, setFormDivisions] = useState<string[]>([]);
  const [formCanOrderParts, setFormCanOrderParts] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);
  const [agentSearchQuery, setAgentSearchQuery] = useState("");
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [selectedDivisions, setSelectedDivisions] = useState<string[]>([]);
  const [deactivateConfirm, setDeactivateConfirm] = useState<{ id: number; name: string; isActive: boolean } | null>(null);
  const [resetPwConfirm, setResetPwConfirm] = useState<{ id: number; name: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; name: string } | null>(null);
  const [grantingTech, setGrantingTech] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState<{ id: number; name: string } | null>(null);
  const [rgcDate, setRgcDate] = useState(() => getEtDateString());
  const [rgcDigits, setRgcDigits] = useState("");
  const [adminStatus, setAdminStatus] = useState<string>((user as any)?.agentStatus || "offline");
  // Coaching report (Analytics view) opens ticket detail in this dialog —
  // separate from TicketOverviewSection's own selectedTicketId because that
  // state lives in a different component scope.
  const [coachingDetailTicketId, setCoachingDetailTicketId] = useState<number | null>(null);

  useEffect(() => {
    if (user && (user as any).agentStatus) {
      setAdminStatus((user as any).agentStatus);
    }
  }, [user]);

  const { subscribe } = useWebSocket(user?.role);

  useEffect(() => {
    // Tyler 2026-07-08 (perf) — WS refetches are coalesced (2.5s trailing
    // debounce via scheduleWsInvalidate) so an event burst triggers one
    // refetch wave instead of one per event. Toasts/sounds stay immediate;
    // mutation onSuccess invalidations elsewhere stay immediate too.
    const unsub = subscribe("agent_status_changed", () => {
      scheduleWsInvalidate(["/api/admin/agent-status", "/api/admin/users"]);
    });

    const unsub2 = subscribe("new_ticket", (payload: any) => {
      playNotificationDing();
      const title = `New ${payload.applianceLabel} ticket, ${payload.warrantyLabel}`;
      const desc = `SO #${payload.serviceOrder}`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      scheduleWsInvalidate(["/api/submissions", "/api/admin/analytics"]);
    });

    const unsub3 = subscribe("ticket_queued", (payload: any) => {
      playNotificationDing();
      const title = `Ticket returned to queue`;
      const desc = `${payload.applianceLabel} - ${payload.warrantyLabel} (SO #${payload.serviceOrder})`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      scheduleWsInvalidate(["/api/submissions", "/api/admin/analytics"]);
    });

    const unsub4 = subscribe("pending_tickets", (payload: any) => {
      const title = `Queued ${payload.applianceLabel} ticket, ${payload.warrantyLabel}`;
      const desc = `SO #${payload.serviceOrder} waiting in queue`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      scheduleWsInvalidate(["/api/submissions", "/api/admin/analytics"]);
    });

    // Tyler 2026-05-01 (architect fix): when another admin tab saves
    // business hours, the server broadcasts `business_hours_updated`.
    // Refetch so timer columns + the after-hours indicator re-render
    // without a manual reload.
    const unsub5 = subscribe("business_hours_updated", () => {
      queryClient.invalidateQueries({ queryKey: ["/api/business-hours"] });
    });

    // Tyler 2026-05-05 (perf-fix paired): when we stretched the admin
    // /api/submissions poll from 15s → 60s (see comment on the
    // useQuery), we relied on the WS to keep the ticket overview
    // current. But admin was never subscribed to `ticket_claimed`,
    // `ticket_assigned`, or `resubmission_received` — server already
    // emits all three, and admin/super_admin are valid recipients via
    // broadcastToDivisionAgents (server/websocket.ts). Without these
    // handlers, an admin watching the overview could see a queued
    // ticket as still-queued for up to 60s after an agent claimed it.
    // No toast/sound — admins don't need to be paged on every claim,
    // just kept in sync silently.
    const unsub6 = subscribe("ticket_claimed", () => {
      scheduleWsInvalidate(["/api/submissions"]);
    });
    const unsub7 = subscribe("ticket_assigned", () => {
      scheduleWsInvalidate(["/api/submissions"]);
    });
    const unsub8 = subscribe("resubmission_received", () => {
      scheduleWsInvalidate(["/api/submissions", "/api/admin/analytics"]);
    });

    // Tyler 2026-05-15: VRS reported the admin Ticket Overview showed a
    // ticket as still-pending with a live "Handle Time" ticking past 58
    // minutes — but on manual refresh the ticket was already completed.
    // Root cause: with the 60s /api/submissions poll, completion events
    // had no realtime push to admins. Server now emits `ticket_updated`
    // from /process and /process-nla on every status transition; this
    // listener invalidates the submissions cache + analytics so the row
    // re-renders the moment the DB row commits. Silent (no toast/sound)
    // — admins don't need to be paged on every completion.
    const unsub9 = subscribe("ticket_updated", () => {
      // Replacement Review + B2B analytics cards are sourced from separate
      // endpoints; coalesce alongside the main analytics so the Today/Week
      // tiles update as agents process tickets.
      scheduleWsInvalidate([
        "/api/submissions",
        "/api/admin/analytics",
        "/api/admin/replacement-review-analytics",
        "/api/admin/b2b-replacement-analytics",
      ]);
    });

    return () => { unsub(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); unsub7(); unsub8(); unsub9(); };
  }, [subscribe]);

  const [userTab, setUserTab] = useState<"staff" | "technicians">("staff");
  const [techSearchQuery, setTechSearchQuery] = useState("");
  // Tyler 2026-05-14 — every column in the Field Technicians table is sortable.
  // String columns default to asc on first click; numeric columns default to
  // desc (admins want highest counts surfaced first).
  type TechSortField = "name" | "racId" | "phone" | "district" | "manager" | "totalTickets" | "pending" | "approved" | "rejected";
  const TECH_NUMERIC_FIELDS: TechSortField[] = ["totalTickets", "pending", "approved", "rejected"];
  const [techSortField, setTechSortField] = useState<TechSortField>("name");
  const [techSortDir, setTechSortDir] = useState<"asc" | "desc">("asc");
  const handleTechSort = (field: TechSortField) => {
    if (techSortField === field) {
      setTechSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setTechSortField(field);
      setTechSortDir(TECH_NUMERIC_FIELDS.includes(field) ? "desc" : "asc");
    }
  };

  // Tyler 2026-05-15 — every column in the Users (admin) table is sortable.
  type UserSortField = "name" | "role" | "phone" | "racId" | "isActive";
  const [userSortField, setUserSortField] = useState<UserSortField>("name");
  const [userSortDir, setUserSortDir] = useState<"asc" | "desc">("asc");
  const handleUserSort = (field: UserSortField) => {
    if (userSortField === field) {
      setUserSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setUserSortField(field);
      setUserSortDir("asc");
    }
  };

  // Tyler 2026-05-14 — every column in the analytics "Technicians with
  // Resubmissions" table is sortable. Default: highest rate first.
  type ResubSortField = "techName" | "techLdap" | "totalTickets" | "resubmissions" | "rate";
  const RESUB_NUMERIC_FIELDS: ResubSortField[] = ["totalTickets", "resubmissions", "rate"];
  const [resubSortField, setResubSortField] = useState<ResubSortField>("rate");
  const [resubSortDir, setResubSortDir] = useState<"asc" | "desc">("desc");
  const handleResubSort = (field: ResubSortField) => {
    if (resubSortField === field) {
      setResubSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setResubSortField(field);
      setResubSortDir(RESUB_NUMERIC_FIELDS.includes(field) ? "desc" : "asc");
    }
  };

  const { data: usersData, isLoading: usersLoading } = useQuery<{ users: SafeUser[] }>({
    queryKey: ["/api/admin/users"],
  });

  const users = usersData?.users || [];
  const vrsAgents = users.filter((u) => u.role === "vrs_agent");

  const { data: techUsersData, isLoading: techUsersLoading } = useQuery<{ technicians: TechnicianUserView[] }>({
    queryKey: ["/api/admin/technician-users"],
    enabled: activeView === "users",
  });
  const fieldTechIds = new Set((techUsersData?.technicians ?? []).map((t) => t.id));

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

  const [coachingDays, setCoachingDays] = useState(30);
  const { data: coachingData } = useQuery<CoachingDuplicatesResponse>({
    queryKey: ["/api/admin/analytics/coaching-duplicates", coachingDays],
    queryFn: async () => {
      const res = await fetch(`/api/admin/analytics/coaching-duplicates?days=${coachingDays}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("vrs_token") || ""}` },
      });
      if (!res.ok) throw new Error(`Failed to load coaching duplicates: ${res.status}`);
      return res.json();
    },
    enabled: activeView === "analytics",
  });

  const { data: b2bReplacementAnalytics } = useQuery<{ today: number; week: number; month: number; allTime: number }>({
    queryKey: ["/api/admin/b2b-replacement-analytics"],
  });

  const { data: replacementReviewAnalytics } = useQuery<{ today: number; week: number; month: number; allTime: number }>({
    queryKey: ["/api/admin/replacement-review-analytics"],
  });

  const { data: nlaAnalytics } = useQuery<{ today: number; week: number; month: number; allTime: number }>({
    queryKey: ["/api/admin/nla-analytics"],
    enabled: activeView === "analytics",
  });

  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const [exportStartDate, setExportStartDate] = useState("");
  const [exportEndDate, setExportEndDate] = useState("");
  const [exportTechLdap, setExportTechLdap] = useState("");
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const setExportPreset = (preset: string) => {
    const now = new Date();
    // ET-canonical export ranges so "Today" is today in ET — not tomorrow's
    // UTC date after 8 PM EDT. Week/month spans use browser-local Date math
    // (correct for VRS users in ET) and only the day-key formatting routes
    // through getEtDateString.
    const today = getEtDateString(now);
    if (preset === "today") {
      setExportStartDate(today);
      setExportEndDate(today);
    } else if (preset === "week") {
      const day = now.getDay();
      const start = new Date(now);
      start.setDate(now.getDate() - day);
      setExportStartDate(getEtDateString(start));
      setExportEndDate(today);
    } else if (preset === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      setExportStartDate(getEtDateString(start));
      setExportEndDate(today);
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

  const exportControls = (
    <div className="space-y-4">
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
    </div>
  );

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
      email?: string;
      password: string;
      role: string;
      phone?: string;
      racId?: string;
      companyName?: string;
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
      toast({ title: grantingTech ? "VRS Access Granted" : "User Updated", description: grantingTech ? "Technician can now log in as a VRS agent." : "User has been updated successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/technician-users"] });
      closeDialog();
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const revokeVrsMutation = useMutation({
    mutationFn: async ({ id }: { id: number }) => {
      await apiRequest("PATCH", `/api/admin/users/${id}`, { role: "technician" });
      await apiRequest("PATCH", `/api/admin/users/${id}/specializations`, { divisions: [] });
    },
    onSuccess: () => {
      toast({ title: "VRS Access Revoked", description: "Technician can no longer log in as a VRS agent." });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/technician-users"] });
      setRevokeConfirm(null);
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
    setFormCompanyName("");
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
    setFormCompanyName(u.companyName || "");
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
    setGrantingTech(false);
  };

  const openGrantDialog = (t: TechnicianUserView) => {
    setEditingUser({ id: t.id, name: t.name, email: "", role: "vrs_agent", phone: t.phone, racId: t.racId, canOrderParts: false } as unknown as SafeUser);
    setGrantingTech(true);
    setFormName(t.name);
    setFormEmail("");
    setFormPassword("");
    setFormRole("vrs_agent");
    setFormPhone(t.phone || "");
    setFormRacId(t.racId || "");
    setFormCompanyName("");
    setFormDivisions([]);
    setFormCanOrderParts(false);
    setDialogOpen(true);
  };

  const handleFormSubmit = () => {
    if (grantingTech && (!formPassword || formPassword.length < 6)) {
      toast({ title: "Password required", description: "Set a VRS login password (at least 6 characters) for this technician.", variant: "destructive" });
      return;
    }
    // 1099 provider portal: company name is required (must be one of the
    // preset companies) when the role is provider_1099.
    if (formRole === "provider_1099" && !formCompanyName) {
      toast({ title: "Company required", description: "Select the 1099 company for this provider account.", variant: "destructive" });
      return;
    }
    if (editingUser) {
      const data: Record<string, unknown> = {
        name: formName,
        role: formRole,
        phone: formPhone || null,
        racId: formRacId || null,
        companyName: formRole === "provider_1099" ? formCompanyName : null,
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
        companyName: formRole === "provider_1099" ? formCompanyName : undefined,
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
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => setActiveView("business-hours")}
                      data-active={activeView === "business-hours"}
                      data-testid="nav-business-hours"
                    >
                      <Clock className="w-4 h-4" />
                      <span>Business Hours</span>
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
                      onClick={() => setActiveView("health")}
                      data-active={activeView === "health"}
                      data-testid="nav-health"
                    >
                      <Activity className="w-4 h-4" />
                      <span>System Health</span>
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
                {activeView === "business-hours" && "Business Hours"}
                {activeView === "tickets" && "Ticket Overview"}
                {activeView === "feedback" && "Technician Feedback"}
                {activeView === "health" && "System Health"}
              </h1>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                variant="outline"
                onClick={() => setExportDialogOpen(true)}
                data-testid="button-export-ticket-header"
              >
                <Download className="w-4 h-4 mr-2" />
                Export Ticket
              </Button>
              {activeView === "users" && userTab === "staff" && (
                <>
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
                </>
              )}
            </div>
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
                            <TableHead>
                              <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleUserSort("name")} data-testid="sort-user-name">
                                Name <ArrowUpDown className="w-3 h-3" />
                              </button>
                            </TableHead>
                            <TableHead>
                              <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleUserSort("role")} data-testid="sort-user-role">
                                Role <ArrowUpDown className="w-3 h-3" />
                              </button>
                            </TableHead>
                            <TableHead className="hidden sm:table-cell">
                              <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleUserSort("phone")} data-testid="sort-user-phone">
                                Phone <ArrowUpDown className="w-3 h-3" />
                              </button>
                            </TableHead>
                            <TableHead>
                              <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleUserSort("racId")} data-testid="sort-user-racid">
                                RAC ID <ArrowUpDown className="w-3 h-3" />
                              </button>
                            </TableHead>
                            <TableHead className="hidden sm:table-cell">Password Status</TableHead>
                            <TableHead>
                              <div className="flex items-center gap-1.5">
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleUserSort("isActive")} data-testid="sort-user-status">
                                  Status <ArrowUpDown className="w-3 h-3" />
                                </button>
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
                          }).slice().sort((a: any, b: any) => {
                            const dir = userSortDir === "asc" ? 1 : -1;
                            if (userSortField === "isActive") {
                              return ((a.isActive ? 1 : 0) - (b.isActive ? 1 : 0)) * dir;
                            }
                            const av = (a[userSortField] || "").toString().toLowerCase();
                            const bv = (b[userSortField] || "").toString().toLowerCase();
                            return av < bv ? -dir : av > bv ? dir : 0;
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
                                  {u.role === "vrs_agent" && fieldTechIds.has(u.id) && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-blue-500 text-blue-700 dark:text-blue-400 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-field-tech-${u.id}`}>
                                      <Wrench className="w-3 h-3 mr-0.5" />Field Tech
                                    </Badge>
                                  )}
                                  {u.role === "provider_1099" && u.companyName && (
                                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-purple-500 text-purple-700 dark:text-purple-400 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-company-${u.id}`}>
                                      {u.companyName}
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
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("name")} data-testid="sort-tech-name">
                                  Name <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("racId")} data-testid="sort-tech-racid">
                                  RAC ID <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("phone")} data-testid="sort-tech-phone">
                                  Phone <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("district")} data-testid="sort-tech-district">
                                  District <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("manager")} data-testid="sort-tech-manager">
                                  Manager <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("totalTickets")} data-testid="sort-tech-tickets">
                                  Total Tickets <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("pending")} data-testid="sort-tech-pending">
                                  Pending <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("approved")} data-testid="sort-tech-approved">
                                  Approved <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>
                                <button className="flex items-center gap-1 hover:text-foreground" onClick={() => handleTechSort("rejected")} data-testid="sort-tech-rejected">
                                  Rejected <ArrowUpDown className="w-3 h-3" />
                                </button>
                              </TableHead>
                              <TableHead>VRS Access</TableHead>
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
                              .sort((a: any, b: any) => {
                                const dir = techSortDir === "asc" ? 1 : -1;
                                if (TECH_NUMERIC_FIELDS.includes(techSortField)) {
                                  const key = techSortField === "pending" ? "pendingCount"
                                    : techSortField === "approved" ? "approvedCount"
                                    : techSortField === "rejected" ? "rejectedCount"
                                    : "totalTickets";
                                  return ((a[key] ?? 0) - (b[key] ?? 0)) * dir;
                                }
                                const key = techSortField === "manager" ? "managerName" : techSortField;
                                const aVal = (a[key] || "").toString().toLowerCase();
                                const bVal = (b[key] || "").toString().toLowerCase();
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
                                    <div className="flex items-center gap-2">
                                      <Badge variant="secondary" className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 no-default-hover-elevate no-default-active-elevate">{t.approvedCount}</Badge>
                                      <span className="text-xs text-muted-foreground tabular-nums" data-testid={`text-tech-approved-pct-${t.id}`}>
                                        {t.totalTickets > 0 ? `${Math.round((t.approvedCount / t.totalTickets) * 100)}%` : "—"}
                                      </span>
                                    </div>
                                  </TableCell>
                                  <TableCell data-testid={`text-tech-rejected-${t.id}`}>
                                    <div className="flex items-center gap-2">
                                      <Badge variant="secondary" className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 no-default-hover-elevate no-default-active-elevate">{t.rejectedCount}</Badge>
                                      <span className="text-xs text-muted-foreground tabular-nums" data-testid={`text-tech-rejected-pct-${t.id}`}>
                                        {t.totalTickets > 0 ? `${Math.round((t.rejectedCount / t.totalTickets) * 100)}%` : "—"}
                                      </span>
                                    </div>
                                  </TableCell>
                                  <TableCell data-testid={`cell-tech-vrs-${t.id}`}>
                                    {t.role !== "technician" ? (
                                      <div className="flex items-center gap-2">
                                        <Badge variant="secondary" className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 no-default-hover-elevate no-default-active-elevate" data-testid={`badge-vrs-enabled-${t.id}`}>
                                          <Headset className="w-3 h-3 mr-0.5" />VRS-enabled
                                        </Badge>
                                        <Button
                                          variant="ghost"
                                          size="sm"
                                          className="text-red-600 dark:text-red-400 hover-elevate h-7 px-2 text-xs"
                                          onClick={() => setRevokeConfirm({ id: t.id, name: t.name })}
                                          data-testid={`button-revoke-vrs-${t.id}`}
                                        >
                                          Revoke
                                        </Button>
                                      </div>
                                    ) : (
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 px-2 text-xs"
                                        onClick={() => openGrantDialog(t)}
                                        data-testid={`button-grant-vrs-${t.id}`}
                                      >
                                        <Headset className="w-3 h-3 mr-1" />Grant VRS access
                                      </Button>
                                    )}
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
                    <Card>
                      <CardHeader>
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <CardTitle className="text-base">Export Tickets</CardTitle>
                          <Download className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </CardHeader>
                      <CardContent>
                        {exportControls}
                      </CardContent>
                    </Card>

                    <div className="space-y-1">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Volume</h2>
                      <p className="text-xs text-muted-foreground">Submission counts across timeframes.</p>
                    </div>
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

                    {replacementReviewAnalytics && (
                      <Card data-testid="card-replacement-review-analytics">
                        <CardHeader className="pb-3">
                          <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-purple-600" />
                            <CardTitle className="text-base">Replacement Review Outcomes</CardTitle>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="rounded-lg border p-3 bg-purple-50 dark:bg-purple-950/20">
                              <p className="text-2xl font-bold" data-testid="text-replacement-review-today">{replacementReviewAnalytics.today}</p>
                              <p className="text-xs text-muted-foreground">Today</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-purple-50 dark:bg-purple-950/20">
                              <p className="text-2xl font-bold" data-testid="text-replacement-review-week">{replacementReviewAnalytics.week}</p>
                              <p className="text-xs text-muted-foreground">This Week</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-purple-50 dark:bg-purple-950/20">
                              <p className="text-2xl font-bold" data-testid="text-replacement-review-month">{replacementReviewAnalytics.month}</p>
                              <p className="text-xs text-muted-foreground">This Month</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-purple-50 dark:bg-purple-950/20">
                              <p className="text-2xl font-bold" data-testid="text-replacement-review-alltime">{replacementReviewAnalytics.allTime}</p>
                              <p className="text-xs text-muted-foreground">All Time</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

                    {b2bReplacementAnalytics && (
                      <Card data-testid="card-b2b-replacement-analytics">
                        <CardHeader className="pb-3">
                          <div className="flex items-center gap-2">
                            <CheckCircle className="w-4 h-4 text-indigo-600" />
                            <CardTitle className="text-base">B2B Approved Replacement Outcomes</CardTitle>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <div className="rounded-lg border p-3 bg-indigo-50 dark:bg-indigo-950/20">
                              <p className="text-2xl font-bold" data-testid="text-b2b-replacement-today">{b2bReplacementAnalytics.today}</p>
                              <p className="text-xs text-muted-foreground">Today</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-indigo-50 dark:bg-indigo-950/20">
                              <p className="text-2xl font-bold" data-testid="text-b2b-replacement-week">{b2bReplacementAnalytics.week}</p>
                              <p className="text-xs text-muted-foreground">This Week</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-indigo-50 dark:bg-indigo-950/20">
                              <p className="text-2xl font-bold" data-testid="text-b2b-replacement-month">{b2bReplacementAnalytics.month}</p>
                              <p className="text-xs text-muted-foreground">This Month</p>
                            </div>
                            <div className="rounded-lg border p-3 bg-indigo-50 dark:bg-indigo-950/20">
                              <p className="text-2xl font-bold" data-testid="text-b2b-replacement-alltime">{b2bReplacementAnalytics.allTime}</p>
                              <p className="text-xs text-muted-foreground">All Time</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    )}

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


                    <div className="space-y-1 pt-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Quality Signals</h2>
                      <p className="text-xs text-muted-foreground">Tech behavior issues that warrant coaching follow-up.</p>
                    </div>

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
                                      <th className="text-left p-2 font-medium">
                                        <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => handleResubSort("techName")} data-testid="sort-resub-name">
                                          Technician <ArrowUpDown className="w-3 h-3" />
                                        </button>
                                      </th>
                                      <th className="text-left p-2 font-medium">
                                        <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => handleResubSort("techLdap")} data-testid="sort-resub-ldap">
                                          LDAP <ArrowUpDown className="w-3 h-3" />
                                        </button>
                                      </th>
                                      <th className="text-center p-2 font-medium">
                                        <button className="inline-flex items-center gap-1 hover:text-foreground mx-auto" onClick={() => handleResubSort("totalTickets")} data-testid="sort-resub-total">
                                          Total <ArrowUpDown className="w-3 h-3" />
                                        </button>
                                      </th>
                                      <th className="text-center p-2 font-medium">
                                        <button className="inline-flex items-center gap-1 hover:text-foreground mx-auto" onClick={() => handleResubSort("resubmissions")} data-testid="sort-resub-count">
                                          Resubs <ArrowUpDown className="w-3 h-3" />
                                        </button>
                                      </th>
                                      <th className="text-center p-2 font-medium">
                                        <button className="inline-flex items-center gap-1 hover:text-foreground mx-auto" onClick={() => handleResubSort("rate")} data-testid="sort-resub-rate">
                                          Rate <ArrowUpDown className="w-3 h-3" />
                                        </button>
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {[...resubmissionData.topTechnicians].sort((a: any, b: any) => {
                                      const dir = resubSortDir === "asc" ? 1 : -1;
                                      if (RESUB_NUMERIC_FIELDS.includes(resubSortField)) {
                                        return ((a[resubSortField] ?? 0) - (b[resubSortField] ?? 0)) * dir;
                                      }
                                      const aVal = (a[resubSortField] || "").toString().toLowerCase();
                                      const bVal = (b[resubSortField] || "").toString().toLowerCase();
                                      return aVal < bVal ? -dir : aVal > bVal ? dir : 0;
                                    }).map((t, i) => (
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

                    {coachingData && (
                      <Card>
                        <CardHeader>
                          <div className="flex items-center justify-between gap-2 flex-wrap">
                            <div>
                              <CardTitle className="text-base flex items-center gap-2">
                                <GraduationCap className="w-4 h-4 text-amber-600 dark:text-amber-500" />
                                Coaching: New ticket after rejection
                              </CardTitle>
                              <p className="text-xs text-muted-foreground mt-1">
                                Techs who submitted a brand-new ticket for the same SO instead of using the resubmit-after-rejection flow.
                              </p>
                            </div>
                            <Select value={String(coachingDays)} onValueChange={(v) => setCoachingDays(parseInt(v, 10))}>
                              <SelectTrigger className="w-32" data-testid="select-coaching-days">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="7">Last 7 days</SelectItem>
                                <SelectItem value="14">Last 14 days</SelectItem>
                                <SelectItem value="30">Last 30 days</SelectItem>
                                <SelectItem value="60">Last 60 days</SelectItem>
                                <SelectItem value="90">Last 90 days</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </CardHeader>
                        <CardContent>
                          {coachingData.rows.length === 0 ? (
                            <p className="text-sm text-muted-foreground py-4 text-center" data-testid="text-coaching-empty">
                              No coaching cases in the last {coachingData.days} days. Techs are using the resubmit flow correctly.
                            </p>
                          ) : (
                            <>
                              <p className="text-sm text-muted-foreground mb-3" data-testid="text-coaching-count">
                                <span className="font-semibold text-foreground">{coachingData.rows.length}</span> case{coachingData.rows.length === 1 ? "" : "s"} in the last {coachingData.days} days
                              </p>
                              <div className="rounded-md border overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="bg-muted/50 border-b">
                                      <th className="text-left p-2 font-medium">Technician</th>
                                      <th className="text-left p-2 font-medium">LDAP</th>
                                      <th className="text-left p-2 font-medium">Service Order</th>
                                      <th className="text-left p-2 font-medium">Previous (Rejected)</th>
                                      <th className="text-left p-2 font-medium">New Tickets</th>
                                      <th className="text-right p-2 font-medium">First Gap</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {coachingData.rows.map((c, i) => {
                                      const fmtGap = (m: number) => m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
                                      const gapLabel = fmtGap(c.minutesBetween);
                                      const tickets = c.newTickets || [];
                                      return (
                                        <tr key={`${c.previousId}`} className={i % 2 === 0 ? "" : "bg-muted/20"} data-testid={`coaching-row-${c.previousId}`}>
                                          <td className="p-2 align-top" data-testid={`text-coaching-name-${c.previousId}`}>{c.techName || "—"}</td>
                                          <td className="p-2 font-mono text-xs align-top" data-testid={`text-coaching-ldap-${c.previousId}`}>{c.techLdap || "—"}</td>
                                          <td className="p-2 font-mono text-xs align-top" data-testid={`text-coaching-so-${c.previousId}`}>{c.serviceOrder}</td>
                                          <td className="p-2 text-xs align-top">
                                            <div className="flex items-center gap-2">
                                              <button
                                                type="button"
                                                onClick={() => setCoachingDetailTicketId(c.previousId)}
                                                className="hover-elevate active-elevate-2 rounded-sm"
                                                data-testid={`button-coaching-prev-${c.previousId}`}
                                              >
                                                <Badge variant="destructive" className="text-xs cursor-pointer">#{c.previousId}</Badge>
                                              </button>
                                              <span className="text-muted-foreground" data-testid={`text-coaching-prev-at-${c.previousId}`}>{formatDate(c.previousAt)}</span>
                                            </div>
                                          </td>
                                          <td className="p-2 text-xs align-top">
                                            <div className="flex flex-col gap-1">
                                              {tickets.length > 1 && (
                                                <span className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-500 font-semibold" data-testid={`text-coaching-newcount-${c.previousId}`}>
                                                  {tickets.length} duplicate new tickets
                                                </span>
                                              )}
                                              {tickets.map((nt) => (
                                                <div key={nt.id} className="flex items-center gap-2 flex-wrap">
                                                  <button
                                                    type="button"
                                                    onClick={() => setCoachingDetailTicketId(nt.id)}
                                                    className="hover-elevate active-elevate-2 rounded-sm"
                                                    data-testid={`button-coaching-new-${nt.id}`}
                                                  >
                                                    <Badge variant="outline" className="text-xs cursor-pointer">#{nt.id}</Badge>
                                                  </button>
                                                  <span className="text-muted-foreground" data-testid={`text-coaching-new-at-${nt.id}`}>{formatDate(nt.at)}</span>
                                                  <span className="text-muted-foreground/70 font-mono text-[10px]" data-testid={`text-coaching-new-gap-${nt.id}`}>+{fmtGap(nt.minutesAfter)}</span>
                                                </div>
                                              ))}
                                            </div>
                                          </td>
                                          <td className="p-2 text-right font-mono text-xs align-top" data-testid={`text-coaching-gap-${c.previousId}`}>{gapLabel}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    <div className="space-y-1 pt-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Performance</h2>
                      <p className="text-xs text-muted-foreground">Outcomes and processing-time averages across all tickets.</p>
                    </div>

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
                          {analyticsData.otherStatusCounts && Object.entries(analyticsData.otherStatusCounts)
                            .filter(([_, count]) => count > 0)
                            .sort((a, b) => b[1] - a[1])
                            .map(([key, count]) => (
                              <div key={key} className="flex items-center justify-between gap-2 flex-wrap" data-testid={`row-status-${key}`}>
                                <div className="flex items-center gap-2">
                                  <Circle className="w-4 h-4 text-muted-foreground" />
                                  <span className="text-sm">{formatStage1Status(key)}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-bold" data-testid={`text-status-count-${key}`}>{count}</span>
                                  <Badge variant="secondary" className="text-xs">
                                    {analyticsData.totalSubmissions > 0
                                      ? Math.round((count / analyticsData.totalSubmissions) * 100)
                                      : 0}%
                                  </Badge>
                                </div>
                              </div>
                            ))}
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
                                {analyticsData.otherStatusCounts && (() => {
                                  const otherTotal = Object.values(analyticsData.otherStatusCounts).reduce((s, n) => s + n, 0);
                                  return otherTotal > 0 ? (
                                    <div
                                      className="bg-muted-foreground/40"
                                      style={{ width: `${(otherTotal / analyticsData.totalSubmissions) * 100}%` }}
                                    />
                                  ) : null;
                                })()}
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

                    <div className="space-y-1 pt-2">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Breakdown</h2>
                      <p className="text-xs text-muted-foreground">Per-district rollup of submission outcomes.</p>
                    </div>

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
            {activeView === "business-hours" && (
              <BusinessHoursSection />
            )}
            {activeView === "tickets" && (
              <TicketOverviewSection />
            )}
            {activeView === "feedback" && (
              <FeedbackSection />
            )}
            {activeView === "health" && (
              <HealthSection />
            )}
          </div>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle data-testid="text-dialog-title">
              {grantingTech ? "Grant VRS Agent Access" : editingUser ? "Edit User" : "Create User"}
            </DialogTitle>
            <DialogDescription>
              {grantingTech
                ? "Set a VRS login password and divisions so this field technician can flex into VRS. Their field login is unchanged."
                : editingUser ? "Update user details below." : "Fill in the details to create a new user."}
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
                {grantingTech ? "VRS Login Password (required)" : `Password${editingUser ? " (leave blank to keep current)" : ""}`}
              </Label>
              <Input
                id="user-password"
                type="password"
                value={formPassword}
                onChange={(e) => setFormPassword(e.target.value)}
                placeholder={grantingTech ? "Set a password (min 6 characters)" : editingUser ? "Leave blank to keep current" : "Password"}
                data-testid="input-user-password"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select value={formRole} onValueChange={setFormRole} disabled={grantingTech}>
                <SelectTrigger data-testid="select-user-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="technician">Technician</SelectItem>
                  <SelectItem value="vrs_agent">VRS Agent</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  {portal1099Enabled && (
                    <SelectItem value="provider_1099">1099 Provider</SelectItem>
                  )}
                  {user?.role === "super_admin" && (
                    <SelectItem value="super_admin">Super Admin</SelectItem>
                  )}
                </SelectContent>
              </Select>
              {grantingTech && (
                <p className="text-xs text-muted-foreground">This person stays a field technician — granting VRS access lets them also work tickets as a VRS agent.</p>
              )}
            </div>

            {formRole === "provider_1099" && (
              <div className="space-y-2">
                <Label htmlFor="user-company">1099 Company Name</Label>
                <Popover open={companyPickerOpen} onOpenChange={setCompanyPickerOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={companyPickerOpen}
                      className="w-full justify-between font-normal"
                      data-testid="select-user-company"
                    >
                      <span className={cn("truncate", !formCompanyName && "text-muted-foreground")}>
                        {formCompanyName || "Select company"}
                      </span>
                      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                    <Command>
                      <CommandInput placeholder="Search company..." data-testid="input-company-search" />
                      <CommandList>
                        <CommandEmpty>No company found.</CommandEmpty>
                        <CommandGroup>
                          {PROVIDER_1099_COMPANIES.map((company) => (
                            <CommandItem
                              key={company}
                              value={company}
                              onSelect={() => {
                                setFormCompanyName(company === formCompanyName ? "" : company);
                                setCompanyPickerOpen(false);
                              }}
                              data-testid={`option-company-${company}`}
                            >
                              <Check
                                className={cn(
                                  "mr-2 h-4 w-4",
                                  formCompanyName === company ? "opacity-100" : "opacity-0"
                                )}
                              />
                              {company}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              </div>
            )}

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
              <Label htmlFor="user-racid">{formRole === "provider_1099" ? "Username" : "LDAP ID"}</Label>
              <Input
                id="user-racid"
                value={formRacId}
                onChange={(e) => setFormRacId(e.target.value.replace(/[^a-zA-Z0-9]/g, ''))}
                placeholder={formRole === "provider_1099" ? "providerlogin" : "MTHOMA2"}
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
      <AlertDialog open={!!revokeConfirm} onOpenChange={(open) => !open && setRevokeConfirm(null)}>
        <AlertDialogContent data-testid="dialog-revoke-vrs">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke VRS Access</AlertDialogTitle>
            <AlertDialogDescription>
              Remove VRS agent access from <strong>{revokeConfirm?.name}</strong>? They will revert to a field technician and can no longer log in to the VRS dashboard. Their field login is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeConfirm) {
                  revokeVrsMutation.mutate({ id: revokeConfirm.id });
                }
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-revoke-vrs"
            >
              Revoke Access
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <TicketDetailDialog
        ticketId={coachingDetailTicketId}
        open={coachingDetailTicketId !== null}
        onClose={() => setCoachingDetailTicketId(null)}
      />
      <Dialog open={exportDialogOpen} onOpenChange={setExportDialogOpen}>
        <DialogContent className="max-w-2xl" data-testid="dialog-export-tickets">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="w-4 h-4" />
              Export Tickets
            </DialogTitle>
            <DialogDescription>
              Download tickets as CSV or XLSX for offline review or audit.
            </DialogDescription>
          </DialogHeader>
          {exportControls}
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  );
}
