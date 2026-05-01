// Tyler 2026-05-01: Admin UI for editing the per-category VRS business hours.
// Two side-by-side panels (Standard + HVAC), each with HH:MM open/close
// inputs and Mon-Sun day toggles. PUT /api/business-hours saves both at
// once and the server broadcasts `business_hours_updated` so other open
// admin tabs refresh without a manual reload.
//
// Pattern follows the existing admin sections — local state for the form,
// React Query for fetch + invalidation, single mutation that posts the
// whole config (matches the server's all-or-nothing validation).

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Save } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ALL_DAYS,
  DAY_LABELS,
  DEFAULT_BUSINESS_HOURS_CONFIG,
  formatHoursLabel,
  type BusinessHoursConfig,
  type BusinessHoursProfile,
  type DayKey,
} from "@shared/business-hours";

type Category = "default" | "hvac";

const CATEGORY_LABELS: Record<Category, string> = {
  default: "Standard (all non-HVAC)",
  hvac: "HVAC",
};

function hhmmToMinutes(s: string): number {
  if (!/^\d{1,2}:\d{2}$/.test(s)) return NaN;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

function validateProfile(p: BusinessHoursProfile): string | null {
  if (!/^\d{1,2}:\d{2}$/.test(p.open)) return "Open time must be HH:MM (24h)";
  if (!/^\d{1,2}:\d{2}$/.test(p.close)) return "Close time must be HH:MM (24h)";
  if (hhmmToMinutes(p.close) <= hhmmToMinutes(p.open)) return "Close time must be after open time";
  if (p.openDays.length === 0) return "Pick at least one open day";
  return null;
}

export default function BusinessHoursSection() {
  const { toast } = useToast();
  const { data: serverConfig, isLoading } = useQuery<BusinessHoursConfig>({
    queryKey: ["/api/business-hours"],
  });

  // Local working copy. Re-seeds whenever server data changes AND the form
  // is pristine (no unsaved local edits). This way a cross-tab save broadcast
  // refreshes the form, but a user mid-edit isn't blown away.
  // Tyler 2026-05-01 (architect fix): the original code had a one-shot
  // `seeded` gate that ignored every subsequent server update — cross-tab
  // edits and post-save refetches never reached the form.
  const [draft, setDraft] = useState<BusinessHoursConfig>(DEFAULT_BUSINESS_HOURS_CONFIG);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (serverConfig && !dirty) {
      setDraft(serverConfig);
    }
  }, [serverConfig, dirty]);

  const mutation = useMutation({
    mutationFn: async (config: BusinessHoursConfig) => {
      const res = await apiRequest("PUT", "/api/business-hours", config);
      return res.json() as Promise<BusinessHoursConfig>;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(["/api/business-hours"], saved);
      queryClient.invalidateQueries({ queryKey: ["/api/business-hours"] });
      // Tyler 2026-05-01 (architect fix): clear dirty so the next server
      // update re-seeds the draft (and matches the broadcast WS event for
      // other tabs).
      setDirty(false);
      toast({ title: "Business hours saved", description: "Tech-facing SMS and dashboard timers will use the new windows immediately." });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save business hours",
        description: err?.message ?? "Server rejected the change.",
        variant: "destructive",
      });
    },
  });

  function updateProfile(cat: Category, patch: Partial<BusinessHoursProfile>) {
    setDirty(true);
    setDraft((prev) => ({ ...prev, [cat]: { ...prev[cat], ...patch } }));
  }

  function toggleDay(cat: Category, day: DayKey) {
    setDirty(true);
    setDraft((prev) => {
      const existing = prev[cat].openDays;
      const next = existing.includes(day)
        ? existing.filter((d) => d !== day)
        : [...ALL_DAYS].filter((d) => existing.includes(d) || d === day);
      return { ...prev, [cat]: { ...prev[cat], openDays: next } };
    });
  }

  function onSave() {
    const defErr = validateProfile(draft.default);
    const hvacErr = validateProfile(draft.hvac);
    if (defErr || hvacErr) {
      toast({
        title: "Fix the highlighted fields",
        description: defErr ? `Standard: ${defErr}` : `HVAC: ${hvacErr}`,
        variant: "destructive",
      });
      return;
    }
    mutation.mutate(draft);
  }

  if (isLoading && !serverConfig) {
    return (
      <div className="p-6 flex items-center gap-2 text-muted-foreground" data-testid="business-hours-loading">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading business hours...
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4" data-testid="business-hours-section">
      <Card>
        <CardHeader>
          <CardTitle>VRS Business Hours (Eastern Time)</CardTitle>
          <p className="text-sm text-muted-foreground">
            These windows drive the after-hours SMS gate (techs submitting outside
            them get the after-hours wording instead of "an agent will review
            shortly") and the dashboard ticket-age timers (they only accumulate
            during open hours). HVAC tickets use the HVAC window; everything else
            uses the Standard window.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(["default", "hvac"] as Category[]).map((cat) => {
              const profile = draft[cat];
              const err = validateProfile(profile);
              return (
                <Card key={cat} data-testid={`business-hours-panel-${cat}`}>
                  <CardHeader>
                    <CardTitle className="text-base">{CATEGORY_LABELS[cat]}</CardTitle>
                    <p className="text-xs text-muted-foreground" data-testid={`business-hours-preview-${cat}`}>
                      Preview: {err ? <span className="text-destructive">{err}</span> : formatHoursLabel(profile)}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <Label htmlFor={`open-${cat}`}>Open</Label>
                        <Input
                          id={`open-${cat}`}
                          type="time"
                          value={profile.open}
                          onChange={(e) => updateProfile(cat, { open: e.target.value })}
                          data-testid={`input-open-${cat}`}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={`close-${cat}`}>Close</Label>
                        <Input
                          id={`close-${cat}`}
                          type="time"
                          value={profile.close}
                          onChange={(e) => updateProfile(cat, { close: e.target.value })}
                          data-testid={`input-close-${cat}`}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label>Open days</Label>
                      <div className="grid grid-cols-7 gap-2">
                        {ALL_DAYS.map((day) => {
                          const checked = profile.openDays.includes(day);
                          return (
                            <label
                              key={day}
                              className="flex flex-col items-center gap-1 cursor-pointer rounded-md border p-2 hover-elevate"
                              data-testid={`day-toggle-${cat}-${day}`}
                            >
                              <span className="text-xs font-medium">{DAY_LABELS[day]}</span>
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleDay(cat, day)}
                                data-testid={`checkbox-day-${cat}-${day}`}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <div className="flex justify-end mt-4">
            <Button
              onClick={onSave}
              disabled={mutation.isPending}
              data-testid="button-save-business-hours"
            >
              {mutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Save Business Hours
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
