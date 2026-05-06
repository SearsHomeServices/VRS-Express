import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "vrs-install-prompt-dismissed";
const SESSION_SHOWN_KEY = "vrs-install-prompt-shown-this-session";
const AUTO_HIDE_MS = 8000;

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY)) return;
    if (sessionStorage.getItem(SESSION_SHOWN_KEY)) return;

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowBanner(true);
      sessionStorage.setItem(SESSION_SHOWN_KEY, "true");

      timerRef.current = setTimeout(() => {
        setShowBanner(false);
      }, AUTO_HIDE_MS);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleInstall = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      localStorage.setItem(DISMISS_KEY, "true");
    }
    setShowBanner(false);
    setDeferredPrompt(null);
  };

  const handleDismiss = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setShowBanner(false);
    localStorage.setItem(DISMISS_KEY, "true");
  };

  if (!showBanner) return null;

  return (
    <div
      data-testid="install-prompt-banner"
      className="fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-xl max-w-sm animate-in slide-in-from-top-2 fade-in duration-300"
      style={{ backgroundColor: "#003366" }}
    >
      <span className="text-white text-sm font-medium">Install VRS Express</span>
      <div className="flex items-center gap-2">
        <Button
          data-testid="button-install"
          size="sm"
          variant="outline"
          className="text-white border-white bg-transparent hover:bg-white/20"
          onClick={handleInstall}
        >
          Install
        </Button>
        <Button
          data-testid="button-dismiss-install"
          size="icon"
          variant="ghost"
          className="text-white hover:bg-white/20 h-7 w-7"
          onClick={handleDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
