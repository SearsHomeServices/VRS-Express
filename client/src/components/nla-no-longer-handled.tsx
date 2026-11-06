import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { NLA_NO_LONGER_HANDLED_HEADING } from "@shared/nla-policy";

// Shown on the tech submit and resubmit forms when the request type is
// "Parts — No Longer Available (NLA)". VRS no longer handles NLA parts, so
// the notice tells the tech what to do in TechHub instead and the rest of
// the form is disabled (NlaBlockedFieldset). Red, high-visibility; the only
// motion is a gentle pulse on the icon for users who allow motion.
export function NlaNoLongerHandledNotice({ className }: { className?: string }) {
  return (
    <div
      role="alert"
      className={cn(
        "rounded-md border-2 border-destructive bg-destructive/10 p-3 dark:bg-destructive/20",
        className,
      )}
      data-testid="nla-no-longer-handled"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-destructive motion-safe:animate-pulse"
          aria-hidden="true"
        />
        <div className="space-y-1.5">
          <p className="text-sm font-semibold text-destructive" data-testid="text-nla-no-longer-handled-heading">
            {NLA_NO_LONGER_HANDLED_HEADING}
          </p>
          <ul className="list-disc space-y-1 pl-4 text-sm text-foreground" data-testid="list-nla-techhub-steps">
            <li>
              After confirming a part is NLA through part inquiry, select <strong>"Needed for Repair."</strong>
            </li>
            <li>Follow all TH 2.0 prompts for SOM team research.</li>
            <li>
              <strong>Do not close the order</strong> until research is complete.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// Wraps form sections that must be greyed out and unusable while NLA is
// selected. A disabled <fieldset> disables every native control inside it
// (inputs, textareas, Radix triggers and buttons, the submit button);
// pointer-events-none also stops clickable non-control elements.
export function NlaBlockedFieldset({
  blocked,
  className,
  children,
}: {
  blocked: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <fieldset
      disabled={blocked}
      aria-disabled={blocked || undefined}
      data-nla-blocked={blocked ? "true" : undefined}
      className={cn("m-0 min-w-0 border-0 p-0", className, blocked && "pointer-events-none select-none opacity-50")}
      data-testid="fieldset-nla-blocked"
    >
      {children}
    </fieldset>
  );
}
