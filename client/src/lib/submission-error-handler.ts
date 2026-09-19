interface SubmissionErrorEffects {
  openAdditionalPrompt: () => void;
  friendlyMessage: (error: Error) => string;
  toast: (options: { title: string; description: string; variant: "destructive" }) => void;
}

/** Error handling deliberately has no draft, form, photo reset or navigation effect. */
export function createSubmissionErrorHandler(effects: SubmissionErrorEffects) {
  return (error: Error & { status?: number; body?: { code?: string; canRequestAdditional?: boolean } }) => {
    if (error.status === 409 && error.body?.canRequestAdditional) {
      effects.openAdditionalPrompt();
      return;
    }
    const unavailable = error.status === 503 && error.body?.code === "LOOKUP_UNAVAILABLE";
    effects.toast({
      title: unavailable ? "Service Order Lookup Unavailable" : "Submission Failed",
      description: unavailable
        ? "We couldn't verify the service order right now. Your form and uploaded photos are still here. Please wait a few seconds, then tap Submit again."
        : effects.friendlyMessage(error),
      variant: "destructive",
    });
  };
}