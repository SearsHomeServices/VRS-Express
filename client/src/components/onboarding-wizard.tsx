import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Home,
  FileText,
  Send,
  CheckCircle2,
  Shield,
  ClipboardList,
  ClipboardCheck,
  Users,
  GitBranch,
  BarChart3,
  Smartphone,
  Bell,
  Key,
  Layers,
  Settings,
  type LucideIcon,
} from "lucide-react";

interface Slide {
  icon: LucideIcon;
  title: string;
  description: string;
}

const technicianSlides: Slide[] = [
  {
    icon: Send,
    title: "Welcome to VRS Express",
    description:
      "Submit authorization requests digitally from anywhere. No more paper forms or waiting in line. Your requests go straight to the review queue for fast processing.",
  },
  {
    icon: Home,
    title: "Home Dashboard",
    description:
      "View your queue count, recent submissions, and quick actions all in one place. Stay on top of your workload with a clear overview of pending, approved, and rejected requests.",
  },
  {
    icon: FileText,
    title: "Submit a Request",
    description:
      "Choose your request type, fill in the details, and upload supporting photos or videos. Each submission is tracked with a unique ID for easy reference.",
  },
  {
    icon: Bell,
    title: "Track Your Status",
    description:
      "Get real-time status updates on every submission. Receive SMS notifications the moment your request is approved or rejected so you can take action immediately.",
  },
  {
    icon: Key,
    title: "Authorization Codes",
    description:
      "Receive authorization codes via SMS once your request is approved. You can also view codes directly in the submission detail page for quick reference.",
  },
];

const vrsAgentSlides: Slide[] = [
  {
    icon: Shield,
    title: "Welcome to VRS Dashboard",
    description:
      "Review and process authorization requests efficiently. Your dashboard is designed to help you manage submissions quickly with all the information you need at a glance.",
  },
  {
    icon: Layers,
    title: "Dashboard Layout",
    description:
      "Navigate using the sidebar menu and work with the split-panel queue and detail view. Select a submission from the queue to see its full details side by side.",
  },
  {
    icon: ClipboardList,
    title: "Stage 1 Review",
    description:
      "Review incoming submissions for completeness and accuracy. Approve submissions that meet requirements or reject them with clear reasons to guide the technician.",
  },
  {
    icon: ClipboardCheck,
    title: "Stage 2 Authorization",
    description:
      "Send authorization codes to approved submissions. Codes are delivered via SMS to the technician and recorded in the system for audit purposes.",
  },
  {
    icon: Settings,
    title: "Batch Processing",
    description:
      "Handle multiple submissions efficiently using batch actions. Filter submissions by type, status, or date to focus on what matters most.",
  },
];

const adminSlides: Slide[] = [
  {
    icon: Shield,
    title: "Welcome to VRS Admin",
    description:
      "Manage every aspect of the VRS platform from one central location. Configure users, divisions, and monitor system performance with powerful admin tools.",
  },
  {
    icon: Users,
    title: "User Management",
    description:
      "Create new user accounts, assign roles, and activate or deactivate accounts as needed. Control who has access to the system and what they can do.",
  },
  {
    icon: GitBranch,
    title: "Division Assignments",
    description:
      "Assign agents to specific appliance divisions to ensure the right people review the right submissions. Manage workload distribution across your team.",
  },
  {
    icon: BarChart3,
    title: "Analytics",
    description:
      "View submission statistics, approval rates, and processing times. Use data-driven insights to identify bottlenecks and improve team performance.",
  },
];

const slidesByRole: Record<string, Slide[]> = {
  technician: technicianSlides,
  vrs_agent: vrsAgentSlides,
  admin: adminSlides,
};

interface OnboardingWizardProps {
  role: "technician" | "vrs_agent" | "admin" | "super_admin";
  open: boolean;
  onComplete: () => void;
}

export default function OnboardingWizard({
  role,
  open,
  onComplete,
}: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const slides = slidesByRole[role] || technicianSlides;
  const totalSteps = slides.length;
  const isFirstSlide = currentStep === 0;
  const isLastSlide = currentStep === totalSteps - 1;
  const currentSlide = slides[currentStep];
  const IconComponent = currentSlide.icon;

  const maxWidthClass = role === "technician" ? "max-w-md" : "max-w-lg";

  function handleNext() {
    if (isLastSlide) {
      setCurrentStep(0);
      onComplete();
    } else {
      setCurrentStep((prev) => prev + 1);
    }
  }

  function handleBack() {
    if (!isFirstSlide) {
      setCurrentStep((prev) => prev - 1);
    }
  }

  function handleSkip() {
    setCurrentStep(0);
    onComplete();
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleSkip(); }}>
      <DialogContent
        data-testid="wizard-modal"
        className={`${maxWidthClass} p-0 gap-0 overflow-visible`}
      >
        <div className="flex flex-col items-center px-6 pt-8 pb-6 gap-4">
          <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10">
            <IconComponent className="w-8 h-8 text-primary" />
          </div>

          <div className="flex flex-col items-center gap-2 text-center">
            <DialogTitle
              data-testid="wizard-title"
              className="text-xl font-semibold"
            >
              {currentSlide.title}
            </DialogTitle>
            <DialogDescription
              data-testid="wizard-description"
              className="text-sm text-muted-foreground leading-relaxed"
            >
              {currentSlide.description}
            </DialogDescription>
          </div>

          <div className="flex items-center gap-1.5 pt-2">
            {slides.map((_, index) => (
              <button
                key={index}
                data-testid={`wizard-progress-dot-${index}`}
                className={`w-2 h-2 rounded-full transition-colors ${
                  index === currentStep
                    ? "bg-primary"
                    : "bg-muted-foreground/30"
                }`}
                onClick={() => setCurrentStep(index)}
                aria-label={`Go to step ${index + 1}`}
              />
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-6 pb-6">
          <Button
            data-testid="button-wizard-skip"
            variant="ghost"
            onClick={handleSkip}
          >
            Skip
          </Button>

          <div className="flex items-center gap-2">
            {!isFirstSlide && (
              <Button
                data-testid="button-wizard-back"
                variant="outline"
                onClick={handleBack}
              >
                Back
              </Button>
            )}
            <Button
              data-testid="button-wizard-next"
              onClick={handleNext}
            >
              {isLastSlide ? "Get Started" : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
