import {
  APPLIANCE_CHOICES,
  applianceChoice,
  applianceKindFromServiceOrderProduct,
  applianceKindSchema,
  applianceLabel,
  unambiguousApplianceKind,
  type ApplianceKind,
} from "@shared/appliance-types";
import { APPLIANCE_DIVISIONS, type ApplianceDivision } from "@shared/appliance-division";
import { useState, useRef, useEffect } from "react";
import { useForm, type Control, type FieldErrors, type FieldPath, type FieldValues, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest, apiRequestWithRetry, friendlyApiErrorMessage, queryClient } from "@/lib/queryClient";
import { createSubmissionErrorHandler } from "@/lib/submission-error-handler";
import { useAuth, getToken } from "@/lib/auth";
import { TechPhotoPreview, MediaVideo, MediaAudio } from "@/components/media";
import { MAX_VIDEOS_PER_TICKET } from "@/lib/videoUrls";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/hooks/use-feature-flags";
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
import imageCompression from "browser-image-compression";
import HelpTooltip from "@/components/help-tooltip";
import {
  parseAndValidateDraft,
  stampDraftIdentity,
  type DraftEnvelope,
} from "@/lib/draft-identity";
import { getEtDateString } from "@shared/business-hours";
import type { DerivedServiceOrderAppliance, DerivedWarranty, ServiceOrderProduct } from "@shared/warranty";
import { parseServiceOrderProduct, ServiceOrderProductText } from "@/components/ahs-ticket-review";
import {
  TECH_APPLIANCE_COLORS,
  TECH_APPLIANCE_GRADES,
  techApplianceDetailsApply,
  techApplianceDetailsSchema,
  techApplianceGradeLabel,
  type TechApplianceDetails,
} from "@shared/tech-appliance-details";

// Tyler 2026-06-30 — one-day holiday closure notice shown on the tech submit
// form. Gated to the Eastern-Time calendar date so it appears only on July 4,
// 2026 and self-hides afterward (no cleanup needed).
const HOLIDAY_CLOSURE_DATE = "2026-07-04";

// The routing division GET /api/tech/lookup-warranty derived from the
// service order's product code (applianceType), when it is one of the seven
// divisions; null otherwise (missing, unknown or no lookup).
export function lookupApplianceType(derived: unknown): ApplianceDivision | null {
  const value = derived && typeof derived === "object" ? (derived as { applianceType?: unknown }).applianceType : undefined;
  return APPLIANCE_DIVISIONS.some((division) => division === value) ? (value as ApplianceDivision) : null;
}

// The specific appliance (applianceKind) to preselect for a looked-up
// division: the one the service order's product category names, when its
// division is the looked-up one; else the division's only appliance
// (microwave, hvac); else undefined, and the tech picks it.
export function lookupApplianceKind(
  division: ApplianceDivision | null,
  productText: string | null | undefined,
): ApplianceKind | undefined {
  if (!division) return undefined;
  const mapped = applianceKindFromServiceOrderProduct(productText);
  if (mapped && applianceChoice(mapped)?.division === division) return mapped;
  return unambiguousApplianceKind(division);
}

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

// ---------------------------------------------------------------------------
// Tech appliance details (2026-10-23): Appliance Grade, Appliance Color and
// Part Function on American Home Shield and First American authorization
// tickets, behind TECH_APPLIANCE_DETAILS_ENABLED. The contract lives in
// shared/tech-appliance-details.ts; tech-resubmit.tsx reuses these helpers.
// ---------------------------------------------------------------------------
export const techApplianceDetailsFormSchema = z
  .object({
    applianceGrade: z.string().optional(),
    applianceColor: z.string().optional(),
    partFunction: z.string().optional(),
  })
  .optional()
  .catch(undefined);

export type TechApplianceDetailsFormValues = {
  applianceGrade?: string;
  applianceColor?: string;
  partFunction?: string;
};

export const EMPTY_TECH_APPLIANCE_DETAILS: TechApplianceDetailsFormValues = {
  applianceGrade: undefined,
  applianceColor: undefined,
  partFunction: "",
};

// The single gate for showing, validating and sending the three fields.
export function showTechApplianceDetails(
  enabled: boolean,
  warrantyType: string | null | undefined,
  requestType: string | null | undefined,
): boolean {
  return enabled && techApplianceDetailsApply(warrantyType, requestType);
}

// Lenient read of stored values (a draft's object, or the server's JSON
// string column). Keeps each field only when it is still a valid choice, so
// junk never reaches the controls; never throws.
export function techApplianceDetailsFormValues(raw: unknown): TechApplianceDetailsFormValues {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const grade = obj.applianceGrade;
  const color = obj.applianceColor;
  return {
    applianceGrade:
      typeof grade === "string" && TECH_APPLIANCE_GRADES.some((option) => option.value === grade) ? grade : undefined,
    applianceColor:
      typeof color === "string" && (TECH_APPLIANCE_COLORS as readonly string[]).includes(color) ? color : undefined,
    partFunction: typeof obj.partFunction === "string" ? obj.partFunction : "",
  };
}

type TechApplianceDetailsGateValues = {
  warrantyType?: string | null;
  requestType?: string | null;
  techApplianceDetails?: unknown;
};

// The POST body value: the shared schema's parsed details when the section
// is shown, otherwise null (the caller then leaves the key out).
export function techApplianceDetailsForPayload(
  values: TechApplianceDetailsGateValues,
  enabled: boolean,
): TechApplianceDetails | null {
  if (!showTechApplianceDetails(enabled, values.warrantyType, values.requestType)) return null;
  const parsed = techApplianceDetailsSchema.safeParse(values.techApplianceDetails ?? {});
  return parsed.success ? parsed.data : null;
}

// Wraps the page's zod resolver: when the section is shown, the three
// fields are validated with the shared techApplianceDetailsSchema and their
// errors merged with the form's own. (A superRefine on the form schema would
// not run while another field is missing, so the tech would only see these
// errors on a second tap of Submit.)
export function techApplianceDetailsResolver<T extends FieldValues>(
  base: Resolver<T>,
  isEnabled: () => boolean,
): Resolver<T> {
  return async (values, context, options) => {
    const result = await base(values, context, options);
    const gate = values as TechApplianceDetailsGateValues;
    if (!showTechApplianceDetails(isEnabled(), gate.warrantyType, gate.requestType)) return result;
    const parsed = techApplianceDetailsSchema.safeParse(gate.techApplianceDetails ?? {});
    if (parsed.success) {
      if (Object.keys(result.errors).length > 0) return result;
      return { values: { ...result.values, techApplianceDetails: parsed.data } as unknown as T, errors: {} };
    }
    const detailErrors: Record<string, { type: string; message: string }> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "");
      if (key && !detailErrors[key]) detailErrors[key] = { type: issue.code, message: issue.message };
    }
    return {
      values: {},
      errors: { ...result.errors, techApplianceDetails: detailErrors } as unknown as FieldErrors<T>,
    };
  };
}

// Appliance Grade, Appliance Color, Part Function, in that order, with the
// form's standard controls. Rendered only when showTechApplianceDetails().
export function TechApplianceDetailsFields<T extends FieldValues>({
  control,
  testIdSuffix = "",
}: {
  control: Control<T>;
  testIdSuffix?: string;
}) {
  return (
    <div className="space-y-4" data-testid={`section-tech-appliance-details${testIdSuffix}`}>
      <FormField
        control={control}
        name={"techApplianceDetails.applianceGrade" as FieldPath<T>}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Appliance Grade *</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger data-testid={`select-appliance-grade${testIdSuffix}`}>
                  <SelectValue placeholder="Select appliance grade" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {TECH_APPLIANCE_GRADES.map((grade) => (
                  <SelectItem key={grade.value} value={grade.value} data-testid={`option-appliance-grade-${grade.value}`}>
                    {grade.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name={"techApplianceDetails.applianceColor" as FieldPath<T>}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Appliance Color *</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger data-testid={`select-appliance-color${testIdSuffix}`}>
                  <SelectValue placeholder="Select appliance color" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {TECH_APPLIANCE_COLORS.map((color) => (
                  <SelectItem key={color} value={color} data-testid={`option-appliance-color-${color.toLowerCase().replace(/\s+/g, "-")}`}>
                    {color}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={control}
        name={"techApplianceDetails.partFunction" as FieldPath<T>}
        render={({ field }) => (
          <FormItem>
            <FormLabel>Part Function *</FormLabel>
            <FormControl>
              <Input
                placeholder="What does the part do?"
                maxLength={200}
                {...field}
                value={field.value ?? ""}
                data-testid={`input-part-function${testIdSuffix}`}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

const submissionFormSchema = z.object({
  serviceOrder: z.string().regex(/^\d{4}-\d{8}$/, "Service order must be in format DDDD-SSSSSSSS (e.g., 8175-12345678)"),
  phone: z.string().min(7, "Valid phone number is required"),
  applianceType: z.enum(["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"], {
    required_error: "Select an appliance type",
  }),
  applianceKind: applianceKindSchema,
  requestType: z.enum(["authorization", "infestation_non_accessible", "parts_nla"]),
  warrantyType: z.enum(["sears_protect", "american_home_shield", "first_american"]).default("sears_protect"),
  warrantyProvider: z.string().optional(),
  issueDescription: z.string().min(10, "Please provide at least 10 characters").max(2000, "Description must be 2000 characters or less"),
  partNumbers: z.array(z.string()).optional(),
  // Appliance grade / color / part function (AHS and First American
  // authorization only). Loose here so a hidden, half-filled section never
  // blocks submit; techApplianceDetailsResolver applies the shared schema
  // when the section is shown.
  techApplianceDetails: techApplianceDetailsFormSchema,
});

type SubmissionFormData = z.infer<typeof submissionFormSchema>;

// The localStorage draft holds only this form's own fields. A draft saved by
// an older build can carry fields the form no longer has (the tech-side AHS
// section was removed 2026-10: the server drafts AHS details and the VRS
// manager completes them at Stage 1), so those are dropped on restore and save.
const SUBMISSION_FORM_FIELDS: readonly string[] = Object.keys(submissionFormSchema.shape);
// techApplianceDetails is kept (grade, color and part function are not PII),
// normalized so a stale or hand-edited draft cannot put junk in the controls.
function pickSubmissionFormFields(values: Record<string, unknown>): Record<string, unknown> {
  const picked = Object.fromEntries(Object.entries(values).filter(([key]) => SUBMISSION_FORM_FIELDS.includes(key)));
  if ("techApplianceDetails" in picked) {
    picked.techApplianceDetails = techApplianceDetailsFormValues(picked.techApplianceDetails);
  }
  const choice = applianceChoice(picked.applianceKind);
  if (choice) {
    picked.applianceType = choice.division;
  } else {
    delete picked.applianceKind;
  }
  return picked;
}

export default function TechSubmitPage() {
  const { user } = useAuth();
  // 1099 provider portal: restricted submission experience (no District,
  // no warranty section, no parts_nla, RAC → 1099 Company Name).
  const isProvider1099 = user?.role === "provider_1099";
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
  // Tyler 2026-05-12: per-photo upload progress as a fraction 0..1, keyed by
  // a transient photo id (crypto.randomUUID() generated at upload-start). The
  // worker pool below pushes 0 on start, calls xhr.upload progress events to
  // update, and clears the id on success/failure. Surfaces a progress bar
  // under the per-section "Uploading N/M" text so the tech can see movement
  // instead of staring at a frozen spinner on weak signal.
  const [photoUploadProgress, setPhotoUploadProgress] = useState<Record<string, number>>({});
  // Tyler 2026-07-08 — client-generated thumbnails, keyed by the FULL photo
  // object path (the identity used everywhere else: rejection, lightbox,
  // rejected_media). Best-effort: a thumb that fails to generate or upload
  // simply has no entry here and viewers fall back to the full image. Sent
  // as `photoThumbnails` (JSON map) in the submission payload.
  const [photoThumbs, setPhotoThumbs] = useState<Record<string, string>>({});
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

  function getUploadContentType(file: File): string {
    if (file.type && file.type.trim().length > 0) return file.type;
    const name = file.name.toLowerCase();
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
  }

  async function uploadSinglePhoto(
    file: File,
    retries = 2,
    onProgress?: (fraction: number) => void,
  ): Promise<string | null> {
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
            contentType: getUploadContentType(file),
          }),
        });
        if (!urlRes.ok) {
          reportUploadError({ stage: "request-url", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: "HTTP " + urlRes.status, attempt });
          throw new Error("Failed to get upload URL");
        }
        const { uploadURL, objectPath } = await urlRes.json();

        const result = await new Promise<string | null>((resolve) => {
          const xhr = new XMLHttpRequest();
          // Tyler 2026-05-12: was 300000 (5 min). With compressed photos
          // (~300-500 KB) anything >60s is a real network problem, not a
          // slow upload — fail fast so retry / UI can react.
          xhr.timeout = 60000;
          xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable && onProgress) {
              onProgress(e.loaded / e.total);
            }
          });
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
            reportUploadError({ stage: "xhr-timeout", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: "timeout after 60s", attempt });
            resolve(null);
          });
          xhr.open("PUT", uploadURL);
          xhr.setRequestHeader("Content-Type", getUploadContentType(file));
          xhr.send(file);
        });
        if (result) return result;
        if (attempt < retries) {
          // Tyler 2026-05-12: exponential backoff with jitter. Was linear
          // 1000 * (attempt+1). New: ~1-2s, ~2-3s, ~4-5s, capped at 30s.
          const delay = Math.min(30000, 2 ** attempt * 1000) + Math.floor(Math.random() * 1000);
          await new Promise(r => setTimeout(r, delay));
        }
      } catch (error) {
        reportUploadError({ stage: "unknown", fileName: file.name, fileSize: file.size, fileType: file.type, errorMessage: String(error), attempt });
        if (attempt < retries) {
          const delay = Math.min(30000, 2 ** attempt * 1000) + Math.floor(Math.random() * 1000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    return null;
  }

  // Tyler 2026-07-08 — generate + upload a small grid thumbnail for a photo
  // that just finished its full-size upload. ~480px max edge / ~60 KB JPEG:
  // plenty for the ~150-300px grid cells agents see, ~15-20x lighter than
  // the 1.2 MB full image, so first paint of a ticket's photo grid is fast
  // even cold. Forced to JPEG (PNG screenshots would balloon). Entirely
  // best-effort: any failure returns null and the caller just skips the map
  // entry — the grid falls back to the full image, exactly today's behavior.
  // 1 retry (vs 2 for the real photo) because losing a thumb is harmless.
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
      return await uploadSinglePhoto(thumbFile, 1);
    } catch (err) {
      console.warn("[tech-submit] thumbnail generation failed; grid will use full image", {
        name: file.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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
    const filesSelected = validFiles.slice(0, totalAllowed);
    if (filesSelected.length < validFiles.length) {
      toast({ title: "Photo Limit", description: `Maximum ${maxPhotos} photos allowed. Only uploading ${filesSelected.length} more.` });
    }
    setUploading(true);
    setCount({ done: 0, total: filesSelected.length });

    // Compress images client-side before upload to dramatically reduce
    // payload size on weak cell signal. Skips non-image files (defensive —
    // the validFiles filter above should already exclude them). HEIC/HEIF
    // and any other Canvas-decode failure falls back to the original file.
    const compressionStart = performance.now();
    let preparingToastShown = false;
    const preparingTimer = window.setTimeout(() => {
      preparingToastShown = true;
      toast({ title: "Preparing photos...", description: "Optimizing for upload on weak signal." });
    }, 250);
    const filesToUpload = await Promise.all(
      filesSelected.map(async (file) => {
        if (!file.type.startsWith("image/")) return file;
        try {
          const compressed = await imageCompression(file, {
            // Tyler 2026-05-12 — tuned for agent-side legibility at max zoom.
            // PhotoLightbox allows zoom up to 300%; at that level model
            // plates / voltage readings / estimate-screenshot text must
            // remain readable. 2560px max edge + q=0.85 retains enough
            // detail for ~2x more readable pixels at 300% zoom vs the
            // initial 1920/0.75 settings, while still cutting payloads
            // ~2.5x (2.6 MB iPhone JPEG -> ~900 KB-1.2 MB).
            maxSizeMB: 1.2,
            maxWidthOrHeight: 2560,
            useWebWorker: true,
            initialQuality: 0.85,
          });
          // imageCompression returns a Blob on some paths and a File on others.
          // Normalize to a File that preserves the original name + extension so
          // dedup/rename logic downstream (and the server `name` field) still
          // sees the same identifier.
          if (compressed instanceof File && compressed.name === file.name) {
            return compressed;
          }
          return new File([compressed], file.name, {
            type: compressed.type || file.type,
            lastModified: file.lastModified,
          });
        } catch (err) {
          // HEIC/HEIF on browsers that can't decode it, OOM on giant images,
          // canvas tainted errors, etc. Keep the original file rather than
          // dropping it — upload-side retry/timeout handling will deal with it.
          console.warn("[tech-submit] image compression failed; using original file", {
            name: file.name,
            type: file.type,
            size: file.size,
            error: err instanceof Error ? err.message : String(err),
          });
          return file;
        }
      })
    );
    window.clearTimeout(preparingTimer);
    if (preparingToastShown) {
      const elapsed = Math.round(performance.now() - compressionStart);
      console.info(`[tech-submit] compressed ${filesToUpload.length} photo(s) in ${elapsed}ms`);
    }
    const newUrls: string[] = [];
    const newPreviews: Record<string, string> = {};
    const newFailures: FailedUpload[] = [];
    const categoryForList: "estimate" | "issue" = setUrls === setEstimatePhotoUrls ? "estimate" : "issue";
    // Tyler 2026-05-12: adaptive concurrency. iOS Safari historically does
    // not expose navigator.connection, so guard every access with ?. and
    // `as any`. On weak/saving connections drop to 1 in-flight upload so we
    // don't compete with ourselves; otherwise keep at 3.
    const conn = (navigator as any).connection;
    const slowConn = !!(
      conn?.saveData ||
      conn?.effectiveType === "2g" ||
      conn?.effectiveType === "slow-2g" ||
      conn?.effectiveType === "3g"
    );
    const maxConcurrent = slowConn ? 1 : 3;
    let completed = 0;
    let cursor = 0;
    const runNext = async (): Promise<void> => {
      while (cursor < filesToUpload.length) {
        const idx = cursor++;
        const file = filesToUpload[idx];
        const localBlob = URL.createObjectURL(file);
        const progressKey = crypto.randomUUID();
        setPhotoUploadProgress((prev) => ({ ...prev, [progressKey]: 0 }));
        const url = await uploadSinglePhoto(file, 2, (fraction) => {
          setPhotoUploadProgress((prev) => ({ ...prev, [progressKey]: fraction }));
        });
        setPhotoUploadProgress((prev) => {
          const next = { ...prev };
          delete next[progressKey];
          return next;
        });
        if (url) {
          newUrls.push(url);
          newPreviews[url] = localBlob;
          // Thumb rides after the full upload inside the same worker slot so
          // it respects the adaptive concurrency cap (no extra parallel
          // request competing on weak signal). ~60 KB — adds well under a
          // second per photo. Failure is silent by design.
          const thumb = await generateAndUploadThumb(file);
          if (thumb) setPhotoThumbs((prev) => ({ ...prev, [url]: thumb }));
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
        completed += 1;
        setCount({ done: completed, total: filesToUpload.length });
      }
    };
    const workers = Array.from({ length: Math.min(maxConcurrent, filesToUpload.length) }, () => runNext());
    await Promise.all(workers);
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
        title: "Some photos didn't upload",
        description: `${newFailures.length} photo(s) didn't upload — likely a weak connection. They are NOT attached yet. Scroll down to retry before submitting.`,
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
      const thumb = await generateAndUploadThumb(failed.file);
      if (thumb) setPhotoThumbs((prev) => ({ ...prev, [url]: thumb }));
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
        title: "Still didn't upload",
        description: `${failed.file.name} — check your connection and try again. It is not attached yet.`,
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

  // Returns the converted (playable MP4) object path, or null when the video
  // could not be converted. On failure we deliberately do NOT fall back to the
  // original file — an unconverted iPhone HEVC .mov cannot play on the desktop
  // browsers VRS agents/admins use, so storing it would silently produce a
  // broken player. Returning null lets the caller reject the upload and prompt
  // the tech to retry.
  async function convertVideo(objectPath: string): Promise<string | null> {
    setIsConverting(true);
    try {
      const res = await apiRequest("POST", "/api/uploads/convert-video", { objectPath });
      const data = await res.json();
      if (data.converted === false) {
        toast({
          title: "Video Couldn't Be Processed",
          description: "This video couldn't be converted to a playable format and was not attached. Please try recording or uploading it again.",
          variant: "destructive",
        });
        return null;
      }
      return data.objectPath;
    } catch {
      toast({
        title: "Video Couldn't Be Processed",
        description: "Video conversion failed and the video was not attached. Please try again.",
        variant: "destructive",
      });
      return null;
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
            // Only append when conversion produced a playable MP4 — a null
            // result means the video could not be processed and the tech
            // has already been told to retry, so we don't attach an
            // unplayable original.
            if (convertedPath) {
              setVideoUrls((prev) => [...prev, convertedPath]);
            }
          } else {
            setIsUploading(false);
            setVideoUrls((prev) => [...prev, objectPath]);
          }
          if (videoInputRef.current) videoInputRef.current.value = "";
        } else {
          setIsUploading(false);
          toast({ title: "Video didn't upload", description: "The video did not upload. Check your connection and add it again before submitting.", variant: "destructive" });
        }
      });

      xhr.addEventListener("error", () => {
        setIsUploading(false);
        toast({ title: "Video didn't upload", description: "Your connection dropped — the video was NOT uploaded. Check your signal and try again.", variant: "destructive" });
      });

      xhr.open("PUT", uploadURL);
      xhr.setRequestHeader("Content-Type", getUploadContentType(file));
      xhr.send(file);
    } catch (err) {
      setIsUploading(false);
      toast({ title: "Video didn't upload", description: "Couldn't start the upload — likely a connection issue. Check your signal and try again.", variant: "destructive" });
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
      toast({ title: "Voice note didn't upload", description: "Your connection dropped, so the voice note was NOT attached. Re-record or upload it again before submitting.", variant: "destructive" });
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

  const { techApplianceDetailsEnabled } = useFeatureFlags();
  // Read at validation time, so the resolver always sees the current flag.
  const techApplianceDetailsEnabledRef = useRef(techApplianceDetailsEnabled);
  techApplianceDetailsEnabledRef.current = techApplianceDetailsEnabled;

  const form = useForm<SubmissionFormData>({
    resolver: techApplianceDetailsResolver(
      zodResolver(submissionFormSchema),
      () => techApplianceDetailsEnabledRef.current,
    ),
    defaultValues: {
      serviceOrder: "",
      phone: user?.phone || "",
      applianceType: undefined,
      requestType: "authorization",
      warrantyType: "sears_protect",
      warrantyProvider: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)",
      issueDescription: "",
      techApplianceDetails: { ...EMPTY_TECH_APPLIANCE_DETAILS },
    },
  });

  const watchedServiceOrder = form.watch("serviceOrder");
  const isValidSo = /^\d{4}-\d{8}$/.test(watchedServiceOrder || "");
  const warrantyLookup = useQuery<{
    serviceOrder: string;
    // The warranty fields are absent when only the appliance type is known.
    derived: (Partial<DerivedWarranty> & DerivedServiceOrderAppliance) | null;
    applianceType?: DerivedServiceOrderAppliance["applianceType"];
    // The product category the type came from, when known (top level).
    serviceOrderProduct?: ServiceOrderProduct;
  }>({
    queryKey: ["/api/tech/lookup-warranty", watchedServiceOrder],
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/tech/lookup-warranty?serviceOrder=${encodeURIComponent(watchedServiceOrder)}`,
      );
      return res.json();
    },
    enabled: isValidSo && !isProvider1099,
    staleTime: 5 * 60 * 1000,
  });
  const lookupDerived = warrantyLookup.data?.derived ?? null;
  // Locks the warranty only when the lookup identified it; `derived` may
  // carry just the appliance type.
  const derivedWarranty: DerivedWarranty | null =
    lookupDerived?.warrantyType && lookupDerived.warrantyProvider ? (lookupDerived as DerivedWarranty) : null;

  // Appliance Type is preselected from the same lookup, but stays editable
  // (the product-code mapping is a heuristic): the routing division
  // (applianceType) and, when lookupApplianceKind can tell, the specific
  // appliance (applianceKind). `autoApplianceType` records the division the
  // lookup set and for which service order; it is cleared as soon as the
  // tech picks an appliance, so a tech-chosen value is never overwritten. A
  // lookup-set value follows the service order: replaced by the new order's
  // division and kind, or cleared when the new order has none.
  const [autoApplianceType, setAutoApplianceType] = useState<{ value: ApplianceDivision; serviceOrder: string } | null>(null);
  const autoApplianceTypeRef = useRef(autoApplianceType);
  autoApplianceTypeRef.current = autoApplianceType;
  // The server returns the type at the top level (always, when known) and
  // inside `derived` only when the warranty is known; read either.
  const derivedApplianceType =
    lookupApplianceType(warrantyLookup.data ?? null) ?? lookupApplianceType(lookupDerived);
  const applianceLookupSettled = isValidSo && !isProvider1099 && !warrantyLookup.isFetching && (warrantyLookup.isSuccess || warrantyLookup.isError);
  // Shown under Appliance Type so the tech sees where the type came from.
  // Only the current service order's lookup result: the query is keyed by
  // the service order, so on a change it is empty until the new lookup
  // lands, and nothing shows while the order is incomplete.
  const serviceOrderProduct =
    isValidSo && !isProvider1099 && warrantyLookup.isSuccess
      ? parseServiceOrderProduct(warrantyLookup.data?.serviceOrderProduct)
      : null;
  // The specific appliance the lookup preselects along with the division.
  const derivedApplianceKind = lookupApplianceKind(derivedApplianceType, serviceOrderProduct?.text);
  useEffect(() => {
    if (!applianceLookupSettled) return;
    const auto = autoApplianceTypeRef.current;
    const current = form.getValues("applianceType");
    const setByLookup = !!current && !!auto && current === auto.value;
    if (current && !setByLookup) return; // the tech's choice
    if (derivedApplianceType) {
      if (current !== derivedApplianceType) {
        form.setValue("applianceType", derivedApplianceType, { shouldDirty: false, shouldValidate: form.formState.isSubmitted });
      }
      // Also when the division is unchanged: a lookup-set kind follows the
      // service order (e.g. laundry with no kind, then a Washer order).
      if (form.getValues("applianceKind") !== derivedApplianceKind) {
        form.setValue("applianceKind", derivedApplianceKind as any, {
          shouldDirty: false,
          shouldValidate: form.formState.isSubmitted && !!derivedApplianceKind,
        });
      }
      setAutoApplianceType({ value: derivedApplianceType, serviceOrder: watchedServiceOrder });
    } else if (setByLookup && auto!.serviceOrder !== watchedServiceOrder) {
      // Set from another service order; this one has no known type.
      form.setValue("applianceType", undefined as any, { shouldDirty: false, shouldValidate: false });
      form.setValue("applianceKind", undefined as any, { shouldValidate: false });
      setAutoApplianceType(null);
    }
  }, [applianceLookupSettled, derivedApplianceType, derivedApplianceKind, watchedServiceOrder]);

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
      // 2026-05-11 — Field tech (Mike, AHS, SO 8420-13676372) hit a
      // "Submission Failed" toast whose body was Replit's edge-proxy
      // HTML 403 page; the request never reached Express. Self-heal via
      // shared apiRequestWithRetry helper (queryClient.ts) — retries
      // transient edge-layer hiccups up to 2 extra times with 800/1600ms
      // backoff. SAFE because server enforces 60s (tech, SO#) idempotency
      // at routes.ts:~590 / createSubmissionWithIdempotency, so a
      // duplicate retry returns the existing row without a second SMS.
      const res = await apiRequestWithRetry(
        "POST",
        "/api/submissions",
        data,
        { logTag: "submit-retry" },
      );
      return await res.json();
    },
    onSuccess: (data) => {
      try { localStorage.removeItem(DRAFT_KEY); } catch {}
      queryClient.invalidateQueries({ predicate: (q) => (q.queryKey[0] as string).startsWith("/api/submissions") });
      toast({ title: "Submission Created", description: `Service Order #${data.submission.serviceOrder} submitted successfully.` });
      setLocation(`/tech/submissions/${data.submission.id}`);
    },
    onError: createSubmissionErrorHandler({
      openAdditionalPrompt: () => setAdditionalPromptOpen(true),
      friendlyMessage: friendlyApiErrorMessage,
      toast,
    }),
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
  // Task — Additional Request confirmation. Opened when the server blocks a
  // normal submit for a SO that already has a resolved (completed) ticket
  // today; confirming re-sends the same payload with `additionalRequest: true`.
  const [additionalPromptOpen, setAdditionalPromptOpen] = useState(false);

  function onSubmit(data: SubmissionFormData) {
    // Tyler 2026-04-29 (warranty × request-type matrix): hard gate. The UI
    // grays out incompatible warranty cards, but if the SO auto-detected a
    // warranty that doesn't match the chosen request type — or any state
    // change slipped through — block submission with a clear toast pointing
    // the tech at the fix.
    const allowedWarranties = REQUEST_TYPE_WARRANTY_MATRIX[data.requestType as RequestTypeValue] ?? [];
    if (!isProvider1099 && allowedWarranties.length > 0 && !allowedWarranties.includes(data.warrantyType as WarrantyValue)) {
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
    // Sent only when the section is shown (AHS / First American +
    // Authorization, flag on); otherwise the key is left out entirely.
    delete payload.techApplianceDetails;
    const techApplianceDetails = techApplianceDetailsForPayload(data, techApplianceDetailsEnabled);
    if (techApplianceDetails) payload.techApplianceDetails = techApplianceDetails;
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
    // Thumb map filtered to photos actually attached (a removed photo's
    // stale entry must not leak into the payload). Only sent when at least
    // one attached photo has a thumb.
    const attachedUrls = new Set([...estimatePhotoUrls, ...issuePhotoUrls]);
    const thumbsForPayload: Record<string, string> = {};
    for (const [full, thumb] of Object.entries(photoThumbs)) {
      if (attachedUrls.has(full)) thumbsForPayload[full] = thumb;
    }
    if (Object.keys(thumbsForPayload).length > 0) payload.photoThumbnails = JSON.stringify(thumbsForPayload);
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

  // Task — re-send the last attempted payload as a deliberate Additional
  // Request. The server re-validates and will still refuse if any ticket for
  // the SO is currently active; it only succeeds when the prior ticket(s) are
  // fully resolved.
  function confirmAdditionalRequest() {
    if (!pendingPayload || mutation.isPending) return;
    setAdditionalPromptOpen(false);
    mutation.mutate({ ...pendingPayload, additionalRequest: true } as any);
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
  const watchedApplianceType = form.watch("applianceType");
  useEffect(() => {
    if (watchedRequestType === "parts_nla" && watchedApplianceType === "hvac") {
      form.setValue("applianceType", undefined as any, { shouldValidate: false });
      form.setValue("applianceKind", undefined as any, { shouldValidate: false });
    }
  }, [watchedRequestType, watchedApplianceType, form]);
  const watchedValues = form.watch();
  const techApplianceDetailsShown = showTechApplianceDetails(
    techApplianceDetailsEnabled,
    watchedValues.warrantyType,
    watchedRequestType,
  );
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
      form.reset({ ...form.getValues(), ...pickSubmissionFormFields(draft.formValues as Record<string, unknown>) });
      setAutoApplianceType(null);
    }
    if (Array.isArray(draft.estimatePhotoUrls)) setEstimatePhotoUrls(draft.estimatePhotoUrls as string[]);
    if (Array.isArray(draft.issuePhotoUrls)) setIssuePhotoUrls(draft.issuePhotoUrls as string[]);
    // Thumb map — tolerate absence (drafts saved before thumbnails shipped)
    // and junk (only keep string→string entries).
    const draftThumbs = (draft as any).photoThumbs;
    if (draftThumbs && typeof draftThumbs === "object" && !Array.isArray(draftThumbs)) {
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(draftThumbs)) {
        if (typeof k === "string" && typeof v === "string") clean[k] = v;
      }
      setPhotoThumbs(clean);
    }
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
        formValues: pickSubmissionFormFields(formValues),
        estimatePhotoUrls,
        issuePhotoUrls,
        photoThumbs,
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
    photoThumbs,
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
      applianceKind: undefined,
      requestType: "authorization",
      warrantyType: "sears_protect",
      warrantyProvider: "Sears Protect / Sears PA / Sears Home Warranty (Cinch)",
      issueDescription: "",
      techApplianceDetails: { ...EMPTY_TECH_APPLIANCE_DETAILS },
    });
    setAutoApplianceType(null);
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

      <AlertDialog open={additionalPromptOpen} onOpenChange={(open) => { if (!open) setAdditionalPromptOpen(false); }}>
        <AlertDialogContent data-testid="dialog-additional-request">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-additional-request-title">
              Submit an Additional Request?
            </AlertDialogTitle>
            <AlertDialogDescription data-testid="text-additional-request-detail">
              This service order already has a ticket that was completed today.
              If you are on a return visit and genuinely need a separate
              authorization for this same service order, you can submit an
              Additional Request. This creates a new, separate authorization
              request — only do this if the prior request is fully resolved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-additional-request-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAdditionalRequest}
              data-testid="button-additional-request-confirm"
            >
              Submit Additional Request
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
        {getEtDateString() === HOLIDAY_CLOSURE_DATE && (
          <div
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-4 space-y-2"
            data-testid="banner-holiday-closure"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive shrink-0" />
              <div className="font-semibold text-destructive" data-testid="text-holiday-closure-title">
                VRS is closed today — Saturday, July 4
              </div>
            </div>
            <p className="text-sm text-foreground/90" data-testid="text-holiday-closure-observance">
              VRS is closed today Saturday, July 4, in observance of Independence Day.
            </p>
            <p className="text-sm text-foreground/90" data-testid="text-holiday-closure-afterhours">
              For any PA, SHW, SPHW, FA or AHS authorization requests during this time, please use the after-hours process by submitting the request through the VRS Express App.
            </p>
            <p className="text-sm text-foreground/90" data-testid="text-holiday-closure-monday">
              If authorization is needed, VRS will review and work to obtain it first thing Monday morning.
            </p>
          </div>
        )}
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
                      //
                      // 1099 provider portal: providers never see warranty info, so the
                      // FA/AHS-specific copy is stripped for them; parts_nla is excluded
                      // from the provider experience entirely (filtered out below).
                      isProvider1099
                        ? { value: "infestation_non_accessible", label: "Infestation / No Model Tag or Infestation / Non-Accessible", desc: "Unable to service due to infestation, missing model tag, or access limitations." }
                        : { value: "infestation_non_accessible", label: "Infestation / No Model Tag or Infestation / Non-Accessible (FA & AHS Only)", desc: "Unable to service due to infestation, missing model tag, or access limitations. American Home Shield and First American calls only." },
                      { value: "parts_nla", label: "Parts — No Longer Available (NLA)", desc: "Part is unavailable in TechHub. Submit for VRS parts team research. Sears Protect, Sears PA, and Sears Home Warranty (Cinch) calls only." },
                    ].filter((opt) => !(isProvider1099 && opt.value === "parts_nla")).map((opt) => (
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
                    <label className="text-sm font-medium">{isProvider1099 ? "1099 Company Name" : "RAC ID"}</label>
                    <Input
                      value={isProvider1099 ? (user?.companyName || "") : (user?.racId || "")}
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
                        {isProvider1099 ? (
                          // 1099 provider portal: District is hidden. Providers
                          // enter the full service order (DDDD-SSSSSSSS) in a
                          // single field; we auto-format the dash as they type.
                          <Input
                            placeholder="e.g., 8175-12345678"
                            value={field.value || ""}
                            inputMode="numeric"
                            data-testid="input-service-order"
                            onChange={(e) => {
                              const digits = e.target.value.replace(/\D/g, "").slice(0, 12);
                              const d = digits.slice(0, 4);
                              const s = digits.slice(4);
                              field.onChange(s ? `${d}-${s}` : d);
                            }}
                          />
                        ) : (
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
                        )}
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
                <FormField
                  control={form.control}
                  name="applianceKind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Appliance Type *</FormLabel>
                      <Select
                        onValueChange={(v) => {
                          const choice = applianceChoice(v);
                          if (!choice) return;
                          field.onChange(v);
                          form.setValue("applianceType", choice.division, { shouldValidate: true });
                          // The tech picked a type: it is theirs now.
                          setAutoApplianceType(null);
                        }}
                        value={field.value ?? ""}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-appliance-type">
                            <SelectValue placeholder="Select appliance type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {APPLIANCE_CHOICES.filter(
                            (type) => !(watchedRequestType === "parts_nla" && type.value === "hvac")
                          ).map((type) => (
                            <SelectItem key={type.value} value={type.value} data-testid={`option-${type.value}`}>
                              {type.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {(() => {
                        // The lookup sets the routing category (applianceType);
                        // the dropdown holds the specific appliance
                        // (applianceKind), which the tech may still need to pick.
                        const autoDetected =
                          !!autoApplianceType &&
                          autoApplianceType.value === watchedApplianceType &&
                          autoApplianceType.serviceOrder === watchedServiceOrder;
                        const needsSpecific = autoDetected && !field.value;
                        // The lookup found only the category: ask for the
                        // specific appliance (with or without a product line).
                        const hint = needsSpecific ? (
                          <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1" data-testid="text-appliance-type-auto-note">
                            <Info className="w-3 h-3" />
                            {`${applianceLabel({ applianceType: watchedApplianceType })} category detected — select the specific appliance`}
                          </p>
                        ) : null;
                        // The product line replaces the generic note; once
                        // the type is the tech's own it drops "From".
                        if (serviceOrderProduct) {
                          return (
                            <>
                            <p
                              className="mt-1 text-xs text-muted-foreground flex items-start gap-1"
                              data-testid="text-appliance-type-product"
                              data-auto-detected={autoDetected ? "true" : "false"}
                            >
                              <Info className="w-3 h-3 mt-0.5 shrink-0" />
                              <span className="break-words">
                                {autoDetected ? "From service order product: " : "Service order product: "}
                                <span className="font-medium text-foreground" data-testid="text-appliance-type-product-text">
                                  <ServiceOrderProductText product={serviceOrderProduct} />
                                </span>
                              </span>
                            </p>
                            {hint}
                            </>
                          );
                        }
                        if (hint) return hint;
                        return autoDetected ? (
                          <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1" data-testid="text-appliance-type-auto-note">
                            <Info className="w-3 h-3" />
                            Auto-detected from service order
                          </p>
                        ) : null;
                      })()}
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
                {!isProvider1099 && (
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
                  ) : warrantyLookup.isError ? (
                    <p className="mt-1 text-xs text-destructive" role="status" data-testid="text-warranty-lookup-unavailable">
                      Warranty lookup is unavailable. Please try again before submitting.{" "}
                      <button type="button" className="underline" onClick={() => warrantyLookup.refetch()}>
                        Retry lookup
                      </button>
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
                )}
                {/* Appliance Grade / Color / Part Function: AHS and First
                    American authorization tickets only (flag
                    techApplianceDetailsEnabled). */}
                {techApplianceDetailsShown && <TechApplianceDetailsFields control={form.control} />}
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
                        <TechPhotoPreview
                          src={url}
                          localPreview={issuePhotoLocalPreviews[url] || null}
                          fallbackText={`Photo ${i + 1}`}
                          alt={`Issue ${i + 1}`}
                          className="w-full h-full object-cover rounded-md"
                          data-testid={`img-issue-preview-${i}`}
                        />
                        <Button type="button" size="icon" variant="destructive" className="absolute -top-2 -right-2 h-6 w-6" onClick={() => { const blobUrl = issuePhotoLocalPreviews[url]; if (blobUrl) URL.revokeObjectURL(blobUrl); setIssuePhotoLocalPreviews((prev) => { const n = {...prev}; delete n[url]; return n; }); setPhotoThumbs((prev) => { const n = {...prev}; delete n[url]; return n; }); setIssuePhotoUrls((prev) => prev.filter((_, idx) => idx !== i)); }} data-testid={`button-remove-issue-${i}`}>
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
                {issuePhotoUploading && (() => {
                  // Tyler 2026-05-12: aggregate progress across in-flight
                  // photos. photoUploadProgress holds fractions 0..1 keyed
                  // by transient ids; we sum and add completed-count to get
                  // an overall fraction of total. Mirrors video xhr.upload
                  // progress treatment (Progress + % text) from tech-submit
                  // line 1891ish.
                  const inflight = Object.values(photoUploadProgress);
                  const inflightSum = inflight.reduce((a, b) => a + b, 0);
                  const total = issuePhotoUploadCount.total || 1;
                  const pct = Math.min(100, Math.round(((issuePhotoUploadCount.done + inflightSum) / total) * 100));
                  return (
                    <div className="space-y-2 py-3" data-testid="issue-photo-uploading">
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm text-muted-foreground">Uploading {issuePhotoUploadCount.done}/{issuePhotoUploadCount.total} photos...</span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <Progress value={pct} className="flex-1" data-testid="progress-issue-photo-upload" />
                        <span className="text-sm text-muted-foreground whitespace-nowrap">{pct}%</span>
                      </div>
                    </div>
                  );
                })()}
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
                          <TechPhotoPreview
                            src={url}
                            localPreview={estimatePhotoLocalPreviews[url] || null}
                            fallbackText={`Estimate ${i + 1}`}
                            alt={`Estimate ${i + 1}`}
                            className="w-full h-full object-cover rounded-md"
                            data-testid={`img-estimate-preview-${i}`}
                          />
                          <Button type="button" size="icon" variant="destructive" className="absolute -top-2 -right-2 h-6 w-6" onClick={() => { const blobUrl = estimatePhotoLocalPreviews[url]; if (blobUrl) URL.revokeObjectURL(blobUrl); setEstimatePhotoLocalPreviews((prev) => { const n = {...prev}; delete n[url]; return n; }); setPhotoThumbs((prev) => { const n = {...prev}; delete n[url]; return n; }); setEstimatePhotoUrls((prev) => prev.filter((_, idx) => idx !== i)); }} data-testid={`button-remove-estimate-${i}`}>
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
                  {estimatePhotoUploading && (() => {
                    // Tyler 2026-05-12: same aggregate progress treatment as
                    // the issue-photo block above. See comment there.
                    const inflight = Object.values(photoUploadProgress);
                    const inflightSum = inflight.reduce((a, b) => a + b, 0);
                    const total = estimatePhotoUploadCount.total || 1;
                    const pct = Math.min(100, Math.round(((estimatePhotoUploadCount.done + inflightSum) / total) * 100));
                    return (
                      <div className="space-y-2 py-3" data-testid="estimate-photo-uploading">
                        <div className="flex items-center justify-center gap-2">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span className="text-sm text-muted-foreground">Uploading {estimatePhotoUploadCount.done}/{estimatePhotoUploadCount.total} photos...</span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <Progress value={pct} className="flex-1" data-testid="progress-estimate-photo-upload" />
                          <span className="text-sm text-muted-foreground whitespace-nowrap">{pct}%</span>
                        </div>
                      </div>
                    );
                  })()}
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
                        <MediaVideo
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
                    <MediaAudio src={voiceNoteUrl} controls className="w-full" data-testid="audio-player-preview" />
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
                    <span className="font-medium text-right" data-testid="review-appliance">{applianceLabel(pendingData)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Warranty</span>
                    <span className="font-medium text-right" data-testid="review-warranty">{formatWarrantyLabel(pendingData.warrantyType)}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Request Type</span>
                    <span className="font-medium text-right" data-testid="review-request-type">{formatRequestTypeLabel(pendingData.requestType)}</span>
                  </div>
                  {pendingPayload?.techApplianceDetails && (
                    <>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Appliance Grade</span>
                        <span className="font-medium text-right" data-testid="review-appliance-grade">{techApplianceGradeLabel(pendingPayload.techApplianceDetails.applianceGrade)}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Appliance Color</span>
                        <span className="font-medium text-right" data-testid="review-appliance-color">{pendingPayload.techApplianceDetails.applianceColor}</span>
                      </div>
                      <div className="flex justify-between gap-3">
                        <span className="text-muted-foreground">Part Function</span>
                        <span className="font-medium text-right break-words" data-testid="review-part-function">{pendingPayload.techApplianceDetails.partFunction}</span>
                      </div>
                    </>
                  )}
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
