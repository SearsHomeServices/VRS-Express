import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// Tyler 2026-04-30: Audience tagging matches help-center.tsx — techs see
// only tech/all items; agents/admins see everything. Default is "tech"
// when omitted (the original content origin was tech-perspective).
type Audience = "tech" | "agent_admin" | "all";

interface Feature {
  title: string;
  description: string;
  audience?: Audience;
}

interface WhatsNewModalProps {
  open: boolean;
  onDismiss: () => void;
  version: string;
  role?: string;
}

const FEATURES: Record<string, Feature[]> = {
  "1.0.0": [
    {
      title: "Digital Authorization Submissions",
      description:
        "Submit requests with photo/video evidence from your phone",
      audience: "tech",
    },
    {
      title: "Two-Stage Review Workflow",
      description:
        "Streamlined approval process with real-time SMS notifications",
      audience: "agent_admin",
    },
    {
      title: "Admin Analytics Dashboard",
      description:
        "Track submission volumes, approval rates, and processing times",
      audience: "agent_admin",
    },
    {
      title: "PWA Support",
      description: "Install VRS Express on your phone for quick access",
      audience: "tech",
    },
    {
      title: "Interactive Help System",
      description:
        "Onboarding wizard, contextual help, and comprehensive help center",
      audience: "all",
    },
  ],
};

function isVisibleToRole(feature: Feature, role: string | undefined): boolean {
  if (role && role !== "technician") return true;
  const audience = feature.audience ?? "tech";
  return audience === "tech" || audience === "all";
}

export default function WhatsNewModal({
  open,
  onDismiss,
  version,
  role,
}: WhatsNewModalProps) {
  const allFeatures = FEATURES[version] || [];
  const features = allFeatures.filter((f) => isVisibleToRole(f, role));

  return (
    <Dialog open={open} onOpenChange={onDismiss}>
      <DialogContent data-testid="whats-new-modal" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>What's New in v{version}</DialogTitle>
          <DialogDescription>
            Check out the latest features and improvements
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {features.map((feature, index) => (
            <div key={index} className="flex gap-3">
              <div className="flex-shrink-0 pt-1">
                <Sparkles className="w-5 h-5 text-primary" />
              </div>
              <div className="flex-1">
                <h4 className="font-medium text-base">{feature.title}</h4>
                <p className="text-sm text-muted-foreground mt-1">
                  {feature.description}
                </p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-4">
          <Button onClick={onDismiss} data-testid="button-whats-new-dismiss">
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
