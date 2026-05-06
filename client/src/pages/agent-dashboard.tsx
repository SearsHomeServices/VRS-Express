import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { downloadPhotoUrl, safeDate, formatDate } from "@/lib/utils";
import { getBusinessElapsedMs } from "@/lib/business-hours";
import { useWebSocket, playNotificationDing, disconnectWs, requestNotificationPermission, showBrowserNotification, loadNotificationSettings, getNotificationPermission } from "@/lib/websocket";
import NotificationSettings from "@/components/notification-settings";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
// Tyler 2026-04-29 — IntakeFormFieldset + intake-form-config imports removed
// here. The "Branch fields" Collapsible panel inside IntakeFormTab was
// retired (duplicated the Smartsheet iframe's own data-entry surface). The
// server-side `detectBranch` in `server/services/smartsheet.ts` still drives
// the prefill URL — only the client-side fieldset/gating helpers are gone.
import { IntakeFormTab } from "@/components/intake-form-tab";
import { CalculatorIframe } from "@/components/calculator-iframe";
import { CalculatorSettingsDialog } from "@/components/calculator-settings-dialog";
import type { Submission } from "@shared/schema";
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
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ClipboardCheck,
  ClipboardList,
  CheckCircle2,
  LogOut,
  Clock,
  User,
  Phone,
  FileText,
  Wrench,
  AlertTriangle,
  Filter,
  Image as ImageIcon,
  ShieldX,
  Send,
  Layers,
  Square,
  CheckSquare,
  Video,
  LifeBuoy,
  RotateCcw,
  Sparkles,
  Mic,
  Trash2,
  Globe,
  PanelRightClose,
  PanelRightOpen,
  Loader2,
  RefreshCw,
  MessageSquare,
  ArrowLeft,
  ZoomIn,
  Ban,
  ScrollText,
  XCircle,
  Download,
  Moon,
  Sun,
  Package,
  CreditCard,
  ChevronDown,
  BellRing,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useTheme } from "@/components/theme-provider";
import PhotoLightbox from "@/components/photo-lightbox";
import { SmsPreview } from "@/components/sms-preview";
import { buildSmsPreview } from "@/lib/smsPreview";
import { parseVideoUrls } from "@/lib/videoUrls";

type SubmissionWithTech = Submission & {
  technicianName: string;
  technicianPhone: string | null;
  assignedAgentName: string | null;
};

const DIVISION_LABELS: Record<string, string> = {
  refrigeration: "Refrigeration",
  laundry: "Laundry",
  cooking: "Cooking",
  dishwasher: "Dishwasher / Compactor",
  microwave: "Microwave",
  hvac: "HVAC",
  all_other: "All Other",
  nla: "NLA Parts",
};

const APPLIANCE_LABELS: Record<string, string> = {
  refrigeration: "Refrigerator",
  laundry: "Laundry",
  cooking: "Cooking",
  dishwasher: "Dishwasher / Compactor",
  microwave: "Microwave",
  hvac: "HVAC",
  all_other: "All Other",
};

// Tyler 2026-04-29 (VRS business-hours timer): both queue-elapsed and
// urgency-level computations now use business hours (8 AM-8 PM ET) so the
// queue doesn't show inflated times overnight. After-hours windows pause
// the accumulation. Format string preserved to avoid column-width churn.
function getTimeElapsed(createdAt: string | Date | null | undefined): string {
  const created = safeDate(createdAt);
  if (!created) return "—";
  const businessMs = getBusinessElapsedMs(created, new Date());
  const totalMinutes = Math.floor(businessMs / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const diffHours = Math.floor(totalMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ${totalMinutes % 60}m`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ${diffHours % 24}h`;
}

function getUrgencyLevel(createdAt: string | Date | null | undefined): "normal" | "warning" | "urgent" {
  const created = safeDate(createdAt);
  if (!created) return "normal";
  const diffHours = getBusinessElapsedMs(created, new Date()) / 3600000;
  if (diffHours >= 4) return "urgent";
  if (diffHours >= 2) return "warning";
  return "normal";
}

function getWarrantyLabel(sub: SubmissionWithTech): string {
  if (sub.warrantyProvider) return sub.warrantyProvider;
  return sub.warrantyType === "sears_protect" ? "Sears Protect / Sears PA / Sears Home Warranty (Cinch)" : sub.warrantyType;
}

export default function AgentDashboard() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const { theme, toggleTheme } = useTheme();
  const [activeView, setActiveView] = useState<"queue" | "mytickets" | "completed" | "nla_queue" | "nla_mytickets" | "nla_completed">("queue");
  const [queueMode, setQueueMode] = useState<"vrs" | "nla">("vrs");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">(() => getNotificationPermission());
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false);
  const isAdminViewing = user?.role === "admin" || user?.role === "super_admin";
  const isMyTicketsView = activeView === "mytickets" || activeView === "nla_mytickets";
  const isQueueView = activeView === "queue" || activeView === "nla_queue";
  const isCompletedView = activeView === "completed" || activeView === "nla_completed";
  const showNotifBanner = notifPermission !== "granted" && notifPermission !== "unsupported" && !notifBannerDismissed;

  useEffect(() => {
    if (activeView.startsWith("nla_")) {
      setQueueMode("nla");
    } else {
      setQueueMode("vrs");
    }
  }, [activeView]);

  useEffect(() => {
    if (isAdminViewing) return;
    const handleBeforeUnload = () => {
      disconnectWs();
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isAdminViewing]);

  const [divisionFilter, setDivisionFilter] = useState<string | null>(null);
  const [requestTypeFilter, setRequestTypeFilter] = useState<string | null>(null);
  const [divisionFiltersOpen, setDivisionFiltersOpen] = useState(true);
  const [requestTypeOpen, setRequestTypeOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [showOriginalDesc, setShowOriginalDesc] = useState(false);

  const [selectedAction, setSelectedAction] = useState<"approve" | "reject" | "reject_and_close" | "invalid" | "approve_submission" | null>(null);
  const [selectedRejectionReasons, setSelectedRejectionReasons] = useState<string[]>([]);
  const [rejectCloseReason, setRejectCloseReason] = useState("");
  const [rejectCloseCustomReason, setRejectCloseCustomReason] = useState("");
  const [rejectedPhotos, setRejectedPhotos] = useState<{url: string; reason: string}[]>([]);
  const [rejectedVideo, setRejectedVideo] = useState<{rejected: boolean; reason: string}>({rejected: false, reason: ""});
  const [rejectedVoiceNote, setRejectedVoiceNote] = useState<{rejected: boolean; reason: string}>({rejected: false, reason: ""});
  const [technicianMessage, setTechnicianMessage] = useState("");
  const [agentNotes, setAgentNotes] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [selectedInvalidReasons, setSelectedInvalidReasons] = useState<string[]>([]);
  const [invalidMessage, setInvalidMessage] = useState("");
  const [otherRejectionText, setOtherRejectionText] = useState("");
  const [otherInvalidText, setOtherInvalidText] = useState("");
  const [otherPhotoRejectionText, setOtherPhotoRejectionText] = useState("");
  const [otherVideoRejectionText, setOtherVideoRejectionText] = useState("");
  const [otherVoiceRejectionText, setOtherVoiceRejectionText] = useState("");
  const [nlaAction, setNlaAction] = useState<string | null>(null);
  const [nlaFoundPartNumber, setNlaFoundPartNumber] = useState("");
  const [nlaConfirmOpen, setNlaConfirmOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [todaysRgcCode, setTodaysRgcCode] = useState<string | null>(null);
  const [rgcMissing, setRgcMissing] = useState(false);
  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignNotes, setReassignNotes] = useState("");
  const [reassignTarget, setReassignTarget] = useState<string>("");
  const [divisionCorrectionTarget, setDivisionCorrectionTarget] = useState<string | null>(null);
  const [divisionCorrectionConfirmOpen, setDivisionCorrectionConfirmOpen] = useState(false);
  const [lightboxPhotos, setLightboxPhotos] = useState<string[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const openLightbox = (photos: string[], index: number) => {
    setLightboxPhotos(photos);
    setLightboxIndex(index);
    setLightboxOpen(true);
  };
  const [shsaiVisible, setShsaiVisible] = useState(true);
  // ----------------------------------------------------------------------
  // Right-panel tabs (T2 + 2026-04-27 modal->tab migration):
  // keep `shsaiVisible` for back-compat with the existing show/hide buttons
  // (test IDs button-show-shsai / button-hide-shsai are preserved).
  // Within the panel we switch between Service Order History (SHSAI),
  // the Repair/Replace Calculator iframe, and the new Intake Form tab
  // that replaced the IntakeFormReviewModal popup.
  // ----------------------------------------------------------------------
  type RightPanelView = "shsai" | "calculator" | "intake";
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>("shsai");
  useEffect(() => {
    if (!user?.id) return;
    try {
      const saved = localStorage.getItem(`agent:${user.id}:rightPanel`);
      if (saved === "shsai" || saved === "calculator" || saved === "intake") {
        setRightPanelView(saved);
      }
    } catch {}
  }, [user?.id]);
  useEffect(() => {
    if (!user?.id) return;
    try {
      localStorage.setItem(`agent:${user.id}:rightPanel`, rightPanelView);
    } catch {}
  }, [user?.id, rightPanelView]);
  // Tyler 2026-04-27 (Q2 = AUTO-SELECT ONCE, THEN RESPECT USER):
  // The post-Authorize "open intake" trigger schedules a tab switch on a
  // 350ms timer. If the agent picks a different tab during those 350ms we
  // cancel the pending switch — they made an explicit choice and we don't
  // yank them back. The flag is set true at trigger schedule time and
  // cleared either when the timer fires OR when the agent clicks any tab.
  // Selection change also clears it so a fresh ticket arms cleanly.
  const pendingIntakeAutoFireRef = useRef(false);
  const handleRightPanelViewChange = (v: RightPanelView) => {
    if (pendingIntakeAutoFireRef.current) pendingIntakeAutoFireRef.current = false;
    setRightPanelView(v);
  };
  // ----------------------------------------------------------------------
  // Tyler 2026-04-30 (resizable right panel):
  // Agents asked to be able to drag the boundary between the left ticket
  // pane and the right SHSAI/Calculator/Intake-Form tabs panel — the
  // hard-coded md:w-1/2 split was too narrow for the intake form on
  // larger monitors. We track the right panel's width as a percentage of
  // the parent flex row (clamped 25%-75%) and persist per-user. Below
  // the md breakpoint the layout still stacks (right panel keeps its
  // `hidden md:flex`), so the percentage is only consulted on md+.
  // The splitter handle and drag overlay live further down in the JSX.
  // ----------------------------------------------------------------------
  const RIGHT_PANEL_WIDTH_MIN = 25;
  const RIGHT_PANEL_WIDTH_MAX = 75;
  const RIGHT_PANEL_WIDTH_DEFAULT = 50;
  const [rightPanelWidthPct, setRightPanelWidthPct] = useState<number>(RIGHT_PANEL_WIDTH_DEFAULT);
  useEffect(() => {
    if (!user?.id) return;
    try {
      const saved = localStorage.getItem(`agent:${user.id}:rightPanelWidthPct`);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n) && n >= RIGHT_PANEL_WIDTH_MIN && n <= RIGHT_PANEL_WIDTH_MAX) {
          setRightPanelWidthPct(n);
        }
      }
    } catch {}
  }, [user?.id]);
  const [isResizingRightPanel, setIsResizingRightPanel] = useState(false);
  const splitterContainerRef = useRef<HTMLDivElement | null>(null);
  const handleSplitterMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = splitterContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const containerWidth = rect.width;
    // The splitter sits between the left ScrollArea and the right panel.
    // We compute the right panel width directly from cursor X relative to
    // the container's right edge — this keeps the splitter visually glued
    // to the cursor even after clamping at the min/max bounds.
    let lastPct = rightPanelWidthPct;
    const onMove = (moveEvent: MouseEvent) => {
      if (containerWidth <= 0) return;
      const pctFromCursor = ((rect.right - moveEvent.clientX) / containerWidth) * 100;
      const clamped = Math.max(RIGHT_PANEL_WIDTH_MIN, Math.min(RIGHT_PANEL_WIDTH_MAX, pctFromCursor));
      lastPct = clamped;
      setRightPanelWidthPct(clamped);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setIsResizingRightPanel(false);
      if (user?.id) {
        try {
          localStorage.setItem(`agent:${user.id}:rightPanelWidthPct`, String(lastPct));
        } catch {}
      }
    };
    setIsResizingRightPanel(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [rightPanelWidthPct, user?.id]);
  const handleSplitterDoubleClick = useCallback(() => {
    setRightPanelWidthPct(RIGHT_PANEL_WIDTH_DEFAULT);
    if (user?.id) {
      try {
        localStorage.setItem(`agent:${user.id}:rightPanelWidthPct`, String(RIGHT_PANEL_WIDTH_DEFAULT));
      } catch {}
    }
  }, [user?.id]);
  const [calcSettingsOpen, setCalcSettingsOpen] = useState(false);
  // ----------------------------------------------------------------------
  // Intake form (T3/T4/T5; modal->tab migrated 2026-04-27):
  // per-submission working values for the Stage 3 fallback fieldset. The
  // review-modal state was removed — the form now lives as a third tab in
  // the right panel (see RightPanelView type above) and reads its own
  // payload from `intakeValues`. Reset on selection change so we don't
  // leak data across tickets.
  // ----------------------------------------------------------------------
  const [intakeValues, setIntakeValues] = useState<Record<string, string>>({});
  // Stage 3 scroll target — set by the post-Authorize flow so we can land
  // the agent's view directly on the new Smartsheet Intake fallback card
  // when the agent dismisses the auto-opened modal.
  const stage3CardRef = useRef<HTMLDivElement | null>(null);
  const [shsaiLoading, setShsaiLoading] = useState(false);
  const [shsaiError, setShsaiError] = useState<string | null>(null);
  const [shsaiSession, setShsaiSession] = useState<{ sessionId: string; trackId: string; threadId: string; deviceInfo: string } | null>(null);
  const [shsaiMessages, setShsaiMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [shsaiFollowup, setShsaiFollowup] = useState("");
  const [shsaiFollowupLoading, setShsaiFollowupLoading] = useState(false);
  const [lastQueriedSubmissionId, setLastQueriedSubmissionId] = useState<number | null>(null);
  const [showStatusPopup, setShowStatusPopup] = useState(false);
  const [statusChecked, setStatusChecked] = useState(false);
  const [localAgentStatus, setLocalAgentStatus] = useState<string>(user?.agentStatus || "offline");

  useEffect(() => {
    if (user?.agentStatus) {
      setLocalAgentStatus(user.agentStatus);
    }
  }, [user?.agentStatus]);

  const agentStatus = localAgentStatus;

  const isAdminRole = user?.role === "admin" || user?.role === "super_admin";
  const { data: specsData, isSuccess: specsLoaded } = useQuery<{ divisions: string[] }>({
    queryKey: ["/api/agent/specializations"],
    enabled: !isAdminRole,
  });
  const { data: usersData } = useQuery<{ users: any[] }>({
    queryKey: ["/api/admin/users"],
    enabled: isAdminRole,
  });
  const availableAgents = (usersData?.users || []).filter(
    (u: any) => (u.role === "vrs_agent" || u.role === "admin" || u.role === "super_admin") && u.isActive
  );
  const allDivisionKeys = Object.keys(DIVISION_LABELS);
  const agentDivisions = isAdminRole ? allDivisionKeys : (specsData?.divisions || []);

  const isGeneralist = isAdminRole || agentDivisions.length >= allDivisionKeys.length;
  const hasNlaAccess = isAdminViewing || agentDivisions.includes("nla");

  const statusMutation = useMutation({
    mutationFn: async (status: "online" | "offline") => {
      const res = await fetch("/api/agent/status", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("vrs_token")}`,
        },
        body: JSON.stringify({ status }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update status");
      return data;
    },
    onSuccess: (_data, status) => {
      setLocalAgentStatus(status);
    },
    onError: (error: Error) => {
      toast({
        title: "Cannot Go Unavailable",
        description: error.message,
        variant: "destructive",
        duration: 6000,
      });
    },
  });

  const { subscribe } = useWebSocket(user?.role);

  useEffect(() => {
    requestNotificationPermission();
    loadNotificationSettings();
  }, []);

  useEffect(() => {
    const unsub1 = subscribe("new_ticket", (payload: any) => {
      playNotificationDing();
      const title = `New ${payload.applianceLabel} ticket, ${payload.warrantyLabel}`;
      const desc = `SO #${payload.serviceOrder}`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    });

    const unsub2 = subscribe("ticket_claimed", (payload: any) => {
      toast({
        title: "Ticket claimed by another agent",
        description: payload?.serviceOrder ? `SO #${payload.serviceOrder} is no longer available.` : "A queued ticket has been claimed by another agent.",
        duration: 5000,
      });
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    });

    const unsub3 = subscribe("ticket_queued", (payload: any) => {
      playNotificationDing();
      const title = `Ticket returned to queue`;
      const desc = `${payload.applianceLabel} - ${payload.warrantyLabel} (SO #${payload.serviceOrder})`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    });

    const unsub4 = subscribe("pending_tickets", (payload: any) => {
      const title = `Queued ${payload.applianceLabel} ticket, ${payload.warrantyLabel}`;
      const desc = `SO #${payload.serviceOrder} waiting in queue`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    });

    const unsub5 = subscribe("resubmission_received", (payload: any) => {
      playNotificationDing();
      const title = `Resubmission assigned to you`;
      const desc = `SO #${payload.serviceOrder} — ${payload.applianceLabel} (${payload.warrantyLabel}). A technician resubmitted a ticket you previously reviewed.`;
      toast({ title, description: desc, duration: 10000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    });

    const unsub6 = subscribe("ticket_assigned", (payload: any) => {
      playNotificationDing();
      const title = `Ticket assigned to you`;
      const desc = payload.message || `SO #${payload.serviceOrder} has been assigned to you by an admin.`;
      toast({ title, description: desc, duration: 8000 });
      showBrowserNotification(title, desc);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    });

    const unsub7 = subscribe("own_status_changed", (payload: any) => {
      if (payload?.status) {
        setLocalAgentStatus(payload.status);
      }
    });

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
      unsub6();
      unsub7();
    };
  }, [subscribe, toast]);

  useEffect(() => {
    if (!statusChecked && user && !isAdminViewing && agentStatus === "offline") {
      setShowStatusPopup(true);
      setStatusChecked(true);
    } else if (!statusChecked && user) {
      setStatusChecked(true);
    }
  }, [user, agentStatus, statusChecked, isAdminViewing]);

  const resetActionState = () => {
    setSelectedAction(null);
    setSelectedRejectionReasons([]);
    setRejectedPhotos([]);
    setRejectedVideo({rejected: false, reason: ""});
    setRejectedVoiceNote({rejected: false, reason: ""});
    setTechnicianMessage("");
    setAgentNotes("");
    setAuthCode("");
    setSelectedInvalidReasons([]);
    setInvalidMessage("");
    setOtherRejectionText("");
    setOtherInvalidText("");
    setOtherPhotoRejectionText("");
    setOtherVideoRejectionText("");
    setOtherVoiceRejectionText("");
    setRejectCloseReason("");
    setRejectCloseCustomReason("");
    setConfirmOpen(false);
    setNlaAction(null);
    setNlaFoundPartNumber("");
    setNlaConfirmOpen(false);
  };

  useEffect(() => {
    resetActionState();
  }, [selectedId]);

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    const isNlaView = activeView.startsWith("nla_");

    if (activeView === "queue") {
      params.set("ticketStatus", "queued");
      params.set("excludeRequestType", "parts_nla");
    } else if (activeView === "mytickets") {
      params.set("ticketStatus", "pending");
      params.set("excludeRequestType", "parts_nla");
    } else if (activeView === "completed") {
      params.set("completedToday", "true");
      params.set("excludeRequestType", "parts_nla");
    } else if (activeView === "nla_queue") {
      params.set("ticketStatus", "queued");
      params.set("requestType", "parts_nla");
    } else if (activeView === "nla_mytickets") {
      params.set("ticketStatus", "pending");
      params.set("requestType", "parts_nla");
    } else if (activeView === "nla_completed") {
      params.set("completedToday", "true");
      params.set("requestType", "parts_nla");
    }
    if (divisionFilter) {
      params.set("applianceType", divisionFilter);
    }
    if (!isNlaView && requestTypeFilter) {
      params.set("requestType", requestTypeFilter);
    }
    if (searchQuery.trim()) {
      params.set("search", searchQuery.trim());
    }
    return params.toString();
  }, [activeView, divisionFilter, requestTypeFilter, searchQuery]);

  const submissionsUrl = queryParams ? `/api/submissions?${queryParams}` : "/api/submissions";

  const { data: submissionsData, isLoading } = useQuery<{ submissions: SubmissionWithTech[] }>({
    queryKey: [submissionsUrl],
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const { data: statsData } = useQuery<{ queueCount: number; pendingCount: number; completedToday: number; nlaQueueCount?: number; nlaPendingCount?: number; nlaCompletedToday?: number }>({
    queryKey: ["/api/agent/stats"],
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const { data: rgcStatus } = useQuery<{
    needsEntry: boolean;
    missingCode: boolean;
    code: string | null;
  }>({
    queryKey: ["/api/agent/rgc-status"],
  });

  useEffect(() => {
    if (rgcStatus) {
      if (rgcStatus.missingCode) {
        setRgcMissing(true);
        setTodaysRgcCode(null);
      } else {
        setTodaysRgcCode(rgcStatus.code);
        setRgcMissing(false);
      }
    }
  }, [rgcStatus]);

  useEffect(() => {
    setShowOriginalDesc(false);
  }, [selectedId]);

  const fetchShsaiData = async (serviceOrder: string, submissionId: number) => {
    setShsaiLoading(true);
    setShsaiError(null);
    setShsaiSession(null);
    setShsaiMessages([]);
    setShsaiFollowup("");
    setLastQueriedSubmissionId(submissionId);
    try {
      const res = await apiRequest("POST", "/api/shsai/query", { serviceOrder });
      const json = await res.json();
      if (json.success) {
        setShsaiSession(json.data.session);
        const soNumber = serviceOrder.includes("-") ? serviceOrder.split("-").pop()! : serviceOrder;
        const queryText = `Give me all orders for customer having sample service order number ${soNumber}`;
        setShsaiMessages([
          { role: "user", content: queryText },
          { role: "assistant", content: json.data.content || "" },
        ]);
      } else {
        setShsaiError(json.error || "Failed to query SHSAI");
      }
    } catch {
      setShsaiError("Could not load service order history. Click to retry.");
    } finally {
      setShsaiLoading(false);
    }
  };

  useEffect(() => {
    if (isMyTicketsView && selectedId && shsaiVisible) {
      const sub = (submissionsData?.submissions || []).find((s) => s.id === selectedId);
      if (sub && sub.requestType !== "parts_nla" && sub.id !== lastQueriedSubmissionId) {
        fetchShsaiData(sub.serviceOrder, sub.id);
      }
    }
  }, [selectedId, activeView, shsaiVisible]);

  const submissions = useMemo(() => {
    return submissionsData?.submissions || [];
  }, [submissionsData]);

  const selectedSubmissionFromQuery = submissions.find((s) => s.id === selectedId) || null;

  // Tyler 2026-04-28 (intake-tab disappearance bug, Fix B — extended for
  // requirement A "ticket review screen must NOT clear after Approve/Reject"):
  // Post-action transition guard. The My Tickets list is filtered server-
  // side to ticketStatus="pending" (queryParams line 486). Once Approve
  // flips the row to "completed" (or Reject flips it to "rejected" + nulls
  // assignedTo), the next list refetch (triggered by the processMutation
  // onSuccess invalidation) drops the ticket from the submissions array.
  // selectedSubmissionFromQuery becomes null even though selectedId is
  // still set (we deliberately keepSelected per requirement A so the agent
  // can finish the Smartsheet intake form). That null would collapse BOTH
  // the left-side detail pane (gate at ~line 1578) AND the right-side 3-
  // tab panel — leaving an empty review screen and violating Tyler's
  // explicit "stay on the same ticket" requirement.
  //
  // The snapshot keeps a copy of the last-known query row alive. The
  // PUBLIC `selectedSubmission` const below is the snapshot-falling-back
  // value: every `selectedSubmission.foo` read in the JSX (127+ sites)
  // automatically picks up the snapshot when the My Tickets refetch
  // evicts the row, so the entire review screen survives the eviction.
  // (List-level UI iterates the `submissions` array directly, not
  // `selectedSubmission`, so the row still correctly disappears from the
  // My Tickets list and reappears in Completed.)
  //
  // The snapshot is cleared only when selectedId becomes null (genuine
  // deselection — fired by the IntakeFormTab.onConfirmed callback when
  // the agent clicks "I submitted Smartsheet"). That keeps a re-selection
  // of a different ticket from briefly nulling the gate while submissions
  // hasn't refetched yet.
  //
  // The snapshot is ALSO refreshed inside processMutation.onSuccess from
  // the fresh `{ submission: updated }` server response so action buttons
  // and status badges reflect the post-action state instead of the pre-
  // action snapshot (otherwise an Approved ticket would still show the
  // Approve/Reject button stripe in the detail pane).
  const selectedSubmissionSnapshotRef = useRef<typeof selectedSubmissionFromQuery>(null);
  useEffect(() => {
    if (selectedSubmissionFromQuery) {
      selectedSubmissionSnapshotRef.current = selectedSubmissionFromQuery;
    }
  }, [selectedSubmissionFromQuery]);
  const selectedSubmission =
    selectedSubmissionFromQuery ?? selectedSubmissionSnapshotRef.current;
  // Backward-compatible alias retained so any callsite still using the old
  // name continues to work; both reference the same snapshot-fallback value.
  const effectiveSelectedSubmission = selectedSubmission;

  // Reset intake form working values when switching submissions so we don't
  // leak data between tickets. Also clears the pending auto-fire flag so a
  // fresh ticket arms cleanly for the post-Authorize tab-switch trigger
  // (Tyler Q2 = re-selecting re-arms the auto-select).
  //
  // IMPORTANT: do NOT clear selectedSubmissionSnapshotRef here. This effect
  // and the snapshot-population effect above both run on the same commit
  // when selectedId AND selectedSubmission both change (e.g. selecting a
  // ticket from the queue). React fires effects in declaration order, so
  // clearing the snapshot here would always wipe the value the previous
  // effect just wrote, defeating Fix B entirely. Instead, the snapshot is
  // cleared only on explicit deselection below.
  useEffect(() => {
    setIntakeValues({});
    pendingIntakeAutoFireRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // Clear the snapshot only when the agent fully deselects (selectedId
  // becomes null). This path is hit by the post-action `setSelectedId(null)`
  // in processMutation onSuccess (for non-keepSelected actions like reject /
  // approve_submission on stage 1) and by manual back-to-queue navigation.
  // For keepSelected paths (justAuthorized, approve_submission), selectedId
  // stays set and the snapshot continues to fall back during the brief
  // selectedSubmission=null window from the My Tickets list refetch.
  useEffect(() => {
    if (!selectedId) {
      selectedSubmissionSnapshotRef.current = null;
    }
  }, [selectedId]);

  const submissionHistoryQuery = useQuery<{
    history: any[];
    reviewerNames: Record<number, string>;
    technicianName: string;
    resubmissionCount: number;
    maxResubmissions: number;
  }>({
    queryKey: ["/api/submissions", selectedId, "history"],
    enabled: !!selectedId,
  });

  // Stage 3 visibility — server is the single source of truth (matches the
  // 24h claim-gate predicate on the storage side). `required: true` means the
  // selected ticket has been authorized, an auth code went out, the request
  // type isn't NLA, and no intake_forms row exists yet.
  const intakeFormStatusQuery = useQuery<{
    required: boolean;
    recorded: boolean;
    reason?: string;
    intakeForm?: { id: number; createdAt: string; smartsheetUrlSubmitted?: string };
  }>({
    queryKey: ["/api/submissions", selectedId, "intake-form-status"],
    enabled: !!selectedId,
  });
  const stage3Required = !!intakeFormStatusQuery.data?.required;
  const stage3Recorded = !!intakeFormStatusQuery.data?.recorded;

  // Sidebar "Pending Smartsheet Intake" badge REMOVED 2026-04-26 (Tyler D2).
  // The 24h claim gate is gone, so there's no concept of "missing intake
  // forms" blocking future claims. Per-submission Stage 3 status is still
  // surfaced inline on the selected ticket via /intake-form-status.

  const REJECTION_SUGGESTIONS = [
    "Photos do not meet submission criteria",
    "Missing required photos",
    "Photo does not show voltage/reading",
    "Photo is blurry or unreadable",
    "Model/serial number not visible",
    "Estimate screenshot missing or incomplete",
    "Issue description does not match photos",
    "Missing appliance information",
    "Incomplete submission",
  ];

  const INVALID_SUGGESTIONS = [
    "Not a VRS-eligible warranty",
    "Product not covered under warranty",
    "Use standard authorization process",
    "Contact B2B support directly",
    "Service order not found or invalid",
    "Duplicate submission",
    "Technician not authorized for this service",
  ];

  const PHOTO_REJECTION_REASONS = [
    "Blurry or out of focus",
    "Does not show required information",
    "Wrong angle — cannot verify issue",
    "Too dark / overexposed",
    "Duplicate photo",
    "Does not match description",
    "Model/serial not readable",
    "Other",
  ];

  const MEDIA_REJECTION_REASONS = [
    "Too much background noise",
    "Cannot hear audio clearly",
    "No image / blank screen",
    "Video is too short",
    "Video does not show the issue",
    "Corrupted or won't play",
    "Other",
  ];

  // 24h INTAKE_REQUIRED claim gate REMOVED 2026-04-26 (Tyler D2). The fetch
  // bypass is preserved so future structured 409 codes (e.g. ALREADY_CLAIMED
  // race-loser) can still be discriminated, but no body codes are currently
  // consumed — every non-2xx surfaces as a destructive toast.
  const claimMutation = useMutation({
    mutationFn: async (submissionId: number) => {
      const token = localStorage.getItem("vrs_token");
      const res = await fetch(`/api/submissions/${submissionId}/claim`, {
        method: "PATCH",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || res.statusText || "Failed to claim");
      }
      return body;
    },
    onSuccess: () => {
      toast({ title: "Ticket Claimed", description: "You are now working on this ticket." });
      setLocalAgentStatus("working");
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const processMutation = useMutation({
    mutationFn: async ({ submissionId, body }: { submissionId: number; body: Record<string, unknown> }) => {
      const res = await apiRequest("PATCH", `/api/submissions/${submissionId}/process`, body);
      return res.json();
    },
    onSuccess: (data: any) => {
      // Tyler 2026-04-28 (Part A — keep-ticket-open): refresh the snapshot
      // ref from the fresh server response. Without this, the post-action
      // detail pane (which now persists past the My Tickets refetch
      // eviction via the snapshot fallback) would still show the pre-
      // action `ticketStatus="pending"`, causing the action button stripe
      // to remain visible on a just-approved/rejected ticket. The /process
      // endpoint returns `{ submission: updated }` — capturing it here
      // makes the snapshot reflect ticketStatus="completed" / "rejected"
      // immediately so action buttons and stage badges flip correctly
      // while the agent is still mid-intake-form on the right panel.
      if (data?.submission) {
        selectedSubmissionSnapshotRef.current = data.submission;
      }

      const actionLabel = selectedAction === "approve_submission" ? "Submission Approved" : selectedAction === "approve" ? "Approved" : selectedAction === "reject" ? "Rejected" : selectedAction === "reject_and_close" ? "Rejected & Closed" : "Marked Invalid";
      const actionDesc = selectedAction === "approve_submission" ? "Technician has been notified. Enter the authorization code to complete this ticket." : selectedAction === "reject_and_close" ? "Technician has been notified. This service order is permanently closed." : "Technician has been notified.";
      toast({ title: actionLabel, description: actionDesc });

      // Tyler 2026-04-28 (REQUIREMENT CHANGE — overrides prior post-Authorize-
      // only behavior): WHATEVER the outcome, the agent stays on the same
      // ticket with all ticket details visible, the Intake Form tab auto-
      // selected, and the Smartsheet iframe loaded. The intake form is
      // filled out next to the resolved ticket info. Close-out happens
      // ONLY when the agent clicks "I submitted Smartsheet" (handled in
      // IntakeFormTab.onConfirmed below — that callback fires
      // setSelectedId(null) + flips status back to online).
      //
      // Scope (Tyler 2026-04-28 follow-up): UNIFORM close-out across
      // every terminal outcome. All three reject-shaped actions —
      // "reject", "reject_and_close" (permanent closure), and "invalid"
      // (bogus ticket marker) — keep the ticket open + auto-switch to
      // the Intake Form tab, exactly like "approve". No special-case
      // branching by reject variant. The agent fills out the intake
      // form for every outcome.
      //
      // The only exception is "approve_submission" (Stage 1 mid-flow on
      // 2-stage warranties): the agent is still mid-flow and hasn't
      // issued the auth code yet, so they need to stay on the ticket
      // (keepSelected) but the Intake Form tab is NOT yet relevant —
      // it becomes relevant only after the final Approve / Reject /
      // Close / Invalid decision lands.
      const justResolved =
        (selectedAction === "approve" ||
          selectedAction === "reject" ||
          selectedAction === "reject_and_close" ||
          selectedAction === "invalid") &&
        selectedSubmission?.requestType !== "parts_nla";
      const keepSelected = selectedAction === "approve_submission" || justResolved;
      if (!keepSelected) {
        setSelectedId(null);
        setLocalAgentStatus("online");
      } else if (justResolved) {
        setLocalAgentStatus("online");
        // Tyler 2026-04-27 (modal -> tab migration): auto-select the new
        // Intake Form tab in the right panel instead of opening the
        // retired modal popup. The 350ms delay lets the per-submission
        // intake-form-status query refetch (the iframe itself loads
        // immediately because the tab is always-on per the 2026-04-28
        // change). We also force-show the right panel in case the
        // agent had it hidden — without that, the tab switch would be
        // silently invisible.
        // Q2 (AUTO-SELECT ONCE THEN RESPECT USER) is enforced via
        // `pendingIntakeAutoFireRef`: the flag is set true here and
        // cleared either when the timer fires or when the agent picks
        // any tab during the 350ms window (cancelling the pending fire).
        pendingIntakeAutoFireRef.current = true;
        window.setTimeout(() => {
          if (!pendingIntakeAutoFireRef.current) return;
          pendingIntakeAutoFireRef.current = false;
          setShsaiVisible(true);
          setRightPanelView("intake");
        }, 350);
      }

      resetActionState();
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const nlaProcessMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", `/api/submissions/${selectedId}/process-nla`, data);
      return await res.json();
    },
    // Tyler 2026-04-30 (NLA intake-form parity with AUTH): mirrors the
    // post-resolve UX from processMutation.onSuccess (line ~900). For any
    // terminal NLA action (resolution sent / rejected / invalid) we now
    // KEEP the ticket selected, force-show the right panel, and auto-
    // switch to the Intake Form tab so the agent fills out the NLA
    // Smartsheet form before the ticket detail closes. The actual close-
    // out (setSelectedId(null) + setLocalAgentStatus("online")) moves to
    // IntakeFormTab.onConfirmed below — same handoff AUTH uses.
    //
    // Exception: nla_escalate_to_pcard hands the ticket off to a P-Card
    // agent (server sets ticketStatus = "queued"), so the ORIGINAL agent
    // should NOT see/fill the intake form — the receiving P-Card agent
    // will when they process via nla_pcard_confirm. Keep the immediate
    // close-out for that one case.
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
      setNlaAction(null);
      setNlaFoundPartNumber("");
      setNlaConfirmOpen(false);

      const action = (variables as { action?: string } | undefined)?.action ?? "";
      const isEscalate = action === "nla_escalate_to_pcard";
      if (isEscalate) {
        setSelectedId(null);
        setLocalAgentStatus("online");
        toast({ title: "NLA Ticket Escalated", description: "Sent to P-Card agent." });
        return;
      }

      // Terminal NLA action — keep ticket open, auto-fire Intake tab.
      // The 350ms delay matches the AUTH side so the per-submission
      // intake-form-status query has time to refetch (now returning
      // required:true since the server hard-return for NLA was removed).
      setLocalAgentStatus("online");
      pendingIntakeAutoFireRef.current = true;
      window.setTimeout(() => {
        if (!pendingIntakeAutoFireRef.current) return;
        pendingIntakeAutoFireRef.current = false;
        setShsaiVisible(true);
        setRightPanelView("intake");
      }, 350);
      toast({ title: "NLA Ticket Processed", description: "Resolution sent. Now log the Smartsheet intake form on the right." });
    },
    onError: (error: Error) => {
      toast({ title: "Processing Failed", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (submissionId: number) => {
      const res = await apiRequest("DELETE", `/api/submissions/${submissionId}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Deleted", description: "Submission has been deleted." });
      setSelectedId(null);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const [sendToNlaOpen, setSendToNlaOpen] = useState(false);
  const [sendToNlaNotes, setSendToNlaNotes] = useState("");
  const [sendToNlaDivision, setSendToNlaDivision] = useState<string>("");

  const sendToNlaMutation = useMutation({
    mutationFn: async ({ submissionId, notes, division }: { submissionId: number; notes?: string; division?: string }) => {
      const res = await apiRequest("POST", `/api/submissions/${submissionId}/send-to-nla`, { notes, division });
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Sent to NLA Queue",
        description: "Ticket has been moved to the NLA parts queue.",
      });
      setSelectedId(null);
      setSendToNlaNotes("");
      setSendToNlaDivision("");
      setSendToNlaOpen(false);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const reassignMutation = useMutation({
    mutationFn: async ({ submissionId, agentId, notes }: { submissionId: number; agentId?: number; notes?: string }) => {
      const res = await apiRequest("PATCH", `/api/submissions/${submissionId}/reassign`, { agentId, notes });
      return res.json();
    },
    onSuccess: (_data: any, variables: { submissionId: number; agentId?: number }) => {
      toast({
        title: variables.agentId ? "Ticket Reassigned" : "Reassigned to Queue",
        description: variables.agentId
          ? `Assigned to ${availableAgents.find((a: any) => a.id === variables.agentId)?.name || "agent"}.`
          : "Ticket returned to the queue.",
      });
      setSelectedId(null);
      setReassignNotes("");
      setReassignTarget("");
      setReassignOpen(false);
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const divisionCorrectionMutation = useMutation({
    mutationFn: async ({ submissionId, newDivision }: { submissionId: number; newDivision: string }) => {
      const res = await apiRequest("PATCH", `/api/submissions/${submissionId}/correct-division`, { newDivision });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.agentKeepsTicket) {
        toast({ title: "Division Corrected", description: "Appliance type updated. You still own this ticket." });
        queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
        queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
        queryClient.refetchQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      } else {
        toast({ title: "Division Corrected", description: "Ticket re-routed to the correct division queue." });
        setSelectedId(null);
        setLocalAgentStatus("online");
        queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
        queryClient.invalidateQueries({ queryKey: ["/api/agent/stats"] });
        queryClient.refetchQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      }
      setDivisionCorrectionTarget(null);
      setDivisionCorrectionConfirmOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleClaimAndOpen = (submissionId: number) => {
    claimMutation.mutate(submissionId);
    setSelectedId(submissionId);
    setActiveView(activeView === "nla_queue" ? "nla_mytickets" : "mytickets");
  };

  const handleProcessSubmit = () => {
    if (!selectedSubmission || !selectedAction) return;
    const body: Record<string, unknown> = {
      action: selectedAction,
      agentNotes: agentNotes || undefined,
    };
    if (selectedAction === "reject") {
      const allRejectReasons = [...selectedRejectionReasons];
      if (allRejectReasons.includes("Other") && otherRejectionText.trim()) {
        allRejectReasons[allRejectReasons.indexOf("Other")] = `Other: ${otherRejectionText.trim()}`;
      } else if (allRejectReasons.includes("Other")) {
        allRejectReasons[allRejectReasons.indexOf("Other")] = "Other";
      }
      if (allRejectReasons.length > 0) {
        body.rejectionReasons = allRejectReasons;
      }
      const mediaRejections: Record<string, unknown> = {};
      if (rejectedPhotos.length > 0) {
        const processedPhotos = rejectedPhotos.map(rp => {
          if (rp.reason === "Other" && otherPhotoRejectionText.trim()) {
            return { ...rp, reason: `Other: ${otherPhotoRejectionText.trim()}` };
          }
          return rp;
        });
        mediaRejections.photos = processedPhotos;
      }
      if (rejectedVideo.rejected) {
        const videoData = rejectedVideo.reason === "Other" && otherVideoRejectionText.trim()
          ? { ...rejectedVideo, reason: `Other: ${otherVideoRejectionText.trim()}` }
          : rejectedVideo;
        mediaRejections.video = videoData;
      }
      if (rejectedVoiceNote.rejected) {
        const voiceData = rejectedVoiceNote.reason === "Other" && otherVoiceRejectionText.trim()
          ? { ...rejectedVoiceNote, reason: `Other: ${otherVoiceRejectionText.trim()}` }
          : rejectedVoiceNote;
        mediaRejections.voiceNote = voiceData;
      }
      if (Object.keys(mediaRejections).length > 0) body.rejectedMedia = mediaRejections;
      if (technicianMessage) body.technicianMessage = technicianMessage;
    }
    if (selectedAction === "reject_and_close") {
      const closeReason = rejectCloseReason === "Other" && rejectCloseCustomReason.trim()
        ? `Other: ${rejectCloseCustomReason.trim()}`
        : rejectCloseReason;
      body.rejectionReasons = [closeReason];
      if (technicianMessage) body.technicianMessage = technicianMessage;
    }
    if (selectedAction === "invalid") {
      const allInvalidReasons = [...selectedInvalidReasons];
      if (allInvalidReasons.includes("Other") && otherInvalidText.trim()) {
        allInvalidReasons[allInvalidReasons.indexOf("Other")] = `Other: ${otherInvalidText.trim()}`;
      } else if (allInvalidReasons.includes("Other")) {
        allInvalidReasons[allInvalidReasons.indexOf("Other")] = "Other";
      }
      body.invalidReason = allInvalidReasons.join("; ");
      body.invalidInstructions = invalidMessage || undefined;
    }
    if (selectedAction === "approve" && authCode) {
      body.authCode = authCode;
    }
    if ((selectedAction === "approve" || selectedAction === "approve_submission") && technicianMessage) {
      body.technicianMessage = technicianMessage;
    }
    processMutation.mutate({ submissionId: selectedSubmission.id, body });
    setConfirmOpen(false);
  };

  const isTwoStageWarranty = (sub: SubmissionWithTech | null): boolean => {
    if (!sub) return false;
    if (sub.requestType !== "authorization") return false;
    return needsExternalAuth(sub);
  };

  const isSubmissionApprovedStage = (sub: SubmissionWithTech | null): boolean => {
    if (!sub) return false;
    return (sub as any).submissionApproved === true;
  };

  const needsExternalAuth = (sub: SubmissionWithTech | null): boolean => {
    if (!sub) return false;
    const provider = (sub.warrantyProvider || "").toLowerCase();
    return ["american home shield", "ahs", "first american"].some(w => provider.includes(w));
  };

  const isNonPartsRequest = (sub: SubmissionWithTech | null): boolean => {
    if (!sub) return false;
    return sub.requestType !== "authorization" && sub.requestType !== "parts_nla";
  };

  const getProviderAuthLabel = (sub: SubmissionWithTech | null): string => {
    if (!sub) return "Authorization Code";
    const provider = (sub.warrantyProvider || "").toLowerCase();
    if (provider.includes("american home shield") || provider.includes("ahs")) return "AHS Authorization Code";
    if (provider.includes("first american")) return "First American Authorization Code";
    return "Authorization Code";
  };


  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full" data-testid="agent-dashboard">
        <Sidebar>
          <SidebarHeader className="p-4">
            <div className="flex items-center gap-2">
              <img src={searsLogo} alt="Sears Home Services" className="h-7" data-testid="img-logo" />
              <span className="font-semibold text-sm" data-testid="text-sidebar-title">VRS Agent</span>
            </div>
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-block w-2.5 h-2.5 rounded-full ${
                    agentStatus === "online" ? "bg-green-500" :
                    agentStatus === "working" ? "bg-yellow-500" :
                    "bg-gray-400"
                  }`}
                  data-testid="indicator-agent-status"
                />
                <span className="text-xs text-muted-foreground" data-testid="text-agent-name">{user?.name}</span>
              </div>
              {!isAdminViewing && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">
                    {agentStatus === "online" ? "Available" : agentStatus === "working" ? "Working" : "Unavailable"}
                  </span>
                  <Switch
                    checked={agentStatus === "online" || agentStatus === "working"}
                    onCheckedChange={(checked) => {
                      if (agentStatus === "working") {
                        toast({
                          title: "Cannot Go Unavailable",
                          description: "You have an open ticket. Complete it or ask an admin to reassign it.",
                          variant: "destructive",
                          duration: 5000,
                        });
                        return;
                      }
                      statusMutation.mutate(checked ? "online" : "offline");
                    }}
                    disabled={statusMutation.isPending}
                    data-testid="toggle-agent-status"
                    className="scale-75"
                  />
                </div>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent>
            {hasNlaAccess && (
              <SidebarGroup>
                <SidebarGroupContent>
                  <div className="flex rounded-lg border bg-muted/50 p-1 mx-2" data-testid="toggle-queue-mode">
                    <button
                      type="button"
                      onClick={() => {
                        setQueueMode("vrs");
                        setActiveView("queue");
                        setSelectedId(null);
                        setDivisionFilter(null);
                        setRequestTypeFilter(null);
                      }}
                      className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-all ${
                        queueMode === "vrs"
                          ? "bg-background shadow-sm text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      data-testid="toggle-vrs-mode"
                    >
                      VRS Authorization
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setQueueMode("nla");
                        setActiveView("nla_queue");
                        setSelectedId(null);
                        setDivisionFilter(null);
                        setRequestTypeFilter(null);
                      }}
                      className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-all ${
                        queueMode === "nla"
                          ? "bg-amber-100 dark:bg-amber-900/40 shadow-sm text-amber-900 dark:text-amber-200"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      data-testid="toggle-nla-mode"
                    >
                      NLA Parts
                    </button>
                  </div>
                </SidebarGroupContent>
              </SidebarGroup>
            )}

            <Separator className="my-2" />

            <SidebarGroup>
              <SidebarGroupLabel>{queueMode === "nla" ? "NLA Tickets" : "Tickets"}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {/* Stage 3 "Pending Smartsheet Intake" sidebar badge REMOVED
                      2026-04-26 (Tyler D2). The 24h claim gate is gone, so
                      there's no concept of pending-intake blocking the next
                      claim. Per-submission Stage 3 status is still surfaced
                      inline on the selected ticket. */}
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => { setActiveView(queueMode === "nla" ? "nla_queue" : "queue"); setSelectedId(null); }}
                      data-active={activeView === (queueMode === "nla" ? "nla_queue" : "queue")}
                      data-testid="nav-queue"
                    >
                      {queueMode === "nla" ? <Package className="w-4 h-4" /> : <ClipboardList className="w-4 h-4" />}
                      <span>Queue</span>
                      {queueMode === "nla" ? (
                        statsData?.nlaQueueCount != null && statsData.nlaQueueCount > 0 && activeView !== "nla_queue" && (
                          <Badge variant="secondary" className="ml-auto text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                            {statsData.nlaQueueCount}
                          </Badge>
                        )
                      ) : (
                        statsData && activeView !== "queue" && (
                          <Badge variant="secondary" className="ml-auto text-xs" data-testid="badge-queue-count">
                            {statsData.queueCount}
                          </Badge>
                        )
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => { setActiveView(queueMode === "nla" ? "nla_mytickets" : "mytickets"); setSelectedId(null); }}
                      data-active={activeView === (queueMode === "nla" ? "nla_mytickets" : "mytickets")}
                      data-testid="nav-mytickets"
                    >
                      {queueMode === "nla" ? <Package className="w-4 h-4" /> : <ClipboardCheck className="w-4 h-4" />}
                      <span>My Tickets</span>
                      {queueMode === "nla" ? (
                        statsData?.nlaPendingCount != null && statsData.nlaPendingCount > 0 && activeView !== "nla_mytickets" && (
                          <Badge variant="secondary" className="ml-auto text-xs bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                            {statsData.nlaPendingCount}
                          </Badge>
                        )
                      ) : (
                        statsData && (statsData.pendingCount ?? 0) > 0 && activeView !== "mytickets" && (
                          <Badge variant="secondary" className="ml-auto text-xs" data-testid="badge-pending-count">
                            {statsData.pendingCount}
                          </Badge>
                        )
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      onClick={() => { setActiveView(queueMode === "nla" ? "nla_completed" : "completed"); setSelectedId(null); }}
                      data-active={activeView === (queueMode === "nla" ? "nla_completed" : "completed")}
                      data-testid="nav-completed"
                    >
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Completed Today</span>
                      {queueMode === "vrs" && statsData && (
                        <Badge variant="outline" className="ml-auto text-xs" data-testid="badge-completed-count">
                          {statsData.completedToday}
                        </Badge>
                      )}
                      {queueMode === "nla" && statsData?.nlaCompletedToday != null && statsData.nlaCompletedToday > 0 && (
                        <Badge variant="outline" className="ml-auto text-xs">
                          {statsData.nlaCompletedToday}
                        </Badge>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>

            <Separator className="my-2" />

            <SidebarGroup>
              <button
                type="button"
                onClick={() => setDivisionFiltersOpen(!divisionFiltersOpen)}
                className="flex w-full items-center justify-between px-2 py-1 text-xs font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors"
                data-testid="toggle-division-filters"
              >
                <span>Division Filters</span>
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${divisionFiltersOpen ? "" : "-rotate-90"}`} />
              </button>
              {divisionFiltersOpen && (
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => setDivisionFilter(null)}
                        data-active={divisionFilter === null}
                        data-testid="filter-all"
                      >
                        <Filter className="w-4 h-4" />
                        <span>All Divisions</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    {Object.entries(DIVISION_LABELS)
                      .filter(([key]) => key !== "nla" && (isGeneralist || agentDivisions.includes(key)))
                      .map(([key, label]) => (
                      <SidebarMenuItem key={key}>
                        <SidebarMenuButton
                          onClick={() => setDivisionFilter(key)}
                          data-active={divisionFilter === key}
                          data-testid={`filter-${key}`}
                        >
                          <Wrench className="w-4 h-4" />
                          <span>{label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              )}
            </SidebarGroup>

            {queueMode === "vrs" && (
              <SidebarGroup>
                <button
                  type="button"
                  onClick={() => setRequestTypeOpen(!requestTypeOpen)}
                  className="flex w-full items-center justify-between px-2 py-1 text-xs font-medium text-sidebar-foreground/70 hover:text-sidebar-foreground transition-colors"
                  data-testid="toggle-request-type"
                >
                  <span>Request Type</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${requestTypeOpen ? "" : "-rotate-90"}`} />
                </button>
                {requestTypeOpen && (
                  <SidebarGroupContent>
                    <SidebarMenu>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          onClick={() => setRequestTypeFilter(null)}
                          data-active={requestTypeFilter === null}
                          data-testid="filter-request-all"
                        >
                          <Filter className="w-4 h-4" />
                          <span>All Types</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      {[
                        { value: "authorization", label: "Authorization" },
                        { value: "infestation_non_accessible", label: "Infestation / Non-Accessible" },
                      ].map((rt) => (
                        <SidebarMenuItem key={rt.value}>
                          <SidebarMenuButton
                            onClick={() => setRequestTypeFilter(rt.value)}
                            data-active={requestTypeFilter === rt.value}
                            data-testid={`filter-request-${rt.value}`}
                          >
                            <ClipboardList className="w-4 h-4" />
                            <span>{rt.label}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroupContent>
                )}
              </SidebarGroup>
            )}

          </SidebarContent>

          <SidebarFooter className="p-4 space-y-1">
            {(user?.role === "admin" || user?.role === "super_admin") && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => navigate("/admin/dashboard")}
                data-testid="nav-back-to-admin"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>Back to Admin</span>
              </Button>
            )}
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

        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {showNotifBanner && (
            <div
              className="w-full px-4 py-2 bg-blue-50 dark:bg-blue-900/30 text-blue-800 dark:text-blue-200 text-sm font-medium flex items-center justify-between gap-2"
              data-testid="banner-enable-notifications"
            >
              <div className="flex items-center gap-2 flex-1 justify-center">
                <BellRing className="w-4 h-4 flex-shrink-0" />
                <span>
                  {notifPermission === "denied"
                    ? "Notifications are blocked. Enable them in your browser settings to receive alerts when new tickets arrive."
                    : "Enable browser notifications to get alerts when new tickets arrive, even when this tab is in the background."}
                </span>
                {notifPermission === "default" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="ml-2 flex-shrink-0"
                    data-testid="button-enable-notifications"
                    onClick={async () => {
                      const result = await Notification.requestPermission();
                      setNotifPermission(result);
                    }}
                  >
                    Enable Notifications
                  </Button>
                )}
              </div>
              <button
                onClick={() => setNotifBannerDismissed(true)}
                className="text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-100 flex-shrink-0"
                data-testid="button-dismiss-notif-banner"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}
          {!isAdminViewing && agentStatus === "offline" && (
            <button
              onClick={() => statusMutation.mutate("online")}
              className="w-full px-4 py-2 bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 text-sm font-medium text-center hover:bg-amber-200 dark:hover:bg-amber-900/60 transition-colors flex items-center justify-center gap-2"
              data-testid="banner-offline"
            >
              <AlertTriangle className="w-4 h-4" />
              You are currently unavailable and not receiving tickets. Click here to go available.
            </button>
          )}
          <header className="flex items-center justify-between gap-2 p-3 border-b sticky top-0 z-50 bg-background">
            <div className="flex items-center gap-2">
              {selectedId && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="hidden md:inline-flex gap-1.5"
                  onClick={() => setSelectedId(null)}
                  data-testid="button-back-to-queue"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to Queue
                </Button>
              )}
              {!selectedId && (
                <SidebarTrigger data-testid="button-sidebar-toggle" />
              )}
              <h1 className="text-lg font-semibold" data-testid="text-page-title">
                {activeView === "queue" && `Queue (${statsData?.queueCount ?? 0})`}
                {activeView === "mytickets" && `My Tickets (${statsData?.pendingCount ?? 0})`}
                {activeView === "completed" && "Completed Today"}
                {activeView === "nla_queue" && `NLA Parts Queue (${statsData?.nlaQueueCount ?? 0})`}
                {activeView === "nla_mytickets" && `My NLA Tickets (${statsData?.nlaPendingCount ?? 0})`}
                {activeView === "nla_completed" && "NLA Completed Today"}
              </h1>
            </div>
            <div className="flex items-center gap-3">
            </div>
          </header>

          <div className="flex flex-1 min-h-0">
            <div className={`w-full md:w-[380px] border-r flex flex-col min-h-0 ${selectedId ? "hidden" : ""}`}>
              <div className="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm text-muted-foreground" data-testid="text-queue-count">
                  {submissions.length} ticket{submissions.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="px-3 pb-2">
                <Input
                  placeholder="Search by service order..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="text-sm"
                  data-testid="input-search-submissions"
                />
              </div>
              <ScrollArea className="flex-1">
                {isLoading ? (
                  <div className="p-4 space-y-3">
                    {[1, 2, 3].map((i) => (
                      <div key={i} className="h-20 bg-muted rounded-md animate-pulse" />
                    ))}
                  </div>
                ) : submissions.length === 0 ? (
                  <div className="p-8 text-center text-sm text-muted-foreground" data-testid="text-empty-queue">
                    No submissions in queue
                  </div>
                ) : (
                  <div className="p-2 space-y-1">
                    {submissions.map((sub) => {
                      const urgency = getUrgencyLevel(sub.createdAt);
                      const isSelected = selectedId === sub.id;
                      return (
                        <div
                          key={sub.id}
                          className={`flex items-start gap-2 rounded-md p-3 transition-colors ${
                            isSelected
                              ? "bg-accent"
                              : "hover-elevate"
                          }`}
                          style={
                            urgency === "urgent"
                              ? { borderLeft: "3px solid #ef4444" }
                              : urgency === "warning"
                              ? { borderLeft: "3px solid #f59e0b" }
                              : undefined
                          }
                          data-testid={`queue-item-${sub.id}`}
                        >
                          <button
                            onClick={() => {
                              if (isQueueView) {
                                handleClaimAndOpen(sub.id);
                              } else {
                                setSelectedId(sub.id);
                              }
                            }}
                            className="flex-1 text-left min-w-0"
                          >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                              <span className="font-medium text-sm" data-testid={`text-so-${sub.id}`}>
                                SO# {sub.serviceOrder}
                              </span>
                              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                <Clock className="w-3 h-3" />
                                <span data-testid={`text-elapsed-${sub.id}`}>{getTimeElapsed(sub.createdAt)}</span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-2 mt-1 flex-wrap">
                              <span className="text-xs text-muted-foreground" data-testid={`text-tech-${sub.id}`}>
                                {sub.technicianName}
                              </span>
                              <Badge variant="outline" className="text-xs" data-testid={`badge-type-${sub.id}`}>
                                {APPLIANCE_LABELS[sub.applianceType] || sub.applianceType}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                              {sub.requestType === "infestation_non_accessible" && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                                  data-testid={`badge-request-type-${sub.id}`}
                                >
                                  Infestation / Non-Accessible
                                </Badge>
                              )}
                              {sub.requestType === "parts_nla" && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
                                  data-testid={`badge-request-type-${sub.id}`}
                                >
                                  NLA Parts
                                </Badge>
                              )}
                              {sub.nlaEscalatedBy && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                                  data-testid={`badge-escalated-${sub.id}`}
                                >
                                  <CreditCard className="w-3 h-3 mr-0.5" />Ready for Order
                                </Badge>
                              )}
                              {sub.resubmissionOf && (
                                <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" data-testid={`badge-resubmission-${sub.id}`}>
                                  Resubmission
                                </Badge>
                              )}
                              {sub.aiEnhanced && (
                                <Badge variant="secondary" className="text-xs gap-0.5">
                                  <Sparkles className="w-3 h-3" />
                                  AI
                                </Badge>
                              )}
                              <Badge variant="outline" className="text-xs">
                                {getWarrantyLabel(sub)}
                              </Badge>
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            </div>

            <div className="flex-1 min-w-0 flex flex-col">
              {!selectedSubmission ? (
                <div className="flex-1 flex items-center justify-center text-muted-foreground" data-testid="text-no-selection">
                  <div className="text-center">
                    <ClipboardList className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">
                      {isQueueView ? "Click a ticket to claim and review it" : "Select a ticket to review"}
                    </p>
                  </div>
                </div>
              ) : (
                <div
                  ref={splitterContainerRef}
                  className="flex flex-1 min-h-0"
                  style={
                    // Tyler 2026-04-30: the right panel + splitter now also
                    // render for parts_nla tickets (the NLA intake form is
                    // routed to its own Smartsheet form server-side via
                    // VRS_INTAKE_FORM_NLA_BASE). Previously NLA was excluded
                    // entirely; agents now get the same SHSAI + Calculator +
                    // Intake-Form tab triplet for every request type.
                    isMyTicketsView && shsaiVisible && effectiveSelectedSubmission
                      ? ({ ["--right-panel-w" as any]: `${rightPanelWidthPct}%` } as React.CSSProperties)
                      : undefined
                  }
                >
                {/* Tyler 2026-04-27: column split widened from 60/40 to 50/50
                    so the Sears Repair/Replace Calculator (right panel) has
                    breathing room. Below md the panel still goes w-full and
                    the right panel is `hidden`, so mobile/tablet stack is
                    preserved. Internal ScrollArea retained on both sides.

                    Tyler 2026-04-30: split is now drag-resizable on md+. The
                    parent <div> exposes `--right-panel-w` (a percentage from
                    rightPanelWidthPct state). On md+ the left ScrollArea
                    consumes the remaining space via flex-1 and the right
                    panel below gets `md:w-[var(--right-panel-w)]`. The
                    splitter handle in between drives the percentage; min/max
                    clamps live in the drag handler (25%-75%). */}
                <ScrollArea className={isMyTicketsView && shsaiVisible ? "w-full md:flex-1 md:w-auto border-r min-w-0" : "flex-1"}>
                  <div className="p-4 md:p-6 max-w-3xl space-y-4 md:space-y-6">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="md:hidden mb-2 -ml-1 gap-1"
                      onClick={() => setSelectedId(null)}
                      data-testid="button-back-to-list"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back to list
                    </Button>
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div>
                        <h2 className="text-xl font-semibold" data-testid="text-detail-so">
                          SO# {selectedSubmission.serviceOrder}
                        </h2>
                        <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {selectedSubmission.technicianName}
                          </span>
                          <span>{selectedSubmission.racId}</span>
                          {selectedSubmission.phone && (
                            <span className="flex items-center gap-1">
                              <Phone className="w-3 h-3" />
                              {selectedSubmission.phone}
                            </span>
                          )}
                          <span className="text-xs">
                            Submitted {formatDate(selectedSubmission.createdAt)}
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          className={
                            selectedSubmission.requestType === "infestation_non_accessible"
                              ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                              : selectedSubmission.requestType === "parts_nla"
                              ? "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
                              : ""
                          }
                          variant={selectedSubmission.requestType === "authorization" ? "default" : "secondary"}
                          data-testid="badge-request-type"
                        >
                          {selectedSubmission.requestType === "authorization"
                            ? "Authorization"
                            : selectedSubmission.requestType === "parts_nla"
                            ? "Parts — NLA"
                            : "Infestation / Non-Accessible"}
                        </Badge>
                        {getUrgencyLevel(selectedSubmission.createdAt) !== "normal" && (
                          <Badge variant="destructive" data-testid="badge-urgency">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            {getUrgencyLevel(selectedSubmission.createdAt) === "urgent" ? "Urgent" : "Aging"}
                          </Badge>
                        )}
                        {/* Tyler 2026-04-30: button-show-shsai now also renders
                            for parts_nla tickets so the agent can re-open the
                            right panel (which now hosts the NLA-specific
                            intake form via VRS_INTAKE_FORM_NLA_BASE). */}
                        {isMyTicketsView && !shsaiVisible && selectedSubmission && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setShsaiVisible(true)}
                            data-testid="button-show-shsai"
                          >
                            <PanelRightOpen className="w-4 h-4 mr-1" />
                            Service History
                          </Button>
                        )}
                        {isMyTicketsView && selectedSubmission?.requestType !== "parts_nla" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setSendToNlaDivision(selectedSubmission?.applianceType || "");
                              setSendToNlaOpen(true);
                            }}
                            data-testid="button-send-to-nla"
                          >
                            <Package className="w-4 h-4 mr-1" />
                            Send to NLA
                          </Button>
                        )}
                        {isMyTicketsView && (user?.role === "admin" || user?.role === "super_admin") && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setReassignOpen(true)}
                            data-testid="button-reassign"
                          >
                            <RotateCcw className="w-4 h-4 mr-1" />
                            Reassign
                          </Button>
                        )}
                        {(user?.role === "admin" || user?.role === "super_admin") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setDeleteConfirmOpen(true)}
                            disabled={deleteMutation.isPending}
                            data-testid="button-delete-submission"
                          >
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </div>

                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                          <User className="w-4 h-4" />
                          Technician Info
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs text-muted-foreground">Name</p>
                            <p className="text-sm font-medium" data-testid="text-detail-tech-name">{selectedSubmission.technicianName}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">RAC ID</p>
                            <p className="text-sm font-medium" data-testid="text-detail-rac">{selectedSubmission.racId}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Phone</p>
                            <p className="text-sm font-medium flex items-center gap-1" data-testid="text-detail-phone">
                              <Phone className="w-3 h-3" />
                              {selectedSubmission.phone}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">District</p>
                            <p className="text-sm font-medium" data-testid="text-detail-district">{selectedSubmission.districtCode || "\u2014"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">ProcID</p>
                            <p className="text-sm font-medium" data-testid="text-detail-proc-id">{selectedSubmission.procId || "Not Found"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Client</p>
                            <p className="text-sm font-medium" data-testid="text-detail-client-nm">{selectedSubmission.clientNm || "Not Found"}</p>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                          <FileText className="w-4 h-4" />
                          Submission Details
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <p className="text-xs text-muted-foreground">Appliance Type</p>
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium" data-testid="text-detail-appliance">
                                {APPLIANCE_LABELS[selectedSubmission.applianceType] || selectedSubmission.applianceType}
                              </p>
                              {isMyTicketsView && selectedSubmission.ticketStatus === "pending" && selectedSubmission.assignedTo === user?.id && (
                                <Select
                                  value=""
                                  onValueChange={(val) => {
                                    if (val && val !== selectedSubmission.applianceType) {
                                      setDivisionCorrectionTarget(val);
                                      setDivisionCorrectionConfirmOpen(true);
                                    }
                                  }}
                                >
                                  <SelectTrigger className="h-6 w-auto px-2 text-xs gap-1" data-testid="button-correct-division">
                                    <Wrench className="w-3 h-3" />
                                    <span>Correct</span>
                                  </SelectTrigger>
                                  <SelectContent>
                                    {Object.entries(DIVISION_LABELS).filter(([key]) => key !== selectedSubmission.applianceType).map(([key, label]) => (
                                      <SelectItem key={key} value={key}>{label}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Warranty Provider</p>
                            <p className="text-sm font-medium" data-testid="text-detail-warranty">
                              {getWarrantyLabel(selectedSubmission)}
                            </p>
                          </div>
                          <div>
                            <p className="text-xs text-muted-foreground">Estimate Amount</p>
                            <p className="text-sm font-medium" data-testid="text-detail-estimate">
                              {selectedSubmission.estimateAmount ? `$${selectedSubmission.estimateAmount}` : "\u2014"}
                            </p>
                          </div>
                        </div>
                        <div>
                          {(selectedSubmission as any).partNumbers && (() => {
                            try {
                              const parts = JSON.parse((selectedSubmission as any).partNumbers);
                              if (Array.isArray(parts) && parts.length > 0) {
                                return (
                                  <div className="mb-3">
                                    <p className="text-xs text-muted-foreground mb-1">Part Number(s)</p>
                                    <p className="text-sm font-mono" data-testid="text-detail-part-numbers">{parts.join(", ")}</p>
                                  </div>
                                );
                              }
                              if (parts && typeof parts === "object" && !Array.isArray(parts)) {
                                const nlaParts = Array.isArray(parts.nla) ? parts.nla : [];
                                const availParts = Array.isArray(parts.available) ? parts.available : [];
                                return (
                                  <>
                                    {nlaParts.length > 0 && (
                                      <div className="mb-3">
                                        <p className="text-xs text-muted-foreground mb-1">NLA Part Number(s)</p>
                                        <p className="text-sm font-mono" data-testid="text-detail-nla-parts">{nlaParts.join(", ")}</p>
                                      </div>
                                    )}
                                    {availParts.length > 0 && (
                                      <div className="mb-3">
                                        <p className="text-xs text-muted-foreground mb-1">Other Required Parts (Available)</p>
                                        <p className="text-sm font-mono" data-testid="text-detail-available-parts">{availParts.join(", ")}</p>
                                      </div>
                                    )}
                                  </>
                                );
                              }
                            } catch {}
                            return null;
                          })()}
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-xs text-muted-foreground">Description</p>
                            {selectedSubmission.aiEnhanced && (
                              <Badge variant="secondary" className="text-xs gap-0.5">
                                <Sparkles className="w-3 h-3" />
                                AI-Enhanced
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm whitespace-pre-wrap" data-testid="text-detail-description">
                            {selectedSubmission.issueDescription}
                          </p>
                          {selectedSubmission.aiEnhanced && selectedSubmission.originalDescription && (
                            <div className="mt-2">
                              <button
                                type="button"
                                className="text-xs text-muted-foreground hover:underline"
                                onClick={() => setShowOriginalDesc(!showOriginalDesc)}
                                data-testid="button-toggle-original"
                              >
                                {showOriginalDesc ? "Hide original" : "View original"}
                              </button>
                              {showOriginalDesc && (
                                <div className="mt-1.5 p-2.5 rounded-md bg-muted text-sm text-muted-foreground whitespace-pre-wrap" data-testid="text-original-description">
                                  {selectedSubmission.originalDescription}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                          <ImageIcon className="w-4 h-4" />
                          Photos & Media
                          {selectedAction === "reject" && (
                            <Badge variant="outline" className="ml-auto text-[10px] text-red-600 border-red-300">Click media to reject</Badge>
                          )}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {(() => {
                          let parsed: any = null;
                          try { parsed = selectedSubmission.photos ? JSON.parse(selectedSubmission.photos) : null; } catch { parsed = null; }
                          if (!parsed) return <p className="text-sm text-muted-foreground" data-testid="text-no-photos">No photos attached</p>;

                          const isNewFormat = parsed && typeof parsed === "object" && !Array.isArray(parsed);
                          const estimatePhotos: string[] = isNewFormat ? (parsed.estimate || []) : [];
                          const issuePhotos: string[] = isNewFormat ? (parsed.issue || []) : [];
                          const legacyPhotos: string[] = Array.isArray(parsed) ? parsed : [];
                          const allPhotos = [...issuePhotos, ...estimatePhotos, ...legacyPhotos];

                          const isPhotoRejected = (url: string) => rejectedPhotos.some(rp => rp.url === url);
                          const getPhotoRejection = (url: string) => rejectedPhotos.find(rp => rp.url === url);

                          const togglePhotoRejection = (url: string) => {
                            if (isPhotoRejected(url)) {
                              setRejectedPhotos(prev => prev.filter(rp => rp.url !== url));
                            } else {
                              setRejectedPhotos(prev => [...prev, {url, reason: PHOTO_REJECTION_REASONS[0]}]);
                            }
                          };

                          const updatePhotoRejectionReason = (url: string, reason: string) => {
                            setRejectedPhotos(prev => prev.map(rp => rp.url === url ? {...rp, reason} : rp));
                          };

                          const renderPhotoGrid = (photos: string[], label: string, icon: any, offset: number, testIdPrefix: string) => {
                            if (photos.length === 0) return null;
                            return (
                              <div>
                                <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-2 flex items-center gap-1.5">
                                  <ImageIcon className="w-3.5 h-3.5" />
                                  {label} ({photos.length})
                                </p>
                                <div className="grid grid-cols-3 gap-2" data-testid={`media-${testIdPrefix}`}>
                                  {photos.map((url: string, i: number) => {
                                    const rejected = isPhotoRejected(url);
                                    const rejection = getPhotoRejection(url);
                                    return (
                                      <div key={i} className="space-y-1">
                                        <div
                                          className={`relative aspect-square bg-muted rounded-md overflow-hidden cursor-pointer group ${rejected ? "ring-2 ring-red-500" : ""}`}
                                          onClick={() => selectedAction === "reject" ? togglePhotoRejection(url) : openLightbox(allPhotos, offset + i)}
                                          data-testid={`${testIdPrefix}-photo-${i}`}
                                        >
                                          <img src={url} alt={`${label} ${i + 1}`} className={`w-full h-full object-cover pointer-events-none ${rejected ? "opacity-40" : ""}`} />
                                          {selectedAction === "reject" && (
                                            <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${rejected ? "bg-red-500/30 opacity-100" : "opacity-0 group-hover:opacity-100 bg-red-500/20"}`}>
                                              {rejected ? (
                                                <XCircle className="w-8 h-8 text-red-600" />
                                              ) : (
                                                <XCircle className="w-8 h-8 text-red-400" />
                                              )}
                                            </div>
                                          )}
                                          {selectedAction !== "reject" && (
                                            <>
                                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                                <ZoomIn className="w-6 h-6 text-white" />
                                              </div>
                                              <button
                                                className="absolute top-1 right-1 bg-black/60 rounded-md p-1 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 z-10"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  downloadPhotoUrl(url, `photo-${offset + i + 1}`);
                                                }}
                                                data-testid={`${testIdPrefix}-download-${i}`}
                                              >
                                                <Download className="w-3.5 h-3.5" />
                                              </button>
                                            </>
                                          )}
                                        </div>
                                        {rejected && (
                                          <>
                                            <Select value={rejection?.reason || ""} onValueChange={(val) => updatePhotoRejectionReason(url, val)}>
                                              <SelectTrigger className="h-7 text-[10px] border-red-300">
                                                <SelectValue />
                                              </SelectTrigger>
                                              <SelectContent>
                                                {PHOTO_REJECTION_REASONS.map(r => (
                                                  <SelectItem key={r} value={r}>{r}</SelectItem>
                                                ))}
                                              </SelectContent>
                                            </Select>
                                            {rejection?.reason === "Other" && (
                                              <input
                                                type="text"
                                                className="w-full text-[10px] border rounded-md px-2 py-1 bg-background border-red-300"
                                                placeholder="Specify reason..."
                                                value={otherPhotoRejectionText}
                                                onChange={(e) => setOtherPhotoRejectionText(e.target.value)}
                                                data-testid="input-other-photo-rejection"
                                              />
                                            )}
                                          </>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          };

                          return (
                            <div className="space-y-4">
                              {renderPhotoGrid(issuePhotos, "Issue Photos", ImageIcon, 0, "issue-photos")}
                              {renderPhotoGrid(estimatePhotos, "Model, Serial & Estimate Screenshots", ImageIcon, issuePhotos.length, "estimate-photos")}
                              {renderPhotoGrid(legacyPhotos, "Photos", ImageIcon, issuePhotos.length + estimatePhotos.length, "photos")}
                              {estimatePhotos.length === 0 && issuePhotos.length === 0 && legacyPhotos.length === 0 && (
                                <p className="text-sm text-muted-foreground" data-testid="text-no-photos">No photos attached</p>
                              )}
                            </div>
                          );
                        })()}
                        <Separator />
                        <div>
                          <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-2 flex items-center gap-1.5">
                            <Video className="w-3.5 h-3.5" />
                            Video
                          </p>
                          {(() => {
                            // Tyler 2026-04-30: render up to 3 video tiles. Rejection
                            // remains category-wide (rejectedMedia.video.rejected is a
                            // singleton on the wire), so the toggle below applies to all
                            // tiles together.
                            const videoList = parseVideoUrls(selectedSubmission.videoUrl);
                            return videoList.length > 0 ? (
                            <div className="space-y-2">
                              {videoList.map((vurl, vi) => (
                                <div
                                  key={`${vurl}-${vi}`}
                                  className={`rounded-md overflow-hidden bg-muted ${rejectedVideo.rejected ? "ring-2 ring-red-500" : ""}`}
                                  data-testid={videoList.length === 1 ? "media-video" : `media-video-${vi}`}
                                >
                                  <video
                                    src={vurl}
                                    controls
                                    className={`w-full max-h-[300px] ${rejectedVideo.rejected ? "opacity-40" : ""}`}
                                    data-testid={videoList.length === 1 ? "video-player" : `video-player-${vi}`}
                                  />
                                </div>
                              ))}
                              {selectedAction === "reject" && (
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setRejectedVideo(prev => ({...prev, rejected: !prev.rejected}))}
                                    className="shrink-0"
                                    data-testid="button-reject-video"
                                  >
                                    {rejectedVideo.rejected ? <CheckSquare className="w-5 h-5 text-red-600" /> : <Square className="w-5 h-5 text-muted-foreground" />}
                                  </button>
                                  <span className="text-xs text-red-600 font-medium">Reject Video</span>
                                </div>
                              )}
                              {rejectedVideo.rejected && (
                                <>
                                  <Select value={rejectedVideo.reason || ""} onValueChange={(val) => setRejectedVideo(prev => ({...prev, reason: val}))}>
                                    <SelectTrigger className="h-8 text-xs border-red-300" data-testid="select-video-reject-reason">
                                      <SelectValue placeholder="Select reason..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {MEDIA_REJECTION_REASONS.map(r => (
                                        <SelectItem key={r} value={r}>{r}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {rejectedVideo.reason === "Other" && (
                                    <input
                                      type="text"
                                      className="w-full text-xs border rounded-md px-2 py-1 bg-background border-red-300"
                                      placeholder="Specify reason..."
                                      value={otherVideoRejectionText}
                                      onChange={(e) => setOtherVideoRejectionText(e.target.value)}
                                      data-testid="input-other-video-rejection"
                                    />
                                  )}
                                </>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground" data-testid="text-no-video">No video attached</p>
                          );
                          })()}
                        </div>
                        <Separator />
                        <div>
                          <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium mb-2 flex items-center gap-1.5">
                            <Mic className="w-3.5 h-3.5" />
                            Voice Note
                          </p>
                          {selectedSubmission.voiceNoteUrl ? (
                            <div className="space-y-2">
                              <audio src={selectedSubmission.voiceNoteUrl} controls className={`w-full ${rejectedVoiceNote.rejected ? "opacity-40" : ""}`} data-testid="audio-player" />
                              {selectedAction === "reject" && (
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setRejectedVoiceNote(prev => ({...prev, rejected: !prev.rejected}))}
                                    className="shrink-0"
                                    data-testid="button-reject-voice-note"
                                  >
                                    {rejectedVoiceNote.rejected ? <CheckSquare className="w-5 h-5 text-red-600" /> : <Square className="w-5 h-5 text-muted-foreground" />}
                                  </button>
                                  <span className="text-xs text-red-600 font-medium">Reject Voice Note</span>
                                </div>
                              )}
                              {rejectedVoiceNote.rejected && (
                                <>
                                  <Select value={rejectedVoiceNote.reason || ""} onValueChange={(val) => setRejectedVoiceNote(prev => ({...prev, reason: val}))}>
                                    <SelectTrigger className="h-8 text-xs border-red-300" data-testid="select-voice-reject-reason">
                                      <SelectValue placeholder="Select reason..." />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {MEDIA_REJECTION_REASONS.map(r => (
                                        <SelectItem key={r} value={r}>{r}</SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {rejectedVoiceNote.reason === "Other" && (
                                    <input
                                      type="text"
                                      className="w-full text-xs border rounded-md px-2 py-1 bg-background border-red-300"
                                      placeholder="Specify reason..."
                                      value={otherVoiceRejectionText}
                                      onChange={(e) => setOtherVoiceRejectionText(e.target.value)}
                                      data-testid="input-other-voice-rejection"
                                    />
                                  )}
                                </>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground" data-testid="text-no-voice-note">No voice note attached</p>
                          )}
                        </div>
                      </CardContent>
                    </Card>

                    {submissionHistoryQuery.data && submissionHistoryQuery.data.history.length > 1 && (
                      <Card>
                        <CardHeader className="pb-2">
                          <CardTitle className="text-base flex items-center gap-1.5">
                            <ScrollText className="w-4 h-4" />
                            Submission History
                          </CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Resubmission {submissionHistoryQuery.data.resubmissionCount} of {submissionHistoryQuery.data.maxResubmissions}
                          </p>
                        </CardHeader>
                        <CardContent className="space-y-0">
                          {submissionHistoryQuery.data.history.map((item: any, idx: number) => {
                            const isOriginal = item.resubmissionOf == null;
                            const resubNumber = isOriginal ? 0 : submissionHistoryQuery.data!.history.filter((h: any, hi: number) => h.resubmissionOf != null && hi <= idx).length;
                            return (
                              <div key={item.id}>
                                {idx > 0 && <Separator className="my-2" />}
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between">
                                    <p className="text-xs font-medium">
                                      {isOriginal ? "Original Submission" : `Resubmission #${resubNumber}`}
                                      {item.id === selectedId && <Badge variant="outline" className="ml-2 text-[10px] py-0">Current</Badge>}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      {formatDate(item.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                    </p>
                                  </div>
                                  {item.appealNotes && (
                                    <p className="text-xs text-blue-600">
                                      Appeal: {item.appealNotes}
                                    </p>
                                  )}
                                  {(item.ticketStatus === "rejected" || item.stage1Status === "rejected") && (item.stage1RejectionReason || item.rejectionReasons) && (
                                    <p className="text-xs text-destructive">
                                      Rejected: "{item.rejectionReasons ? (typeof item.rejectionReasons === 'string' ? JSON.parse(item.rejectionReasons) : item.rejectionReasons).join(', ') : item.stage1RejectionReason}"
                                    </p>
                                  )}
                                  {(item.ticketStatus === "invalid" || item.stage1Status === "invalid") && item.invalidReason && (
                                    <p className="text-xs text-muted-foreground">
                                      Invalid: "{item.invalidReason}"
                                    </p>
                                  )}
                                  {(item.ticketStatus === "completed" || item.stage1Status === "approved") && (
                                    <p className="text-xs text-green-600">Approved</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </CardContent>
                      </Card>
                    )}

                    {isMyTicketsView && selectedSubmission.ticketStatus === "pending" && selectedSubmission.requestType === "parts_nla" && (
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base flex items-center gap-2">
                            <Package className="w-4 h-4" />
                            {selectedSubmission.nlaEscalatedBy ? "NLA Parts — Escalated for P-Card Order" : "NLA Parts Resolution"}
                          </CardTitle>
                          {selectedSubmission.resubmissionOf && (
                            <p className="text-xs text-blue-600" data-testid="text-nla-resubmission-indicator">
                              This is a resubmission
                            </p>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-5">
                          {selectedSubmission.nlaEscalatedBy ? (
                            <>
                              <div className="border rounded-lg p-4 bg-blue-50/50 dark:bg-blue-950/10 space-y-2">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Pre-Filled by Research Agent</p>
                                {selectedSubmission.reassignmentNotes && (
                                  <p className="text-sm">{selectedSubmission.reassignmentNotes}</p>
                                )}
                                <div className="grid grid-cols-2 gap-2 text-sm">
                                  <div>
                                    <span className="text-muted-foreground text-xs">Resolution:</span>
                                    <p className="font-medium">
                                      {selectedSubmission.nlaResolution === "replacement_submitted" ? "Replacement Submitted (SPHW / MPA)" :
                                       selectedSubmission.nlaResolution === "replacement_tech_initiates" ? "Replacement Approved — Tech Initiates" :
                                       selectedSubmission.nlaResolution === "part_found_vrs_ordered" ? "Part Found — VRS Orders" :
                                       selectedSubmission.nlaResolution === "part_found_tech_orders" ? "Part Found — Tech Orders" :
                                       selectedSubmission.nlaResolution || "—"}
                                    </p>
                                  </div>
                                  {selectedSubmission.nlaFoundPartNumber && (
                                    <div>
                                      <span className="text-muted-foreground text-xs">Part Number:</span>
                                      <p className="font-mono font-medium">{selectedSubmission.nlaFoundPartNumber}</p>
                                    </div>
                                  )}
                                </div>
                                {selectedSubmission.technicianMessage && (
                                  <div>
                                    <span className="text-muted-foreground text-xs">Message to Technician:</span>
                                    <p className="text-sm">{selectedSubmission.technicianMessage}</p>
                                  </div>
                                )}
                              </div>

                              <div className="space-y-2">
                                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                  <Send className="w-3 h-3" />
                                  Additional Instructions (optional)
                                </Label>
                                <Textarea
                                  placeholder="Add any additional instructions for the technician..."
                                  value={technicianMessage}
                                  onChange={(e) => setTechnicianMessage(e.target.value)}
                                  className="resize-none"
                                  rows={3}
                                  data-testid="input-nla-pcard-instructions"
                                />
                              </div>

                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block">Internal Agent Notes (not sent to technician)</Label>
                                <Textarea
                                  placeholder="Internal notes..."
                                  value={agentNotes}
                                  onChange={(e) => setAgentNotes(e.target.value)}
                                  className="resize-none"
                                  rows={2}
                                  data-testid="input-nla-pcard-agent-notes"
                                />
                              </div>

                              <Button
                                className="w-full"
                                size="lg"
                                onClick={() => setNlaConfirmOpen(true)}
                                disabled={nlaProcessMutation.isPending}
                                data-testid="button-nla-pcard-confirm"
                              >
                                <CreditCard className="w-4 h-4 mr-2" />
                                {nlaProcessMutation.isPending ? "Processing..." : "Confirm & Complete Order"}
                              </Button>
                            </>
                          ) : (
                            <>
                              <div className="space-y-2">
                                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                                  Resolution *
                                </Label>
                                <Select
                                  value={nlaAction || ""}
                                  onValueChange={(val) => setNlaAction(val || null)}
                                >
                                  <SelectTrigger data-testid="select-nla-resolution">
                                    <SelectValue placeholder="Select NLA resolution..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="nla_replacement_submitted">
                                      Verified NLA VRS Replacement Submitted (SPHW / MPA)
                                    </SelectItem>
                                    <SelectItem value="nla_replacement_tech_initiates">
                                      Verified NLA VRS Replacement Approved (SHW / Cinch — Tech initiates in TechHub)
                                    </SelectItem>
                                    <SelectItem value="nla_part_found_vrs_ordered">
                                      Part Found — VRS Ordered Part (reschedule the call in TH)
                                    </SelectItem>
                                    <SelectItem value="nla_part_found_tech_orders">
                                      Part Found (Instruct Tech to order part # Provided)
                                    </SelectItem>
                                    <SelectItem value="nla_reject">
                                      Rejected — More Information Needed
                                    </SelectItem>
                                    <SelectItem value="nla_invalid">
                                      Invalid NLA Request
                                    </SelectItem>
                                    <SelectItem value="nla_rfr_eligible">
                                      Parts is RFR eligible — Tech to remove and return for repair
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>

                              {nlaAction && ["nla_replacement_submitted", "nla_replacement_tech_initiates", "nla_part_found_vrs_ordered", "nla_part_found_tech_orders", "nla_rfr_eligible"].includes(nlaAction) && (
                                <div className="space-y-2 border rounded-lg p-3 bg-green-50/50 dark:bg-green-950/10">
                                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Authorization Code (RGC)</p>
                                  {rgcMissing ? (
                                    <p className="text-sm text-destructive" data-testid="text-nla-rgc-not-set">
                                      No RGC code set for today. Contact an administrator.
                                    </p>
                                  ) : (
                                    <div>
                                      <Label className="text-xs text-muted-foreground">Today's RGC Code</Label>
                                      <Input
                                        value={todaysRgcCode || ""}
                                        readOnly
                                        className="font-mono bg-muted mt-1"
                                        data-testid="input-nla-rgc-readonly"
                                      />
                                    </div>
                                  )}
                                </div>
                              )}

                              {nlaAction === "nla_part_found_vrs_ordered" && !user?.canOrderParts && (
                                <div className="p-3 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30">
                                  <p className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                    <CreditCard className="w-3 h-3" /> Will escalate to P-card agent for ordering
                                  </p>
                                </div>
                              )}

                              {nlaAction === "nla_part_found_tech_orders" && (
                                <div className="space-y-1">
                                  <Label className="text-xs">Part Number</Label>
                                  <Input
                                    placeholder="Enter part number..."
                                    value={nlaFoundPartNumber}
                                    onChange={(e) => setNlaFoundPartNumber(e.target.value.toUpperCase())}
                                    className="font-mono"
                                    data-testid="input-nla-part-number"
                                  />
                                </div>
                              )}

                              {nlaAction === "nla_reject" && (
                                <div className="space-y-2 border rounded-lg p-3 bg-red-50/50 dark:bg-red-950/10">
                                  <p className="text-xs font-medium text-muted-foreground">Rejection Reasons</p>
                                  {REJECTION_SUGGESTIONS.map((reason) => (
                                    <button
                                      key={reason}
                                      type="button"
                                      className="flex items-center gap-2 cursor-pointer w-full text-left"
                                      onClick={() => {
                                        setSelectedRejectionReasons((prev) =>
                                          prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
                                        );
                                      }}
                                    >
                                      {selectedRejectionReasons.includes(reason) ? (
                                        <CheckSquare className="w-4 h-4 text-red-600 shrink-0" />
                                      ) : (
                                        <Square className="w-4 h-4 text-muted-foreground shrink-0" />
                                      )}
                                      <span className="text-sm">{reason}</span>
                                    </button>
                                  ))}
                                </div>
                              )}

                              {nlaAction === "nla_invalid" && (
                                <div className="space-y-2 border rounded-lg p-3 bg-gray-50/50 dark:bg-gray-950/10">
                                  <p className="text-xs font-medium text-muted-foreground">Invalid Reasons</p>
                                  {INVALID_SUGGESTIONS.map((reason) => (
                                    <button
                                      key={reason}
                                      type="button"
                                      className="flex items-center gap-2 cursor-pointer w-full text-left"
                                      onClick={() => {
                                        setSelectedInvalidReasons((prev) =>
                                          prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
                                        );
                                      }}
                                    >
                                      {selectedInvalidReasons.includes(reason) ? (
                                        <CheckSquare className="w-4 h-4 text-gray-600 shrink-0" />
                                      ) : (
                                        <Square className="w-4 h-4 text-muted-foreground shrink-0" />
                                      )}
                                      <span className="text-sm">{reason}</span>
                                    </button>
                                  ))}
                                  <div className="pt-2">
                                    <Label className="text-xs">Instructions for Technician</Label>
                                    <Textarea
                                      placeholder="Additional instructions..."
                                      value={invalidMessage}
                                      onChange={(e) => setInvalidMessage(e.target.value)}
                                      className="resize-none mt-1"
                                      rows={2}
                                      data-testid="input-nla-invalid-instructions"
                                    />
                                  </div>
                                </div>
                              )}

                              <div className="space-y-2">
                                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                  <Send className="w-3 h-3" />
                                  Additional context for the technician *
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  Auth code, part number, and standard NLA instructions are included automatically. Add anything extra the tech needs (scheduling, customer notes, special handling). Required.
                                </p>
                                <Textarea
                                  placeholder="e.g., Customer is aware of the delay — schedule for Friday"
                                  value={technicianMessage}
                                  onChange={(e) => setTechnicianMessage(e.target.value)}
                                  className="resize-none"
                                  rows={3}
                                  data-testid="input-nla-tech-message"
                                />
                              </div>
                              {nlaAction && (
                                <SmsPreview
                                  testId="preview-nla"
                                  text={buildSmsPreview({
                                    serviceOrder: selectedSubmission.serviceOrder,
                                    action: nlaAction as any,
                                    message: technicianMessage,
                                    rgcCode: todaysRgcCode,
                                    partNumber: nlaFoundPartNumber,
                                    rejectionReasons: selectedRejectionReasons
                                      .map((r) => (r === "Other" ? otherRejectionText.trim() || "Other" : r))
                                      .filter(Boolean),
                                    invalidReasons: selectedInvalidReasons
                                      .map((r) => (r === "Other" ? otherInvalidText.trim() || "Other" : r))
                                      .filter(Boolean),
                                  })}
                                />
                              )}

                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block">Internal Agent Notes (not sent to technician)</Label>
                                <Textarea
                                  placeholder="Internal notes..."
                                  value={agentNotes}
                                  onChange={(e) => setAgentNotes(e.target.value)}
                                  className="resize-none"
                                  rows={2}
                                  data-testid="input-nla-agent-notes"
                                />
                              </div>

                              {nlaAction === "nla_part_found_vrs_ordered" && !user?.canOrderParts ? (
                                <Button
                                  className="w-full"
                                  size="lg"
                                  variant="secondary"
                                  onClick={() => {
                                    if (!nlaAction) {
                                      toast({ title: "Error", description: "Select a resolution", variant: "destructive" });
                                      return;
                                    }
                                    if (!technicianMessage.trim()) {
                                      toast({ title: "Instructions Required", description: "Please provide instructions for the technician.", variant: "destructive" });
                                      return;
                                    }
                                    if (rgcMissing) {
                                      toast({ title: "Error", description: "RGC code not set for today. Contact an administrator.", variant: "destructive" });
                                      return;
                                    }
                                    setNlaConfirmOpen(true);
                                  }}
                                  disabled={!nlaAction || !technicianMessage.trim() || nlaProcessMutation.isPending}
                                  data-testid="button-nla-escalate"
                                >
                                  <CreditCard className="w-4 h-4 mr-2" />
                                  {nlaProcessMutation.isPending ? "Processing..." : "Escalate to P-Card Agent"}
                                </Button>
                              ) : (
                                <Button
                                  className="w-full"
                                  size="lg"
                                  onClick={() => {
                                    if (!nlaAction) {
                                      toast({ title: "Error", description: "Select a resolution", variant: "destructive" });
                                      return;
                                    }
                                    if (!technicianMessage.trim()) {
                                      toast({ title: "Instructions Required", description: "Please provide instructions for the technician.", variant: "destructive" });
                                      return;
                                    }
                                    if (["nla_replacement_submitted", "nla_replacement_tech_initiates", "nla_part_found_vrs_ordered", "nla_part_found_tech_orders", "nla_rfr_eligible"].includes(nlaAction!) && rgcMissing) {
                                      toast({ title: "Error", description: "RGC code not set for today. Contact an administrator.", variant: "destructive" });
                                      return;
                                    }
                                    if (nlaAction === "nla_part_found_tech_orders" && !nlaFoundPartNumber.trim()) {
                                      toast({ title: "Error", description: "Enter a part number", variant: "destructive" });
                                      return;
                                    }
                                    if (nlaAction === "nla_reject" && selectedRejectionReasons.length === 0) {
                                      toast({ title: "Error", description: "Select at least one rejection reason", variant: "destructive" });
                                      return;
                                    }
                                    if (nlaAction === "nla_invalid" && selectedInvalidReasons.length === 0) {
                                      toast({ title: "Error", description: "Select at least one invalid reason", variant: "destructive" });
                                      return;
                                    }
                                    setNlaConfirmOpen(true);
                                  }}
                                  disabled={!nlaAction || !technicianMessage.trim() || nlaProcessMutation.isPending}
                                  data-testid="button-nla-process"
                                >
                                  <Send className="w-4 h-4 mr-2" />
                                  {nlaProcessMutation.isPending ? "Processing..." : "Process & Send NLA Resolution"}
                                </Button>
                              )}
                            </>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {/* Stage 3: Smartsheet Intake — replaces Stage 2 in the
                        resolution-panel slot AFTER Authorize & Send completes.
                        Server is the single source of truth (see
                        /api/submissions/:id/intake-form-status). The card
                        shows when the ticket is approved + has no intake_forms
                        row yet. Once the agent confirms the Smartsheet
                        submission, the same endpoint flips `recorded: true`
                        and we render the success banner instead.
                        Tyler 2026-04-30: applies to NLA parts tickets too —
                        per Tyler "NLA parts tickets have to fill out the NLA
                        intake form just like the AUTH tickets". The previous
                        `requestType !== "parts_nla"` exclusion is removed;
                        the iframe + status query are now branch-agnostic. */}
                    {isMyTicketsView && stage3Required && (
                      <Card ref={stage3CardRef} data-testid="card-stage3-intake">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base flex items-center gap-2">
                            <Layers className="w-4 h-4" />
                            Stage 3: Smartsheet Intake
                          </CardTitle>
                          {/* 3-segment progress bar — Stage 1 + Stage 2 done
                              (green), Stage 3 in progress (blue). Mirrors the
                              earlier 2-stage bar's visual language. */}
                          <div className="flex items-center gap-2 mt-1" data-testid="progress-stage3">
                            <div className="h-1.5 flex-1 rounded-full bg-green-500" />
                            <div className="h-1.5 flex-1 rounded-full bg-green-500" />
                            <div className="h-1.5 flex-1 rounded-full bg-blue-500" />
                          </div>
                          <div className="mt-2 p-2 bg-green-50 dark:bg-green-950 rounded-md border border-green-200 dark:border-green-800">
                            <p className="text-xs font-medium text-green-700 dark:text-green-300 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> Authorization Sent
                            </p>
                            <p className="text-xs text-green-600 dark:text-green-400 mt-1" data-testid="text-stage3-context">
                              Technician received the auth code. Last step: open the <strong>Intake Form</strong> tab on the right and log this ticket in Smartsheet so the next claim isn't blocked.
                            </p>
                          </div>
                        </CardHeader>
                        {/* Tyler 2026-04-29 (intake-form layout fix → simplified
                            2026-04-29 batch B): the IntakeFormFieldset that
                            briefly lived inside the right-side IntakeFormTab
                            has been REMOVED entirely. Rationale: it duplicated
                            the data-entry surface that the agent already
                            interacts with inside the Smartsheet iframe — there
                            is no value in two places to type the same thing.
                            This Stage 3 card now functions purely as a status
                            indicator on the left: agent reads the ticket on the
                            left, works the Smartsheet iframe on the right.
                            CardContent intentionally omitted (header banner
                            above already carries the message). */}
                      </Card>
                    )}

                    {/* Stage 3 success banner — shown once the agent has
                        recorded the intake row. Confirms to the agent that
                        the gate is released. Tyler 2026-04-30: also
                        renders for NLA parts tickets (see Stage 3 card
                        above for rationale). */}
                    {isMyTicketsView && stage3Recorded && (
                      <Card data-testid="card-stage3-recorded">
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base flex items-center gap-2 text-green-700 dark:text-green-300">
                            <CheckCircle2 className="w-4 h-4" />
                            Smartsheet Intake Recorded
                          </CardTitle>
                          <div className="flex items-center gap-2 mt-1">
                            <div className="h-1.5 flex-1 rounded-full bg-green-500" />
                            <div className="h-1.5 flex-1 rounded-full bg-green-500" />
                            <div className="h-1.5 flex-1 rounded-full bg-green-500" />
                          </div>
                        </CardHeader>
                        <CardContent>
                          <p className="text-xs text-muted-foreground" data-testid="text-stage3-recorded">
                            Intake row logged. You can claim the next ticket.
                          </p>
                        </CardContent>
                      </Card>
                    )}

                    {/* Stage 1/2 (non-NLA) — strictly hidden once Stage 3 is in
                        play so we never render Stage 2 + Stage 3 simultaneously
                        during the brief invalidation window after Authorize.
                        Server's /intake-form-status check is the single source
                        of truth for Stage 3 visibility, but selectedSubmission
                        comes from a separate query and may briefly still report
                        ticketStatus='pending' before refetch lands. */}
                    {isMyTicketsView && selectedSubmission.ticketStatus === "pending" && selectedSubmission.requestType !== "parts_nla" && !stage3Required && !stage3Recorded && (
                      <Card>
                        <CardHeader className="pb-3">
                          <CardTitle className="text-base flex items-center gap-2">
                            <Layers className="w-4 h-4" />
                            {isTwoStageWarranty(selectedSubmission) && !isSubmissionApprovedStage(selectedSubmission)
                              ? "Stage 1: Submission Review"
                              : isTwoStageWarranty(selectedSubmission) && isSubmissionApprovedStage(selectedSubmission)
                              ? "Stage 2: Authorization"
                              : "Review Actions"}
                          </CardTitle>
                          {isTwoStageWarranty(selectedSubmission) && selectedSubmission.requestType !== "parts_nla" && (
                            <div className="flex items-center gap-2 mt-1">
                              <div className={`h-1.5 flex-1 rounded-full ${isSubmissionApprovedStage(selectedSubmission) ? "bg-green-500" : "bg-blue-500"}`} />
                              <div className={`h-1.5 flex-1 rounded-full ${isSubmissionApprovedStage(selectedSubmission) ? "bg-blue-500" : "bg-muted"}`} />
                              {/* Stage 3 anticipated — muted while pending,
                                  fills blue/green from the new Stage 3 card
                                  once the agent reaches Authorize & Send. */}
                              <div className="h-1.5 flex-1 rounded-full bg-muted" />
                            </div>
                          )}
                          {isTwoStageWarranty(selectedSubmission) && selectedSubmission.requestType === "parts_nla" && (
                            <div className="flex items-center gap-2 mt-1">
                              <div className={`h-1.5 flex-1 rounded-full ${isSubmissionApprovedStage(selectedSubmission) ? "bg-green-500" : "bg-blue-500"}`} />
                              <div className={`h-1.5 flex-1 rounded-full ${isSubmissionApprovedStage(selectedSubmission) ? "bg-blue-500" : "bg-muted"}`} />
                            </div>
                          )}
                          {isTwoStageWarranty(selectedSubmission) && isSubmissionApprovedStage(selectedSubmission) && (
                            <div className="mt-2 p-2 bg-green-50 dark:bg-green-950 rounded-md border border-green-200 dark:border-green-800">
                              <p className="text-xs font-medium text-green-700 dark:text-green-300 flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> Submission Approved
                              </p>
                              <p className="text-xs text-green-600 dark:text-green-400 mt-1" data-testid="text-submission-approved">
                                Technician has been notified. Enter the authorization code to complete this ticket.
                              </p>
                            </div>
                          )}
                          {selectedSubmission.resubmissionOf && (
                            <p className="text-xs text-blue-600" data-testid="text-resubmission-indicator">
                              This is a resubmission
                            </p>
                          )}
                          {(selectedSubmission as any).appealNotes && (
                            <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-950 rounded-md border border-blue-200 dark:border-blue-800">
                              <p className="text-xs font-medium text-blue-700 dark:text-blue-300 flex items-center gap-1">
                                <ScrollText className="w-3 h-3" /> Appeal Notes
                              </p>
                              <p className="text-xs text-blue-600 dark:text-blue-400 mt-1" data-testid="text-appeal-notes">
                                {(selectedSubmission as any).appealNotes}
                              </p>
                            </div>
                          )}
                        </CardHeader>
                        <CardContent className="space-y-5">
                          {isTwoStageWarranty(selectedSubmission) && isSubmissionApprovedStage(selectedSubmission) ? (
                            <>
                              <div className="space-y-3 border rounded-lg p-4 bg-green-50/50 dark:bg-green-950/10">
                                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Authorization Code</p>
                                {rgcMissing ? (
                                  <p className="text-sm text-destructive" data-testid="text-rgc-not-set">
                                    No RGC code set for today. Contact an administrator.
                                  </p>
                                ) : (
                                  <div className="space-y-3">
                                    <div>
                                      <Label className="text-xs text-muted-foreground">Today's RGC Code</Label>
                                      <Input
                                        value={todaysRgcCode || ""}
                                        readOnly
                                        className="font-mono bg-muted mt-1"
                                        data-testid="input-rgc-readonly"
                                      />
                                    </div>
                                    <div>
                                      <Label className="text-xs text-muted-foreground">{getProviderAuthLabel(selectedSubmission)}</Label>
                                      <Input
                                        placeholder="Enter auth code from warranty provider..."
                                        value={authCode}
                                        onChange={(e) => setAuthCode(e.target.value)}
                                        className="mt-1"
                                        data-testid="input-auth-code"
                                      />
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="space-y-2 border rounded-lg p-4 bg-green-50/50 dark:bg-green-950/10">
                                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                  <Send className="w-3 h-3" />
                                  Additional message (optional)
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  The tech will already see the auth code and TechHub instructions. Add anything extra you want them to know — your text appears as an extra paragraph at the end of the SMS.
                                </p>
                                <Textarea
                                  placeholder="e.g., Submit close-out by EOD please"
                                  value={technicianMessage}
                                  onChange={(e) => setTechnicianMessage(e.target.value)}
                                  className="resize-none"
                                  rows={3}
                                  data-testid="input-approval-notes-stage2"
                                />
                              </div>
                              <SmsPreview
                                testId="preview-approve-stage2"
                                text={buildSmsPreview({
                                  serviceOrder: selectedSubmission.serviceOrder,
                                  action: "approve",
                                  message: technicianMessage,
                                  rgcCode: todaysRgcCode,
                                  authCode: authCode,
                                })}
                              />

                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1.5">
                                  Internal Agent Notes (not sent to technician)
                                </Label>
                                <Textarea
                                  placeholder="Internal notes — saved to ticket history only..."
                                  value={agentNotes}
                                  onChange={(e) => setAgentNotes(e.target.value)}
                                  className="resize-none"
                                  rows={2}
                                  data-testid="input-agent-notes"
                                />
                              </div>

                              <Button
                                className="w-full"
                                size="lg"
                                onClick={() => {
                                  if (!authCode.trim()) {
                                    toast({ title: "Error", description: `Enter the ${getProviderAuthLabel(selectedSubmission)}`, variant: "destructive" });
                                    return;
                                  }
                                  if (rgcMissing) {
                                    toast({ title: "Error", description: "RGC code not set for today", variant: "destructive" });
                                    return;
                                  }
                                  setSelectedAction("approve");
                                  setConfirmOpen(true);
                                }}
                                disabled={processMutation.isPending}
                                data-testid="button-authorize-submit"
                              >
                                <Send className="w-4 h-4 mr-2" />
                                {processMutation.isPending ? "Processing..." : "Authorize & Send"}
                              </Button>
                            </>
                          ) : (
                            <>
                              <div className={`grid ${isTwoStageWarranty(selectedSubmission) ? "grid-cols-3" : "grid-cols-3"} gap-3`}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isTwoStageWarranty(selectedSubmission)) {
                                      setSelectedAction(selectedAction === "approve_submission" ? null : "approve_submission");
                                    } else {
                                      setSelectedAction(selectedAction === "approve" ? null : "approve");
                                    }
                                  }}
                                  className={`flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-all ${
                                    selectedAction === "approve" || selectedAction === "approve_submission"
                                      ? "border-green-500 bg-green-50 dark:bg-green-950/30"
                                      : "border-border hover:border-green-300"
                                  }`}
                                  data-testid="action-approve"
                                >
                                  {selectedAction === "approve" || selectedAction === "approve_submission" ? (
                                    <CheckSquare className="w-8 h-8 text-green-600" />
                                  ) : (
                                    <Square className="w-8 h-8 text-muted-foreground" />
                                  )}
                                  <span className={`text-sm font-medium ${selectedAction === "approve" || selectedAction === "approve_submission" ? "text-green-700 dark:text-green-400" : ""}`}>
                                    {isTwoStageWarranty(selectedSubmission) ? "Approve Submission" : "Approve"}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSelectedAction(selectedAction === "reject" ? null : "reject")}
                                  className={`flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-all ${
                                    selectedAction === "reject"
                                      ? "border-red-500 bg-red-50 dark:bg-red-950/30"
                                      : "border-border hover:border-red-300"
                                  }`}
                                  data-testid="action-reject"
                                >
                                  {selectedAction === "reject" ? (
                                    <CheckSquare className="w-8 h-8 text-red-600" />
                                  ) : (
                                    <Square className="w-8 h-8 text-muted-foreground" />
                                  )}
                                  <span className={`text-sm font-medium ${selectedAction === "reject" ? "text-red-700 dark:text-red-400" : ""}`}>
                                    Reject
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSelectedAction(selectedAction === "invalid" ? null : "invalid")}
                                  className={`flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-all ${
                                    selectedAction === "invalid"
                                      ? "border-gray-500 bg-gray-50 dark:bg-gray-950/30"
                                      : "border-border hover:border-gray-300"
                                  }`}
                                  data-testid="action-invalid"
                                >
                                  {selectedAction === "invalid" ? (
                                    <CheckSquare className="w-8 h-8 text-gray-600" />
                                  ) : (
                                    <Square className="w-8 h-8 text-muted-foreground" />
                                  )}
                                  <span className={`text-sm font-medium ${selectedAction === "invalid" ? "text-gray-700 dark:text-gray-400" : ""}`}>
                                    Invalid
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSelectedAction(selectedAction === "reject_and_close" ? null : "reject_and_close")}
                                  className={`flex flex-col items-center justify-center gap-2 p-4 rounded-lg border-2 transition-all ${
                                    selectedAction === "reject_and_close"
                                      ? "border-orange-600 bg-orange-50 dark:bg-orange-950/30"
                                      : "border-border hover:border-orange-300"
                                  }`}
                                  data-testid="action-reject-and-close"
                                >
                                  {selectedAction === "reject_and_close" ? (
                                    <CheckSquare className="w-8 h-8 text-orange-600" />
                                  ) : (
                                    <Square className="w-8 h-8 text-muted-foreground" />
                                  )}
                                  <span className={`text-sm font-medium ${selectedAction === "reject_and_close" ? "text-orange-700 dark:text-orange-400" : ""}`}>
                                    Reject & Close
                                  </span>
                                </button>
                              </div>

                              {selectedAction === "reject" && (
                                <div className="space-y-4">
                                  <div className="space-y-3 border rounded-lg p-4 bg-red-50/50 dark:bg-red-950/10">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rejection Reasons</p>
                                    <div className="space-y-2">
                                      {REJECTION_SUGGESTIONS.map((reason) => (
                                        <button
                                          key={reason}
                                          type="button"
                                          className="flex items-center gap-2 cursor-pointer w-full text-left"
                                          onClick={() => {
                                            setSelectedRejectionReasons((prev) =>
                                              prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
                                            );
                                            if (reason === "Other" && selectedRejectionReasons.includes("Other")) {
                                              setOtherRejectionText("");
                                            }
                                          }}
                                          data-testid={`checkbox-reason-${reason.replace(/\s+/g, '-').toLowerCase()}`}
                                        >
                                          {selectedRejectionReasons.includes(reason) ? (
                                            <CheckSquare className="w-5 h-5 text-red-600 shrink-0" />
                                          ) : (
                                            <Square className="w-5 h-5 text-muted-foreground shrink-0" />
                                          )}
                                          <span className="text-sm">{reason}</span>
                                        </button>
                                      ))}
                                      <button
                                        type="button"
                                        className="flex items-center gap-2 cursor-pointer w-full text-left"
                                        onClick={() => {
                                          setSelectedRejectionReasons((prev) =>
                                            prev.includes("Other") ? prev.filter((r) => r !== "Other") : [...prev, "Other"]
                                          );
                                          if (selectedRejectionReasons.includes("Other")) {
                                            setOtherRejectionText("");
                                          }
                                        }}
                                        data-testid="checkbox-reason-other"
                                      >
                                        {selectedRejectionReasons.includes("Other") ? (
                                          <CheckSquare className="w-5 h-5 text-red-600 shrink-0" />
                                        ) : (
                                          <Square className="w-5 h-5 text-muted-foreground shrink-0" />
                                        )}
                                        <span className="text-sm">Other</span>
                                      </button>
                                      {selectedRejectionReasons.includes("Other") && (
                                        <input
                                          type="text"
                                          className="w-full ml-7 text-sm border rounded-md px-3 py-1.5 bg-background"
                                          placeholder="Specify other reason..."
                                          value={otherRejectionText}
                                          onChange={(e) => setOtherRejectionText(e.target.value)}
                                          data-testid="input-other-rejection-reason"
                                        />
                                      )}
                                    </div>
                                  </div>

                                  {(rejectedPhotos.length > 0 || rejectedVideo.rejected || rejectedVoiceNote.rejected) && (
                                    <div className="space-y-2 border rounded-lg p-4 bg-red-50/50 dark:bg-red-950/10">
                                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Rejected Media Summary</p>
                                      <div className="space-y-1">
                                        {rejectedPhotos.map((rp, i) => (
                                          <div key={i} className="flex items-center gap-2 text-xs text-red-700">
                                            <XCircle className="w-3.5 h-3.5 shrink-0" />
                                            <span>Photo: {rp.reason}</span>
                                          </div>
                                        ))}
                                        {rejectedVideo.rejected && (
                                          <div className="flex items-center gap-2 text-xs text-red-700">
                                            <XCircle className="w-3.5 h-3.5 shrink-0" />
                                            <span>Video: {rejectedVideo.reason || "Rejected"}</span>
                                          </div>
                                        )}
                                        {rejectedVoiceNote.rejected && (
                                          <div className="flex items-center gap-2 text-xs text-red-700">
                                            <XCircle className="w-3.5 h-3.5 shrink-0" />
                                            <span>Voice Note: {rejectedVoiceNote.reason || "Rejected"}</span>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  )}

                                  <div className="space-y-2 border rounded-lg p-4 bg-orange-50/50 dark:bg-orange-950/10">
                                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                      <Send className="w-3 h-3" />
                                      Additional context (optional)
                                    </Label>
                                    <p className="text-xs text-muted-foreground">
                                      The tech will already see the rejection reason and a resubmit link. Use this only to add extra context (e.g. customer details, scheduling notes).
                                    </p>
                                    <Textarea
                                      placeholder="e.g., Customer is aware — please retake the estimate photo before EOD"
                                      value={technicianMessage}
                                      onChange={(e) => setTechnicianMessage(e.target.value)}
                                      className="resize-none"
                                      rows={3}
                                      data-testid="input-technician-message"
                                    />
                                  </div>
                                  <SmsPreview
                                    testId="preview-reject"
                                    text={buildSmsPreview({
                                      serviceOrder: selectedSubmission.serviceOrder,
                                      action: "reject",
                                      message: technicianMessage,
                                      rejectionReasons: selectedRejectionReasons
                                        .map((r) => (r === "Other" ? otherRejectionText.trim() || "Other" : r))
                                        .filter(Boolean),
                                      rejectedMediaSummary: [
                                        rejectedPhotos.length > 0 ? `${rejectedPhotos.length} photo(s) rejected` : null,
                                        rejectedVideo.rejected
                                          ? `Video rejected${rejectedVideo.reason ? `: ${rejectedVideo.reason === "Other" ? otherVideoRejectionText.trim() || "Other" : rejectedVideo.reason}` : ""}`
                                          : null,
                                        rejectedVoiceNote.rejected
                                          ? `Voice note rejected${rejectedVoiceNote.reason ? `: ${rejectedVoiceNote.reason === "Other" ? otherVoiceRejectionText.trim() || "Other" : rejectedVoiceNote.reason}` : ""}`
                                          : null,
                                      ].filter(Boolean) as string[],
                                    })}
                                  />
                                </div>
                              )}

                              {selectedAction === "reject_and_close" && (
                                <div className="space-y-4">
                                  <div className="space-y-3 border rounded-lg p-4 bg-orange-50/50 dark:bg-orange-950/10">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Reject & Close — Not Covered</p>
                                    <p className="text-xs text-muted-foreground">This permanently closes the ticket. The technician will be unable to resubmit or create new tickets for this service order. Use when the repair is not covered under warranty.</p>
                                    <div className="space-y-2">
                                      <Label className="text-xs text-muted-foreground">Reason</Label>
                                      <select
                                        className="w-full text-sm border rounded-md px-3 py-2 bg-background"
                                        value={rejectCloseReason}
                                        onChange={(e) => {
                                          setRejectCloseReason(e.target.value);
                                          if (e.target.value !== "Other") setRejectCloseCustomReason("");
                                        }}
                                        data-testid="select-reject-close-reason"
                                      >
                                        <option value="">Select a reason...</option>
                                        <option value="Customer abuse/neglect">Customer abuse/neglect</option>
                                        <option value="Pre-existing damage not covered">Pre-existing damage not covered</option>
                                        <option value="Cosmetic damage — not a functional failure">Cosmetic damage — not a functional failure</option>
                                        <option value="Unauthorized modification by customer">Unauthorized modification by customer</option>
                                        <option value="Commercial use of residential product">Commercial use of residential product</option>
                                        <option value="Coverage expired or not active">Coverage expired or not active</option>
                                        <option value="Product not listed on warranty contract">Product not listed on warranty contract</option>
                                        <option value="Recall or manufacturer defect — contact manufacturer">Recall or manufacturer defect — contact manufacturer</option>
                                        <option value="Infestation">Infestation</option>
                                        <option value="Other">Other</option>
                                      </select>
                                      {rejectCloseReason === "Other" && (
                                        <input
                                          type="text"
                                          className="w-full text-sm border rounded-md px-3 py-1.5 bg-background"
                                          placeholder="Specify other reason..."
                                          value={rejectCloseCustomReason}
                                          onChange={(e) => setRejectCloseCustomReason(e.target.value)}
                                          data-testid="input-reject-close-custom-reason"
                                        />
                                      )}
                                    </div>
                                  </div>
                                  <div className="space-y-2">
                                    <Label className="text-xs text-muted-foreground">Additional context (optional)</Label>
                                    <p className="text-xs text-muted-foreground">
                                      The tech will already see the close reason and a note that no further VRS submissions are possible. Add anything extra they should tell the customer.
                                    </p>
                                    <textarea
                                      className="w-full text-sm border rounded-md px-3 py-2 bg-background resize-none"
                                      placeholder="e.g., Offer customer cash call estimate for repair"
                                      value={technicianMessage}
                                      onChange={(e) => setTechnicianMessage(e.target.value)}
                                      rows={3}
                                      data-testid="input-reject-close-message"
                                    />
                                  </div>
                                  <SmsPreview
                                    testId="preview-reject-close"
                                    text={buildSmsPreview({
                                      serviceOrder: selectedSubmission.serviceOrder,
                                      action: "reject_and_close",
                                      message: technicianMessage,
                                      warrantyType: selectedSubmission.warrantyType,
                                      rejectCloseReason:
                                        rejectCloseReason === "Other"
                                          ? rejectCloseCustomReason.trim() || "Other"
                                          : rejectCloseReason,
                                    })}
                                  />
                                </div>
                              )}

                              {selectedAction === "invalid" && (
                                <div className="space-y-3">
                                  <div className="space-y-2 border rounded-lg p-4 bg-gray-50/50 dark:bg-gray-950/10">
                                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Invalid Reasons (select all that apply)</p>
                                    <div className="space-y-1.5">
                                      {INVALID_SUGGESTIONS.map((reason) => (
                                        <button
                                          key={reason}
                                          type="button"
                                          className="flex items-center gap-2 cursor-pointer w-full text-left"
                                          onClick={() => {
                                            setSelectedInvalidReasons((prev) =>
                                              prev.includes(reason) ? prev.filter((r) => r !== reason) : [...prev, reason]
                                            );
                                            if (reason === "Other" && selectedInvalidReasons.includes("Other")) {
                                              setOtherInvalidText("");
                                            }
                                          }}
                                          data-testid={`checkbox-invalid-${reason.replace(/\s+/g, '-').toLowerCase()}`}
                                        >
                                          {selectedInvalidReasons.includes(reason) ? (
                                            <CheckSquare className="w-5 h-5 text-gray-700 dark:text-gray-400 shrink-0" />
                                          ) : (
                                            <Square className="w-5 h-5 text-muted-foreground shrink-0" />
                                          )}
                                          <span className="text-sm">{reason}</span>
                                        </button>
                                      ))}
                                      <button
                                        type="button"
                                        className="flex items-center gap-2 cursor-pointer w-full text-left"
                                        onClick={() => {
                                          setSelectedInvalidReasons((prev) =>
                                            prev.includes("Other") ? prev.filter((r) => r !== "Other") : [...prev, "Other"]
                                          );
                                          if (selectedInvalidReasons.includes("Other")) {
                                            setOtherInvalidText("");
                                          }
                                        }}
                                        data-testid="checkbox-invalid-other"
                                      >
                                        {selectedInvalidReasons.includes("Other") ? (
                                          <CheckSquare className="w-5 h-5 text-gray-700 dark:text-gray-400 shrink-0" />
                                        ) : (
                                          <Square className="w-5 h-5 text-muted-foreground shrink-0" />
                                        )}
                                        <span className="text-sm">Other</span>
                                      </button>
                                      {selectedInvalidReasons.includes("Other") && (
                                        <input
                                          type="text"
                                          className="w-full ml-7 text-sm border rounded-md px-3 py-1.5 bg-background"
                                          placeholder="Specify other reason..."
                                          value={otherInvalidText}
                                          onChange={(e) => setOtherInvalidText(e.target.value)}
                                          data-testid="input-other-invalid-reason"
                                        />
                                      )}
                                    </div>
                                  </div>

                                  <div className="space-y-2 border rounded-lg p-4 bg-orange-50/50 dark:bg-orange-950/10">
                                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                      <Send className="w-3 h-3" />
                                      Additional instructions (optional)
                                    </Label>
                                    <p className="text-xs text-muted-foreground">
                                      The tech will already see the invalid reason and a note that VRS cannot process this. Add specific next steps (e.g. who to contact instead).
                                    </p>
                                    <Textarea
                                      placeholder="e.g., Direct customer to call 1-800-... to renew their plan first"
                                      value={invalidMessage}
                                      onChange={(e) => setInvalidMessage(e.target.value)}
                                      className="resize-none"
                                      rows={3}
                                      data-testid="input-invalid-message"
                                    />
                                  </div>
                                  <SmsPreview
                                    testId="preview-invalid"
                                    text={buildSmsPreview({
                                      serviceOrder: selectedSubmission.serviceOrder,
                                      action: "invalid",
                                      invalidReasons: selectedInvalidReasons
                                        .map((r) => (r === "Other" ? otherInvalidText.trim() || "Other" : r))
                                        .filter(Boolean),
                                      invalidInstructions: invalidMessage,
                                    })}
                                  />
                                </div>
                              )}

                              {selectedAction === "approve" && !isNonPartsRequest(selectedSubmission) && (
                                <div className="space-y-3 border rounded-lg p-4 bg-green-50/50 dark:bg-green-950/10">
                                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Authorization Code</p>
                                  {rgcMissing ? (
                                    <p className="text-sm text-destructive" data-testid="text-rgc-not-set">
                                      No RGC code set for today. Contact an administrator.
                                    </p>
                                  ) : (
                                    <div className="space-y-3">
                                      <div>
                                        <Label className="text-xs text-muted-foreground">Today's RGC Code</Label>
                                        <Input
                                          value={todaysRgcCode || ""}
                                          readOnly
                                          className="font-mono bg-muted mt-1"
                                          data-testid="input-rgc-readonly"
                                        />
                                      </div>
                                      {needsExternalAuth(selectedSubmission) && (
                                        <div>
                                          <Label className="text-xs text-muted-foreground">{getProviderAuthLabel(selectedSubmission)}</Label>
                                          <Input
                                            placeholder="Enter auth code..."
                                            value={authCode}
                                            onChange={(e) => setAuthCode(e.target.value)}
                                            className="mt-1"
                                            data-testid="input-auth-code"
                                          />
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}

                              {(selectedAction === "approve" || selectedAction === "approve_submission") && (
                                <>
                                  <div className="space-y-2 border rounded-lg p-4 bg-green-50/50 dark:bg-green-950/10">
                                    <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                      <Send className="w-3 h-3" />
                                      Additional message (optional)
                                    </Label>
                                    <p className="text-xs text-muted-foreground">
                                      The tech will already see the approval{selectedAction === "approve" ? " and auth code" : ""}. Add anything extra you want them to know — your text appears as an extra paragraph at the end of the SMS.
                                    </p>
                                    <Textarea
                                      placeholder="e.g., Looks great — auth code coming in ~10 min"
                                      value={technicianMessage}
                                      onChange={(e) => setTechnicianMessage(e.target.value)}
                                      className="resize-none"
                                      rows={3}
                                      data-testid="input-approval-notes"
                                    />
                                  </div>
                                  <SmsPreview
                                    testId="preview-approve"
                                    text={buildSmsPreview({
                                      serviceOrder: selectedSubmission.serviceOrder,
                                      action: selectedAction,
                                      message: technicianMessage,
                                      rgcCode: todaysRgcCode,
                                      authCode: authCode,
                                    })}
                                  />
                                </>
                              )}

                              {selectedAction === "approve_submission" && (
                                <div className="space-y-2 border rounded-lg p-4 bg-green-50/50 dark:bg-green-950/10">
                                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Submission Approval</p>
                                  <p className="text-sm text-muted-foreground">
                                    Approving the submission will notify the technician that their photos and information meet the requirements. You will then need to obtain the authorization code from the warranty provider to complete this ticket.
                                  </p>
                                </div>
                              )}

                              <div>
                                <Label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1.5">
                                  Internal Agent Notes (not sent to technician)
                                </Label>
                                <Textarea
                                  placeholder="Internal notes — saved to ticket history only..."
                                  value={agentNotes}
                                  onChange={(e) => setAgentNotes(e.target.value)}
                                  className="resize-none"
                                  rows={2}
                                  data-testid="input-agent-notes"
                                />
                              </div>

                              <Button
                                className="w-full"
                                size="lg"
                                variant={selectedAction === "reject" || selectedAction === "reject_and_close" ? "destructive" : selectedAction === "invalid" ? "outline" : "default"}
                                onClick={() => {
                                  if (!selectedAction) return;
                                  if (selectedAction === "reject" && selectedRejectionReasons.length === 0 && rejectedPhotos.length === 0 && !rejectedVideo.rejected && !rejectedVoiceNote.rejected) {
                                    toast({ title: "Error", description: "Select at least one rejection reason or reject specific media", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject" && rejectedVideo.rejected && !rejectedVideo.reason) {
                                    toast({ title: "Error", description: "Select a reason for rejecting the video", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject" && rejectedVoiceNote.rejected && !rejectedVoiceNote.reason) {
                                    toast({ title: "Error", description: "Select a reason for rejecting the voice note", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject" && selectedRejectionReasons.includes("Other") && !otherRejectionText.trim()) {
                                    toast({ title: "Error", description: "Please specify the 'Other' rejection reason", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject" && rejectedVideo.rejected && rejectedVideo.reason === "Other" && !otherVideoRejectionText.trim()) {
                                    toast({ title: "Error", description: "Please specify the 'Other' reason for video rejection", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject" && rejectedVoiceNote.rejected && rejectedVoiceNote.reason === "Other" && !otherVoiceRejectionText.trim()) {
                                    toast({ title: "Error", description: "Please specify the 'Other' reason for voice note rejection", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject" && rejectedPhotos.some(rp => rp.reason === "Other") && !otherPhotoRejectionText.trim()) {
                                    toast({ title: "Error", description: "Please specify the 'Other' reason for photo rejection", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "invalid" && selectedInvalidReasons.includes("Other") && !otherInvalidText.trim()) {
                                    toast({ title: "Error", description: "Please specify the 'Other' invalid reason", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "invalid" && selectedInvalidReasons.length === 0) {
                                    toast({ title: "Error", description: "Select at least one invalid reason", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject_and_close" && !rejectCloseReason) {
                                    toast({ title: "Error", description: "Select a reason for permanently closing this ticket", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "reject_and_close" && rejectCloseReason === "Other" && !rejectCloseCustomReason.trim()) {
                                    toast({ title: "Error", description: "Please specify the 'Other' reason for closing", variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "approve" && !isNonPartsRequest(selectedSubmission) && needsExternalAuth(selectedSubmission) && !authCode.trim()) {
                                    toast({ title: "Error", description: `Enter the ${getProviderAuthLabel(selectedSubmission)}`, variant: "destructive" });
                                    return;
                                  }
                                  if (selectedAction === "approve" && !isNonPartsRequest(selectedSubmission) && rgcMissing) {
                                    toast({ title: "Error", description: "RGC code not set for today", variant: "destructive" });
                                    return;
                                  }
                                  setConfirmOpen(true);
                                }}
                                disabled={!selectedAction || processMutation.isPending}
                                data-testid="button-process-submit"
                              >
                                <Send className="w-4 h-4 mr-2" />
                                {processMutation.isPending ? "Processing..." : selectedAction === "approve_submission" ? "Approve Submission & Notify" : selectedAction === "reject_and_close" ? "Reject & Close Permanently" : "Process & Send"}
                              </Button>
                            </>
                          )}
                        </CardContent>
                      </Card>
                    )}

                    {activeView === "completed" && (
                      <Card>
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-2 text-sm">
                            {selectedSubmission.ticketStatus === "completed" && (
                              <>
                                <CheckCircle2 className="w-5 h-5 text-chart-4" />
                                <span className="font-medium" data-testid="text-ticket-completed">Completed</span>
                              </>
                            )}
                            {selectedSubmission.ticketStatus === "rejected" && (
                              <>
                                <ShieldX className="w-5 h-5 text-destructive" />
                                <span className="font-medium" data-testid="text-ticket-rejected">Rejected</span>
                              </>
                            )}
                            {selectedSubmission.ticketStatus === "invalid" && (
                              <>
                                <Ban className="w-5 h-5 text-muted-foreground" />
                                <span className="font-medium" data-testid="text-ticket-invalid">Invalid</span>
                              </>
                            )}
                            {selectedSubmission.reviewedAt && (
                              <span className="text-muted-foreground">
                                on {formatDate(selectedSubmission.reviewedAt)}
                              </span>
                            )}
                          </div>
                          {selectedSubmission.agentNotes && (
                            <p className="text-sm text-muted-foreground mt-2 bg-muted/50 rounded-md p-3" data-testid="text-agent-notes-display">
                              Notes: {selectedSubmission.agentNotes}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    )}
                  </div>
                </ScrollArea>
                {/* Tyler 2026-04-30: drag-to-resize splitter. Only renders
                    on md+ AND when the right panel is visible. The shared
                    --right-panel-w CSS variable on the parent flex row
                    drives the right panel's width below; this handle
                    updates that variable via rightPanelWidthPct state.
                    Double-click resets to the 50/50 default. */}
                {/* Tyler 2026-04-30: splitter renders for ALL request types now,
                    including parts_nla (NLA intake form is routed server-side
                    via VRS_INTAKE_FORM_NLA_BASE). Predicate kept in sync with
                    the right panel gate immediately below. */}
                {isMyTicketsView && shsaiVisible && effectiveSelectedSubmission && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Resize right panel"
                    aria-valuemin={RIGHT_PANEL_WIDTH_MIN}
                    aria-valuemax={RIGHT_PANEL_WIDTH_MAX}
                    aria-valuenow={Math.round(rightPanelWidthPct)}
                    onMouseDown={handleSplitterMouseDown}
                    onDoubleClick={handleSplitterDoubleClick}
                    title="Drag to resize · double-click to reset"
                    data-testid="splitter-right-panel"
                    className="hidden md:flex shrink-0 w-1.5 cursor-col-resize bg-border hover-elevate active-elevate-2 group items-center justify-center select-none"
                  >
                    <div className="h-8 w-0.5 rounded-full bg-muted-foreground/40 group-hover:bg-muted-foreground/70" />
                  </div>
                )}
                {/* Tyler 2026-04-28 (intake-tab disappearance bug, Fix B):
                    Use effectiveSelectedSubmission (snapshot fallback) so the
                    right panel stays mounted across the post-Authorize list
                    refetch, when the My Tickets pending filter briefly drops
                    the ticket and selectedSubmission goes null. Without this,
                    the entire 3-tab right panel unmounts and the auto-fire
                    timer's setRightPanelView("intake") lands on a destroyed
                    Tabs container. */}
                {isMyTicketsView && shsaiVisible && effectiveSelectedSubmission && (
                  <div
                    className="hidden md:flex md:w-[var(--right-panel-w)] shrink-0 flex-col min-h-0 min-w-0"
                    data-testid="panel-shsai"
                  >
                    {/* T2: Tabbed right panel — Service Order History (default) /
                        Calculator. The hide button (button-hide-shsai) and
                        refresh button (button-shsai-refresh) are preserved as
                        existing test IDs require. */}
                    <Tabs
                      value={rightPanelView}
                      onValueChange={(v) => handleRightPanelViewChange(v as RightPanelView)}
                      className="flex flex-col flex-1 min-h-0"
                    >
                      <div className="px-2 py-2 border-b flex items-center justify-between gap-2 flex-wrap">
                        {/* Tyler 2026-04-27 (Q2 hardening, architect-flagged):
                            Radix Tabs only fires onValueChange when the value
                            actually changes. If the agent is on Calculator
                            when they click Authorize and then re-clicks the
                            Calculator tab within the 350ms window, no value
                            change fires and the pending intake auto-fire was
                            slipping through. Capturing pointer-down on the
                            entire TabsList catches *any* click intent — same
                            tab or different tab — and cancels the pending
                            auto-fire deterministically. */}
                        <TabsList
                          data-testid="tabs-right-panel"
                          onPointerDownCapture={() => {
                            if (pendingIntakeAutoFireRef.current) {
                              pendingIntakeAutoFireRef.current = false;
                            }
                          }}
                        >
                          <TabsTrigger value="shsai" data-testid="tab-shsai">
                            <Globe className="w-4 h-4 mr-1" />
                            Service Order History
                          </TabsTrigger>
                          <TabsTrigger value="calculator" data-testid="tab-calculator">
                            Calculator
                          </TabsTrigger>
                          {/* Tyler 2026-04-28 (requirement change, OVERRIDES
                              the prior 2026-04-27 Q1 = CONDITIONAL + PRE-AUTH
                              GHOST design): the Intake Form tab is now ALWAYS
                              enabled and clickable from the moment a ticket
                              opens — same enabled state as Service Order
                              History and Calculator. Pre-auth fields (auth
                              code, etc.) are simply left blank in the iframe;
                              everything else is prefilled and usable
                              immediately. The earlier `disabled` gate on
                              stage3Required/stage3Recorded has been removed. */}
                          <TabsTrigger
                            value="intake"
                            data-testid="tab-intake"
                          >
                            <ClipboardList className="w-4 h-4 mr-1" />
                            Intake Form
                          </TabsTrigger>
                        </TabsList>
                        <div className="flex items-center gap-1">
                          {rightPanelView === "shsai" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => fetchShsaiData(selectedSubmission.serviceOrder, selectedSubmission.id)}
                              disabled={shsaiLoading}
                              data-testid="button-shsai-refresh"
                            >
                              <RefreshCw className={`w-4 h-4 ${shsaiLoading ? "animate-spin" : ""}`} />
                            </Button>
                          )}
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => setShsaiVisible(false)}
                            data-testid="button-hide-shsai"
                          >
                            <PanelRightClose className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                      <TabsContent
                        value="shsai"
                        className="flex-1 flex flex-col min-h-0 m-0 data-[state=inactive]:hidden"
                        forceMount
                      >
                    <ScrollArea className="flex-1">
                      <div className="p-4 space-y-3">
                        {shsaiLoading && (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground" data-testid="shsai-loading">
                            <Loader2 className="w-6 h-6 animate-spin mb-2" />
                            <p className="text-sm">Loading service order history...</p>
                          </div>
                        )}
                        {shsaiError && !shsaiLoading && (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground" data-testid="shsai-error">
                            <AlertTriangle className="w-6 h-6 mb-2 text-destructive" />
                            <p className="text-sm text-center mb-3">{shsaiError}</p>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => fetchShsaiData(selectedSubmission.serviceOrder, selectedSubmission.id)}
                              data-testid="button-shsai-retry"
                            >
                              <RefreshCw className="w-3 h-3 mr-1" />
                              Retry
                            </Button>
                          </div>
                        )}
                        {!shsaiLoading && !shsaiError && shsaiMessages.length > 0 && (
                          <div className="space-y-3" data-testid="shsai-messages">
                            {shsaiMessages.map((msg, idx) => (
                              <div
                                key={idx}
                                className={`text-sm ${msg.role === "user" ? "text-muted-foreground italic" : ""}`}
                              >
                                {msg.role === "user" ? (
                                  <div className="flex items-start gap-2">
                                    <User className="w-3 h-3 mt-1 shrink-0" />
                                    <span>{msg.content}</span>
                                  </div>
                                ) : (
                                  <Card>
                                    <CardContent className="p-3" data-testid={`shsai-response-${idx}`}>
                                      <div className="prose prose-sm dark:prose-invert max-w-none text-xs leading-relaxed [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:mt-3 [&_h2]:mb-1 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_strong]:font-semibold">
                                        <ReactMarkdown>{msg.content}</ReactMarkdown>
                                      </div>
                                    </CardContent>
                                  </Card>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                        {!shsaiLoading && !shsaiError && shsaiMessages.length === 0 && (
                          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                            <MessageSquare className="w-6 h-6 mb-2 opacity-30" />
                            <p className="text-sm">No service order data yet</p>
                          </div>
                        )}
                      </div>
                    </ScrollArea>
                    {shsaiSession && !shsaiLoading && !shsaiError && (
                      <div className="px-3 py-2 border-t">
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!shsaiFollowup.trim() || !shsaiSession) return;
                            const question = shsaiFollowup.trim();
                            setShsaiFollowupLoading(true);
                            setShsaiFollowup("");
                            setShsaiMessages((prev) => [...prev, { role: "user", content: question }]);
                            try {
                              const res = await apiRequest("POST", "/api/shsai/followup", {
                                sessionId: shsaiSession.sessionId,
                                trackId: shsaiSession.trackId,
                                threadId: shsaiSession.threadId,
                                deviceInfo: shsaiSession.deviceInfo,
                                message: question,
                              });
                              const json = await res.json();
                              if (json.success) {
                                setShsaiMessages((prev) => [...prev, { role: "assistant", content: json.data.content || "" }]);
                              } else {
                                setShsaiMessages((prev) => [...prev, { role: "assistant", content: "Error: " + (json.error || "Failed to get response") }]);
                              }
                            } catch {
                              setShsaiMessages((prev) => [...prev, { role: "assistant", content: "Error: Could not send follow-up question" }]);
                            } finally {
                              setShsaiFollowupLoading(false);
                            }
                          }}
                          className="flex gap-2"
                          data-testid="form-shsai-followup"
                        >
                          <Input
                            placeholder="Ask a follow-up question..."
                            value={shsaiFollowup}
                            onChange={(e) => setShsaiFollowup(e.target.value)}
                            disabled={shsaiFollowupLoading}
                            data-testid="input-shsai-followup"
                          />
                          <Button
                            type="submit"
                            size="icon"
                            disabled={!shsaiFollowup.trim() || shsaiFollowupLoading}
                            data-testid="button-shsai-send"
                          >
                            {shsaiFollowupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                          </Button>
                        </form>
                      </div>
                    )}
                      </TabsContent>
                      <TabsContent
                        value="calculator"
                        className="flex-1 flex flex-col min-h-0 m-0 data-[state=inactive]:hidden"
                        forceMount
                      >
                        {/* flex flex-col min-h-0 is REQUIRED here — without it the
                            inner CalculatorIframe's flex-1 has no flex parent to
                            grow into and the iframe collapses to ~the height of
                            the Streamlit logo (clipping the Username / Password /
                            Sign In form below). Mirrors the SHSAI TabsContent
                            classes above so both tabs fill the panel identically. */}
                        <CalculatorIframe onOpenSettings={() => setCalcSettingsOpen(true)} />
                      </TabsContent>
                      {/* Tyler 2026-04-27: Intake Form tab — replaces the
                          retired IntakeFormReviewModal. Same flex-col min-h-0
                          pattern as Calculator so the inner iframe fills.
                          forceMount keeps the iframe alive across tab
                          switches so the agent doesn't lose Smartsheet form
                          progress when peeking at the Calculator/SHSAI tabs.
                          onConfirmed only clears intakeValues — the green
                          banner is server-driven (intake-form-status query)
                          so it appears automatically on the next refetch. */}
                      <TabsContent
                        value="intake"
                        className="flex-1 flex flex-col min-h-0 m-0 data-[state=inactive]:hidden"
                        forceMount
                      >
                        <IntakeFormTab
                          submissionId={selectedId}
                          // Tyler 2026-04-28 (intake-tab disappearance bug,
                          // Fix B): prefer the snapshot fallback so the
                          // service order persists across the post-Authorize
                          // moment when selectedSubmission is briefly null.
                          // Without this the iframe would re-render with
                          // serviceOrder=null mid-Authorize and fail to
                          // build the prefill URL.
                          serviceOrder={effectiveSelectedSubmission?.serviceOrder ?? null}
                          // Tyler 2026-04-29 (batch B): the IntakeFormFieldset
                          // that briefly used these props is now removed.
                          // procId + payload + onPayloadChange remain because
                          // they still drive the SERVER /preview endpoint —
                          // the server uses procId for branch detection and
                          // bakes payload (server-derived defaults from
                          // /preview's `derivedDefaults` response) into the
                          // Smartsheet prefill URL. There is no longer any
                          // agent-facing UI that mutates payload directly.
                          procId={(effectiveSelectedSubmission as any)?.procId ?? null}
                          onPayloadChange={setIntakeValues}
                          payload={intakeValues}
                          intakeStatus={intakeFormStatusQuery.data}
                          onPreviewLoaded={(derivedDefaults) => {
                            // Tyler 2026-04-26 (D4 max-derivation): merge
                            // server-derived defaults into the working
                            // payload for any keys the agent hasn't
                            // explicitly set — same plumbing the modal had.
                            // CRITICAL: must return `prev` unchanged when
                            // nothing is actually written, otherwise a fresh
                            // object reference retriggers the tab's preview
                            // useEffect (which depends on `payload`), which
                            // calls back into onPreviewLoaded — infinite
                            // refetch loop. (Architect-flagged regression
                            // risk on first review of the modal version.)
                            setIntakeValues((prev) => {
                              let changed = false;
                              const next = { ...prev };
                              for (const [k, v] of Object.entries(derivedDefaults)) {
                                if (next[k] === undefined || next[k] === "") {
                                  next[k] = v;
                                  changed = true;
                                }
                              }
                              return changed ? next : prev;
                            });
                          }}
                          onConfirmed={() => {
                            // Intake row is recorded — clear local working
                            // state. The green banner shows automatically
                            // because the intake-form-status query was
                            // invalidated inside IntakeFormTab.onConfirm.
                            setIntakeValues({});
                            queryClient.invalidateQueries({
                              predicate: (q) =>
                                (q.queryKey[0] as string).startsWith("/api/submissions"),
                            });
                            // Tyler 2026-04-28 (post-Approve/Reject keep-
                            // ticket-open requirement): the close-out moved
                            // here from processMutation.onSuccess. Now the
                            // ticket review screen ONLY clears when the
                            // agent confirms the Smartsheet submission —
                            // returning them to the queue / next ticket.
                            setSelectedId(null);
                            setLocalAgentStatus("online");
                          }}
                        />
                      </TabsContent>
                    </Tabs>
                  </div>
                )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Tyler 2026-04-27: <IntakeFormReviewModal> removed — replaced by
          the <IntakeFormTab> rendered inside the right-panel <Tabs> above.
          The onPreviewLoaded / onConfirmed callbacks moved with it
          unchanged. See COMMITS.md for the full migration note. */}

      {/* Tyler 2026-04-30: drag overlay — fixed full-viewport layer that
          intercepts pointer events while the agent is dragging the right-
          panel splitter. Without this, the cursor passing over the
          Smartsheet / Calculator / SHSAI iframes would let the iframe
          capture the mousemove and stall the resize. Only mounted during
          an active drag so it never affects normal interaction. */}
      {isResizingRightPanel && (
        <div
          className="fixed inset-0 z-50 cursor-col-resize"
          data-testid="overlay-resizing-right-panel"
        />
      )}

      <CalculatorSettingsDialog
        open={calcSettingsOpen}
        onOpenChange={setCalcSettingsOpen}
      />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-confirm-title">
              {selectedAction === "approve_submission" ? "Approve Submission" : selectedAction === "approve" ? "Approve Ticket" : selectedAction === "reject" ? "Reject Ticket" : selectedAction === "reject_and_close" ? "Reject & Close Permanently" : "Mark as Invalid"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedAction === "approve_submission" && (
                <>The technician will be notified via SMS that their submission has been approved and VRS is working on obtaining authorization. The ticket will remain pending for you to enter the authorization code.</>
              )}
              {selectedAction === "approve" && (
                <>The technician will be notified via SMS with the authorization code. This action completes the ticket.</>
              )}
              {selectedAction === "reject" && (
                <>The ticket will be returned to the queue and the technician will be notified via SMS with the rejection reasons.</>
              )}
              {selectedAction === "reject_and_close" && (
                <>This will permanently close the ticket. The technician will be notified that the repair is not covered and will be unable to resubmit or create new tickets for this service order. This action cannot be undone.</>
              )}
              {selectedAction === "invalid" && (
                <>The technician will be notified via SMS that this request cannot be processed through VRS.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {selectedAction === "reject" && selectedRejectionReasons.length > 0 && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Rejection Reasons:</p>
              <ul className="text-sm space-y-0.5">
                {selectedRejectionReasons.map((r) => (
                  <li key={r} className="text-destructive">&bull; {r}</li>
                ))}
              </ul>
            </div>
          )}
          {selectedAction === "invalid" && selectedInvalidReasons.length > 0 && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Invalid Reasons:</p>
              <ul className="text-sm space-y-0.5">
                {selectedInvalidReasons.map((r) => (
                  <li key={r} className="text-gray-700 dark:text-gray-400">&bull; {r}</li>
                ))}
              </ul>
            </div>
          )}
          {selectedAction === "reject_and_close" && rejectCloseReason && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Closure Reason:</p>
              <p className="text-sm text-orange-700 dark:text-orange-400">&bull; {rejectCloseReason === "Other" && rejectCloseCustomReason.trim() ? `Other: ${rejectCloseCustomReason.trim()}` : rejectCloseReason}</p>
            </div>
          )}
          {((selectedAction === "approve" || selectedAction === "approve_submission" || selectedAction === "reject" || selectedAction === "reject_and_close") && technicianMessage || selectedAction === "invalid" && invalidMessage) && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">{selectedAction === "approve" || selectedAction === "approve_submission" ? "Approval Notes to Technician:" : "Message to Technician:"}</p>
              <p className="text-sm">{selectedAction === "invalid" ? invalidMessage : technicianMessage}</p>
            </div>
          )}
          {agentNotes && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Internal Agent Notes:</p>
              <p className="text-sm">{agentNotes}</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-confirm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleProcessSubmit}
              className={selectedAction === "reject" || selectedAction === "reject_and_close" ? "bg-destructive text-destructive-foreground" : ""}
              data-testid="button-confirm-process"
            >
              {selectedAction === "approve_submission" ? "Approve Submission & Notify" : selectedAction === "approve" ? "Approve & Notify" : selectedAction === "reject" ? "Reject & Notify" : selectedAction === "reject_and_close" ? "Reject, Close & Notify" : "Mark Invalid & Notify"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={nlaConfirmOpen} onOpenChange={setNlaConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-nla-confirm-title">
              {selectedSubmission?.nlaEscalatedBy
                ? "Confirm & Complete Order"
                : nlaAction === "nla_part_found_vrs_ordered" && !user?.canOrderParts
                ? "Escalate to P-Card Agent"
                : "Confirm NLA Resolution"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {selectedSubmission?.nlaEscalatedBy ? (
                <>You are completing this escalated order. The technician will be notified via SMS with the resolution details.</>
              ) : nlaAction === "nla_part_found_vrs_ordered" && !user?.canOrderParts ? (
                <>You are escalating this ticket to a P-Card agent for ordering. Your research notes will be saved. The P-Card agent will review and complete the order.</>
              ) : nlaAction === "nla_replacement_submitted" ? (
                <>The technician will be notified that a replacement has been submitted to the warranty company.</>
              ) : nlaAction === "nla_replacement_tech_initiates" ? (
                <>Resolution: Verified NLA VRS Replacement Approved. The technician will be notified to initiate the replacement in TechHub.</>
              ) : nlaAction === "nla_part_found_vrs_ordered" ? (
                <>The technician will be notified that VRS has ordered the part.</>
              ) : nlaAction === "nla_part_found_tech_orders" ? (
                <>The technician will be notified to order part <strong className="font-mono">{nlaFoundPartNumber}</strong> from TechHub.</>
              ) : nlaAction === "nla_rfr_eligible" ? (
                <>The technician will be notified that the part is RFR eligible — to remove the failed part, return it for repair, and reschedule the call in TechHub.</>
              ) : nlaAction === "nla_reject" ? (
                <>The technician will be notified that more information is needed.</>
              ) : nlaAction === "nla_invalid" ? (
                <>The technician will be notified that this NLA request is invalid.</>
              ) : (
                <>This will send an SMS to the technician.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {nlaAction === "nla_reject" && selectedRejectionReasons.length > 0 && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Rejection Reasons:</p>
              <ul className="text-sm space-y-0.5">
                {selectedRejectionReasons.map((r) => (
                  <li key={r} className="text-destructive">&bull; {r}</li>
                ))}
              </ul>
            </div>
          )}
          {technicianMessage && (
            <div className="px-6 pb-2">
              <p className="text-xs font-medium text-muted-foreground mb-1">Message to Technician:</p>
              <p className="text-sm">{technicianMessage}</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-nla-cancel-confirm">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedSubmission?.nlaEscalatedBy) {
                  nlaProcessMutation.mutate({
                    action: "nla_pcard_confirm",
                    agentNotes: agentNotes || undefined,
                    technicianMessage: technicianMessage || undefined,
                    nlaResolution: selectedSubmission.nlaResolution,
                    nlaFoundPartNumber: selectedSubmission.nlaFoundPartNumber || undefined,
                  });
                } else if (nlaAction === "nla_part_found_vrs_ordered" && !user?.canOrderParts) {
                  nlaProcessMutation.mutate({
                    action: "nla_escalate_to_pcard",
                    agentNotes: agentNotes || undefined,
                    technicianMessage: technicianMessage || undefined,
                    nlaResolution: "part_found_vrs_ordered",
                    nlaFoundPartNumber: nlaFoundPartNumber || undefined,
                  });
                } else {
                  const body: Record<string, unknown> = {
                    action: nlaAction,
                    agentNotes: agentNotes || undefined,
                    technicianMessage: technicianMessage || undefined,
                  };
                  if (nlaAction === "nla_part_found_tech_orders") {
                    body.nlaFoundPartNumber = nlaFoundPartNumber;
                  }
                  if (nlaAction === "nla_reject") {
                    body.rejectionReasons = selectedRejectionReasons;
                  }
                  if (nlaAction === "nla_invalid") {
                    body.invalidReason = selectedInvalidReasons.join("; ");
                    body.invalidInstructions = invalidMessage || undefined;
                  }
                  nlaProcessMutation.mutate(body);
                }
              }}
              data-testid="button-nla-confirm-process"
            >
              {selectedSubmission?.nlaEscalatedBy
                ? "Confirm & Complete"
                : nlaAction === "nla_part_found_vrs_ordered" && !user?.canOrderParts
                ? "Escalate"
                : "Confirm & Send"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-delete-confirm-title">Delete Submission</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to permanently delete this submission? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedSubmission) {
                  deleteMutation.mutate(selectedSubmission.id);
                }
                setDeleteConfirmOpen(false);
              }}
              className="bg-destructive text-destructive-foreground"
              data-testid="button-confirm-delete"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PhotoLightbox
        photos={lightboxPhotos}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
      <Dialog open={reassignOpen} onOpenChange={(open) => { if (!open) { setReassignOpen(false); setReassignNotes(""); setReassignTarget(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reassign Ticket</DialogTitle>
            <DialogDescription>
              {isAdminRole
                ? "Reassign this ticket to the queue or directly to an agent."
                : "Return this ticket to the queue so another agent can pick it up."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {isAdminRole && (
              <div className="space-y-2">
                <Label>Assign to</Label>
                <Select value={reassignTarget} onValueChange={setReassignTarget}>
                  <SelectTrigger data-testid="select-reassign-target">
                    <SelectValue placeholder="Select an option..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="queue" data-testid="option-return-queue">
                      Return to Queue (unassign)
                    </SelectItem>
                    {availableAgents.map((agent: any) => (
                      <SelectItem
                        key={agent.id}
                        value={String(agent.id)}
                        data-testid={`option-agent-${agent.id}`}
                      >
                        {agent.name} ({agent.role === "vrs_agent" ? "Agent" : agent.role === "admin" ? "Admin" : "Super Admin"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Reassignment Notes (optional)</Label>
              <Textarea
                placeholder="Reason for reassignment"
                value={reassignNotes}
                onChange={(e) => setReassignNotes(e.target.value)}
                className="resize-none"
                rows={3}
                data-testid="input-reassign-notes"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setReassignOpen(false); setReassignNotes(""); setReassignTarget(""); }} data-testid="button-cancel-reassign">Cancel</Button>
            <Button
              onClick={() => {
                if (selectedId) {
                  if (isAdminRole && reassignTarget) {
                    const agentId = reassignTarget === "queue" ? undefined : parseInt(reassignTarget);
                    reassignMutation.mutate({ submissionId: selectedId, agentId, notes: reassignNotes || undefined });
                  } else {
                    reassignMutation.mutate({ submissionId: selectedId, notes: reassignNotes || undefined });
                  }
                }
              }}
              disabled={reassignMutation.isPending || (isAdminRole && !reassignTarget)}
              data-testid="button-confirm-reassign"
            >
              {reassignMutation.isPending ? "Reassigning..." : (
                isAdminRole
                  ? (reassignTarget === "queue" ? "Reassign to Queue" : reassignTarget ? "Reassign to Agent" : "Reassign")
                  : "Reassign to Queue"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sendToNlaOpen} onOpenChange={(open) => { if (!open) { setSendToNlaOpen(false); setSendToNlaNotes(""); setSendToNlaDivision(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to NLA Queue</DialogTitle>
            <DialogDescription>
              This will move the ticket to the NLA parts queue where an NLA-specialized agent can pick it up. The ticket will be unassigned from you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>NLA Division</Label>
              <Select value={sendToNlaDivision} onValueChange={setSendToNlaDivision}>
                <SelectTrigger data-testid="select-nla-division">
                  <SelectValue placeholder="Select division..." />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(DIVISION_LABELS)
                    .filter(([key]) => key !== "nla")
                    .map(([key, label]) => (
                    <SelectItem key={key} value={key} data-testid={`option-nla-div-${key}`}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Notes (optional)</Label>
              <Textarea
                placeholder="Reason for sending to NLA..."
                value={sendToNlaNotes}
                onChange={(e) => setSendToNlaNotes(e.target.value)}
                className="resize-none"
                rows={3}
                data-testid="input-send-nla-notes"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setSendToNlaOpen(false); setSendToNlaNotes(""); setSendToNlaDivision(""); }} data-testid="button-cancel-send-nla">Cancel</Button>
            <Button
              onClick={() => {
                if (selectedId && sendToNlaDivision) {
                  sendToNlaMutation.mutate({ submissionId: selectedId, division: sendToNlaDivision, notes: sendToNlaNotes || undefined });
                }
              }}
              disabled={sendToNlaMutation.isPending || !sendToNlaDivision}
              data-testid="button-confirm-send-nla"
            >
              {sendToNlaMutation.isPending ? "Sending..." : "Send to NLA Queue"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={divisionCorrectionConfirmOpen} onOpenChange={setDivisionCorrectionConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Correct Division?</AlertDialogTitle>
            <AlertDialogDescription>
              Change appliance type from{" "}
              <strong>{DIVISION_LABELS[selectedSubmission?.applianceType || ""] || selectedSubmission?.applianceType}</strong>{" "}
              to <strong>{DIVISION_LABELS[divisionCorrectionTarget || ""] || divisionCorrectionTarget}</strong>.
              {" "}If you don't handle this division, the ticket will be released back to the queue for another agent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setDivisionCorrectionTarget(null); setDivisionCorrectionConfirmOpen(false); }}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (selectedId && divisionCorrectionTarget) {
                  divisionCorrectionMutation.mutate({ submissionId: selectedId, newDivision: divisionCorrectionTarget });
                }
              }}
              disabled={divisionCorrectionMutation.isPending}
              data-testid="button-confirm-division-correction"
            >
              {divisionCorrectionMutation.isPending ? "Correcting..." : "Confirm Correction"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showStatusPopup} onOpenChange={setShowStatusPopup}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-status-popup-title">You're currently unavailable</AlertDialogTitle>
            <AlertDialogDescription>
              Set yourself as available to start receiving tickets?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setShowStatusPopup(false)} data-testid="button-stay-offline">
              Stay Unavailable
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                statusMutation.mutate("online");
                setShowStatusPopup(false);
              }}
              data-testid="button-go-online"
            >
              Go Available
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
