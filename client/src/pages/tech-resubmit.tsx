import { APPLIANCE_CHOICES, applianceChoice, applianceKindSchema, applianceLabel } from "@shared/appliance-types";
import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation, Link } from "wouter";
import { apiRequest, apiRequestWithRetry, queryClient } from "@/lib/queryClient";
import { shouldSuppressCashCall } from "@/lib/smsPreview";
import { useAuth, getToken } from "@/lib/auth";
import { MediaImage, MediaVideo } from "@/components/media";
import { parseVideoUrls, MAX_VIDEOS_PER_TICKET } from "@/lib/videoUrls";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
import {
  EMPTY_TECH_APPLIANCE_DETAILS,
  TechApplianceDetailsFields,
  showTechApplianceDetails,
  techApplianceDetailsForPayload,
  techApplianceDetailsFormSchema,
  techApplianceDetailsFormValues,
  techApplianceDetailsResolver,
} from "@/pages/tech-submit";
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
import imageCompression from "browser-image-compression";
import { Camera, Send, X, AlertTriangle, ArrowLeft, Lock, Video, Upload, Info, Plus } from "lucide-react";
import HelpTooltip from "@/components/help-tooltip";
import type { Submission } from "@shared/schema";

const resubmitFormSchema = z.object({
  serviceOrder: z.string(),
  phone: z.string().min(7, "Valid phone number is required"),
  applianceType: z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"], {
    required_error: "Select an appliance type",
  }),
  applianceKind: applianceKindSchema.optional(),
  requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
  warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
  warrantyProvider: z.string().optional(),
  issueDescription: z.string().min(10, "Please provide at least 10 characters").max(2000, "Description must be 2000 characters or less"),
  appealNotes: z.string().max(2000, "Appeal notes must be 2000 characters or less").optional(),
  partNumbers: z.array(z.string()).optional(),
  // Appliance grade / color / part function, same rules as tech-submit.
  techApplianceDetails: techApplianceDetailsFormSchema,
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
  // Tyler 2026-07-08 — thumbnail map keyed by FULL photo path (same identity
  // rule as tech-submit). Hydrated from the original submission's map for
  // kept photos and extended with new uploads; the payload filter keeps only
  // entries whose full photo is actually attached at resubmit time.
  const [photoThumbs, setPhotoThumbs] = useState<Record<string, string>>({});
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
  // Tyler 2026-05-01: NLA parts come in two lists on initial submit —
  // `nla` (the parts that are no longer available) and `available` (parts
  // that ARE in TechHub but must stay on the order). Resubmit was only
  // hydrating/serializing an array, so the `available` list was silently
  // dropped on every resubmission. Mirror submit's two-list shape now.
  const [availableParts, setAvailableParts] = useState<string[]>([]);
  const issuePhotoInputRef = useRef<HTMLInputElement>(null);
  const estimatePhotoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  const { techApplianceDetailsEnabled } = useFeatureFlags();
  // Read at validation time, so the resolver always sees the current flag.
  const techApplianceDetailsEnabledRef = useRef(techApplianceDetailsEnabled);
  techApplianceDetailsEnabledRef.current = techApplianceDetailsEnabled;

  const form = useForm<ResubmitFormData>({
    resolver: techApplianceDetailsResolver(
      zodResolver(resubmitFormSchema),
      () => techApplianceDetailsEnabledRef.current,
    ),
    defaultValues: {
      serviceOrder: "",
      phone: "",
      applianceType: undefined,
      requestType: "authorization",
      warrantyType: "sears_protect",
      warrantyProvider: "",
      issueDescription: "",
      appealNotes: "",
      techApplianceDetails: { ...EMPTY_TECH_APPLIANCE_DETAILS },
    },
  });

  const watchedRequestType = form.watch("requestType");
  const watchedWarrantyType = form.watch("warrantyType");
  const techApplianceDetailsShown = showTechApplianceDetails(
    techApplianceDetailsEnabled,
    watchedWarrantyType,
    watchedRequestType,
  );
  const watchedApplianceType = form.watch("applianceType");
  useEffect(() => {
    if (watchedRequestType === "parts_nla" && watchedApplianceType === "hvac") {
      form.setValue("applianceType", undefined as any, { shouldValidate: false });
      form.setValue("applianceKind", undefined, { shouldValidate: false });
    }
  }, [watchedRequestType, watchedApplianceType, form]);

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
      applianceKind: applianceChoice(sub.applianceKind)?.division === sub.applianceType
        ? applianceChoice(sub.applianceKind)?.value : undefined,
      requestType: sub.requestType as any,
      warrantyType: sub.warrantyType as any,
      warrantyProvider: sub.warrantyProvider || "",
      issueDescription: sub.issueDescription,
      appealNotes: "",
      // Prefilled from the original ticket. The server returns the column as
      // a JSON string; junk, null or partial values leave those fields empty.
      techApplianceDetails: techApplianceDetailsFormValues(sub.techApplianceDetails),
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
    // Carry the original ticket's thumbnails forward so kept photos don't
    // lose their thumbs on resubmission. Best-effort parse; junk → empty.
    try {
      const rawThumbs = (sub as any).photoThumbnails ? JSON.parse((sub as any).photoThumbnails) : null;
      if (rawThumbs && typeof rawThumbs === "object" && !Array.isArray(rawThumbs)) {
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(rawThumbs)) {
          if (typeof k === "string" && typeof v === "string") clean[k] = v;
        }
        setPhotoThumbs(clean);
      }
    } catch {}
    // Tyler 2026-04-30: parse multi-video JSON or legacy single-URL.
    // `parseVideoUrls` returns [] for empty, [single] for legacy, or the
    // array for new multi-video rows. When the agent rejected the video
    // category, drop everything (existing behavior preserved).
    if (sub.videoUrl && !isVideoRejected) {
      setVideoUrls(parseVideoUrls(sub.videoUrl).slice(0, MAX_VIDEOS_PER_TICKET));
    }
    // Tyler 2026-05-01: hydrate every partNumbers shape we have ever
    // written into production. Architect F3 follow-up — explicitly
    // normalize each shape rather than silently dropping anything that
    // isn't `Array<string>` or `{nla, available}`. Order:
    //   1. Array<string>                     → legacy single-list NLA
    //   2. {nla: string[], available: string[]} → current submit shape
    //   3. Array<unknown>                    → coerce to strings, NLA list
    //   4. Single non-empty string           → one-element NLA list
    //      (covers a row written before JSON-encoding existed)
    //   5. Anything else / parse error       → leave defaults; the user
    //      will see an empty NLA input rather than corrupted state.
    // The normalizer NEVER throws; on any failure the catch falls
    // through and the form renders empty so the tech can re-enter.
    if ((sub as any).partNumbers) {
      const raw = (sub as any).partNumbers;
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // Not JSON — treat the literal string as a single part number.
          parsed = typeof raw === "string" && raw.trim() ? [raw.trim()] : null;
        }
        const toStrings = (xs: unknown): string[] =>
          Array.isArray(xs)
            ? xs.map((x) => (typeof x === "string" ? x : String(x ?? ""))).filter((s) => s.trim() !== "")
            : [];
        if (Array.isArray(parsed)) {
          const arr = toStrings(parsed);
          if (arr.length > 0) setPartNumbers(arr);
        } else if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const nla = toStrings(obj.nla);
          const available = toStrings(obj.available);
          if (nla.length > 0) setPartNumbers(nla);
          if (available.length > 0) setAvailableParts(available);
        } else if (typeof parsed === "string" && parsed.trim() !== "") {
          setPartNumbers([parsed.trim()]);
        }
      } catch {
        // Defensive — keep defaults rather than crashing the page.
      }
    }
    setInitialized(true);
  }

  async function uploadSingleFile(file: File): Promise<string | null> {
    const getUploadContentType = (input: File): string => {
      if (input.type && input.type.trim().length > 0) return input.type;
      const name = input.name.toLowerCase();
      if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
      if (name.endsWith(".png")) return "image/png";
      if (name.endsWith(".webp")) return "image/webp";
      if (name.endsWith(".heic")) return "image/heic";
      if (name.endsWith(".heif")) return "image/heif";
      if (name.endsWith(".mp4")) return "video/mp4";
      if (name.endsWith(".mov")) return "video/quicktime";
      if (name.endsWith(".m4a")) return "audio/mp4";
      if (name.endsWith(".mp3")) return "audio/mpeg";
      return "application/octet-stream";
    };
    const token = getToken();
    try {
      const urlRes = await fetch("/api/uploads/request-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name: file.name, size: file.size, contentType: getUploadContentType(file) }),
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
        xhr.setRequestHeader("Content-Type", getUploadContentType(file));
        xhr.send(file);
      });
    } catch {
      return null;
    }
  }

  // Tyler 2026-07-08 — same best-effort thumbnail generator as tech-submit:
  // ~480px / ~60 KB forced JPEG for fast agent-side grid paint. Any failure
  // returns null and the grid falls back to the full image.
  async function generateAndUploadThumb(file: File): Promise<string | null> {
    try {
      const thumbBlob = await imageCompression(file, {
        maxSizeMB: 0.06,
        maxWidthOrHeight: 480,
        useWebWorker: true,
        initialQuality: 0.7,
        fileType: "image/jpeg",
      });
      const baseName = file.name.replace(/\.[^.]+$/, "");
      const thumbFile = new File([thumbBlob], `thumb_${baseName}.jpg`, {
        type: "image/jpeg",
        lastModified: file.lastModified,
      });
      return await uploadSingleFile(thumbFile);
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
    let failedCount = 0;
    const maxConcurrent = 3;
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < filesToUpload.length) {
        const idx = cursor++;
        const url = await uploadSingleFile(filesToUpload[idx]);
        if (url) {
          newUrls.push(url);
          // Thumb rides in the same worker slot (respects the concurrency
          // cap); silent failure by design.
          const thumb = await generateAndUploadThumb(filesToUpload[idx]);
          if (thumb) setPhotoThumbs((prev) => ({ ...prev, [url]: thumb }));
        } else {
          failedCount += 1;
        }
      }
    };
    const workers = Array.from({ length: Math.min(maxConcurrent, filesToUpload.length) }, () => runNext());
    await Promise.all(workers);
    setUrls((prev) => [...prev, ...newUrls]);
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    if (failedCount > 0) {
      toast({
        title: "Some photos didn't upload",
        description: `${failedCount} photo(s) didn't upload — likely a weak connection. They are NOT attached. Tap to add them again before resubmitting.`,
        variant: "destructive",
      });
    }
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
      toast({ title: "Video didn't upload", description: "Your connection may have dropped — the video was NOT attached. Check your signal and add it again before resubmitting.", variant: "destructive" });
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
      // 2026-05-11 — same transient-edge-403 self-heal as tech-submit,
      // via shared apiRequestWithRetry helper. Server idempotency at
      // routes.ts:~590 makes retries safe (60s (tech, SO#) window
      // returns the existing row without extra SMS).
      const res = await apiRequestWithRetry(
        "POST",
        "/api/submissions",
        data,
        { logTag: "resubmit-retry" },
      );
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
    // Sent only when the section is shown (AHS / First American +
    // Authorization, flag on); otherwise the key is left out entirely.
    delete payload.techApplianceDetails;
    const techApplianceDetails = techApplianceDetailsForPayload(formData, techApplianceDetailsEnabled);
    if (techApplianceDetails) payload.techApplianceDetails = techApplianceDetails;
    const phoneOverride = localStorage.getItem("vrs_phone_override");
    if (phoneOverride) payload.phoneOverride = phoneOverride;
    const photosObj: any = {};
    if (estimatePhotoUrls.length > 0) photosObj.estimate = estimatePhotoUrls;
    if (issuePhotoUrls.length > 0) photosObj.issue = issuePhotoUrls;
    if (Object.keys(photosObj).length > 0) payload.photos = JSON.stringify(photosObj);
    // Thumb map filtered to photos actually attached to THIS resubmission —
    // removed/rejected photos' entries stay behind on the original ticket.
    const attachedUrls = new Set([...estimatePhotoUrls, ...issuePhotoUrls]);
    const thumbsForPayload: Record<string, string> = {};
    for (const [full, thumb] of Object.entries(photoThumbs)) {
      if (attachedUrls.has(full)) thumbsForPayload[full] = thumb;
    }
    if (Object.keys(thumbsForPayload).length > 0) payload.photoThumbnails = JSON.stringify(thumbsForPayload);
    if (videoUrls.length > 0) payload.videoUrls = videoUrls;
    if (formData.appealNotes && formData.appealNotes.trim()) {
      payload.appealNotes = formData.appealNotes.trim();
    }
    // Tyler 2026-05-01: serialize NLA parts in the same object shape that
    // tech-submit produces — `{ nla, available }`. Was sending an array
    // and silently dropping `available` parts on resubmission.
    if (formData.requestType === "parts_nla") {
      const nlaParts = partNumbers.filter(p => p.trim() !== "");
      const otherParts = availableParts.filter(p => p.trim() !== "");
      if (nlaParts.length > 0 || otherParts.length > 0) {
        payload.partNumbers = JSON.stringify({ nla: nlaParts, available: otherParts });
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
              <div className="flex-1 space-y-2">
                <p className="text-sm font-semibold text-destructive" data-testid="text-rejection-banner">This submission was rejected</p>
                {(() => {
                  const raw = (originalSub as any).rejectionReasons;
                  let reasons: string[] = [];
                  if (Array.isArray(raw)) {
                    reasons = raw.filter((r: unknown) => typeof r === "string");
                  } else if (typeof raw === "string" && raw.length > 0) {
                    try {
                      const parsed = JSON.parse(raw);
                      if (Array.isArray(parsed)) reasons = parsed.filter((r: unknown) => typeof r === "string");
                      else reasons = [raw];
                    } catch {
                      reasons = [raw];
                    }
                  }
                  if (reasons.length > 0) {
                    return (
                      <div data-testid="text-rejection-reason">
                        <p className="text-xs uppercase tracking-wider text-destructive/70">Reasons</p>
                        <ul className="text-sm text-muted-foreground list-disc list-inside space-y-0.5">
                          {reasons.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  }
                  if (originalSub.stage1RejectionReason) {
                    return (
                      <p className="text-sm text-muted-foreground" data-testid="text-rejection-reason">
                        Reason: {originalSub.stage1RejectionReason}
                      </p>
                    );
                  }
                  return null;
                })()}
                {(originalSub as any).technicianMessage && (
                  <div>
                    <p className="text-xs uppercase tracking-wider text-destructive/70">Message from VRS</p>
                    <p
                      className="text-sm text-muted-foreground whitespace-pre-wrap"
                      data-testid="text-rejection-technician-message"
                    >
                      {(originalSub as any).technicianMessage}
                    </p>
                  </div>
                )}
                {resubCount > 0 && (
                  <p className="text-xs text-muted-foreground">
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
                    name="applianceKind"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Appliance Type *</FormLabel>
                        <Select onValueChange={(value) => {
                          const choice = applianceChoice(value);
                          if (!choice) return;
                          field.onChange(value);
                          form.setValue("applianceType", choice.division, { shouldValidate: true });
                        }} value={field.value ?? ""}>
                          <FormControl>
                            <SelectTrigger data-testid="select-appliance-type-resubmit">
                              <SelectValue placeholder={watchedApplianceType
                                ? `${applianceLabel({ applianceType: watchedApplianceType })} (existing ticket)`
                                : "Select appliance type"} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {APPLIANCE_CHOICES.filter(
                              (type) => !(watchedRequestType === "parts_nla" && type.value === "hvac")
                            ).map((type) => (
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
                  {/* Appliance Grade / Color / Part Function: AHS and First
                      American authorization tickets only (flag
                      techApplianceDetailsEnabled). */}
                  {techApplianceDetailsShown && (
                    <TechApplianceDetailsFields control={form.control} testIdSuffix="-resubmit" />
                  )}
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
                <>
                  <Card>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          NLA Part Number(s) <span className="text-destructive">*</span>
                        </p>
                        <HelpTooltip content="Enter part numbers that are No Longer Available in TechHub. These are the parts VRS will research." />
                      </div>
                      <p className="text-sm text-muted-foreground">Parts showing unavailable / discontinued in TechHub</p>
                      <div className="space-y-2">
                        {partNumbers.map((pn, idx) => (
                          <div key={idx} className="flex items-center gap-2">
                            <Input
                              placeholder="Enter NLA part number (e.g., WPW10321304)"
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
                            Add NLA Part
                          </Button>
                        )}
                        <p className="text-xs text-muted-foreground ml-auto">{partNumbers.filter(p => p.trim() !== "").length}/10 parts</p>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Tyler 2026-05-01: Available parts card mirrors tech-submit
                      so resubmission preserves the `available` part list. */}
                  <Card>
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                          Other Required Parts (Available)
                        </p>
                        <HelpTooltip content="Enter part numbers that ARE available in TechHub but are also needed for this repair. These parts stay on the order if the NLA part is not found." />
                      </div>
                      <p className="text-sm text-muted-foreground">Parts showing available in TechHub that must remain on the order</p>
                      {availableParts.length > 0 && (
                        <div className="space-y-2">
                          {availableParts.map((pn, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <Input
                                placeholder="Enter available part number"
                                value={pn}
                                onChange={(e) => {
                                  const updated = [...availableParts];
                                  updated[idx] = e.target.value.toUpperCase();
                                  setAvailableParts(updated);
                                }}
                                data-testid={`input-available-part-resubmit-${idx}`}
                              />
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                                onClick={() => setAvailableParts(availableParts.filter((_, i) => i !== idx))}
                                data-testid={`button-remove-available-part-resubmit-${idx}`}
                              >
                                <X className="w-4 h-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        {availableParts.length < 10 && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setAvailableParts([...availableParts, ""])}
                            data-testid="button-add-available-part-resubmit"
                          >
                            <Plus className="w-3.5 h-3.5 mr-1.5" />
                            Add Available Part
                          </Button>
                        )}
                        {availableParts.length > 0 && (
                          <p className="text-xs text-muted-foreground ml-auto">{availableParts.filter(p => p.trim() !== "").length}/10 parts</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}

              <Card>
                <CardContent className="p-4 space-y-4">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Issue Photos</p>
                  <div className="grid grid-cols-4 gap-2">
                    {issuePhotoUrls.map((url, i) => (
                      <div key={i} className="relative aspect-square bg-muted rounded-md overflow-hidden">
                        <MediaImage src={photoThumbs[url] ?? url} alt={`Issue ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-issue-resubmit-${i}`} />
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
                        <MediaImage src={photoThumbs[url] ?? url} alt={`Estimate ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-estimate-resubmit-${i}`} />
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
                          <MediaVideo
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
