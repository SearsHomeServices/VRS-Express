import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";
import { getToken } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { ArrowLeft, Send, Paperclip, CheckCircle, Upload } from "lucide-react";
import searsLogo from "@assets/sears-home-services-logo-brands_1770949137899.png";

const FEEDBACK_TYPES = [
  { value: "issue", label: "Issue" },
  { value: "improvement", label: "Improvement Request" },
  { value: "general", label: "General Feedback" },
];

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

export default function TechFeedbackPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [feedbackType, setFeedbackType] = useState("");
  const [priority, setPriority] = useState("medium");
  const [description, setDescription] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [attachmentName, setAttachmentName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const submitMutation = useMutation({
    mutationFn: async (data: {
      feedbackType: string;
      priority: string;
      description: string;
      attachmentUrl?: string | null;
    }) => {
      const res = await apiRequest("POST", "/api/feedback", data);
      return await res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
    },
    onError: (error: Error) => {
      toast({
        title: "Submission Failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "Maximum file size is 10MB.",
        variant: "destructive",
      });
      return;
    }

    setUploading(true);
    try {
      const token = getToken();
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

      if (!urlRes.ok) throw new Error("Failed to get upload URL");
      const { uploadURL, objectPath } = await urlRes.json();

      const uploadRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadRes.ok) throw new Error("Upload failed");

      setAttachmentUrl(objectPath);
      setAttachmentName(file.name);
      toast({ title: "File Attached", description: file.name });
    } catch {
      toast({
        title: "Upload Failed",
        description: "Could not upload the file — check your connection and try again.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!feedbackType) {
      toast({
        title: "Missing Field",
        description: "Please select a feedback type.",
        variant: "destructive",
      });
      return;
    }

    if (!description.trim()) {
      toast({
        title: "Missing Field",
        description: "Please enter a description.",
        variant: "destructive",
      });
      return;
    }

    submitMutation.mutate({
      feedbackType,
      priority,
      description: description.trim(),
      attachmentUrl,
    });
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center space-y-4">
            <div className="w-16 h-16 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
            </div>
            <h2 className="text-xl font-semibold" data-testid="text-feedback-success">
              Feedback Submitted
            </h2>
            <p className="text-sm text-muted-foreground">
              Thank you for your feedback. Our team will review it and take action.
            </p>
            <div className="flex gap-2 justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSubmitted(false);
                  setFeedbackType("");
                  setPriority("medium");
                  setDescription("");
                  setAttachmentUrl(null);
                  setAttachmentName(null);
                }}
                data-testid="button-submit-another"
              >
                Submit Another
              </Button>
              <Button onClick={() => setLocation("/tech")} data-testid="button-go-home">
                Go Home
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen pb-8">
      <div className="bg-primary text-primary-foreground p-4">
        <div className="max-w-lg mx-auto flex items-center gap-3">
          <Button
            size="icon"
            variant="ghost"
            className="text-primary-foreground shrink-0 no-default-hover-elevate"
            onClick={() => setLocation("/tech")}
            data-testid="button-back"
          >
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="flex items-center gap-3">
            <img src={searsLogo} alt="Sears Home Services" className="h-7" />
            <h1 className="text-lg font-bold">Submit Feedback</h1>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 mt-4">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="techName" className="text-sm">
                Technician Name
              </Label>
              <Input
                id="techName"
                value={user?.name || ""}
                disabled
                className="bg-muted"
                data-testid="input-tech-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="techId" className="text-sm">
                Technician ID
              </Label>
              <Input
                id="techId"
                value={user?.racId || ""}
                disabled
                className="bg-muted"
                data-testid="input-tech-id"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">
              Feedback Type <span className="text-destructive">*</span>
            </Label>
            <Select value={feedbackType} onValueChange={setFeedbackType}>
              <SelectTrigger data-testid="select-feedback-type">
                <SelectValue placeholder="Select type..." />
              </SelectTrigger>
              <SelectContent>
                {FEEDBACK_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value} data-testid={`option-type-${t.value}`}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">Priority</Label>
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger data-testid="select-priority">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((p) => (
                  <SelectItem key={p.value} value={p.value} data-testid={`option-priority-${p.value}`}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="description" className="text-sm">
              Description <span className="text-destructive">*</span>
            </Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the issue, suggestion, or feedback..."
              rows={4}
              maxLength={2000}
              data-testid="input-description"
            />
            <p className="text-xs text-muted-foreground text-right">
              {description.length}/2000
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">Attachment (optional)</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                className="relative"
                data-testid="button-attach-file"
              >
                {uploading ? (
                  <Upload className="w-4 h-4 mr-1.5 animate-pulse" />
                ) : (
                  <Paperclip className="w-4 h-4 mr-1.5" />
                )}
                {uploading ? "Uploading..." : attachmentName ? "Replace File" : "Attach File"}
                <input
                  type="file"
                  accept="image/*,.pdf,.doc,.docx,.txt"
                  onChange={handleFileUpload}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  data-testid="input-file-upload"
                />
              </Button>
              {attachmentName && (
                <span className="text-xs text-muted-foreground truncate max-w-[200px]" data-testid="text-attachment-name">
                  {attachmentName}
                </span>
              )}
            </div>
          </div>

          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={submitMutation.isPending}
            data-testid="button-submit-feedback"
          >
            <Send className="w-4 h-4 mr-2" />
            {submitMutation.isPending ? "Submitting..." : "Submit Feedback"}
          </Button>
        </form>
      </div>
    </div>
  );
}
