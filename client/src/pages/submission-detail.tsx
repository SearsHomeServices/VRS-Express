import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRoute, Link, useLocation } from "wouter";
import { formatDate } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Copy,
  ArrowLeft,
  ImageIcon,
  Video,
  Mic,
  Ban,
  ScrollText,
  Package,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Submission } from "@shared/schema";
import { shouldSuppressCashCall } from "@/lib/smsPreview";
import { parseVideoUrls } from "@/lib/videoUrls";

export default function SubmissionDetailPage() {
  const [, params] = useRoute("/tech/submissions/:id");
  const id = params?.id;
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const { data, isLoading, error } = useQuery<{ submission: Submission }>({
    queryKey: ["/api/submissions", id],
    enabled: !!id,
  });

  const historyQuery = useQuery<{
    history: Submission[];
    reviewerNames: Record<number, string>;
    technicianName: string;
    resubmissionCount: number;
    maxResubmissions: number;
  }>({
    queryKey: ["/api/submissions", id, "history"],
    enabled: !!id,
  });

  const notesQuery = useQuery<{ notes: Array<{ id: number; body: string; authorName: string; authorRole: string; createdAt: string }> }>({
    queryKey: ["/api/submissions", id, "notes"],
    enabled: !!id,
  });

  const [noteDraft, setNoteDraft] = useState("");
  const [postingNote, setPostingNote] = useState(false);

  async function postNote() {
    if (!noteDraft.trim() || !id) return;
    setPostingNote(true);
    try {
      await apiRequest("POST", `/api/submissions/${id}/notes`, { body: noteDraft.trim() });
      setNoteDraft("");
      await queryClient.invalidateQueries({ queryKey: ["/api/submissions", id, "notes"] });
      toast({ title: "Note added" });
    } catch (err: any) {
      toast({ title: "Failed to add note", description: String(err?.message || err), variant: "destructive" });
    } finally {
      setPostingNote(false);
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen pb-20">
        <div className="bg-primary text-primary-foreground p-4">
          <div className="max-w-lg mx-auto">
            <Skeleton className="h-6 w-40 bg-primary-foreground/20" />
          </div>
        </div>
        <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data?.submission) {
    return (
      <div className="min-h-screen pb-20">
        <div className="bg-primary text-primary-foreground p-4">
          <div className="max-w-lg mx-auto flex items-center gap-2">
            <Button size="icon" variant="ghost" className="text-primary-foreground no-default-hover-elevate no-default-active-elevate" onClick={() => navigate("/tech/history")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-lg font-bold">Submission Not Found</h1>
          </div>
        </div>
        <div className="max-w-lg mx-auto px-4 py-8 text-center">
          <p className="text-muted-foreground">This submission could not be found.</p>
          <Button className="mt-4" data-testid="button-go-home" onClick={() => navigate("/tech")}>Go Home</Button>
        </div>
      </div>
    );
  }

  const sub = data.submission;
  const status = sub.ticketStatus || sub.stage1Status;
  const hasAuthCode = !!sub.authCode;
  const hasRgcCode = !!(sub as any).rgcCode;
  const hasBothCodes = hasAuthCode && hasRgcCode;

  function getHeaderConfig() {
    if (status === "invalid" || sub.stage1Status === "invalid") {
      return {
        bgClass: "bg-gray-700 text-white",
        icon: <Ban className="w-10 h-10 mx-auto mb-2" />,
        title: "Not Applicable",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    if (sub.stage2Status === "declined") {
      return {
        bgClass: "bg-destructive text-destructive-foreground",
        icon: <XCircle className="w-10 h-10 mx-auto mb-2" />,
        title: "Repair Declined",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    if (status === "rejected_closed") {
      return {
        bgClass: "bg-destructive text-destructive-foreground",
        icon: <XCircle className="w-10 h-10 mx-auto mb-2" />,
        title: "Not Covered Under Warranty",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    if (status === "rejected" || sub.stage1Status === "rejected") {
      return {
        bgClass: "bg-destructive text-destructive-foreground",
        icon: <AlertTriangle className="w-10 h-10 mx-auto mb-2" />,
        title: "Resubmission Needed",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    if ((status === "completed" || sub.stage1Status === "approved") && (hasAuthCode || hasRgcCode)) {
      return {
        bgClass: "bg-green-700 text-white",
        icon: <CheckCircle className="w-10 h-10 mx-auto mb-2" />,
        title: "Authorization Ready",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    if (status === "completed" || sub.stage1Status === "approved") {
      return {
        bgClass: "bg-green-700 text-white",
        icon: <CheckCircle className="w-10 h-10 mx-auto mb-2" />,
        title: "Submission Approved",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    if ((sub as any).submissionApproved && status === "pending") {
      return {
        bgClass: "bg-blue-600 text-white",
        icon: <CheckCircle className="w-10 h-10 mx-auto mb-2" />,
        title: "Submission Approved",
        subtitle: `Service Order #${sub.serviceOrder}`,
      };
    }
    return {
      bgClass: "bg-primary text-primary-foreground",
      icon: <Clock className="w-10 h-10 mx-auto mb-2 opacity-80" />,
      title: "Under Review",
      subtitle: `Service Order #${sub.serviceOrder}`,
    };
  }

  const headerConfig = getHeaderConfig();

  function copyAuthCode() {
    if (sub.authCode) {
      navigator.clipboard.writeText(sub.authCode);
      toast({ title: "Copied", description: "Authorization code copied to clipboard." });
    }
  }

  function copyRgcCode() {
    const rgc = (sub as any).rgcCode;
    if (rgc) {
      navigator.clipboard.writeText(rgc);
      toast({ title: "Copied", description: "RGC code copied to clipboard." });
    }
  }

  const history = historyQuery.data?.history || [];
  const reviewerNames = historyQuery.data?.reviewerNames || {};
  const techName = historyQuery.data?.technicianName || "Technician";
  const resubCount = historyQuery.data?.resubmissionCount ?? 0;
  const maxResubs = historyQuery.data?.maxResubmissions ?? 3;
  const hasHistory = history.length > 1;

  return (
    <div className="min-h-screen pb-20">
      <div className={`${headerConfig.bgClass} p-4 pb-8`}>
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 mb-4">
            <Button size="icon" variant="ghost" className="text-inherit no-default-hover-elevate no-default-active-elevate" onClick={() => navigate("/tech/history")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <p className="text-sm opacity-80">{headerConfig.subtitle}</p>
          </div>
          <div className="text-center py-4">
            {headerConfig.icon}
            <h1 className="text-xl font-bold" data-testid="text-status-title">{headerConfig.title}</h1>
            {(status === "queued" || status === "pending") && !(sub as any).submissionApproved && (
              <p className="text-sm opacity-80 mt-1">
                Your submission is being reviewed by a VRS agent. You'll receive an SMS notification shortly.
              </p>
            )}
            {status === "pending" && (sub as any).submissionApproved && (
              <p className="text-sm opacity-80 mt-1">
                Your submission has been approved! VRS is now obtaining your authorization code. You can pack up and tidy your workspace while you wait.
              </p>
            )}
            {(status === "completed" || status === "approved") && !hasAuthCode && (
              <p className="text-sm opacity-80 mt-1">
                You're Clear to Go! Your authorization code will arrive via SMS.
              </p>
            )}
            {status === "rejected" && (
              <p className="text-sm opacity-80 mt-1">
                VRS needs additional information before they can proceed with authorization.
              </p>
            )}
            {status === "rejected_closed" && (
              <p className="text-sm opacity-80 mt-1">
                {shouldSuppressCashCall(sub.warrantyType, sub.rejectionReasons || sub.stage1RejectionReason || "")
                  ? "This repair has been determined to not be covered under warranty. No further VRS submissions can be made for this service order."
                  : "This repair has been determined to not be covered under warranty. You may offer the customer a cash call estimate."}
              </p>
            )}
            {status === "invalid" && (
              <p className="text-sm opacity-80 mt-1">
                This request cannot be processed through VRS.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 -mt-4 space-y-4">
        {(hasAuthCode || hasRgcCode) && (
          <Card>
            <CardContent className="p-4 text-center space-y-4">
              {hasBothCodes && (
                <p className="text-xs text-muted-foreground" data-testid="text-both-codes-hint">
                  Enter <span className="font-semibold">both codes</span> in TechHub to complete authorization.
                </p>
              )}
              {hasAuthCode && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                    {hasBothCodes ? "AHS Authorization Code" : "Authorization Code"}
                  </p>
                  <div className="bg-primary text-primary-foreground rounded-md py-4 px-6 mb-3">
                    <p className="text-2xl font-mono font-bold tracking-wider" data-testid="text-auth-code">
                      {sub.authCode}
                    </p>
                  </div>
                  <Button onClick={copyAuthCode} className="w-full" data-testid="button-copy-code">
                    <Copy className="w-4 h-4 mr-2" />
                    Copy {hasBothCodes ? "AHS Code" : "Code to Clipboard"}
                  </Button>
                </div>
              )}
              {hasRgcCode && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">RGC Code</p>
                  <div className="bg-primary text-primary-foreground rounded-md py-4 px-6 mb-3">
                    <p className="text-2xl font-mono font-bold tracking-wider" data-testid="text-rgc-code">
                      {(sub as any).rgcCode}
                    </p>
                  </div>
                  <Button onClick={copyRgcCode} className="w-full" data-testid="button-copy-rgc-code">
                    <Copy className="w-4 h-4 mr-2" />
                    Copy {hasBothCodes ? "RGC Code" : "Code to Clipboard"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {sub.requestType === "parts_nla" && (status === "completed" || status === "approved") && sub.nlaResolution && (
          <Card className="border-emerald-500">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Package className="w-5 h-5 text-emerald-600" />
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-400">NLA Resolution</p>
              </div>
              {sub.nlaResolution === "replacement_submitted" && (
                <div data-testid="text-nla-resolution">
                  <p className="text-sm font-medium">Replacement Submitted</p>
                  <p className="text-sm text-muted-foreground mt-1">A replacement request has been submitted to the warranty company. Close this call using the NLA labor code.</p>
                </div>
              )}
              {sub.nlaResolution === "replacement_tech_initiates" && (
                <div data-testid="text-nla-resolution">
                  <p className="font-semibold text-emerald-700 dark:text-emerald-400">NLA Replacement Approved</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    The part(s) could not be sourced. VRS has approved a replacement. You must initiate the replacement in TechHub using standard replacement procedures.
                  </p>
                </div>
              )}
              {sub.nlaResolution === "part_found_vrs_ordered" && (
                <div data-testid="text-nla-resolution">
                  <p className="text-sm font-medium">Part Ordered by VRS</p>
                  <p className="text-sm text-muted-foreground mt-1">VRS has ordered the part for this service order. You will be contacted with further details.</p>
                </div>
              )}
              {sub.nlaResolution === "part_found_tech_orders" && (
                <div data-testid="text-nla-resolution">
                  <p className="text-sm font-medium">Part Found — You Need to Order</p>
                  {sub.nlaFoundPartNumber && (
                    <div className="mt-2 bg-primary text-primary-foreground rounded-md py-3 px-4 text-center">
                      <p className="text-xs uppercase tracking-wider opacity-80 mb-1">Part Number</p>
                      <p className="text-lg font-mono font-bold tracking-wider">{sub.nlaFoundPartNumber}</p>
                    </div>
                  )}
                  <p className="text-sm text-muted-foreground mt-2">This part is available in TechHub. Order it and reschedule the call.</p>
                </div>
              )}
              {sub.technicianMessage && (
                <div className="mt-3 pt-3 border-t">
                  <p className="text-sm font-semibold mb-1">Feedback from VRS — Action required:</p>
                  <p className="text-sm" data-testid="text-nla-instructions">{sub.technicianMessage}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {status === "rejected" && (sub.rejectionReasons || sub.stage1RejectionReason) && (
          <Card className="border-destructive">
            <CardContent className="p-4">
              <p className="text-sm font-semibold text-destructive mb-1">What's Missing:</p>
              <p className="text-sm" data-testid="text-rejection-reason">
                {sub.rejectionReasons
                  ? (typeof sub.rejectionReasons === 'string' ? JSON.parse(sub.rejectionReasons) : sub.rejectionReasons).join(', ')
                  : sub.stage1RejectionReason}
              </p>
              {sub.technicianMessage && (
                <div className="mt-2 pt-2 border-t">
                  <p className="text-sm font-semibold text-destructive mb-1">Feedback from VRS — Action required:</p>
                  <p className="text-sm" data-testid="text-technician-message">{sub.technicianMessage}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {status === "rejected_closed" && (
          <Card className="border-destructive">
            <CardContent className="p-4">
              <p className="text-sm font-semibold text-destructive mb-1">Rejection Reason:</p>
              <p className="text-sm" data-testid="text-rejection-closed-reason">
                {sub.rejectionReasons
                  ? (typeof sub.rejectionReasons === 'string' ? JSON.parse(sub.rejectionReasons) : sub.rejectionReasons).join(', ')
                  : sub.stage1RejectionReason || "Not covered under warranty"}
              </p>
              {sub.technicianMessage && (
                <div className="mt-2 pt-2 border-t">
                  <p className="text-sm font-semibold text-destructive mb-1">Feedback from VRS:</p>
                  <p className="text-sm">{sub.technicianMessage}</p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {status === "invalid" && (
          <Card className="border-gray-500">
            <CardContent className="p-4 space-y-2">
              <p className="text-sm font-semibold">Not Applicable</p>
              {(sub as any).invalidReason && (
                <p className="text-sm" data-testid="text-invalid-reason">Reason: {(sub as any).invalidReason}</p>
              )}
              {(sub as any).invalidInstructions && (
                <p className="text-sm text-muted-foreground" data-testid="text-invalid-instructions">{(sub as any).invalidInstructions}</p>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-4 space-y-3">
            <DetailRow label="Service Order" value={`#${sub.serviceOrder}`} testId="text-detail-so" />
            <DetailRow label="Appliance" value={sub.applianceType.charAt(0).toUpperCase() + sub.applianceType.slice(1)} testId="text-detail-appliance" />
            <DetailRow label="Request Type" value={sub.requestType === "authorization" ? "Authorization" : sub.requestType === "parts_nla" ? "Parts — No Longer Available (NLA)" : "Infestation / Non-Accessible"} testId="text-detail-request-type" />
            {sub.warrantyType && (
              <DetailRow label="Warranty" value={sub.warrantyType === "sears_protect" ? "Sears Protect" : sub.warrantyType === "home_warranty" ? "Sears Home Warranty" : sub.warrantyType.charAt(0).toUpperCase() + sub.warrantyType.slice(1)} testId="text-detail-warranty" />
            )}
            {sub.estimateAmount != null && (
              <DetailRow label="Estimate" value={`$${Number(sub.estimateAmount).toFixed(2)}`} testId="text-detail-estimate" />
            )}
            <DetailRow label="Status" value={
              <StatusBadge
                status={status}
                stage2={sub.stage2Status}
                hasAuthCode={hasAuthCode}
              />
            } testId="text-detail-status" />
            {sub.createdAt && (
              <DetailRow
                label="Submitted"
                value={formatDate(sub.createdAt)}
                testId="text-detail-submitted"
              />
            )}
            {(sub.reviewedAt || sub.stage1ReviewedAt) && (
              <DetailRow
                label={(status === "completed" || status === "approved") ? "Approved At" : "Reviewed At"}
                value={formatDate(sub.reviewedAt || sub.stage1ReviewedAt)}
                testId="text-detail-reviewed"
              />
            )}
          </CardContent>
        </Card>

        {sub.issueDescription && (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Issue Description</p>
              <p className="text-sm whitespace-pre-wrap" data-testid="text-detail-description">{sub.issueDescription}</p>
            </CardContent>
          </Card>
        )}

        {(sub as any).partNumbers && (() => {
          try {
            const parts = JSON.parse((sub as any).partNumbers);
            if (Array.isArray(parts) && parts.length > 0) {
              return (
                <Card>
                  <CardContent className="p-4">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Part Number(s)</p>
                    <p className="text-sm font-mono" data-testid="text-part-numbers">{parts.join(", ")}</p>
                  </CardContent>
                </Card>
              );
            }
            if (parts && typeof parts === "object" && !Array.isArray(parts)) {
              const nlaParts = Array.isArray(parts.nla) ? parts.nla : [];
              const availParts = Array.isArray(parts.available) ? parts.available : [];
              if (nlaParts.length > 0 || availParts.length > 0) {
                return (
                  <Card>
                    <CardContent className="p-4 space-y-3">
                      {nlaParts.length > 0 && (
                        <div>
                          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">NLA Part Number(s)</p>
                          <p className="text-sm font-mono" data-testid="text-nla-parts">{nlaParts.join(", ")}</p>
                        </div>
                      )}
                      {availParts.length > 0 && (
                        <div>
                          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Other Required Parts (Available)</p>
                          <p className="text-sm font-mono" data-testid="text-available-parts">{availParts.join(", ")}</p>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              }
            }
          } catch {}
          return null;
        })()}

        {(() => {
          let parsed: any = null;
          try { parsed = sub.photos ? JSON.parse(sub.photos) : null; } catch { parsed = null; }
          if (!parsed) return null;
          
          const isNewFormat = parsed && typeof parsed === "object" && !Array.isArray(parsed);
          const estimatePhotos: string[] = isNewFormat ? (parsed.estimate || []) : [];
          const issuePhotos: string[] = isNewFormat ? (parsed.issue || []) : [];
          const legacyPhotos: string[] = Array.isArray(parsed) ? parsed : [];
          const hasAny = estimatePhotos.length > 0 || issuePhotos.length > 0 || legacyPhotos.length > 0;
          
          return hasAny ? (
            <Card>
              <CardContent className="p-4 space-y-4">
                {issuePhotos.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <ImageIcon className="w-3.5 h-3.5" />
                      Issue Photos ({issuePhotos.length})
                    </p>
                    <div className="grid grid-cols-3 gap-2" data-testid="media-issue-photos-detail">
                      {issuePhotos.map((url: string, i: number) => (
                        <div key={i} className="aspect-square bg-muted rounded-md overflow-hidden">
                          <img src={url} alt={`Issue ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-issue-detail-${i}`} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {estimatePhotos.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <ImageIcon className="w-3.5 h-3.5" />
                      Model, Serial & Estimate Screenshots ({estimatePhotos.length})
                    </p>
                    <div className="grid grid-cols-3 gap-2" data-testid="media-estimate-photos-detail">
                      {estimatePhotos.map((url: string, i: number) => (
                        <div key={i} className="aspect-square bg-muted rounded-md overflow-hidden">
                          <img src={url} alt={`Estimate ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-estimate-detail-${i}`} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {legacyPhotos.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <ImageIcon className="w-3.5 h-3.5" />
                      Photos ({legacyPhotos.length})
                    </p>
                    <div className="grid grid-cols-3 gap-2" data-testid="media-photos-detail">
                      {legacyPhotos.map((url: string, i: number) => (
                        <div key={i} className="aspect-square bg-muted rounded-md overflow-hidden">
                          <img src={url} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-photo-detail-${i}`} />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null;
        })()}

        {(() => {
          // Tyler 2026-04-30: render up to 3 video tiles. Backward-compatible
          // with legacy single-URL rows via parseVideoUrls.
          const videoList = parseVideoUrls(sub.videoUrl);
          if (videoList.length === 0) return null;
          return (
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                  <Video className="w-3.5 h-3.5" />
                  {videoList.length === 1 ? "Video Attachment" : `Video Attachments (${videoList.length})`}
                </p>
                <div className="space-y-2">
                  {videoList.map((vurl, vi) => (
                    <div
                      key={`${vurl}-${vi}`}
                      className="rounded-md overflow-hidden bg-muted"
                      data-testid={videoList.length === 1 ? "media-video-detail" : `media-video-detail-${vi}`}
                    >
                      <video
                        src={vurl}
                        controls
                        className="w-full max-h-[250px]"
                        data-testid={videoList.length === 1 ? "video-player-detail" : `video-player-detail-${vi}`}
                      />
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          );
        })()}

        {sub.voiceNoteUrl && (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Mic className="w-3.5 h-3.5" />
                Voice Note
              </p>
              <audio src={sub.voiceNoteUrl} controls className="w-full" data-testid="audio-player-detail" />
            </CardContent>
          </Card>
        )}

        {sub.stage2Status === "declined" && (
          <Card className="border-destructive">
            <CardContent className="p-4 space-y-2">
              <p className="text-sm font-semibold text-destructive">Repair Declined</p>
              {(sub as any).declineReason && (
                <p className="text-sm" data-testid="text-decline-reason">Reason: {(sub as any).declineReason}</p>
              )}
              {(sub as any).declineInstructions && (
                <p className="text-sm text-muted-foreground" data-testid="text-decline-instructions">{(sub as any).declineInstructions}</p>
              )}
            </CardContent>
          </Card>
        )}

        {hasHistory && (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-1.5">
                <ScrollText className="w-3.5 h-3.5" />
                Submission History
              </p>
              <div className="space-y-0">
                {history.map((item, idx) => {
                  const isOriginal = item.resubmissionOf == null;
                  const resubNumber = isOriginal ? 0 : history.filter((h, hi) => h.resubmissionOf != null && hi <= idx).length;
                  return (
                    <div key={item.id}>
                      {idx > 0 && <Separator className="my-3" />}
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium" data-testid={`history-entry-${idx}`}>
                            {isOriginal ? "Original Submission" : `Resubmission #${resubNumber}`}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(item.createdAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Tech: {techName}
                        </p>
                        {item.issueDescription && (
                          <p className="text-xs text-muted-foreground line-clamp-2">
                            "{item.issueDescription.substring(0, 120)}{item.issueDescription.length > 120 ? "..." : ""}"
                          </p>
                        )}
                        {(item as any).appealNotes && (
                          <p className="text-xs text-blue-600">
                            Appeal: {(item as any).appealNotes}
                          </p>
                        )}

                        {(item.ticketStatus === "rejected" || item.stage1Status === "rejected") && (item.reviewedAt || item.stage1ReviewedAt) && (
                          <div className="mt-2 pl-3 border-l-2 border-destructive/50">
                            <p className="text-xs font-medium text-destructive">
                              Rejected {formatDate(item.reviewedAt || item.stage1ReviewedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              {(item.reviewedBy || item.stage1ReviewedBy) && reviewerNames[(item.reviewedBy || item.stage1ReviewedBy)!] ? ` by ${reviewerNames[(item.reviewedBy || item.stage1ReviewedBy)!]}` : ""}
                            </p>
                            {(item.rejectionReasons || item.stage1RejectionReason) && (
                              <p className="text-xs text-muted-foreground">
                                Reason: "{item.rejectionReasons
                                  ? (typeof item.rejectionReasons === 'string' ? JSON.parse(item.rejectionReasons) : item.rejectionReasons).join(', ')
                                  : item.stage1RejectionReason}"
                              </p>
                            )}
                          </div>
                        )}

                        {(item.ticketStatus === "invalid" || item.stage1Status === "invalid") && (item.reviewedAt || item.stage1ReviewedAt) && (
                          <div className="mt-2 pl-3 border-l-2 border-gray-400">
                            <p className="text-xs font-medium text-gray-600">
                              Invalid {formatDate(item.reviewedAt || item.stage1ReviewedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              {(item.reviewedBy || item.stage1ReviewedBy) && reviewerNames[(item.reviewedBy || item.stage1ReviewedBy)!] ? ` by ${reviewerNames[(item.reviewedBy || item.stage1ReviewedBy)!]}` : ""}
                            </p>
                            {(item as any).invalidReason && (
                              <p className="text-xs text-muted-foreground">
                                Reason: "{(item as any).invalidReason}"
                              </p>
                            )}
                          </div>
                        )}

                        {(item.ticketStatus === "completed" || item.stage1Status === "approved") && (item.reviewedAt || item.stage1ReviewedAt) && (
                          <div className="mt-2 pl-3 border-l-2 border-green-500/50">
                            <p className="text-xs font-medium text-green-600">
                              Approved {formatDate(item.reviewedAt || item.stage1ReviewedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              {(item.reviewedBy || item.stage1ReviewedBy) && reviewerNames[(item.reviewedBy || item.stage1ReviewedBy)!] ? ` by ${reviewerNames[(item.reviewedBy || item.stage1ReviewedBy)!]}` : ""}
                            </p>
                          </div>
                        )}

                        {item.stage2Status === "declined" && item.stage2ReviewedAt && (
                          <div className="mt-1 pl-3 border-l-2 border-destructive/50">
                            <p className="text-xs font-medium text-destructive">
                              Declined {formatDate(item.stage2ReviewedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                              {item.stage2ReviewedBy && reviewerNames[item.stage2ReviewedBy] ? ` by ${reviewerNames[item.stage2ReviewedBy]}` : ""}
                            </p>
                            {(item as any).declineReason && (
                              <p className="text-xs text-muted-foreground">
                                Reason: "{(item as any).declineReason}"
                              </p>
                            )}
                          </div>
                        )}

                        {item.stage2Status === "approved" && item.authCode && (
                          <div className="mt-1 pl-3 border-l-2 border-green-500/50">
                            <p className="text-xs font-medium text-green-600">
                              Auth Code Issued: {item.authCode}
                            </p>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {status === "rejected" && resubCount < maxResubs && (
          <div className="space-y-2">
            <Button className="w-full" data-testid="button-resubmit" onClick={() => navigate(`/tech/resubmit/${sub.id}`)}>Resubmit with Updates</Button>
          </div>
        )}

        {status === "rejected" && resubCount >= maxResubs && (
          <Card className="border-destructive/50 bg-destructive/5">
            <CardContent className="p-4 text-center">
              <p className="text-sm font-semibold text-destructive" data-testid="text-max-resubmissions">Maximum resubmissions reached</p>
              <p className="text-xs text-muted-foreground mt-1">
                You have reached the maximum of {maxResubs} resubmissions. Please call VRS directly for assistance.
              </p>
            </CardContent>
          </Card>
        )}

        <Card className="mt-4" data-testid="card-submission-notes">
          <CardContent className="p-4 space-y-3">
            <h3 className="font-semibold flex items-center gap-2">
              <ScrollText className="w-4 h-4" /> Notes
            </h3>
            {notesQuery.data?.notes.length === 0 && (
              <p className="text-sm text-muted-foreground">No notes yet.</p>
            )}
            {notesQuery.data?.notes.map((n) => (
              <div key={n.id} className="rounded-md border p-2 text-sm" data-testid={`note-${n.id}`}>
                <div className="flex items-center justify-between">
                  <span className="font-medium">{n.authorName}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(n.createdAt)}
                  </span>
                </div>
                <div className="whitespace-pre-wrap mt-1">{n.body}</div>
              </div>
            ))}
            <div className="space-y-2">
              <Textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Add a note — clarification, new info, updated diagnosis…"
                rows={3}
                maxLength={2000}
                data-testid="input-note-body"
              />
              <Button
                size="sm"
                onClick={postNote}
                disabled={!noteDraft.trim() || postingNote}
                data-testid="button-post-note"
              >
                {postingNote ? "Posting…" : "Add note"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Button variant="outline" className="w-full" data-testid="button-view-next" onClick={() => navigate("/tech")}>
          {(status === "completed" || status === "approved") ? "View Next Job" : "Back to Home"}
        </Button>
      </div>
    </div>
  );
}

function DetailRow({ label, value, testId }: { label: string; value: React.ReactNode; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium" data-testid={testId}>{value}</span>
    </div>
  );
}

function StatusBadge({ status, stage2, hasAuthCode }: { status: string; stage2: string; hasAuthCode: boolean }) {
  if (status === "invalid") return <Badge variant="secondary">Not Applicable</Badge>;
  if (stage2 === "declined") return <Badge variant="destructive">Repair Declined</Badge>;
  if (status === "rejected_closed") return <Badge variant="destructive">Closed — Not Covered</Badge>;
  if (hasAuthCode) return <Badge className="bg-green-600 text-white border-green-600">Auth Code Issued</Badge>;
  if (status === "completed" || status === "approved") return <Badge className="bg-green-600 text-white border-green-600">Approved</Badge>;
  if (status === "rejected") return <Badge variant="destructive">Rejected</Badge>;
  return <Badge variant="secondary">Under Review</Badge>;
}
