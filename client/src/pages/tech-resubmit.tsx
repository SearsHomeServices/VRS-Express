import { useState, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation, Link } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { shouldSuppressCashCall } from "@/lib/smsPreview";
import { useAuth, getToken } from "@/lib/auth";
import { parseVideoUrls, MAX_VIDEOS_PER_TICKET } from "@/lib/videoUrls";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Camera, Send, X, AlertTriangle, ArrowLeft, Lock, Video, Upload, Info, Plus } from "lucide-react";
import HelpTooltip from "@/components/help-tooltip";
import type { Submission } from "@shared/schema";

const APPLIANCE_TYPES = [
  { value: "refrigeration", label: "Refrigerator" },
  { value: "laundry", label: "Laundry" },
  { value: "cooking", label: "Cooking" },
  { value: "dishwasher", label: "Dishwasher" },
  { value: "microwave", label: "Microwave" },
  { value: "hvac", label: "HVAC" },
  { value: "all_other", label: "All Other" },
];

const resubmitFormSchema = z.object({
  serviceOrder: z.string(),
  phone: z.string().min(7, "Valid phone number is required"),
  applianceType: z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"], {
    required_error: "Select an appliance type",
  }),
  requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
  warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
  warrantyProvider: z.string().optional(),
  issueDescription: z.string().min(10, "Please provide at least 10 characters").max(2000, "Description must be 2000 characters or less"),
  appealNotes: z.string().max(2000, "Appeal notes must be 2000 characters or less").optional(),
  partNumbers: z.array(z.string()).optional(),
});

type ResubmitFormData = z.infer<typeof resubmitFormSchema>;

export default function TechResubmitPage() {
  const [, params] = useRoute("/tech/resubmit/:id");
  const originalId = params?.id ? parseInt(params.id) : null;
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [issuePhotoUrls, setIssuePhotoUrls] = useState<string[]>([]);
  const [estimatePhotoUrls, setEstimatePhotoUrls] = useState<string[]>([]);
  const [issuePhotoUploading, setIssuePhotoUploading] = useState(false);
  const [estimatePhotoUploading, setEstimatePhotoUploading] = useState(false);
  // Tyler 2026-04-30: multi-video resubmit. Up to 3 videos per ticket,
  // matching the limits on initial submission. Sequential uploads — only
  // one at a time — so the existing scalar `videoUploading` flag still
  // gates the UI while the next slot is being uploaded.
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [videoUploading, setVideoUploading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [partNumbers, setPartNumbers] = useState<string[]>([""]);
  const issuePhotoInputRef = useRef<HTMLInputElement>(null);
  const estimatePhotoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<ResubmitFormData>({
    resolver: zodResolver(resubmitFormSchema),
    defaultValues: {
      serviceOrder: "",
      phone: "",
      applianceType: undefined,
      requestType: "authorization",
      warrantyType: "sears_protect",
      warrantyProvider: "",
      issueDescription: "",
      appealNotes: "",
    },
  });

  const { data, isLoading, error } = useQuery<{ submission: Submission }>({
    queryKey: ["/api/submissions", originalId],
    enabled: !!originalId,
  });

  const historyQuery = useQuery<{
    history: Submission[];
    reviewerNames: Record<number, string>;
    technicianName: string;
    resubmissionCount: number;
    maxResubmissions: number;
  }>({
    queryKey: ["/api/submissions", originalId, "history"],
    enabled: !!originalId,
  });

  if (data?.submission && !initialized) {
    const sub = data.submission;
    form.reset({
      serviceOrder: sub.serviceOrder,
      phone: sub.phone,
      applianceType: sub.applianceType as any,
      requestType: sub.requestType as any,
      warrantyType: sub.warrantyType as any,
      warrantyProvider: sub.warrantyProvider || "",
      issueDescription: sub.issueDescription,
      appealNotes: "",
    });
    let rejMedia: any = null;
    try { rejMedia = sub.rejectedMedia ? JSON.parse(sub.rejectedMedia) : null; } catch {}
    const rejectedPhotoUrls = new Set((rejMedia?.photos || []).map((p: any) => p.url));
    const isVideoRejected = rejMedia?.video?.rejected === true;

    try {
      const parsed = sub.photos ? JSON.parse(sub.photos) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        if (parsed.issue) setIssuePhotoUrls(parsed.issue.filter((url: string) => !rejectedPhotoUrls.has(url)));
        if (parsed.estimate) setEstimatePhotoUrls(parsed.estimate.filter((url: string) => !rejectedPhotoUrls.has(url)));
      } else if (Array.isArray(parsed)) {
        setIssuePhotoUrls(parsed.filter((url: string) => !rejectedPhotoUrls.has(url)));
      }
    } catch {}
    // Tyler 2026-04-30: parse multi-video JSON or legacy single-URL.
    // `parseVideoUrls` returns [] for empty, [single] for legacy, or the
    // array for new multi-video rows. When the agent rejected the video
    // category, drop everything (existing behavior preserved).
    if (sub.videoUrl && !isVideoRejected) {
      setVideoUrls(parseVideoUrls(sub.videoUrl).slice(0, MAX_VIDEOS_PER_TICKET));
    }
    if ((sub as any).partNumbers) {
      try {
        const parsed = JSON.parse((sub as any).partNumbers);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setPartNumbers(parsed);
        }
      } catch {}
    }
    setInitialized(true);
  }

  async function uploadSingleFile(file: File): Promise<string | null> {
    const token = getToken();
    try {
      const urlRes = await fetch("/api/uploads/request-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { uploadURL, objectPath } = await urlRes.json();
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.addEventListener("load", () => {
          resolve(xhr.status >= 200 && xhr.status < 300 ? objectPath : null);
        });
        xhr.addEventListener("error", () => resolve(null));
        xhr.open("PUT", uploadURL);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.send(file);
      });
    } catch {
      return null;
    }
  }

  async function handlePhotosSelect(
    files: FileList | null,
    currentUrls: string[],
    setUrls: React.Dispatch<React.SetStateAction<string[]>>,
    setUploading: React.Dispatch<React.SetStateAction<boolean>>,
    maxPhotos: number,
    inputRef: React.RefObject<HTMLInputElement | null>,
  ) {
    if (!files || files.length === 0) return;
    const validFiles = Array.from(files).filter((f) => f.size <= 20 * 1024 * 1024 && f.type.startsWith("image/"));
    if (validFiles.length === 0) {
      toast({ title: "Invalid Files", description: "Please select image files under 20MB each.", variant: "destructive" });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const totalAllowed = maxPhotos - currentUrls.length;
    const filesToUpload = validFiles.slice(0, totalAllowed);
    setUploading(true);
    const newUrls: string[] = [];
    for (const file of filesToUpload) {
      const url = await uploadSingleFile(file);
      if (url) newUrls.push(url);
    }
    setUrls((prev) => [...prev, ...newUrls]);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
  }

  // Tyler 2026-04-30: aligned with initial submission limits — was 100MB
  // with no duration check, now 50MB and 30 sec each, max 3 videos. The
  // duration check uses a hidden <video> element to read metadata before
  // any upload begins, identical to the pattern in tech-submit.tsx.
  async function handleVideoUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const file = files[0];
    setVideoError(null);

    if (videoUrls.length >= MAX_VIDEOS_PER_TICKET) {
      setVideoError(`Maximum ${MAX_VIDEOS_PER_TICKET} videos allowed per ticket`);
      toast({ title: "Video Limit", description: `Maximum ${MAX_VIDEOS_PER_TICKET} videos allowed.`, variant: "destructive" });
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }
    // Tyler 2026-04-30: align with tech-submit — accept MIME-detected
    // video files OR known video extensions, since some mobile captures
    // (certain Samsung browsers, third-party file pickers) ship empty
    // file.type values for valid clips.
    const lname = file.name.toLowerCase();
    const isVideo =
      file.type.startsWith("video/") ||
      /\.(mp4|mov|m4v|webm|mkv|avi|3gp|3gpp|wmv|flv|ts|mts)$/.test(lname);
    if (!isVideo) {
      setVideoError("Please select a video file");
      toast({ title: "Invalid File", description: "Please select a video file.", variant: "destructive" });
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      setVideoError("Video file exceeds 50MB limit");
      toast({ title: "File Too Large", description: "Video must be 50MB or less.", variant: "destructive" });
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }

    // Duration probe — same pattern as tech-submit.tsx. We let it through
    // if metadata fails to load (some browsers can't decode certain codecs
    // client-side even though the upload+convert path will handle them).
    const objectUrl = URL.createObjectURL(file);
    const duration = await new Promise<number | null>((resolve) => {
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.onloadedmetadata = () => resolve(probe.duration);
      probe.onerror = () => resolve(null);
      probe.src = objectUrl;
    });
    URL.revokeObjectURL(objectUrl);
    if (duration !== null && duration > 30) {
      setVideoError("Video must be 30 seconds or less");
      toast({ title: "Video Too Long", description: "Video must be 30 seconds or less.", variant: "destructive" });
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }

    setVideoUploading(true);
    const url = await uploadSingleFile(file);
    if (url) {
      const name = file.name.toLowerCase();
      const isMP4 = file.type === "video/mp4" || name.endsWith(".mp4");
      let finalUrl = url;
      if (!isMP4) {
        try {
          const res = await apiRequest("POST", "/api/uploads/convert-video", { objectPath: url });
          const data = await res.json();
          finalUrl = data.objectPath;
        } catch {
          // fall through with original url
        }
      }
      // Tyler 2026-04-30: append, don't replace.
      setVideoUrls((prev) => [...prev, finalUrl]);
      toast({ title: "Video Uploaded", description: "Video uploaded successfully." });
    } else {
      toast({ title: "Upload Failed", description: "Failed to upload video.", variant: "destructive" });
    }
    setVideoUploading(false);
    if (videoInputRef.current) videoInputRef.current.value = "";
  }

  function removeVideoAtIndex(index: number) {
    setVideoUrls((prev) => prev.filter((_, i) => i !== index));
    setVideoError(null);
    if (videoInputRef.current) videoInputRef.current.value = "";
  }

  const mutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/submissions", data);
      return await res.json();
    },
    onSuccess: (data: any) => {
      toast({ title: "Resubmission Sent", description: `SO# ${data.submission.serviceOrder} resubmitted successfully.` });
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      setLocation(`/tech/submissions/${data.submission.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Resubmission Failed", description: error.message, variant: "destructive" });
    },
  });

  function onSubmit(formData: ResubmitFormData) {
    const payload: any = { ...formData };
    delete payload.partNumbers;
    const phoneOverride = localStorage.getItem("vrs_phone_override");
    if (phoneOverride) payload.phoneOverride = phoneOverride;
    const photosObj: any = {};
    if (estimatePhotoUrls.length > 0) photosObj.estimate = estimatePhotoUrls;
    if (issuePhotoUrls.length > 0) photosObj.issue = issuePhotoUrls;
    if (Object.keys(photosObj).length > 0) payload.photos = JSON.stringify(photosObj);
    if (videoUrls.length > 0) payload.videoUrls = videoUrls;
    if (formData.appealNotes && formData.appealNotes.trim()) {
      payload.appealNotes = formData.appealNotes.trim();
    }
    if (formData.requestType === "parts_nla" && partNumbers.length > 0) {
      const filteredParts = partNumbers.filter(p => p.trim() !== "");
      if (filteredParts.length > 0) {
        payload.partNumbers = JSON.stringify(filteredParts);
      }
    }
    payload.resubmissionOf = originalId;
    mutation.mutate(payload);
  }

  if (isLoading) {
    return (
      <div className="min-h-screen pb-20">
        <div className="bg-primary text-primary-foreground p-4">
          <div className="max-w-lg mx-auto">
            <Skeleton className="h-6 w-48 bg-primary-foreground/20" />
          </div>
        </div>
        <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    );
  }

  if (error || !data?.submission) {
    return (
      <div className="min-h-screen pb-20">
        <div className="bg-primary text-primary-foreground p-4">
          <div className="max-w-lg mx-auto flex items-center gap-2">
            <Button size="icon" variant="ghost" className="text-primary-foreground" data-testid="button-back" onClick={() => setLocation("/tech/history")}>
              <ArrowLeft className="w-5 h-5" />
            </Button>
            <h1 className="text-lg font-bold">Submission Not Found</h1>
          </div>
        </div>
        <div className="max-w-lg mx-auto px-4 py-8 text-center">
          <p className="text-muted-foreground">The original submission could not be found.</p>
          <Button className="mt-4" data-testid="button-go-home" onClick={() => setLocation("/tech")}>Go Home</Button>
        </div>
      </div>
    );
  }

  const originalSub = data.submission;
  const resubCount = historyQuery.data?.resubmissionCount ?? 0;
  const maxResubs = historyQuery.data?.maxResubmissions ?? 3;
  const isMaxReached = resubCount >= maxResubs;
  const isRejectedClosed = originalSub.ticketStatus === "rejected_closed";

  return (
    <div className="min-h-screen pb-20">
      <div className="bg-primary text-primary-foreground p-4">
        <div className="max-w-lg mx-auto flex items-center gap-2">
          <Button size="icon" variant="ghost" className="text-primary-foreground" data-testid="button-back-resubmit" onClick={() => setLocation("/tech/history")}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-lg font-bold" data-testid="text-resubmit-title">Resubmit Request</h1>
            <p className="text-sm opacity-80">SO# {originalSub.serviceOrder}</p>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4 space-y-4">
        {isRejectedClosed && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-destructive" data-testid="text-rejected-closed">Service order permanently closed</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {shouldSuppressCashCall(originalSub.warrantyType, originalSub.rejectionReasons || originalSub.stage1RejectionReason || "")
                      ? "This repair has been determined to not be covered under warranty. No further submissions can be made for this service order."
                      : "This repair has been determined to not be covered under warranty. No further submissions can be made for this service order. You may offer the customer a cash call estimate for the repair."}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
        {isMaxReached && !isRejectedClosed && (
          <Card className="border-destructive bg-destructive/10">
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-destructive" data-testid="text-max-resubmissions">Maximum resubmissions reached</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    You have reached the maximum of {maxResubs} resubmissions for this service order. Please call VRS directly for assistance.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-destructive mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-destructive" data-testid="text-rejection-banner">This submission was rejected</p>
                {originalSub.stage1RejectionReason && (
                  <p className="text-sm text-muted-foreground mt-1" data-testid="text-rejection-reason">
                    Reason: {originalSub.stage1RejectionReason}
                  </p>
                )}
                {resubCount > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Resubmission {resubCount + 1} of {maxResubs}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {!isMaxReached && (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Service Order</p>
                  <div className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-muted-foreground" />
                    <Input
                      value={originalSub.serviceOrder}
                      disabled
                      className="font-mono bg-muted"
                      data-testid="input-service-order-locked"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">Service order cannot be changed on resubmission</p>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Appeal Notes</p>
                  <FormField
                    control={form.control}
                    name="appealNotes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Additional Information</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Explain what was corrected or provide additional context..."
                            rows={3}
                            className="resize-none"
                            {...field}
                            data-testid="input-appeal-notes"
                          />
                        </FormControl>
                        <div className="flex justify-between">
                          <FormMessage />
                          <span className="text-xs text-muted-foreground">{field.value?.length || 0}/2000</span>
                        </div>
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Technician Info</p>
                  <div>
                    <label className="text-sm font-medium">RAC ID</label>
                    <Input value={user?.racId || ""} disabled className="mt-1" data-testid="input-rac-id-resubmit" />
                  </div>
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone Number *</FormLabel>
                        <FormControl>
                          <Input placeholder="(555) 555-0147" {...field} data-testid="input-phone-resubmit" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Appliance Details</p>

                  <FormField
                    control={form.control}
                    name="applianceType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Appliance Type *</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-appliance-type-resubmit">
                              <SelectValue placeholder="Select appliance type" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {APPLIANCE_TYPES.map((type) => (
                              <SelectItem key={type.value} value={type.value}>
                                {type.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="requestType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Request Type</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-request-type-resubmit">
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="authorization">Authorization</SelectItem>
                            <SelectItem value="infestation_non_accessible">Infestation / Non-Accessible</SelectItem>
                            <SelectItem value="parts_nla">Parts — NLA</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Issue Description</p>
                  <FormField
                    control={form.control}
                    name="issueDescription"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description *</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Describe the issue in detail..."
                            rows={5}
                            className="resize-none"
                            {...field}
                            data-testid="input-description-resubmit"
                          />
                        </FormControl>
                        <div className="flex justify-between">
                          <FormMessage />
                          <span className="text-xs text-muted-foreground">{field.value?.length || 0}/2000</span>
                        </div>
                      </FormItem>
                    )}
                  />
                </CardContent>
              </Card>

              {form.watch("requestType") === "parts_nla" && (
                <Card>
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                        Part Number(s) <span className="text-destructive">*</span>
                      </p>
                      <HelpTooltip content="Enter each unavailable part number from TechHub. Add additional parts using the + button." />
                    </div>
                    <div className="space-y-2">
                      {partNumbers.map((pn, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Input
                            placeholder="Enter part number (e.g., WPW10321304)"
                            value={pn}
                            onChange={(e) => {
                              const updated = [...partNumbers];
                              updated[idx] = e.target.value.toUpperCase();
                              setPartNumbers(updated);
                            }}
                            data-testid={`input-part-number-resubmit-${idx}`}
                          />
                          {partNumbers.length > 1 && (
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                              onClick={() => setPartNumbers(partNumbers.filter((_, i) => i !== idx))}
                              data-testid={`button-remove-part-resubmit-${idx}`}
                            >
                              <X className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="flex items-center justify-between">
                      {partNumbers.length < 10 && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setPartNumbers([...partNumbers, ""])}
                          data-testid="button-add-part-number-resubmit"
                        >
                          <Plus className="w-3.5 h-3.5 mr-1.5" />
                          Add Another Part
                        </Button>
                      )}
                      <p className="text-xs text-muted-foreground ml-auto">{partNumbers.filter(p => p.trim() !== "").length}/10 parts</p>
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Issue Photos</p>
                  <div className="grid grid-cols-4 gap-2">
                    {issuePhotoUrls.map((url, i) => (
                      <div key={i} className="relative aspect-square bg-muted rounded-md overflow-hidden">
                        <img src={url} alt={`Issue ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-issue-resubmit-${i}`} />
                        <button
                          type="button"
                          className="absolute top-1 right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center"
                          onClick={() => setIssuePhotoUrls((prev) => prev.filter((_, idx) => idx !== i))}
                          data-testid={`button-remove-issue-photo-${i}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {issuePhotoUrls.length < 15 && (
                      <button
                        type="button"
                        className="aspect-square border-2 border-dashed rounded-md flex flex-col items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                        onClick={() => issuePhotoInputRef.current?.click()}
                        disabled={issuePhotoUploading}
                        data-testid="button-add-issue-photo-resubmit"
                      >
                        <Camera className="w-5 h-5" />
                        <span className="text-xs mt-1">{issuePhotoUploading ? "..." : "Add"}</span>
                      </button>
                    )}
                  </div>
                  <input
                    ref={issuePhotoInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => handlePhotosSelect(e.target.files, issuePhotoUrls, setIssuePhotoUrls, setIssuePhotoUploading, 15, issuePhotoInputRef)}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {form.watch("requestType") === "infestation_non_accessible"
                      ? "Model / Serial Tag Photo"
                      : "Model, Serial & Estimate Screenshots"}
                  </p>
                  <div className="grid grid-cols-4 gap-2">
                    {estimatePhotoUrls.map((url, i) => (
                      <div key={i} className="relative aspect-square bg-muted rounded-md overflow-hidden">
                        <img src={url} alt={`Estimate ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-estimate-resubmit-${i}`} />
                        <button
                          type="button"
                          className="absolute top-1 right-1 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center"
                          onClick={() => setEstimatePhotoUrls((prev) => prev.filter((_, idx) => idx !== i))}
                          data-testid={`button-remove-estimate-photo-${i}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    {estimatePhotoUrls.length < 5 && (
                      <button
                        type="button"
                        className="aspect-square border-2 border-dashed rounded-md flex flex-col items-center justify-center text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                        onClick={() => estimatePhotoInputRef.current?.click()}
                        disabled={estimatePhotoUploading}
                        data-testid="button-add-estimate-photo-resubmit"
                      >
                        <Camera className="w-5 h-5" />
                        <span className="text-xs mt-1">{estimatePhotoUploading ? "..." : "Add"}</span>
                      </button>
                    )}
                  </div>
                  <input
                    ref={estimatePhotoInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => handlePhotosSelect(e.target.files, estimatePhotoUrls, setEstimatePhotoUrls, setEstimatePhotoUploading, 5, estimatePhotoInputRef)}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <Video className="w-3.5 h-3.5" />
                      Video
                    </p>
                    <span className="text-xs text-muted-foreground" data-testid="text-video-count-resubmit">
                      {videoUrls.length}/{MAX_VIDEOS_PER_TICKET} videos
                    </span>
                  </div>
                  {videoUrls.length > 0 && (
                    <div className="space-y-3">
                      {videoUrls.map((url, idx) => (
                        <div className="relative rounded-md overflow-hidden bg-muted" key={`${url}-${idx}`} data-testid={`video-slot-resubmit-${idx}`}>
                          <video
                            src={url}
                            controls
                            className="w-full max-h-[200px]"
                            data-testid={`video-player-resubmit-${idx}`}
                          />
                          <button
                            type="button"
                            className="absolute top-2 right-2 w-6 h-6 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center"
                            onClick={() => removeVideoAtIndex(idx)}
                            data-testid={`button-remove-video-resubmit-${idx}`}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {videoError && (
                    <p className="text-sm text-destructive" data-testid="text-video-error-resubmit">{videoError}</p>
                  )}
                  {videoUrls.length < MAX_VIDEOS_PER_TICKET && (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => videoInputRef.current?.click()}
                      disabled={videoUploading}
                      data-testid="button-upload-video-resubmit"
                    >
                      <Upload className="w-4 h-4 mr-2" />
                      {videoUploading
                        ? "Uploading..."
                        : videoUrls.length === 0
                          ? "Upload Video"
                          : "Add Another Video"}
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">Max 50MB, 30 sec each. Up to {MAX_VIDEOS_PER_TICKET} videos.</p>
                  <input
                    ref={videoInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(e) => handleVideoUpload(e.target.files)}
                  />
                </CardContent>
              </Card>

              <Button
                type="submit"
                className="w-full"
                disabled={mutation.isPending || isRejectedClosed}
                data-testid="button-resubmit"
              >
                <Send className="w-4 h-4 mr-2" />
                {mutation.isPending ? "Resubmitting..." : isRejectedClosed ? "Service Order Closed" : "Resubmit to VRS"}
              </Button>
            </form>
          </Form>
        )}
      </div>
    </div>
  );
}
