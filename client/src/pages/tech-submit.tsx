import { useState, useRef, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth, getToken } from "@/lib/auth";
import { MAX_VIDEOS_PER_TICKET } from "@/lib/videoUrls";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
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
import { Camera, Send, Lock, Video, X, Sparkles, Loader2, AlertTriangle, Square, Mic, MicOff, Trash2, Info, Plus, CheckCircle2 } from "lucide-react";
import HelpTooltip from "@/components/help-tooltip";
import {
  parseAndValidateDraft,
  stampDraftIdentity,
  type DraftEnvelope,
} from "@/lib/draft-identity";

const APPLIANCE_TYPES = [
  { value: "refrigeration", label: "Refrigerator" },
  { value: "laundry", label: "Laundry" },
  { value: "cooking", label: "Cooking" },
  { value: "dishwasher", label: "Dishwasher / Compactor" },
  { value: "microwave", label: "Microwave" },
  { value: "hvac", label: "HVAC" },
  { value: "all_other", label: "All Other" },
];

const WARRANTY_PROVIDERS = [
  { value: "sears_protect", label: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)", available: true },
  { value: "american_home_shield", label: "American Home Shield", available: true },
  { value: "first_american", label: "First American", available: true },
];

// Tyler 2026-04-29 (warranty × request-type matrix): which warranty providers
// are routable through VRS for each request type. Authorization is open to
// all three; Infestation / No Model Tag / Non-Accessible is AHS + First
// American only (Sears Protect family is handled through TechHub directly
// for those scenarios); Parts NLA is the inverse — only the Sears Protect
// family routes through VRS, AHS + FA NLA cases go through TechHub. Drives
// the gray-out behavior on the warranty cards plus the onSubmit gate. UI
// enforcement only — server-side validation deliberately omitted to match
// the existing parts_nla precedent (additive 5-line z.refine in routes.ts
// if Tyler later wants hard server enforcement).
type WarrantyValue = "sears_protect" | "american_home_shield" | "first_american";
type RequestTypeValue = "authorization" | "infestation_non_accessible" | "parts_nla";
const REQUEST_TYPE_WARRANTY_MATRIX: Record<RequestTypeValue, WarrantyValue[]> = {
  authorization: ["sears_protect", "american_home_shield", "first_american"],
  infestation_non_accessible: ["american_home_shield", "first_american"],
  parts_nla: ["sears_protect"],
};

const submissionFormSchema = z.object({
  serviceOrder: z.string().regex(/^\d{4}-\d{8}$/, "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)"),
  phone: z.string().min(7, "Valid phone number is required"),
  applianceType: z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"], {
    required_error: "Select an appliance type",
  }),
  requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
  warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
  warrantyProvider: z.string().optional(),
  issueDescription: z.string().min(10, "Please provide at least 10 characters").max(2000, "Description must be 2000 characters or less"),
  partNumbers: z.array(z.string()).optional(),
});

type SubmissionFormData = z.infer<typeof submissionFormSchema>;

export default function TechSubmitPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  // Tyler 2026-04-30: multi-video. Up to 3 videos per ticket, each 30 sec
  // and 50 MB max. Uploads are sequential — only one is in-flight at a
  // time, so the existing scalar progress/uploading/converting state still
  // works (just gates the next "Add video" tap until the current one
  // completes). The committed URLs accumulate in `videoUrls`.
  const [videoUrls, setVideoUrls] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const estimatePhotoInputRef = useRef<HTMLInputElement>(null);
  const issuePhotoInputRef = useRef<HTMLInputElement>(null);
  const soNumberRef = useRef<HTMLInputElement>(null);
  const [estimatePhotoUrls, setEstimatePhotoUrls] = useState<string[]>([]);
  const [issuePhotoUrls, setIssuePhotoUrls] = useState<string[]>([]);
  const [estimatePhotoLocalPreviews, setEstimatePhotoLocalPreviews] = useState<Record<string, string>>({});
  const [issuePhotoLocalPreviews, setIssuePhotoLocalPreviews] = useState<Record<string, string>>({});
  const [estimatePhotoUploading, setEstimatePhotoUploading] = useState(false);
  const [issuePhotoUploading, setIssuePhotoUploading] = useState(false);
  const [estimatePhotoUploadCount, setEstimatePhotoUploadCount] = useState({ done: 0, total: 0 });
  const [issuePhotoUploadCount, setIssuePhotoUploadCount] = useState({ done: 0, total: 0 });
  const [aiPreview, setAiPreview] = useState<string | null>(null);
  const [originalBeforeAi, setOriginalBeforeAi] = useState<string | null>(null);
  const [aiUsed, setAiUsed] = useState(false);
  const [aiEdited, setAiEdited] = useState(false);
  const [voiceNoteUrl, setVoiceNoteUrl] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [audioUploading, setAudioUploading] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const audioFileInputRef = useRef<HTMLInputElement>(null);
  const [partNumbers, setPartNumbers] = useState<string[]>([""]);
  const [availableParts, setAvailableParts] = useState<string[]>([]);

  type FailedUpload = {
    id: string;
    file: File;
    category: "estimate" | "issue";
    lastError: string;
    attemptsUsed: number;
  };
  const [failedUploads, setFailedUploads] = useState<FailedUpload[]>([]);
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  function reportUploadError(details: Record<string, unknown>) {
    try {
      const token = getToken();
      fetch("/api/uploads/report-error", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          ...details,
          userAgent: navigator.userAgent,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {});
    } catch {}
  }

  async function uploadSinglePhoto(file: File, retries = 2): Promise<string | null> {
    const token = getToken();
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const urlRes = await fetch("/api/uploads/request-url", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            name: file.name,
            size: file.size,
            contentType: file.type,
          }),
        });
        if (!urlRes.ok) {
          reportUploadError({ stage: "request-url", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: "HTTP " + urlRes.status, attempt });
          throw new Error("Failed to get upload URL");
        }
        const { uploadURL, objectPath } = await urlRes.json();

        const result = await new Promise<string | null>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.timeout = 120000;
          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(objectPath);
            } else {
              reportUploadError({ stage: "xhr-upload", fileName: file.name, fileSize: file.size, fileType: file.type, xhrStatus: xhr.status, attempt });
              resolve(null);
            }
          });
          xhr.addEventListener("error", () => {
            reportUploadError({ stage: "xhr-error", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: "network error", attempt });
            resolve(null);
          });
          xhr.addEventListener("timeout", () => {
            reportUploadError({ stage: "xhr-timeout", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: "timeout after 120s", attempt });
            resolve(null);
          });
          xhr.open("PUT", uploadURL);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });
        if (result) return result;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      } catch (error) {
        reportUploadError({ stage: "unknown", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: String(error), attempt });
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    return null;
  }

  async function handlePhotosSelect(
    files: FileList | null,
    currentUrls: string[],
    setUrls: React.Dispatch<React.SetStateAction<string[]>>,
    setUploading: React.Dispatch<React.SetStateAction<boolean>>,
    setCount: React.Dispatch<React.SetStateAction<{ done: number; total: number }>>,
    maxPhotos: number,
    inputRef: React.RefObject<HTMLInputElement | null>,
    setLocalPreviews?: React.Dispatch<React.SetStateAction<Record<string, string>>>,
  ) {
    if (!files || files.length === 0) return;
    const validFiles = Array.from(files).filter((f) => f.size <= 20 * 1024 * 1024 && (f.type.startsWith("image/") || f.type === ""));
    if (validFiles.length === 0) {
      const fileDetails = Array.from(files).map(f => ({ name: f.name, size: f.size, type: f.type }));
      reportUploadError({ stage: "file-filter", errorMessage: "All files filtered out", files: fileDetails });
      toast({ title: "Invalid Files", description: "Please select image files under 20MB each.", variant: "destructive" });
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const totalAllowed = maxPhotos - currentUrls.length;
    const filesToUpload = validFiles.slice(0, totalAllowed);
    if (filesToUpload.length < validFiles.length) {
      toast({ title: "Photo Limit", description: `Maximum ${maxPhotos} photos allowed. Only uploading ${filesToUpload.length} more.` });
    }
    setUploading(true);
    setCount({ done: 0, total: filesToUpload.length });
    const newUrls: string[] = [];
    const newPreviews: Record<string, string> = {};
    const newFailures: FailedUpload[] = [];
    const categoryForList: "estimate" | "issue" = setUrls === setEstimatePhotoUrls ? "estimate" : "issue";
    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i];
      const localBlob = URL.createObjectURL(file);
      const url = await uploadSinglePhoto(file);
      if (url) {
        newUrls.push(url);
        newPreviews[url] = localBlob;
      } else {
        URL.revokeObjectURL(localBlob);
        newFailures.push({
          id: crypto.randomUUID(),
          file,
          category: categoryForList,
          lastError: "Upload failed after retries",
          attemptsUsed: 3,
        });
      }
      setCount({ done: i + 1, total: filesToUpload.length });
    }
    setUrls((prev) => [...prev, ...newUrls]);
    if (setLocalPreviews) {
      setLocalPreviews((prev) => ({ ...prev, ...newPreviews }));
    }
    if (newFailures.length > 0) {
      setFailedUploads((prev) => [...prev, ...newFailures]);
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = "";
    if (newFailures.length > 0) {
      toast({
        title: "Some photos failed",
        description: `${newFailures.length} photo(s) failed. Scroll down to retry.`,
        variant: "destructive",
      });
    }
  }

  async function retryFailedUpload(failedId: string) {
    const failed = failedUploads.find((f) => f.id === failedId);
    if (!failed) return;
    setRetryingIds((prev) => new Set(prev).add(failedId));
    const url = await uploadSinglePhoto(failed.file);
    setRetryingIds((prev) => {
      const next = new Set(prev);
      next.delete(failedId);
      return next;
    });
    if (url) {
      const localBlob = URL.createObjectURL(failed.file);
      if (failed.category === "estimate") {
        setEstimatePhotoUrls((prev) => [...prev, url]);
        setEstimatePhotoLocalPreviews((prev) => ({ ...prev, [url]: localBlob }));
      } else {
        setIssuePhotoUrls((prev) => [...prev, url]);
        setIssuePhotoLocalPreviews((prev) => ({ ...prev, [url]: localBlob }));
      }
      setFailedUploads((prev) => prev.filter((f) => f.id !== failedId));
      toast({ title: "Retry succeeded", description: failed.file.name });
    } else {
      setFailedUploads((prev) =>
        prev.map((f) =>
          f.id === failedId
            ? { ...f, attemptsUsed: f.attemptsUsed + 3, lastError: "Retry failed" }
            : f
        )
      );
      toast({
        title: "Retry failed",
        description: `${failed.file.name} — check your connection.`,
        variant: "destructive",
      });
    }
  }

  function dismissFailedUpload(failedId: string) {
    setFailedUploads((prev) => prev.filter((f) => f.id !== failedId));
  }

  function isVideoFile(file: File): boolean {
    if (file.type.startsWith("video/")) return true;
    const name = file.name.toLowerCase();
    return /\.(mp4|mov|m4v|webm|mkv|avi|3gp|3gpp|wmv|flv|ts|mts)$/.test(name);
  }

  function handleVideoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setVideoError(null);

    // Tyler 2026-04-30: cap at MAX_VIDEOS_PER_TICKET (3). The "Add video"
    // CTA is also hidden once the cap is reached, but we double-check here
    // because the file input element can still be triggered programmatically.
    if (videoUrls.length >= MAX_VIDEOS_PER_TICKET) {
      setVideoError(`Maximum ${MAX_VIDEOS_PER_TICKET} videos allowed per ticket`);
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }

    if (!isVideoFile(file)) {
      setVideoError("Please select a video file");
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setVideoError("Video file exceeds 50MB limit");
      if (videoInputRef.current) videoInputRef.current.value = "";
      return;
    }

    const videoEl = document.createElement("video");
    videoEl.preload = "metadata";
    videoEl.onloadedmetadata = () => {
      URL.revokeObjectURL(videoEl.src);
      if (videoEl.duration > 30) {
        setVideoError("Video must be 30 seconds or less");
        if (videoInputRef.current) videoInputRef.current.value = "";
        return;
      }
      uploadVideo(file);
    };
    videoEl.onerror = () => {
      URL.revokeObjectURL(videoEl.src);
      uploadVideo(file);
    };
    videoEl.src = URL.createObjectURL(file);
  }

  async function convertVideo(objectPath: string): Promise<string> {
    setIsConverting(true);
    try {
      const res = await apiRequest("POST", "/api/uploads/convert-video", { objectPath });
      const data = await res.json();
      if (data.converted === false) {
        toast({ title: "Video Format Notice", description: "Video could not be converted to MP4. It may not play on all devices.", variant: "destructive" });
      }
      return data.objectPath;
    } catch {
      toast({ title: "Video Format Notice", description: "Video conversion failed. The original file will be used.", variant: "destructive" });
      return objectPath;
    } finally {
      setIsConverting(false);
    }
  }

  function needsConversion(file: File): boolean {
    if (file.type === "video/mp4") return false;
    const name = file.name.toLowerCase();
    if (name.endsWith(".mp4")) return false;
    return true;
  }

  async function uploadVideo(file: File) {
    const token = getToken();
    setIsUploading(true);
    setUploadProgress(0);

    try {
      setUploadProgress(10);
      const urlRes = await fetch("/api/uploads/request-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type,
        }),
      });

      if (!urlRes.ok) {
        throw new Error("Failed to get upload URL");
      }

      const { uploadURL, objectPath } = await urlRes.json();

      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          setUploadProgress(10 + Math.round((e.loaded / e.total) * 90));
        }
      });

      xhr.addEventListener("load", async () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          if (needsConversion(file)) {
            setIsUploading(false);
            const convertedPath = await convertVideo(objectPath);
            // Tyler 2026-04-30: append, don't replace. Each upload adds
            // to the array; the per-slot remove button handles deletion.
            setVideoUrls((prev) => [...prev, convertedPath]);
          } else {
            setIsUploading(false);
            setVideoUrls((prev) => [...prev, objectPath]);
          }
          if (videoInputRef.current) videoInputRef.current.value = "";
        } else {
          setIsUploading(false);
          toast({ title: "Upload Failed", description: "Failed to upload video to storage", variant: "destructive" });
        }
      });

      xhr.addEventListener("error", () => {
        setIsUploading(false);
        toast({ title: "Upload Failed", description: "Network error during upload", variant: "destructive" });
      });

      xhr.open("PUT", uploadURL);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.send(file);
    } catch (err) {
      setIsUploading(false);
      toast({ title: "Upload Failed", description: "Failed to initiate upload", variant: "destructive" });
    }
  }

  function removeVideo(index: number) {
    setVideoUrls((prev) => prev.filter((_, i) => i !== index));
    setUploadProgress(0);
    setVideoError(null);
    if (videoInputRef.current) videoInputRef.current.value = "";
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4' });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      setRecordingDuration(0);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        if (recordingIntervalRef.current) {
          clearInterval(recordingIntervalRef.current);
          recordingIntervalRef.current = null;
        }
        const blob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        const ext = mediaRecorder.mimeType.includes('webm') ? 'webm' : 'm4a';
        const file = new File([blob], `voice-note.${ext}`, { type: mediaRecorder.mimeType });
        await uploadAudioFile(file);
      };

      mediaRecorder.start(1000);
      setIsRecording(true);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingDuration(prev => {
          if (prev >= 120) {
            stopRecording();
            return prev;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      toast({ title: "Microphone Access", description: "Please allow microphone access to record a voice note.", variant: "destructive" });
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  function audioNeedsConversion(file: File): boolean {
    const name = file.name.toLowerCase();
    const webFriendly = ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/webm", "audio/ogg", "audio/flac", "audio/x-flac"];
    if (webFriendly.some(t => file.type === t)) return false;
    if (/\.(mp3|m4a|aac|wav|webm|ogg|mp4|flac)$/.test(name)) return false;
    return true;
  }

  async function convertAudio(objectPath: string): Promise<string> {
    try {
      const res = await apiRequest("POST", "/api/uploads/convert-audio", { objectPath });
      const data = await res.json();
      if (data.converted === false) {
        toast({ title: "Audio Format Notice", description: "Audio could not be converted. It may not play on all devices.", variant: "destructive" });
      }
      return data.objectPath;
    } catch {
      return objectPath;
    }
  }

  async function uploadAudioFile(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: "File Too Large", description: "Audio file must be under 10MB.", variant: "destructive" });
      return;
    }
    setAudioUploading(true);
    const url = await uploadSinglePhoto(file);
    if (url) {
      if (audioNeedsConversion(file)) {
        const converted = await convertAudio(url);
        setVoiceNoteUrl(converted);
      } else {
        setVoiceNoteUrl(url);
      }
    } else {
      toast({ title: "Upload Failed", description: "Failed to upload audio file.", variant: "destructive" });
    }
    setAudioUploading(false);
  }

  function isAudioFile(file: File): boolean {
    if (file.type.startsWith("audio/")) return true;
    const name = file.name.toLowerCase();
    return /\.(mp3|m4a|aac|wav|webm|ogg|wma|amr|3gp|caf|flac|opus)$/.test(name);
  }

  function handleAudioFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!isAudioFile(file)) {
      toast({ title: "Invalid File", description: "Please select an audio file.", variant: "destructive" });
      if (audioFileInputRef.current) audioFileInputRef.current.value = "";
      return;
    }
    uploadAudioFile(file);
    if (audioFileInputRef.current) audioFileInputRef.current.value = "";
  }

  function removeVoiceNote() {
    setVoiceNoteUrl(null);
    setRecordingDuration(0);
  }

  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const form = useForm<SubmissionFormData>({
    resolver: zodResolver(submissionFormSchema),
    defaultValues: {
      serviceOrder: "",
      phone: user?.phone || "",
      applianceType: undefined,
      requestType: "authorization",
      warrantyType: "sears_protect",
      warrantyProvider: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)",
      issueDescription: "",
    },
  });

  const watchedServiceOrder = form.watch("serviceOrder");
  const isValidSo = /^\d{4}-\d{8}$/.test(watchedServiceOrder || "");
  const warrantyLookup = useQuery<{
    serviceOrder: string;
    procId: string;
    clientNm: string;
    derived: { warrantyType: "sears_protect" | "american_home_shield" | "first_american"; warrantyProvider: string; source: "client_nm" | "proc_id" } | null;
  }>({
    queryKey: ["/api/tech/lookup-warranty", watchedServiceOrder],
    enabled: isValidSo,
    staleTime: 5 * 60 * 1000,
  });
  const derivedWarranty = warrantyLookup.data?.derived || null;

  useEffect(() => {
    if (derivedWarranty) {
      if (form.getValues("warrantyType") !== derivedWarranty.warrantyType) {
        form.setValue("warrantyType", derivedWarranty.warrantyType, { shouldDirty: false });
      }
      if (form.getValues("warrantyProvider") !== derivedWarranty.warrantyProvider) {
        form.setValue("warrantyProvider", derivedWarranty.warrantyProvider, { shouldDirty: false });
      }
    }
  }, [derivedWarranty?.warrantyType, derivedWarranty?.warrantyProvider]);

  // Tyler 2026-04-29 (warranty × request-type matrix): when the tech changes
  // request type, snap the warranty selection to the first allowed value if
  // the current selection becomes incompatible — but ONLY when the warranty
  // isn't locked by SO auto-detection. If it IS locked and the locked value
  // is incompatible, the conflict is surfaced as an inline error under the
  // warranty section and onSubmit blocks. This avoids stomping the
  // server-derived truth.
  const watchedRequestTypeForMatrix = form.watch("requestType");
  const watchedWarrantyForMatrix = form.watch("warrantyType");
  useEffect(() => {
    if (derivedWarranty) return;
    const allowed = REQUEST_TYPE_WARRANTY_MATRIX[watchedRequestTypeForMatrix as RequestTypeValue] ?? [];
    if (allowed.length === 0) return;
    if (!allowed.includes(watchedWarrantyForMatrix as WarrantyValue)) {
      const firstAllowed = allowed[0];
      const provider = WARRANTY_PROVIDERS.find(p => p.value === firstAllowed);
      form.setValue("warrantyType", firstAllowed as any, { shouldDirty: false });
      if (provider) {
        form.setValue("warrantyProvider", provider.label, { shouldDirty: false });
      }
    }
  }, [watchedRequestTypeForMatrix, derivedWarranty?.warrantyType]);

  const mutation = useMutation({
    mutationFn: async (data: SubmissionFormData & { originalDescription?: string; aiEnhanced?: boolean }) => {
      const res = await apiRequest("POST", "/api/submissions", data);
      return await res.json();
    },
    onSuccess: (data) => {
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      toast({ title: "Submission Created", description: `Service Order #${data.submission.serviceOrder} submitted successfully.` });
      setLocation(`/tech/submissions/${data.submission.id}`);
    },
    onError: (error: Error) => {
      toast({ title: "Submission Failed", description: error.message, variant: "destructive" });
    },
  });

  const aiEnhanceMutation = useMutation({
    mutationFn: async (data: { description: string; applianceType: string }) => {
      const res = await apiRequest("POST", "/api/ai/enhance-description", data);
      return await res.json();
    },
    onSuccess: (data: { enhanced: string; original: string }) => {
      setAiPreview(data.enhanced);
      setOriginalBeforeAi(data.original);
    },
    onError: (error: Error) => {
      toast({ title: "AI Enhancement Unavailable", description: error.message, variant: "destructive" });
    },
  });

  const [reviewOpen, setReviewOpen] = useState(false);
  const [pendingPayload, setPendingPayload] = useState<any>(null);
  const [pendingData, setPendingData] = useState<SubmissionFormData | null>(null);

  function onSubmit(data: SubmissionFormData) {
    // Tyler 2026-04-29 (warranty × request-type matrix): hard gate. The UI
    // grays out incompatible warranty cards, but if the SO auto-detected a
    // warranty that doesn't match the chosen request type — or any state
    // change slipped through — block submission with a clear toast pointing
    // the tech at the fix.
    const allowedWarranties = REQUEST_TYPE_WARRANTY_MATRIX[data.requestType as RequestTypeValue] ?? [];
    if (allowedWarranties.length > 0 && !allowedWarranties.includes(data.warrantyType as WarrantyValue)) {
      const requestLabel = formatRequestTypeLabel(data.requestType);
      toast({
        title: "Warranty / Request Type Mismatch",
        description: `${requestLabel} is not available for the current warranty provider. Switch the request type or handle this case through TechHub directly.`,
        variant: "destructive",
      });
      return;
    }
    if (data.requestType === "parts_nla") {
      const nlaParts = partNumbers.filter(p => p.trim() !== "");
      const otherParts = availableParts.filter(p => p.trim() !== "");
      if (nlaParts.length === 0 && otherParts.length === 0) {
        toast({ title: "Part Numbers Required", description: "At least one NLA or available part number is required.", variant: "destructive" });
        return;
      }
    }
    const payload: any = { ...data };
    delete payload.partNumbers;
    if (aiUsed && originalBeforeAi) {
      payload.originalDescription = originalBeforeAi;
      payload.aiEnhanced = true;
    }
    // Tyler 2026-04-30: send the array under `videoUrls` (server prefers
    // it over the legacy single-string `videoUrl` field).
    if (videoUrls.length > 0) payload.videoUrls = videoUrls;
    if (voiceNoteUrl) payload.voiceNoteUrl = voiceNoteUrl;
    const phoneOverride = localStorage.getItem("vrs_phone_override");
    if (phoneOverride) payload.phoneOverride = phoneOverride;
    const photosObj: any = {};
    if (estimatePhotoUrls.length > 0) photosObj.estimate = estimatePhotoUrls;
    if (issuePhotoUrls.length > 0) photosObj.issue = issuePhotoUrls;
    if (Object.keys(photosObj).length > 0) payload.photos = JSON.stringify(photosObj);
    if (data.requestType === "parts_nla") {
      const nlaParts = partNumbers.filter(p => p.trim() !== "");
      const otherParts = availableParts.filter(p => p.trim() !== "");
      if (nlaParts.length > 0 || otherParts.length > 0) {
        payload.partNumbers = JSON.stringify({ nla: nlaParts, available: otherParts });
      }
    }
    setPendingPayload(payload);
    setPendingData(data);
    setReviewOpen(true);
  }

  function confirmAndSubmit() {
    if (!pendingPayload || mutation.isPending) return;
    setReviewOpen(false);
    mutation.mutate(pendingPayload as any);
  }

  function getReviewWarnings(data: SubmissionFormData | null): string[] {
    if (!data) return [];
    const warnings: string[] = [];
    const desc = (data.issueDescription || "").trim();
    if (desc.length < 50) {
      warnings.push("Description is short (under 50 characters). Agents process requests faster with a clear diagnosis.");
    }
    if (data.requestType !== "infestation_non_accessible" && estimatePhotoUrls.length < 2) {
      warnings.push("Only one model/serial & estimate image uploaded. Agents usually need BOTH the model/serial tag photo AND the TechHub estimate screenshot — double-check before you submit.");
    }
    if (data.requestType !== "infestation_non_accessible" && issuePhotoUrls.length < 2) {
      warnings.push("Only one issue photo uploaded. Multiple angles help the agent approve faster.");
    }
    if (data.requestType === "parts_nla") {
      const nlaParts = partNumbers.filter(p => p.trim() !== "");
      if (nlaParts.length === 0) {
        warnings.push("No NLA part numbers entered. Make sure the NLA parts section has the numbers TechHub flagged.");
      }
    }
    return warnings;
  }

  function formatApplianceLabel(value: string | undefined): string {
    return APPLIANCE_TYPES.find(a => a.value === value)?.label || value || "—";
  }

  function formatRequestTypeLabel(value: string | undefined): string {
    if (value === "authorization") return "Authorization";
    if (value === "infestation_non_accessible") return "Infestation / Non-Accessible";
    if (value === "parts_nla") return "Parts — No Longer Available (NLA)";
    return value || "—";
  }

  function formatWarrantyLabel(value: string | undefined): string {
    return WARRANTY_PROVIDERS.find(w => w.value === value)?.label || value || "—";
  }

  const watchedRequestType = form.watch("requestType");
  const watchedValues = form.watch();
  const descriptionLength = watchedValues.issueDescription?.length || 0;
  const aiButtonDisabled = descriptionLength < 20 || aiEnhanceMutation.isPending;

  const DRAFT_KEY = `vrs_tech_submit_draft_v1_${user?.id ?? "anon"}`;
  const [draftRestored, setDraftRestored] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  // Tier 1 hotfix (2026-04-28): a draft that passes identity validation
  // is held here pending the user's explicit Resume / Start-fresh choice
  // in the AlertDialog below. We no longer auto-hydrate.
  const [pendingDraft, setPendingDraft] = useState<DraftEnvelope | null>(null);
  const draftHydratedRef = useRef(false);
  // Gates the autosave effect: must remain false until either the load
  // path determined "no draft / discarded / mismatched" OR the user has
  // explicitly resolved a pending draft via the dialog. This prevents an
  // accidental in-flight form change from persisting before the user has
  // decided what to do with the prior draft.
  const draftDecisionMadeRef = useRef(false);

  function applyDraftToForm(draft: DraftEnvelope) {
    if (draft.formValues && typeof draft.formValues === "object") {
      form.reset({ ...form.getValues(), ...(draft.formValues as Record<string, unknown>) });
    }
    if (Array.isArray(draft.estimatePhotoUrls)) setEstimatePhotoUrls(draft.estimatePhotoUrls as string[]);
    if (Array.isArray(draft.issuePhotoUrls)) setIssuePhotoUrls(draft.issuePhotoUrls as string[]);
    // Tyler 2026-04-30: hydrate multi-video. Prefer the new `videoUrls`
    // array; fall back to legacy `videoUrl` string for drafts saved before
    // this change rolled out (auto-promotes single → [single]).
    if (Array.isArray((draft as any).videoUrls)) {
      const arr = ((draft as any).videoUrls as unknown[]).filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      setVideoUrls(arr.slice(0, MAX_VIDEOS_PER_TICKET));
    } else if (typeof draft.videoUrl === "string" && draft.videoUrl) {
      setVideoUrls([draft.videoUrl]);
    }
    if (typeof draft.voiceNoteUrl === "string") setVoiceNoteUrl(draft.voiceNoteUrl);
    if (Array.isArray(draft.partNumbers) && (draft.partNumbers as unknown[]).length) {
      setPartNumbers(draft.partNumbers as string[]);
    }
    if (Array.isArray(draft.availableParts) && (draft.availableParts as unknown[]).length) {
      setAvailableParts(draft.availableParts as string[]);
    }
    if (typeof draft.aiUsed === "boolean") setAiUsed(draft.aiUsed);
    if (typeof draft.originalBeforeAi === "string") setOriginalBeforeAi(draft.originalBeforeAi);
    if (typeof draft.aiEdited === "boolean") setAiEdited(draft.aiEdited);
    setDraftRestored(true);
    setDraftSavedAt((draft.savedAt as string) || null);
  }

  function resumePendingDraft() {
    if (!pendingDraft) return;
    applyDraftToForm(pendingDraft);
    setPendingDraft(null);
    draftDecisionMadeRef.current = true;
    toast({
      title: "Draft restored",
      description: "We brought back your in-progress submission so you don't have to start over.",
    });
  }

  function startFreshFromPrompt() {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    setPendingDraft(null);
    draftDecisionMadeRef.current = true;
    toast({
      title: "Starting fresh",
      description: "Your previous draft was discarded.",
    });
  }

  useEffect(() => {
    if (!user?.id || draftHydratedRef.current) return;
    draftHydratedRef.current = true;
    const currentLdap = (user as any).ldapId ?? user.racId ?? null;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(DRAFT_KEY);
    } catch {
      draftDecisionMadeRef.current = true;
      return;
    }
    const result = parseAndValidateDraft(raw, { id: user.id, ldapId: currentLdap });
    if (!result.ok) {
      // Anything other than a clean identity match is treated as not-mine:
      // missing identity (legacy draft from before this hotfix), id mismatch
      // (cross-user inheritance), ldap mismatch, parse error, or simply no
      // draft. In every non-`no_draft` case we evict the localStorage key so
      // it can never contaminate a future session.
      if (result.reason !== "no_draft") {
        // eslint-disable-next-line no-console
        console.warn(`[draft] discarded — ${result.reason}`, {
          currentUserId: user.id,
          currentLdap,
        });
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
      }
      draftDecisionMadeRef.current = true;
      return;
    }
    // Valid match — gate hydration behind the user's explicit choice.
    setPendingDraft(result.draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || !draftHydratedRef.current || !draftDecisionMadeRef.current) return;
    const handle = setTimeout(() => {
      const formValues = form.getValues();
      const hasContent = Boolean(
        formValues.serviceOrder?.trim() ||
        formValues.applianceType ||
        (formValues.issueDescription && formValues.issueDescription.trim().length > 0) ||
        estimatePhotoUrls.length ||
        issuePhotoUrls.length ||
        videoUrls.length > 0 ||
        voiceNoteUrl ||
        partNumbers.some(p => p.trim()) ||
        availableParts.some(p => p.trim())
      );
      if (!hasContent) {
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        return;
      }
      const currentLdap = (user as any).ldapId ?? user.racId ?? null;
      const draft = stampDraftIdentity({
        formValues,
        estimatePhotoUrls,
        issuePhotoUrls,
        // Tyler 2026-04-30: drafts now persist the full array. The legacy
        // `videoUrl` field stays out of the saved envelope (parser tolerates
        // its absence). Old drafts already on disk still hydrate correctly
        // via the `videoUrl` fallback in `applyDraftToForm`.
        videoUrls,
        voiceNoteUrl,
        partNumbers,
        availableParts,
        aiUsed,
        originalBeforeAi,
        aiEdited,
        savedAt: new Date().toISOString(),
      } as any, { id: user.id, ldapId: currentLdap });
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        setDraftSavedAt(draft.savedAt);
      } catch {}
    }, 600);
    return () => clearTimeout(handle);
  }, [
    user?.id,
    watchedValues,
    estimatePhotoUrls,
    issuePhotoUrls,
    videoUrls,
    voiceNoteUrl,
    partNumbers,
    availableParts,
    aiUsed,
    originalBeforeAi,
    aiEdited,
    DRAFT_KEY,
  ]);

  function discardDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
    form.reset({
      serviceOrder: "",
      phone: user?.phone || "",
      applianceType: undefined as any,
      requestType: "authorization",
      warrantyType: "sears_protect",
      warrantyProvider: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)",
      issueDescription: "",
    });
    setEstimatePhotoUrls([]);
    setIssuePhotoUrls([]);
    setEstimatePhotoLocalPreviews({});
    setIssuePhotoLocalPreviews({});
    setVideoUrls([]);
    setVoiceNoteUrl(null);
    setPartNumbers([""]);
    setAvailableParts([]);
    setAiUsed(false);
    setAiEdited(false);
    setAiPreview(null);
    setOriginalBeforeAi(null);
    setDraftRestored(false);
    setDraftSavedAt(null);
    setFailedUploads([]);
    setRetryingIds(new Set());
    toast({ title: "Draft discarded", description: "Starting fresh." });
  }

  function formatDraftSavedAt(iso: string | null): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch { return ""; }
  }

  return (
    <div className="min-h-screen pb-20">
      {/* Tier 1 hotfix (2026-04-28): blocking Resume / Start-fresh dialog
          replaces the prior auto-hydrate-then-show-banner pattern. Tech
          must affirmatively choose so a stale or unexpected draft cannot
          silently pre-populate the form. */}
      <AlertDialog open={!!pendingDraft}>
        <AlertDialogContent data-testid="dialog-draft-resume">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-draft-prompt-title">
              Resume your in-progress draft?
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="text-draft-prompt-detail">
              We saved your last submission as a draft
              {pendingDraft?.savedAt
                ? ` on ${formatDraftSavedAt(pendingDraft.savedAt as string)}`
                : ""}.
              Continue where you left off, or start a fresh ticket?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={startFreshFromPrompt}
              data-testid="button-draft-prompt-fresh"
            >
              Start fresh
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={resumePendingDraft}
              data-testid="button-draft-prompt-resume"
            >
              Resume draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <div className="bg-primary text-primary-foreground p-4">
        <div className="max-w-lg mx-auto">
          <h1 className="text-lg font-bold" data-testid="text-submit-title">VRS Submission</h1>
          <p className="text-sm opacity-80">New Authorization Request</p>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-4">
        {draftRestored && (
          <div
            className="mb-4 rounded-md border border-primary/30 bg-primary/5 p-3 flex items-start justify-between gap-3"
            data-testid="banner-draft-restored"
          >
            <div className="text-sm">
              <div className="font-medium" data-testid="text-draft-restored-title">Draft restored</div>
              <div className="text-muted-foreground" data-testid="text-draft-restored-detail">
                Picked up where you left off{draftSavedAt ? ` (saved ${formatDraftSavedAt(draftSavedAt)})` : ""}.
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={discardDraft}
              data-testid="button-discard-draft"
            >
              Start fresh
            </Button>
          </div>
        )}
        {!draftRestored && draftSavedAt && (
          <div
            className="mb-3 text-xs text-muted-foreground"
            data-testid="text-draft-autosaved"
          >
            Draft auto-saved {formatDraftSavedAt(draftSavedAt)}
          </div>
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <FormField
              control={form.control}
              name="requestType"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center gap-1.5">
                    <FormLabel>Request Type</FormLabel>
                    <HelpTooltip content="Select the type of request for this service order" />
                  </div>
                  <div className="space-y-2">
                    {[
                      { value: "authorization", label: "Authorization", desc: "Request approval for repairs or non-repairable determination" },
                      // Tyler 2026-04-29: renamed from "Infestation / Non-Accessible" to
                      // include the "no model tag" case, with explicit "(FA & AHS Only)"
                      // suffix so techs see at-a-glance that this option does not apply
                      // to Sears Protect / Sears PA / Sears Home Warranty (Cinch) calls.
                      // The wrong-warranty enforcement is the destructive banner below
                      // (mirrors the parts_nla pattern at line ~1028 — UI-side gate;
                      // request-type enum value `infestation_non_accessible` unchanged
                      // so historical rows + downstream Smartsheet routing still match).
                      { value: "infestation_non_accessible", label: "Infestation / No Model Tag or Infestation / Non-Accessible (FA & AHS Only)", desc: "Unable to service due to infestation, missing model tag, or access limitations. American Home Shield and First American calls only." },
                      { value: "parts_nla", label: "Parts — No Longer Available (NLA)", desc: "Part is unavailable in TechHub. Submit for VRS parts team research. Sears Protect, Sears PA, and Sears Home Warranty (Cinch) calls only." },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`w-full text-left p-3 rounded-md border transition-colors ${
                          field.value === opt.value
                            ? "border-primary bg-primary/5"
                            : "hover-elevate"
                        }`}
                        onClick={() => field.onChange(opt.value)}
                        data-testid={`tab-${opt.value.replace(/_/g, "-")}`}
                      >
                        <p className="text-sm font-medium">{opt.label}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                      </button>
                    ))}
                  </div>
                </FormItem>
              )}
            />

            {watchedRequestType === "parts_nla" && (
              <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-950 dark:border-blue-800 p-3" data-testid="nla-info-banner">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-blue-800 dark:text-blue-200">NLA Submissions Only</p>
                    <p className="text-sm text-blue-700 dark:text-blue-300 mt-0.5">
                      Submit this form ONLY when TechHub shows a part as "No Longer Available" for a Sears Protect (SPHW), Sears PA (MPA), or Sears Home Warranty (Cinch) service call. All other calls should be handled through TechHub directly.
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Tyler 2026-04-29 (warranty × request-type matrix): the previous
                pair of destructive wrong-warranty banners (banner-nla-wrong-
                warranty + banner-infestation-wrong-warranty) was removed in
                favor of graying out the incompatible warranty cards directly
                in the warranty section below. Visual consistency: the tech
                sees the disallowed providers grayed with a "Handled in
                TechHub" badge, instead of choosing them and getting a red
                banner after. */}

            <Card>
              <CardContent className="p-4 space-y-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Technician Info</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-sm font-medium">RAC ID</label>
                    <Input
                      value={user?.racId || ""}
                      disabled
                      className="mt-1"
                      data-testid="input-rac-id"
                    />
                  </div>
                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Phone Number *</FormLabel>
                        <FormControl>
                          <Input placeholder="" {...field} data-testid="input-phone" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Appliance Details</p>
                <FormField
                  control={form.control}
                  name="serviceOrder"
                  render={({ field }) => {
                    const parts = (field.value || "").split("-");
                    const district = parts[0] || "";
                    const soNumber = parts[1] || "";
                    return (
                      <FormItem>
                        <FormLabel>Service Order *</FormLabel>
                        <div className="flex items-center gap-2">
                          <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">District</p>
                            <Input
                              placeholder=""
                              value={district}
                              inputMode="numeric"
                              maxLength={4}
                              className="w-20 text-center"
                              data-testid="input-district"
                            onChange={(e) => {
                              const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                              field.onChange(val + "-" + soNumber);
                              if (val.length === 4) {
                                soNumberRef.current?.focus();
                              }
                            }}
                          />
                          </div>
                          <span className="text-lg font-medium text-muted-foreground mt-5">-</span>
                          <div className="space-y-1 flex-1">
                            <p className="text-xs text-muted-foreground">Service Order #</p>
                            <Input
                              ref={soNumberRef}
                              placeholder=""
                              value={soNumber}
                              inputMode="numeric"
                              maxLength={8}
                              data-testid="input-service-order"
                              onChange={(e) => {
                                const val = e.target.value.replace(/\D/g, "").slice(0, 8);
                                field.onChange(district + "-" + val);
                              }}
                            />
                          </div>
                        </div>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
                <FormField
                  control={form.control}
                  name="applianceType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Appliance Type *</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-appliance-type">
                            <SelectValue placeholder="Select appliance type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {APPLIANCE_TYPES.map((type) => (
                            <SelectItem key={type.value} value={type.value} data-testid={`option-${type.value}`}>
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Tyler 2026-04-29 (warranty × request-type matrix): the
                    `watchedRequestType !== "parts_nla"` gate that previously
                    hid this whole section for NLA submissions has been
                    removed. The warranty section now ALWAYS renders — for
                    Parts NLA the AHS + First American cards gray out
                    (handled-in-TechHub) and Sears Protect is the only
                    selectable option. Same gray-out logic also restricts
                    Sears Protect under Infestation / No Model Tag /
                    Non-Accessible. */}
                <div>
                  <div className="flex items-center gap-1.5">
                    <label className="text-sm font-medium">Warranty Provider</label>
                    <HelpTooltip content="The warranty provider is auto-detected from the service order's customer record. When auto-detected, the selection is locked. If detection cannot identify the provider, you can select it manually. Some providers may be unavailable depending on the request type." />
                  </div>
                  {derivedWarranty ? (
                    <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1" data-testid="text-warranty-locked-note">
                      <Lock className="w-3 h-3" />
                      Auto-detected from service order — locked.
                    </p>
                  ) : warrantyLookup.isFetching ? (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="text-warranty-lookup-loading">
                      Looking up warranty provider from service order…
                    </p>
                  ) : isValidSo ? (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="text-warranty-autodetect-note">
                      Could not auto-detect — please select the warranty provider.
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground" data-testid="text-warranty-autodetect-note">
                      Will be auto-detected from the service order once entered.
                    </p>
                  )}
                  {/* Tyler 2026-04-29: surface a conflict when the SO-derived
                      warranty isn't valid for the selected request type.
                      onSubmit blocks the same way; this is the inline
                      explanation of why submission is blocked. */}
                  {derivedWarranty && (() => {
                    const allowed = REQUEST_TYPE_WARRANTY_MATRIX[watchedRequestType as RequestTypeValue] ?? [];
                    return allowed.length > 0 && !allowed.includes(derivedWarranty.warrantyType as WarrantyValue);
                  })() && (
                    <div
                      className="mt-2 rounded-md border border-destructive bg-destructive/10 p-2.5"
                      data-testid="text-warranty-request-conflict"
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                        <p className="text-xs text-destructive">
                          This service order's warranty doesn't match the selected request type. Switch the request type, or handle this case through TechHub directly.
                        </p>
                      </div>
                    </div>
                  )}
                  <div className="mt-2 space-y-2">
                    {WARRANTY_PROVIDERS.map((provider) => {
                      const allowedForRequest = (REQUEST_TYPE_WARRANTY_MATRIX[watchedRequestType as RequestTypeValue] ?? []).includes(provider.value as WarrantyValue);
                      const isSelected = form.watch("warrantyType") === provider.value;
                      const isLocked = !!derivedWarranty;
                      const isClickable = provider.available && allowedForRequest && !isLocked;
                      return (
                        <div
                          key={provider.value}
                          className={`flex items-center justify-between gap-2 p-3 rounded-md border ${
                            isClickable
                              ? "cursor-pointer hover-elevate"
                              : "cursor-not-allowed"
                          } ${
                            isLocked && !isSelected ? "opacity-50" : ""
                          } ${
                            !allowedForRequest ? "opacity-50" : ""
                          } ${
                            !provider.available ? "opacity-60" : ""
                          } ${
                            isSelected ? "border-primary bg-primary/5" : ""
                          }`}
                          onClick={() => {
                            if (isClickable) {
                              form.setValue("warrantyType", provider.value as any);
                              form.setValue("warrantyProvider", provider.label);
                            }
                          }}
                          data-testid={`provider-${provider.value}`}
                          aria-disabled={!isClickable}
                          title={!allowedForRequest ? "Not available for this request type — handled through TechHub directly" : undefined}
                        >
                          <span className="text-sm">{provider.label}</span>
                          <div className="flex items-center gap-1">
                            {isLocked && isSelected && (
                              <Badge variant="secondary" className="text-xs" data-testid={`badge-locked-${provider.value}`}>
                                <Lock className="w-3 h-3 mr-1" />
                                Auto-detected
                              </Badge>
                            )}
                            {!allowedForRequest && (
                              <Badge variant="secondary" className="text-xs" data-testid={`badge-techhub-${provider.value}`}>
                                Handled in TechHub
                              </Badge>
                            )}
                            {!provider.available && (
                              <Badge variant="secondary" className="text-xs" data-testid={`badge-coming-soon-${provider.value}`}>
                                <Lock className="w-3 h-3 mr-1" />
                                Coming Soon
                              </Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Issue Details</p>
                <FormField
                  control={form.control}
                  name="issueDescription"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{watchedRequestType === "parts_nla" ? "Issue Description: Why are the parts needed? *" : "Issue Description *"}</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder={watchedRequestType === "parts_nla" ? "Explain why the part is needed and what failed on the unit..." : watchedRequestType === "authorization" ? "Describe the issue and required repair. For non-repairable units, explain why the unit cannot be repaired." : "Describe the issue..."}
                          className="min-h-[100px]"
                          maxLength={2000}
                          {...field}
                          onChange={(e) => {
                            field.onChange(e);
                            if (aiUsed) setAiEdited(true);
                          }}
                          data-testid="input-issue-description"
                          disabled={aiEnhanceMutation.isPending}
                        />
                      </FormControl>
                      {aiUsed && (
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Sparkles className="w-3 h-3" />
                          {aiEdited ? "AI-enhanced (edited)" : "AI-enhanced"}
                        </p>
                      )}
                      <p className={`text-xs ${descriptionLength >= 20 ? "text-green-600" : "text-muted-foreground"}`} data-testid="text-char-count">
                        {descriptionLength}/20 minimum {descriptionLength >= 20 ? "✓" : ""}
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={aiButtonDisabled}
                          onClick={() => {
                            const desc = form.getValues("issueDescription");
                            const appliance = form.getValues("applianceType") || "appliance";
                            if (!desc || desc.length < 20) return;
                            const seen = localStorage.getItem("ai_tooltip_seen");
                            if (!seen) {
                              localStorage.setItem("ai_tooltip_seen", "true");
                              toast({
                                title: "Experimental Feature",
                                description: "This AI tool helps clarify your description without changing the meaning. Always review the result before submitting.",
                              });
                            }
                            aiEnhanceMutation.mutate({
                              description: desc,
                              applianceType: appliance,
                            });
                          }}
                          data-testid="button-ai-enhance"
                        >
                          {aiEnhanceMutation.isPending ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                              Improving...
                            </>
                          ) : (
                            <>
                              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                              Improve with AI
                            </>
                          )}
                        </Button>
                        <Badge variant="secondary" className="text-xs">Experimental</Badge>
                      </div>
                      {aiPreview && (
                        <div className="mt-3 space-y-2">
                          <p className="text-xs font-medium text-muted-foreground">AI-Improved Version (review and edit as needed)</p>
                          <div className="p-3 rounded-md border bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800 text-sm whitespace-pre-wrap" data-testid="text-ai-preview">
                            {aiPreview}
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                field.onChange(aiPreview);
                                setAiUsed(true);
                                setAiEdited(false);
                                setAiPreview(null);
                              }}
                              data-testid="button-ai-use"
                            >
                              Use This
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setAiPreview(null);
                                setOriginalBeforeAi(null);
                              }}
                              data-testid="button-ai-keep-original"
                            >
                              Keep Original
                            </Button>
                          </div>
                        </div>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />

              </CardContent>
            </Card>

            {watchedRequestType === "parts_nla" && (
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
                            data-testid={`input-part-number-${idx}`}
                          />
                          {partNumbers.length > 1 && (
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                              onClick={() => setPartNumbers(partNumbers.filter((_, i) => i !== idx))}
                              data-testid={`button-remove-part-${idx}`}
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
                          data-testid="button-add-part-number"
                        >
                          <Plus className="w-3.5 h-3.5 mr-1.5" />
                          Add NLA Part
                        </Button>
                      )}
                      <p className="text-xs text-muted-foreground ml-auto">{partNumbers.filter(p => p.trim() !== "").length}/10 parts</p>
                    </div>
                    {partNumbers.every(p => p.trim() === "") && availableParts.every(p => p.trim() === "") && (
                      <p className="text-sm text-destructive" data-testid="text-part-number-error">At least one part number is required</p>
                    )}
                  </CardContent>
                </Card>

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
                              data-testid={`input-available-part-${idx}`}
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-destructive hover:text-destructive shrink-0"
                              onClick={() => setAvailableParts(availableParts.filter((_, i) => i !== idx))}
                              data-testid={`button-remove-available-part-${idx}`}
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
                          data-testid="button-add-available-part"
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
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Issue Photos <span className="text-destructive">*</span>
                  </p>
                  <HelpTooltip content={
                    watchedRequestType === "infestation_non_accessible"
                      ? "You must upload clear photos documenting the infestation or unsafe conditions. These are required for claim review."
                      : "Photos showing the issue, diagnosis, defective parts, error codes, damage."
                  } />
                </div>
                <p className="text-sm text-muted-foreground">Photos showing the issue, diagnosis, defective parts, error codes, damage</p>
                {watchedRequestType === "infestation_non_accessible" && (
                  <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2" data-testid="infestation-photo-requirements">
                    <p className="text-sm font-medium text-destructive">Photo evidence is required. Document the following:</p>
                    <ul className="text-sm text-muted-foreground space-y-1.5 list-none">
                      <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" /><span>Roaches, insects, or pest activity</span></li>
                      <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" /><span>Mouse or rodent droppings</span></li>
                      <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" /><span>Mold, biohazard, or unsanitary conditions</span></li>
                      <li className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" /><span>Blocked or unsafe access to the appliance</span></li>
                    </ul>
                  </div>
                )}
                <input
                  ref={issuePhotoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  capture={undefined}
                  className="hidden"
                  onChange={(e) => handlePhotosSelect(e.target.files, issuePhotoUrls, setIssuePhotoUrls, setIssuePhotoUploading, setIssuePhotoUploadCount, 15, issuePhotoInputRef, setIssuePhotoLocalPreviews)}
                  data-testid="input-issue-photo-file"
                />
                {issuePhotoUrls.length > 0 && (
                  <div className="grid grid-cols-3 gap-2" data-testid="issue-photo-previews">
                    {issuePhotoUrls.map((url, i) => (
                      <div key={i} className="relative aspect-square bg-muted rounded-md overflow-visible">
                        <img
                          src={issuePhotoLocalPreviews[url] || url}
                          alt={`Issue ${i + 1}`}
                          className="w-full h-full object-cover rounded-md"
                          data-testid={`img-issue-preview-${i}`}
                          onError={(e) => { const t = e.currentTarget; if (t.src !== url) { t.src = url; } else { t.style.display = "none"; t.parentElement!.classList.add("flex", "items-center", "justify-center"); const s = document.createElement("span"); s.className = "text-xs text-muted-foreground"; s.textContent = `Photo ${i + 1}`; t.parentElement!.appendChild(s); } }}
                        />
                        <Button type="button" size="icon" variant="destructive" className="absolute -top-2 -right-2 h-6 w-6" onClick={() => { const blobUrl = issuePhotoLocalPreviews[url]; if (blobUrl) URL.revokeObjectURL(blobUrl); setIssuePhotoLocalPreviews((prev) => { const n = {...prev}; delete n[url]; return n; }); setIssuePhotoUrls((prev) => prev.filter((_, idx) => idx !== i)); }} data-testid={`button-remove-issue-${i}`}>
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {failedUploads.filter((f) => f.category === "issue").length > 0 && (
                  <div className="mt-3 space-y-2" data-testid="failed-uploads-issue">
                    {failedUploads
                      .filter((f) => f.category === "issue")
                      .map((f) => (
                        <div
                          key={f.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                          data-testid={`failed-upload-issue-${f.id}`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{f.file.name}</div>
                            <div className="text-xs text-muted-foreground">{f.lastError}</div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={retryingIds.has(f.id)}
                            onClick={() => retryFailedUpload(f.id)}
                            data-testid={`button-retry-issue-${f.id}`}
                          >
                            {retryingIds.has(f.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : "Retry"}
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={retryingIds.has(f.id)}
                            onClick={() => dismissFailedUpload(f.id)}
                            data-testid={`button-dismiss-issue-${f.id}`}
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                  </div>
                )}
                {issuePhotoUploading && (
                  <div className="flex items-center justify-center gap-2 py-3" data-testid="issue-photo-uploading">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Uploading {issuePhotoUploadCount.done}/{issuePhotoUploadCount.total} photos...</span>
                  </div>
                )}
                {issuePhotoUrls.length < 15 && !issuePhotoUploading && (
                  <div className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer hover-elevate" onClick={() => issuePhotoInputRef.current?.click()} data-testid="button-add-issue-photos">
                    <Camera className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{issuePhotoUrls.length === 0 ? "Tap to add issue photos" : "Tap to add more issue photos"}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{issuePhotoUrls.length}/15 photos</p>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-1.5">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {watchedRequestType === "infestation_non_accessible"
                      ? <>Model / Serial Tag Photo <span className="text-destructive">*</span></>
                      : <>Model, Serial &amp; Estimate Screenshots <span className="text-destructive">*</span></>
                    }
                  </p>
                  <HelpTooltip content={
                    watchedRequestType === "infestation_non_accessible"
                      ? "Take a clear photo of the model/serial number tag on the appliance."
                      : "Model/serial plate and TechHub estimate screenshots showing part numbers, costs, labor, tax, and total."
                  } />
                </div>
                <p className="text-sm text-muted-foreground">
                  {watchedRequestType === "infestation_non_accessible"
                    ? "Clear photo of the model/serial number tag on the appliance"
                    : "Model/serial plate and TechHub estimate screenshots"}
                </p>
                  <input
                    ref={estimatePhotoInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    capture={undefined}
                    className="hidden"
                    onChange={(e) => handlePhotosSelect(e.target.files, estimatePhotoUrls, setEstimatePhotoUrls, setEstimatePhotoUploading, setEstimatePhotoUploadCount, 5, estimatePhotoInputRef, setEstimatePhotoLocalPreviews)}
                    data-testid="input-estimate-photo-file"
                  />
                  {estimatePhotoUrls.length > 0 && (
                    <div className="grid grid-cols-3 gap-2" data-testid="estimate-photo-previews">
                      {estimatePhotoUrls.map((url, i) => (
                        <div key={i} className="relative aspect-square bg-muted rounded-md overflow-visible">
                          <img
                            src={estimatePhotoLocalPreviews[url] || url}
                            alt={`Estimate ${i + 1}`}
                            className="w-full h-full object-cover rounded-md"
                            data-testid={`img-estimate-preview-${i}`}
                            onError={(e) => { const t = e.currentTarget; if (t.src !== url) { t.src = url; } else { t.style.display = "none"; t.parentElement!.classList.add("flex", "items-center", "justify-center"); const s = document.createElement("span"); s.className = "text-xs text-muted-foreground"; s.textContent = `Estimate ${i + 1}`; t.parentElement!.appendChild(s); } }}
                          />
                          <Button type="button" size="icon" variant="destructive" className="absolute -top-2 -right-2 h-6 w-6" onClick={() => { const blobUrl = estimatePhotoLocalPreviews[url]; if (blobUrl) URL.revokeObjectURL(blobUrl); setEstimatePhotoLocalPreviews((prev) => { const n = {...prev}; delete n[url]; return n; }); setEstimatePhotoUrls((prev) => prev.filter((_, idx) => idx !== i)); }} data-testid={`button-remove-estimate-${i}`}>
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {failedUploads.filter((f) => f.category === "estimate").length > 0 && (
                    <div className="mt-3 space-y-2" data-testid="failed-uploads-estimate">
                      {failedUploads
                        .filter((f) => f.category === "estimate")
                        .map((f) => (
                          <div
                            key={f.id}
                            className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                            data-testid={`failed-upload-estimate-${f.id}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{f.file.name}</div>
                              <div className="text-xs text-muted-foreground">{f.lastError}</div>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={retryingIds.has(f.id)}
                              onClick={() => retryFailedUpload(f.id)}
                              data-testid={`button-retry-estimate-${f.id}`}
                            >
                              {retryingIds.has(f.id) ? <Loader2 className="w-3 h-3 animate-spin" /> : "Retry"}
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              disabled={retryingIds.has(f.id)}
                              onClick={() => dismissFailedUpload(f.id)}
                              data-testid={`button-dismiss-estimate-${f.id}`}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          </div>
                        ))}
                    </div>
                  )}
                  {estimatePhotoUploading && (
                    <div className="flex items-center justify-center gap-2 py-3" data-testid="estimate-photo-uploading">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm text-muted-foreground">Uploading {estimatePhotoUploadCount.done}/{estimatePhotoUploadCount.total} photos...</span>
                    </div>
                  )}
                  {estimatePhotoUrls.length < 5 && !estimatePhotoUploading && (
                    <div className="border-2 border-dashed rounded-md p-6 text-center cursor-pointer hover-elevate" onClick={() => estimatePhotoInputRef.current?.click()} data-testid="button-add-estimate-photos">
                      <Camera className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">{estimatePhotoUrls.length === 0 ? "Tap to add photos" : "Tap to add more photos"}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{estimatePhotoUrls.length}/5 photos</p>
                    </div>
                  )}
                </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Video Upload</p>
                  <span className="text-xs text-muted-foreground" data-testid="text-video-count">
                    {videoUrls.length}/{MAX_VIDEOS_PER_TICKET} videos
                  </span>
                </div>
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={handleVideoSelect}
                  data-testid="input-video-file"
                />
                {videoUrls.length > 0 && (
                  <div className="space-y-3">
                    {videoUrls.map((url, idx) => (
                      <div className="relative" key={`${url}-${idx}`} data-testid={`video-slot-${idx}`}>
                        <video
                          src={url}
                          controls
                          className="w-full rounded-md"
                          data-testid={`video-preview-${idx}`}
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="destructive"
                          className="absolute top-2 right-2"
                          onClick={() => removeVideo(idx)}
                          data-testid={`button-remove-video-${idx}`}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {videoUrls.length < MAX_VIDEOS_PER_TICKET && !isUploading && !isConverting && (
                  <label
                    className="border-2 border-dashed rounded-md p-6 text-center block cursor-pointer"
                    data-testid="button-add-video"
                    onClick={() => videoInputRef.current?.click()}
                  >
                    <Video className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {videoUrls.length === 0 ? "Tap to add video" : "Tap to add another video"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">Max 50MB, 30 sec each. Up to {MAX_VIDEOS_PER_TICKET} videos.</p>
                  </label>
                )}
                {videoError && (
                  <p className="text-sm text-destructive" data-testid="text-video-error">{videoError}</p>
                )}
                {isUploading && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Progress value={uploadProgress} className="flex-1" data-testid="progress-video-upload" />
                      <span className="text-sm text-muted-foreground whitespace-nowrap">{uploadProgress}%</span>
                    </div>
                    <p className="text-xs text-muted-foreground text-center">Uploading video...</p>
                  </div>
                )}
                {isConverting && (
                  <div className="space-y-2" data-testid="video-converting">
                    <div className="flex items-center justify-center gap-2 py-3">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm text-muted-foreground">Converting video for playback...</span>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Voice Note</p>
                <input
                  ref={audioFileInputRef}
                  type="file"
                  accept="audio/*"
                  className="hidden"
                  onChange={handleAudioFileSelect}
                  data-testid="input-audio-file"
                />
                {!voiceNoteUrl && !isRecording && !audioUploading && (
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={startRecording}
                      data-testid="button-start-recording"
                    >
                      <Mic className="w-4 h-4 mr-2" />
                      Record
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="flex-1"
                      onClick={() => audioFileInputRef.current?.click()}
                      data-testid="button-upload-audio"
                    >
                      <Send className="w-4 h-4 mr-2" />
                      Upload File
                    </Button>
                  </div>
                )}
                {isRecording && (
                  <div className="flex items-center gap-3 p-3 rounded-md border border-destructive/30 bg-destructive/5" data-testid="recording-active">
                    <div className="w-3 h-3 rounded-full bg-destructive animate-pulse" />
                    <span className="text-sm font-medium flex-1">Recording... {formatDuration(recordingDuration)}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={stopRecording}
                      data-testid="button-stop-recording"
                    >
                      <MicOff className="w-4 h-4 mr-1" />
                      Stop
                    </Button>
                  </div>
                )}
                {audioUploading && (
                  <div className="flex items-center justify-center gap-2 py-3" data-testid="audio-uploading">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-sm text-muted-foreground">Uploading audio...</span>
                  </div>
                )}
                {voiceNoteUrl && !audioUploading && (
                  <div className="space-y-2" data-testid="voice-note-preview">
                    <audio src={voiceNoteUrl} controls className="w-full" data-testid="audio-player-preview" />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={removeVoiceNote}
                      data-testid="button-remove-voice-note"
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                      Remove Voice Note
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Record up to 2 minutes or upload an audio file (max 10MB)</p>
              </CardContent>
            </Card>

            {issuePhotoUrls.length === 0 && !issuePhotoUploading && (
              <p className="text-sm text-destructive" data-testid="text-issue-photo-error">
                Please upload at least one issue photo
              </p>
            )}
            {estimatePhotoUrls.length === 0 && !estimatePhotoUploading && (
              <p className="text-sm text-destructive" data-testid="text-estimate-photo-error">
                {watchedRequestType === "infestation_non_accessible"
                  ? "Please upload a model/serial tag photo"
                  : "Please upload at least one model/serial & estimate screenshot"}
              </p>
            )}

            <Button
              type="submit"
              className="w-full"
              size="lg"
              disabled={mutation.isPending || estimatePhotoUploading || issuePhotoUploading || isUploading || isConverting || audioUploading || issuePhotoUrls.length === 0 || estimatePhotoUrls.length === 0 || (watchedRequestType === "parts_nla" && partNumbers.every(p => p.trim() === "") && availableParts.every(p => p.trim() === ""))}
              data-testid="button-submit-form"
            >
              <Send className="w-4 h-4 mr-2" />
              {mutation.isPending ? "Submitting..." : estimatePhotoUploading || issuePhotoUploading ? "Uploading Photos..." : isUploading ? "Uploading Video..." : isConverting ? "Converting Video..." : audioUploading ? "Uploading Audio..." : watchedRequestType === "parts_nla" ? "Submit NLA Request" : "Submit for Review"}
            </Button>
          </form>
        </Form>

        <AlertDialog open={reviewOpen} onOpenChange={setReviewOpen}>
          <AlertDialogContent className="max-w-lg" data-testid="dialog-submit-review">
            <AlertDialogHeader>
              <AlertDialogTitle>Review before you submit</AlertDialogTitle>
              <AlertDialogDescription>
                Once you confirm, this goes to a VRS agent. Double-check the details — especially photos and part numbers.
              </AlertDialogDescription>
            </AlertDialogHeader>

            {pendingData && (
              <div
                className="space-y-3 max-h-[55vh] overflow-y-auto pr-1"
                data-testid="section-submit-review-body"
                tabIndex={0}
                role="region"
                aria-label="Submission summary"
              >
                <div className="rounded-md border p-3 text-sm space-y-1.5">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Service Order</span>
                    <span className="font-medium text-right" data-testid="review-so">{pendingData.serviceOrder}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Phone</span>
                    <span className="font-medium text-right" data-testid="review-phone">{pendingData.phone}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Appliance</span>
                    <span className="font-medium text-right" data-testid="review-appliance">{formatApplianceLabel(pendingData.applianceType)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Warranty</span>
                    <span className="font-medium text-right" data-testid="review-warranty">{formatWarrantyLabel(pendingData.warrantyType)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Request Type</span>
                    <span className="font-medium text-right" data-testid="review-request-type">{formatRequestTypeLabel(pendingData.requestType)}</span>
                  </div>
                </div>

                <div className="rounded-md border p-3 text-sm">
                  <p className="text-muted-foreground mb-1">Description</p>
                  <p className="whitespace-pre-wrap" data-testid="review-description">{(pendingData.issueDescription || "").slice(0, 400)}{(pendingData.issueDescription || "").length > 400 ? "…" : ""}</p>
                  <p className="text-xs text-muted-foreground mt-1">{(pendingData.issueDescription || "").length} characters{aiUsed ? " · AI-enhanced" : ""}</p>
                </div>

                <div className="rounded-md border p-3 text-sm space-y-1.5">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Model/serial & estimate photos</span>
                    <span className="font-medium" data-testid="review-estimate-count">{estimatePhotoUrls.length}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Issue photos</span>
                    <span className="font-medium" data-testid="review-issue-count">{issuePhotoUrls.length}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Video</span>
                    <span className="font-medium" data-testid="review-video">{videoUrls.length > 0 ? `${videoUrls.length} attached` : "None"}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Voice note</span>
                    <span className="font-medium" data-testid="review-voice">{voiceNoteUrl ? "Attached" : "None"}</span>
                  </div>
                </div>

                {pendingData.requestType === "parts_nla" && (
                  <div className="rounded-md border p-3 text-sm space-y-1.5" data-testid="review-nla-parts">
                    <div>
                      <p className="text-muted-foreground mb-1">NLA part numbers</p>
                      {partNumbers.filter(p => p.trim()).length > 0 ? (
                        <ul className="list-disc pl-5 space-y-0.5">
                          {partNumbers.filter(p => p.trim()).map((p, i) => (
                            <li key={i} className="font-medium">{p}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-destructive">None entered</p>
                      )}
                    </div>
                    <div className="pt-2 border-t">
                      <p className="text-muted-foreground mb-1">Other required parts (available)</p>
                      {availableParts.filter(p => p.trim()).length > 0 ? (
                        <ul className="list-disc pl-5 space-y-0.5">
                          {availableParts.filter(p => p.trim()).map((p, i) => (
                            <li key={i} className="font-medium">{p}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground">None</p>
                      )}
                    </div>
                  </div>
                )}

                {(() => {
                  const warnings = getReviewWarnings(pendingData);
                  if (warnings.length === 0) {
                    return (
                      <div className="rounded-md border border-green-300 bg-green-50 dark:bg-green-950 dark:border-green-800 p-3 text-sm flex items-start gap-2" data-testid="review-no-warnings">
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                        <p className="text-green-800 dark:text-green-200">Looks complete. Ready to submit.</p>
                      </div>
                    );
                  }
                  return (
                    <div className="rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950 dark:border-amber-800 p-3 text-sm" data-testid="review-warnings">
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                        <div>
                          <p className="font-medium text-amber-800 dark:text-amber-200 mb-1">Heads up before you submit</p>
                          <ul className="list-disc pl-5 space-y-0.5 text-amber-800 dark:text-amber-200">
                            {warnings.map((w, i) => (
                              <li key={i} data-testid={`review-warning-${i}`}>{w}</li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-review-cancel">Go back & edit</AlertDialogCancel>
              <AlertDialogAction onClick={confirmAndSubmit} data-testid="button-review-confirm">
                <Send className="w-4 h-4 mr-2" /> Confirm & submit
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
