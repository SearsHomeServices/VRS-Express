// Stage 1 editor for a ticket's AHS details ("AHS details for VRS AI").
//
// The technician no longer enters AHS details. At submit the server stores a
// draft built from the service-order lookups (submissions.ahs_details,
// AhsDetailsDraft in shared/ahs-details.ts; may be partial or `{}`), with
// prefilledFields naming what the lookups filled. The VRS manager (a VRS
// agent or admin at Stage 1) completes or corrects it here, next to the
// tech's evidence, and saves it through PATCH /api/submissions/:id/ahs-details
// (shared/ahs-review.ts). The server then creates the VRS AI bridge row, which
// is what makes "Approve & Send to VRS AI" appear.
//
// Appliance grade, color and part 1's function may hold what the technician
// entered (submissions.tech_appliance_details; the server copies them into
// the draft). Those carry "From technician", never "From service order",
// until the manager changes them.
//
// Agent-only. The details carry customer name and address: nothing here is
// logged, and nothing is kept in localStorage or sessionStorage.
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import {
  AHS_APPLIANCE_KINDS,
  AHS_APPLIANCE_LOCATIONS,
  AHS_FAILURE_CAUSES,
  AHS_TECH_RECOMMENDATIONS,
  ahsDetailsSchema,
} from "@shared/ahs-details";
import type { AhsReviewRefreshResponse, AhsReviewSaveResponse } from "@shared/ahs-review";
import {
  SelectField,
  TextField,
  ahsDraftToForm,
  ahsFormTotals,
  emptyAhsPart,
  money,
  type AhsDetailsFormValues,
} from "@/components/ahs-details-fields";
import {
  AhsFromTechnicianBadge,
  AhsMedia,
  AHS_SOURCE_SERVICE_ORDER,
  type AhsReviewMedia,
} from "@/components/ahs-ticket-review";
import type { TechApplianceDetails } from "@shared/tech-appliance-details";
import {
  AHS_GRADE_OPTIONS,
  AHS_REVIEW_FORM_FIELDS,
  groupAhsIssues,
  holdsTechValue,
  parseAhsDetailsForReview,
  techSuppliedAhsValues,
  type AhsIssue,
  type AhsReviewFormField,
  type AhsReviewProvenanceField,
} from "@/lib/ahsReview";
import { apiRequest, friendlyApiErrorMessage } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export const AHS_EDITOR_TITLE = "AHS details for VRS AI";
export const AHS_EDITOR_SAVE_LABEL = "Save & prepare for VRS AI";
export const AHS_EDITOR_REFRESH_LABEL = "Refresh from service order";
export const AHS_EDITOR_ENROLLED_TEXT =
  "Saved. VRS AI is ready for this ticket: use “Approve & Send to VRS AI” below.";
export const AHS_EDITOR_SKIPPED_TEXT = "Saved, but this ticket is not ready for VRS AI:";
export const AHS_EDITOR_UNSAVED_TEXT =
  "You have unsaved changes. Save them before you approve, or VRS AI gets the last saved details.";

const MAX_PARTS = 10;

const editorSchema = z.object({ ahsDetails: ahsDetailsSchema });

interface EditorFormValues {
  ahsDetails: AhsDetailsFormValues;
}

// What the editor compares against to decide whether a field still holds the
// service-order value: the last stored details (on open, after a refresh,
// after a save) and the server's prefilledFields.
interface Baseline {
  values: AhsDetailsFormValues;
  prefilled: AhsReviewProvenanceField[];
}

type SaveOutcome = { kind: "enrolled" } | { kind: "skipped"; reason: string } | null;

function baselineFrom(raw: unknown): Baseline {
  const details = parseAhsDetailsForReview(typeof raw === "string" ? raw : JSON.stringify(raw ?? null));
  return { values: ahsDraftToForm(details), prefilled: details?.prefilledFields ?? [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// apiRequest throws on a non-2xx status and attaches the parsed JSON body.
// A validation failure ({ok:false, error, issues}) is an answer, not a crash.
async function patchAhsDetails(
  submissionId: number,
  ahsDetails: z.infer<typeof ahsDetailsSchema>,
): Promise<AhsReviewSaveResponse> {
  try {
    const res = await apiRequest("PATCH", `/api/submissions/${submissionId}/ahs-details`, { ahsDetails });
    return (await res.json()) as AhsReviewSaveResponse;
  } catch (err) {
    const body = (err as { body?: unknown }).body;
    if (isRecord(body) && typeof body.error === "string") {
      return {
        ok: false,
        error: body.error,
        issues: Array.isArray(body.issues) ? (body.issues as AhsIssue[]) : undefined,
      };
    }
    throw err;
  }
}

async function postAhsRefresh(submissionId: number): Promise<AhsReviewRefreshResponse> {
  const res = await apiRequest("POST", `/api/submissions/${submissionId}/ahs-details/refresh`);
  return (await res.json()) as AhsReviewRefreshResponse;
}

function isBlankPart(part: AhsDetailsFormValues["parts"][number]): boolean {
  return (
    [part.partNumber, part.description, part.unitPrice, part.partFunction, part.failureReason].every(
      (value) => (value ?? "").trim() === "",
    ) && ["", "1"].includes((part.quantity ?? "").trim())
  );
}

// A part line that holds only the technician's part function (the server
// drafts `parts: [{ partFunction }]` when the order has no parts yet). The
// refresh may replace it with service-order parts, keeping that function.
function isTechOnlyPart(part: AhsDetailsFormValues["parts"][number]): boolean {
  return isBlankPart({ ...part, partFunction: "" });
}

function lookupLabel(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value.replace(/_/g, " ") : "unknown";
}

export function AhsFromServiceOrderBadge({ testId }: { testId: string }) {
  return (
    <span
      data-testid={testId}
      data-source="service_order"
      className="inline-flex items-center whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
    >
      {AHS_SOURCE_SERVICE_ORDER}
    </span>
  );
}

export function AhsDetailsEditor({
  submissionId,
  storedDetails,
  issueDescription,
  media,
  onOpenPhoto,
  hasBridge = false,
  techDetails,
}: {
  submissionId: number;
  // submissions.ahs_details as the detail endpoint returns it. Read once when
  // the editor opens (the parent keys it by ticket), so a background refetch
  // never wipes what the manager is typing.
  storedDetails: string | null | undefined;
  issueDescription?: string | null;
  media: AhsReviewMedia;
  onOpenPhoto?: (photos: string[], index: number) => void;
  // A VRS AI bridge row already exists (an earlier save).
  hasBridge?: boolean;
  // submissions.tech_appliance_details, parsed: which values the tech supplied.
  techDetails?: TechApplianceDetails | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [initial] = useState(() => baselineFrom(storedDetails ?? null));
  const [baseline, setBaseline] = useState<Baseline>(initial);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [generalErrors, setGeneralErrors] = useState<string[]>([]);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const form = useForm<EditorFormValues>({
    resolver: zodResolver(editorSchema),
    defaultValues: { ahsDetails: initial.values },
  });
  const { fields, append, remove, replace } = useFieldArray({
    control: form.control,
    name: "ahsDetails.parts",
  });

  const invalidateTicket = () =>
    queryClient.invalidateQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === "string" && query.queryKey[0].startsWith("/api/submissions"),
    });

  const applyIssues = (error: string, issues: AhsIssue[] | undefined) => {
    const grouped = groupAhsIssues(issues);
    const rows = form.getValues("ahsDetails.parts").length;
    const general = [...grouped.general];
    for (const [name, message] of Object.entries(grouped.fields)) {
      const row = /^ahsDetails\.parts\.(\d+)\./.exec(name);
      if (row && Number(row[1]) >= rows) {
        general.push(message);
        continue;
      }
      form.setError(name as `ahsDetails.${AhsReviewFormField}`, { type: "server", message });
    }
    setGeneralErrors(Array.from(new Set([error, ...general])));
  };

  const saveMutation = useMutation({
    mutationFn: (details: z.infer<typeof ahsDetailsSchema>) => patchAhsDetails(submissionId, details),
    onSuccess: (response) => {
      if (!response.ok) {
        setOutcome(null);
        applyIssues(response.error || "The AHS details could not be saved.", response.issues);
        toast({
          title: "AHS details not saved",
          description: "See the messages in the AHS details panel.",
          variant: "destructive",
        });
        return;
      }
      const next = baselineFrom(response.ahsDetails);
      setBaseline(next);
      form.reset({ ahsDetails: next.values });
      setGeneralErrors([]);
      setOutcome(
        response.enrolled
          ? { kind: "enrolled" }
          : { kind: "skipped", reason: response.enrollSkipReason?.trim() || "No reason was given." },
      );
      invalidateTicket();
      toast({ title: "AHS details saved" });
    },
    onError: (err) => {
      setOutcome(null);
      setGeneralErrors([friendlyApiErrorMessage(err)]);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => postAhsRefresh(submissionId),
    onSuccess: (response) => {
      if (!response.ok) {
        setRefreshNote(response.error || "The service order lookup failed.");
        return;
      }
      const fresh = baselineFrom(response.ahsDetails);
      const current = form.getValues("ahsDetails");
      const nextValues: AhsDetailsFormValues = { ...baseline.values };
      let filled = 0;
      // Fill only what is blank here, the same rule the server applies to the
      // stored draft. Nothing the manager typed is overwritten.
      for (const field of AHS_REVIEW_FORM_FIELDS) {
        const value = fresh.values[field];
        if ((current[field] ?? "").trim() === "" && value.trim() !== "") {
          form.setValue(`ahsDetails.${field}`, value, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
          nextValues[field] = value;
          filled += 1;
        }
      }
      const freshParts = fresh.values.parts.filter((part) => !isTechOnlyPart(part));
      if (freshParts.length > 0 && current.parts.every(isTechOnlyPart)) {
        // Keep the technician's part function on part 1 when the fresh part
        // has none, matching the server's refresh rule.
        const techFunction = current.parts.find((part) => (part.partFunction ?? "").trim() !== "")?.partFunction;
        const merged = freshParts.map((part, index) =>
          index === 0 && techFunction && (part.partFunction ?? "").trim() === "" ? { ...part, partFunction: techFunction } : part,
        );
        replace(merged);
        nextValues.parts = merged;
        filled += 1;
      }
      setBaseline({ values: nextValues, prefilled: fresh.prefilled });
      setRefreshNote(
        `Service order lookup: ${lookupLabel(response.snowflake)}. HSSOM lookup: ${lookupLabel(response.hssom)}. ` +
          (filled > 0 ? `Filled ${filled} blank ${filled === 1 ? "field" : "fields"}.` : "No blank fields to fill."),
      );
      invalidateTicket();
    },
    onError: (err) => setRefreshNote(friendlyApiErrorMessage(err)),
  });

  const onValid = () => {
    // The resolver already ran ahsDetailsSchema; parse again for the exact
    // request body (numbers, trimmed text, defaults applied).
    const parsed = ahsDetailsSchema.safeParse(form.getValues("ahsDetails"));
    if (!parsed.success) {
      applyIssues("Fix the highlighted fields.", parsed.error.issues as AhsIssue[]);
      return;
    }
    setGeneralErrors([]);
    saveMutation.mutate(parsed.data);
  };

  const values = (form.watch("ahsDetails") ?? {}) as Partial<AhsDetailsFormValues>;
  const { partLines, partCost, total } = ahsFormTotals(values);
  const partsErrors = form.formState.errors.ahsDetails?.parts as
    | { message?: string; root?: { message?: string } }
    | undefined;
  const partsError = partsErrors?.root?.message ?? partsErrors?.message;

  // A tech-supplied field keeps "From technician" while it still holds the
  // tech's value; it never shows "From service order".
  const tech = techSuppliedAhsValues(techDetails);
  const fromTechnician = (field: "applianceGrade" | "applianceColor") =>
    holdsTechValue(values[field], tech[field]);
  const techBadge = (field: "applianceGrade" | "applianceColor") =>
    fromTechnician(field) ? <AhsFromTechnicianBadge testId={`badge-ahs-from-tech-${field}`} /> : null;
  const partFunctionFromTechnician = holdsTechValue(values.parts?.[0]?.partFunction, tech.partFunction);

  // A prefilled field keeps its badge while it still holds the stored value.
  const fromServiceOrder = (field: AhsReviewFormField) => {
    if ((field === "applianceGrade" || field === "applianceColor") && fromTechnician(field)) return null;
    if (!baseline.prefilled.includes(field as AhsReviewProvenanceField)) return null;
    const value = String(values[field] ?? "").trim();
    if (value === "" || value !== baseline.values[field].trim()) return null;
    return <AhsFromServiceOrderBadge testId={`badge-ahs-from-so-${field}`} />;
  };
  const partsFromServiceOrder =
    baseline.prefilled.includes("parts") &&
    JSON.stringify(values.parts ?? []) === JSON.stringify(baseline.values.parts);

  const locationValue = (values.applianceLocation ?? "").trim();
  const locationOptions = [
    ...AHS_APPLIANCE_LOCATIONS.map((location) => ({ value: location, label: location })),
    ...(locationValue && !(AHS_APPLIANCE_LOCATIONS as readonly string[]).includes(locationValue)
      ? [{ value: locationValue, label: locationValue }]
      : []),
  ];

  const saving = saveMutation.isPending;
  const refreshing = refreshMutation.isPending;

  return (
    <div
      className="mt-3 space-y-3 border-t border-blue-200 pt-3 dark:border-blue-900"
      data-testid="ahs-details-editor"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{AHS_EDITOR_TITLE}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Complete or correct what the service order lookup found, using the technician's
            photos and description. Fields marked * are required. VRS AI confirms anything
            left blank with AHS.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => refreshMutation.mutate()}
          disabled={refreshing || saving}
          data-testid="button-ahs-refresh"
        >
          {refreshing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-1 h-4 w-4" />
          )}
          {AHS_EDITOR_REFRESH_LABEL}
        </Button>
      </div>
      {refreshNote && (
        <p className="text-xs text-muted-foreground" data-testid="text-ahs-refresh-note">
          {refreshNote}
        </p>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="space-y-2 text-xs xl:sticky xl:top-2 xl:self-start" data-testid="ahs-editor-evidence">
          <p className="font-semibold uppercase tracking-wider text-muted-foreground">Technician's evidence</p>
          <div className="rounded border bg-background/60 p-2">
            <span className="text-muted-foreground">Issue description</span>
            {issueDescription?.trim() ? (
              <p className="mt-1 whitespace-pre-wrap text-sm" data-testid="text-ahs-evidence-description">
                {issueDescription}
              </p>
            ) : (
              <p className="mt-1 italic text-muted-foreground" data-testid="text-ahs-evidence-description">
                Not provided
              </p>
            )}
          </div>
          <AhsMedia media={media} onOpenPhoto={onOpenPhoto} />
        </section>

        <Form {...form}>
          <form
            className="space-y-4 text-sm"
            onSubmit={form.handleSubmit(onValid)}
            noValidate
            data-testid="form-ahs-details"
          >
            <div className="space-y-4" data-testid="section-ahs-service-order">
              <TextField
                form={form}
                name="ahsDetails.contractNumber"
                label="Dispatch / Contract Number"
                testId="input-ahs-contract-number"
                badge={fromServiceOrder("contractNumber")}
              />
              <TextField
                form={form}
                name="ahsDetails.customerName"
                label="Customer Name"
                testId="input-ahs-customer-name"
                badge={fromServiceOrder("customerName")}
              />
              <TextField
                form={form}
                name="ahsDetails.customerAddress"
                label="Customer Address"
                placeholder="Street, city, state, ZIP"
                testId="input-ahs-customer-address"
                badge={fromServiceOrder("customerAddress")}
                multiline
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                form={form}
                name="ahsDetails.applianceKind"
                label="Appliance Type *"
                placeholder="Select appliance type"
                options={AHS_APPLIANCE_KINDS}
                testId="select-ahs-appliance-kind"
                badge={fromServiceOrder("applianceKind")}
              />
              <TextField
                form={form}
                name="ahsDetails.brand"
                label="Brand"
                testId="input-ahs-brand"
                badge={fromServiceOrder("brand")}
              />
              <TextField
                form={form}
                name="ahsDetails.modelNumber"
                label="Model Number"
                testId="input-ahs-model"
                badge={fromServiceOrder("modelNumber")}
              />
              <TextField
                form={form}
                name="ahsDetails.serialNumber"
                label="Serial Number"
                testId="input-ahs-serial"
                badge={fromServiceOrder("serialNumber")}
              />
              <TextField
                form={form}
                name="ahsDetails.applianceAge"
                label="Appliance Age (years)"
                inputMode="numeric"
                testId="input-ahs-age"
                badge={fromServiceOrder("applianceAge")}
              />
              <SelectField
                form={form}
                name="ahsDetails.applianceLocation"
                label="Appliance Location *"
                placeholder="Select location"
                options={locationOptions}
                testId="select-ahs-location"
                badge={fromServiceOrder("applianceLocation")}
              />
              <SelectField
                form={form}
                name="ahsDetails.applianceGrade"
                label="Appliance Grade"
                placeholder="Select grade"
                options={AHS_GRADE_OPTIONS}
                testId="select-ahs-grade"
                badge={techBadge("applianceGrade") ?? fromServiceOrder("applianceGrade")}
              />
              <TextField
                form={form}
                name="ahsDetails.applianceColor"
                label="Appliance Color"
                placeholder="e.g., White, Stainless"
                testId="input-ahs-color"
                badge={techBadge("applianceColor") ?? fromServiceOrder("applianceColor")}
              />
              <SelectField
                form={form}
                name="ahsDetails.failureCause"
                label="Failure Cause *"
                placeholder="Why did it break?"
                options={AHS_FAILURE_CAUSES}
                testId="select-ahs-failure-cause"
                badge={fromServiceOrder("failureCause")}
              />
              <SelectField
                form={form}
                name="ahsDetails.techRecommendation"
                label="Repair or Replace"
                placeholder="Select one"
                options={AHS_TECH_RECOMMENDATIONS}
                testId="select-ahs-recommendation"
                badge={fromServiceOrder("techRecommendation")}
              />
            </div>

            <div className="space-y-3" data-testid="section-ahs-parts">
              <div className="flex flex-wrap items-center gap-1.5">
                <p className="text-sm font-medium">Parts *</p>
                {partsFromServiceOrder && <AhsFromServiceOrderBadge testId="badge-ahs-from-so-parts" />}
              </div>
              {fields.map((part, index) => (
                <div key={part.id} className="space-y-3 rounded-md border p-3" data-testid={`ahs-part-${index}`}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">
                      Part {index + 1}
                      {partLines[index] !== null && partLines[index] !== undefined
                        ? ` · ${money(partLines[index]!)}`
                        : ""}
                    </span>
                    {fields.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(index)}
                        aria-label={`Remove part ${index + 1}`}
                        data-testid={`button-remove-ahs-part-${index}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <TextField
                        form={form}
                        name={`ahsDetails.parts.${index}.partNumber`}
                        label="Part Number *"
                        testId={`input-ahs-part-${index}-number`}
                      />
                    </div>
                    <TextField
                      form={form}
                      name={`ahsDetails.parts.${index}.quantity`}
                      label="Qty"
                      inputMode="numeric"
                      placeholder="1"
                      testId={`input-ahs-part-${index}-quantity`}
                    />
                  </div>
                  <TextField
                    form={form}
                    name={`ahsDetails.parts.${index}.description`}
                    label="Description *"
                    testId={`input-ahs-part-${index}-description`}
                  />
                  <TextField
                    form={form}
                    name={`ahsDetails.parts.${index}.unitPrice`}
                    label="Price (each) *"
                    inputMode="decimal"
                    placeholder="0.00"
                    testId={`input-ahs-part-${index}-price`}
                  />
                  <TextField
                    form={form}
                    name={`ahsDetails.parts.${index}.partFunction`}
                    label="Part Function"
                    placeholder="What the part does"
                    testId={`input-ahs-part-${index}-function`}
                    badge={
                      index === 0 && partFunctionFromTechnician ? (
                        <AhsFromTechnicianBadge testId="badge-ahs-from-tech-part-0-function" />
                      ) : null
                    }
                  />
                  <TextField
                    form={form}
                    name={`ahsDetails.parts.${index}.failureReason`}
                    label="Failure Reason"
                    placeholder="Why this part failed"
                    testId={`input-ahs-part-${index}-failure-reason`}
                  />
                </div>
              ))}
              {partsError ? (
                <p className="text-sm font-medium text-destructive" data-testid="text-ahs-parts-error">
                  {partsError}
                </p>
              ) : null}
              {fields.length < MAX_PARTS && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append(emptyAhsPart())}
                  data-testid="button-add-ahs-part"
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Add part
                </Button>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                form={form}
                name="ahsDetails.laborAmount"
                label="Labor Amount *"
                inputMode="decimal"
                placeholder="0.00"
                testId="input-ahs-labor"
                badge={fromServiceOrder("laborAmount")}
              />
              <TextField
                form={form}
                name="ahsDetails.taxAmount"
                label="Total Tax Amount"
                inputMode="decimal"
                placeholder="0.00"
                testId="input-ahs-tax"
                badge={fromServiceOrder("taxAmount")}
              />
            </div>

            <div className="space-y-1 rounded-md bg-muted/50 p-3 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Part cost (all parts)</span>
                <span className="font-medium" data-testid="text-ahs-part-cost">{money(partCost)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">Total (parts + labor + tax)</span>
                <span className="font-semibold" data-testid="text-ahs-total">{money(total)}</span>
              </div>
            </div>

            {generalErrors.length > 0 && (
              <div
                className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                role="alert"
                data-testid="ahs-editor-errors"
              >
                <ul className="list-disc space-y-0.5 pl-4">
                  {generalErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
            {outcome?.kind === "enrolled" && !form.formState.isDirty && (
              <p
                className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-300"
                data-testid="text-ahs-enrolled"
              >
                {AHS_EDITOR_ENROLLED_TEXT}
              </p>
            )}
            {outcome?.kind === "skipped" && (
              <p
                className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
                data-testid="text-ahs-enroll-skipped"
              >
                {AHS_EDITOR_SKIPPED_TEXT} {outcome.reason}
              </p>
            )}
            {(hasBridge || outcome?.kind === "enrolled") && form.formState.isDirty && (
              <p className="text-xs font-medium text-amber-700 dark:text-amber-300" data-testid="text-ahs-unsaved">
                {AHS_EDITOR_UNSAVED_TEXT}
              </p>
            )}

            <Button type="submit" disabled={saving || refreshing} data-testid="button-ahs-save">
              {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {AHS_EDITOR_SAVE_LABEL}
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}
