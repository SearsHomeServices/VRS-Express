// Stage 1 corrections to the request SASHA sent (PATCH
// /api/submissions/:id/vrs-ai-request, server/vrs-sasha-edit.ts). SASHA's
// data is trusted as sent: the form starts from it exactly, nothing is
// looked up or filled, and only the values the VRS agent changes are sent.
// Fields SASHA did not send are not shown (they can't be added).
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, friendlyApiErrorMessage } from "@/lib/queryClient";
import type { VrsAiBridgeStatus } from "@/lib/vrsAiBridge";
import {
  FA_APPLIANCE_AGE_BUCKETS,
  FA_APPLIANCE_AGE_PLACEHOLDER,
  faApplianceAgeBucket,
  faApplianceAgeFromBucket,
  isFirstAmericanPartner,
} from "@shared/fa-appliance-age";

type Context = NonNullable<VrsAiBridgeStatus["reviewContext"]>;

// Same lists as server/vrs-sasha-edit.ts, with the labels agents see.
const TEXT_FIELDS: Array<[string, string]> = [
  ["contract_number", "Contract number"],
  ["customer_name", "Customer name"],
  ["customer_address", "Customer address"],
  ["service_address", "Service address"],
  ["brand", "Brand"],
  ["model_number", "Model number"],
  ["serial_number", "Serial number"],
  ["appliance_type", "Appliance type"],
  ["appliance_location", "Appliance location"],
  ["appliance_grade", "Appliance grade"],
  ["appliance_color", "Appliance color"],
  ["failure_cause", "Failure cause"],
  ["tech_recommendation", "Repair or replace"],
  ["repair_replace_rationale", "Rationale"],
  ["symptom", "Symptom"],
];
const NUMBER_FIELDS: Array<[string, string]> = [
  ["appliance_age", "Appliance age (years)"],
  ["labor_amount", "Labor ($)"],
  ["tax_amount", "Tax ($)"],
  ["part_price", "Parts total ($)"],
];
const PART_FIELDS: Array<[string, string, "text" | "number"]> = [
  ["part_id", "Part number", "text"],
  ["part_description", "Description", "text"],
  ["sell_price", "Price ($)", "number"],
  ["part_function", "Part function", "text"],
];

const asText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

type Edits = { fields: Record<string, string | number>; parts: Array<Record<string, string | number> & { index: number }> };

// Only what differs from SASHA's value; an unreadable number is an error.
function diff(
  context: Context,
  values: Record<string, string>,
  partValues: Array<Record<string, string>>,
): { edits: Edits; error?: string } {
  const source = context as unknown as Record<string, unknown>;
  const edits: Edits = { fields: {}, parts: [] };
  const read = (label: string, raw: string, kind: "text" | "number", original: unknown) => {
    if (kind === "text") return raw.trim() === asText(original) ? undefined : raw.trim();
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n) || n < 0) throw new Error(`${label} must be a number of 0 or more`);
    return n === original ? undefined : n;
  };
  try {
    for (const [name, label, kind] of [
      ...TEXT_FIELDS.map(([n, l]) => [n, l, "text"] as const),
      ...NUMBER_FIELDS.map(([n, l]) => [n, l, "number"] as const),
    ]) {
      if (!(name in source)) continue;
      const next = read(label, values[name] ?? "", kind, source[name]);
      if (next !== undefined) edits.fields[name] = next;
    }
    (context.parts ?? []).forEach((part, index) => {
      const original = part as unknown as Record<string, unknown>;
      const changed: Record<string, string | number> = {};
      for (const [name, label, kind] of PART_FIELDS) {
        if (!(name in original)) continue;
        const next = read(`Part ${index + 1} ${label.toLowerCase()}`, partValues[index]?.[name] ?? "", kind, original[name]);
        if (next !== undefined) changed[name] = next;
      }
      if (Object.keys(changed).length) edits.parts.push({ index, ...changed });
    });
  } catch (error) {
    return { edits, error: (error as Error).message };
  }
  return { edits };
}

export function SashaRequestEditor({
  submissionId,
  context,
  partner,
}: {
  submissionId: number;
  context: Context;
  // "AHS" or "First American" (vrsAiPartnerName).
  partner: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const source = context as unknown as Record<string, unknown>;
  const firstAmerican = isFirstAmericanPartner(partner);
  const initialValues = () =>
    Object.fromEntries([...TEXT_FIELDS, ...NUMBER_FIELDS].filter(([n]) => n in source).map(([n]) => [n, asText(source[n])]));
  const initialParts = () =>
    (context.parts ?? []).map((part) =>
      Object.fromEntries(PART_FIELDS.filter(([n]) => n in part).map(([n]) => [n, asText((part as unknown as Record<string, unknown>)[n])])));
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [partValues, setPartValues] = useState<Array<Record<string, string>>>(initialParts);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (edits: Edits) => {
      const res = await apiRequest("PATCH", `/api/submissions/${submissionId}/vrs-ai-request`, edits);
      return res.json() as Promise<{ ok: boolean; changed?: string[]; error?: string }>;
    },
    onSuccess: (response) => {
      if (!response.ok) {
        setError(response.error ?? "The corrections could not be saved.");
        return;
      }
      setError(null);
      queryClient.invalidateQueries({
        predicate: (query) => typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/submissions"),
      });
      toast({
        title: response.changed?.length ? "Corrections saved" : "Nothing changed",
        description: response.changed?.length ? `Updated: ${response.changed.join(", ")}` : undefined,
      });
    },
    onError: (err) => setError(friendlyApiErrorMessage(err)),
  });

  const submit = () => {
    const { edits, error: invalid } = diff(context, values, partValues);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!Object.keys(edits.fields).length && !edits.parts.length) {
      setError(null);
      toast({ title: "Nothing changed" });
      return;
    }
    save.mutate(edits);
  };

  // First American: appliance age is FA's own bucket list, not a number box.
  // The value kept (and sent) is still a number: SASHA's own, until the
  // agent picks a bucket, then that bucket's lower bound.
  const faAgeField = (name: string, label: string) => (
    <div key={name} className="space-y-1">
      <Label htmlFor={`sasha-${name}`} className="text-xs">{label}</Label>
      <select
        id={`sasha-${name}`}
        data-testid={`input-sasha-${name}`}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm"
        value={faApplianceAgeBucket(values[name]) ?? ""}
        onChange={(e) => {
          const age = faApplianceAgeFromBucket(e.target.value);
          setValues((prev) => ({ ...prev, [name]: age === undefined ? "" : String(age) }));
        }}
      >
        <option value="">{FA_APPLIANCE_AGE_PLACEHOLDER}</option>
        {FA_APPLIANCE_AGE_BUCKETS.map((bucket) => (
          <option key={bucket} value={bucket}>{bucket}</option>
        ))}
      </select>
    </div>
  );

  const field = (name: string, label: string, numeric = false) => (
    <div key={name} className="space-y-1">
      <Label htmlFor={`sasha-${name}`} className="text-xs">{label}</Label>
      <Input
        id={`sasha-${name}`}
        data-testid={`input-sasha-${name}`}
        inputMode={numeric ? "decimal" : undefined}
        value={values[name] ?? ""}
        onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
      />
    </div>
  );

  return (
    <div className="mt-3 space-y-3 border-t border-blue-200 pt-3 text-xs dark:border-blue-900" data-testid="sasha-request-editor">
      <div>
        <p className="text-sm font-medium">{partner} request from SASHA</p>
        <p className="mt-0.5 text-muted-foreground">
          This is what SASHA sent. Change only what you disagree with; everything else goes to VRS AI exactly as SASHA sent it.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {TEXT_FIELDS.filter(([n]) => n in source).map(([n, l]) => field(n, l))}
        {NUMBER_FIELDS.filter(([n]) => n in source).map(([n, l]) =>
          n === "appliance_age" && firstAmerican ? faAgeField(n, "Appliance age") : field(n, l, true))}
      </div>
      {(context.parts ?? []).map((_, index) => (
        <div key={index} className="grid gap-2 rounded border p-2 sm:grid-cols-2" data-testid={`sasha-part-${index}`}>
          <p className="font-medium sm:col-span-2">Part {index + 1}</p>
          {PART_FIELDS.filter(([n]) => n in (partValues[index] ?? {})).map(([n, l, kind]) => (
            <div key={n} className="space-y-1">
              <Label htmlFor={`sasha-part-${index}-${n}`} className="text-xs">{l}</Label>
              <Input
                id={`sasha-part-${index}-${n}`}
                inputMode={kind === "number" ? "decimal" : undefined}
                value={partValues[index]?.[n] ?? ""}
                onChange={(e) =>
                  setPartValues((prev) => prev.map((part, i) => (i === index ? { ...part, [n]: e.target.value } : part)))}
              />
            </div>
          ))}
        </div>
      ))}
      {error && <p className="text-destructive" data-testid="text-sasha-edit-error">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={save.isPending} data-testid="button-sasha-save">
          {save.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
          Save corrections
        </Button>
        <Button
          type="button" size="sm" variant="ghost" disabled={save.isPending}
          onClick={() => { setValues(initialValues()); setPartValues(initialParts()); setError(null); }}
        >
          Undo my changes
        </Button>
      </div>
    </div>
  );
}
