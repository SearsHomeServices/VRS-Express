import { useFieldArray, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FormControl,
  FormDescription,
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
  AHS_APPLIANCE_GRADES,
  AHS_APPLIANCE_KINDS,
  AHS_APPLIANCE_LOCATIONS,
  AHS_FAILURE_CAUSES,
  AHS_TECH_RECOMMENDATIONS,
  ahsApplianceKind,
  ahsDetailsSchema,
  roundCents,
  type AhsDetails,
} from "@shared/ahs-details";
import type { AhsPrefillResponse } from "@shared/ahs-prefill";

// AHS authorization details on the tech submit and resubmit forms. Shown
// only for AHS + Authorization while VRS AI enrollment is enabled.
// Validation is the shared schema (shared/ahs-details.ts), wired into each
// page's form resolver via addAhsDetailsIssues so errors behave like every
// other field.
//
// The tech types only what AHS asks for on the call: failure cause,
// location, repair or replace, labor, and each part's number, description
// and price. Everything else is optional; VRS AI confirms a missing value
// with AHS. Dispatch number, brand, model and serial come from the service
// order when the lookup has them (useAhsServiceOrderPrefill).

// Form-side shape: numbers stay as the strings the tech typed until submit.
export interface AhsPartFormValues {
  partNumber: string;
  quantity: string;
  description: string;
  unitPrice: string;
  partFunction: string;
  failureReason: string;
}

export interface AhsDetailsFormValues {
  contractNumber: string;
  customerName: string;
  customerAddress: string;
  applianceKind: string;
  brand: string;
  modelNumber: string;
  serialNumber: string;
  applianceAge: string;
  applianceLocation: string;
  applianceGrade: string;
  applianceColor: string;
  failureCause: string;
  techRecommendation: string;
  laborAmount: string;
  taxAmount: string;
  parts: AhsPartFormValues[];
}

const MAX_PARTS = 10;

export function emptyAhsPart(): AhsPartFormValues {
  return {
    partNumber: "",
    quantity: "1",
    description: "",
    unitPrice: "",
    partFunction: "",
    failureReason: "",
  };
}

export function emptyAhsDetailsForm(): AhsDetailsFormValues {
  return {
    contractNumber: "",
    customerName: "",
    customerAddress: "",
    applianceKind: "",
    brand: "",
    modelNumber: "",
    serialNumber: "",
    applianceAge: "",
    applianceLocation: "",
    applianceGrade: "",
    applianceColor: "",
    failureCause: "",
    techRecommendation: "repair",
    laborAmount: "",
    taxAmount: "",
    parts: [emptyAhsPart()],
  };
}

// Stored details (current or older, stricter shape) → form strings.
export function ahsDetailsToForm(details: AhsDetails): AhsDetailsFormValues {
  return {
    ...details,
    contractNumber: details.contractNumber ?? "",
    customerName: details.customerName ?? "",
    customerAddress: details.customerAddress ?? "",
    brand: details.brand ?? "",
    modelNumber: details.modelNumber ?? "",
    serialNumber: details.serialNumber ?? "",
    applianceAge: details.applianceAge === undefined ? "" : String(details.applianceAge),
    applianceGrade: details.applianceGrade ?? "",
    applianceColor: details.applianceColor ?? "",
    laborAmount: details.laborAmount.toFixed(2),
    taxAmount: details.taxAmount.toFixed(2),
    parts: details.parts.map((part) => ({
      ...part,
      quantity: String(part.quantity),
      unitPrice: part.unitPrice.toFixed(2),
      partFunction: part.partFunction ?? "",
      failureReason: part.failureReason ?? "",
    })),
  };
}

// Plug into a page schema's superRefine. `ahsRequired` is a hidden form
// value the page keeps in sync with "AHS + Authorization + flag on".
export function addAhsDetailsIssues(
  data: { ahsRequired?: boolean; ahsDetails?: unknown },
  ctx: z.RefinementCtx,
) {
  if (!data.ahsRequired) return;
  const parsed = ahsDetailsSchema.safeParse(data.ahsDetails);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({ ...issue, path: ["ahsDetails", ...issue.path] });
  }
}

// The tech-submit localStorage draft must not hold customer PII. Everything
// else in the AHS section is kept so a resumed draft loses nothing else.
export function omitAhsCustomerPiiFromDraft<T extends Record<string, unknown>>(formValues: T): T {
  const details = formValues.ahsDetails;
  if (!details || typeof details !== "object" || Array.isArray(details)) return formValues;
  const { customerName: _name, customerAddress: _address, ...rest } = details as Record<string, unknown>;
  return { ...formValues, ahsDetails: rest };
}

// ---------------------------------------------------------------------------
// Service-order prefill (GET /api/tech/ahs-prefill, shared/ahs-prefill.ts)
// ---------------------------------------------------------------------------

// Appliance fields the browser may receive and put into the form. The
// dispatch number is filled on the server; the browser only learns whether
// one exists.
export const AHS_PREFILL_APPLIANCE_FIELDS = ["brand", "modelNumber", "serialNumber"] as const;
export type AhsPrefillApplianceField = (typeof AHS_PREFILL_APPLIANCE_FIELDS)[number];
export type AhsPrefillApplianceValues = Partial<Record<AhsPrefillApplianceField, string>>;

export const AHS_PREFILL_HINT = "From service order — check against the model tag photo";
export const AHS_DISPATCH_FROM_SO_TEXT = "Dispatch number will be filled from the service order";

// "DDDD-SSSSSSSS" → its two parts, or null while the SO is incomplete.
export function splitAhsServiceOrder(
  value: string | null | undefined,
): { district: string; serviceOrder: string } | null {
  const match = /^(\d{4})-(\d{8})$/.exec((value ?? "").trim());
  return match ? { district: match[1], serviceOrder: match[2] } : null;
}

// Anything that isn't a well-formed response is treated as "unavailable",
// so the form falls back to manual entry.
export function normalizeAhsPrefillResponse(body: unknown): AhsPrefillResponse {
  if (!body || typeof body !== "object") return { status: "unavailable" };
  const value = body as Record<string, unknown>;
  if (value.status === "not_found") return { status: "not_found" };
  if (value.status !== "found") return { status: "unavailable" };
  const raw = value.appliance && typeof value.appliance === "object"
    ? (value.appliance as Record<string, unknown>)
    : {};
  const appliance: AhsPrefillApplianceValues = {};
  for (const field of AHS_PREFILL_APPLIANCE_FIELDS) {
    const text = typeof raw[field] === "string" ? (raw[field] as string).trim().slice(0, 100) : "";
    if (text) appliance[field] = text;
  }
  return { status: "found", appliance, hasDispatchNumber: value.hasDispatchNumber === true };
}

// Which form values to set from a lookup. A field is filled only when it is
// blank, or still holds the value an earlier lookup put there (the tech
// changed the service order); such a leftover is cleared when the new
// lookup has no value for it. A value the tech typed is never overwritten.
export function ahsPrefillUpdates(
  current: Partial<Record<AhsPrefillApplianceField, unknown>> | null | undefined,
  appliance: AhsPrefillApplianceValues,
  previouslyFilled: AhsPrefillApplianceValues = {},
): AhsPrefillApplianceValues {
  const updates: AhsPrefillApplianceValues = {};
  for (const field of AHS_PREFILL_APPLIANCE_FIELDS) {
    const next = appliance[field] ?? "";
    const value = typeof current?.[field] === "string" ? (current[field] as string).trim() : "";
    const untouched = value === "" || value === previouslyFilled[field];
    if (untouched && value !== next) updates[field] = next;
  }
  return updates;
}

export function isAhsPrefilledValue(
  prefill: AhsPrefillResponse | null | undefined,
  field: AhsPrefillApplianceField,
  value: unknown,
): boolean {
  if (prefill?.status !== "found") return false;
  const expected = prefill.appliance[field];
  return Boolean(expected) && typeof value === "string" && value.trim() === expected;
}

export function ahsDispatchNumberFromServiceOrder(
  prefill: AhsPrefillResponse | null | undefined,
): boolean {
  return prefill?.status === "found" && prefill.hasDispatchNumber;
}

function toAmount(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(String(value).replace(/[$,\s]/g, ""));
  return String(value).trim() !== "" && Number.isFinite(n) ? n : null;
}

function money(value: number) {
  return `$${value.toFixed(2)}`;
}

function TextField({
  form,
  name,
  label,
  placeholder,
  inputMode,
  testId,
  hint,
}: {
  form: UseFormReturn<any>;
  name: string;
  label: string;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal";
  testId: string;
  hint?: string | null;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              value={field.value ?? ""}
              placeholder={placeholder}
              inputMode={inputMode}
              data-testid={testId}
            />
          </FormControl>
          {hint ? (
            <FormDescription className="text-xs" data-testid={`${testId}-hint`}>
              {hint}
            </FormDescription>
          ) : null}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function SelectField({
  form,
  name,
  label,
  placeholder,
  options,
  testId,
}: {
  form: UseFormReturn<any>;
  name: string;
  label: string;
  placeholder: string;
  options: readonly { value: string; label: string }[];
  testId: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <Select onValueChange={field.onChange} value={field.value || undefined}>
            <FormControl>
              <SelectTrigger ref={field.ref} data-testid={testId}>
                <SelectValue placeholder={placeholder} />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// Replaces the division dropdown for AHS tickets. Picking a detailed type
// also sets the routing division (applianceType) the rest of the app uses.
export function AhsApplianceKindField({ form }: { form: UseFormReturn<any> }) {
  const divisionError = form.formState.errors.applianceType?.message;
  return (
    <FormField
      control={form.control}
      name="ahsDetails.applianceKind"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Appliance Type *</FormLabel>
          <Select
            value={field.value || undefined}
            onValueChange={(value) => {
              field.onChange(value);
              const kind = ahsApplianceKind(value);
              if (kind) {
                form.setValue("applianceType", kind.division, {
                  shouldValidate: form.formState.isSubmitted,
                });
              }
            }}
          >
            <FormControl>
              <SelectTrigger ref={field.ref} data-testid="select-ahs-appliance-kind">
                <SelectValue placeholder="Select appliance type" />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {AHS_APPLIANCE_KINDS.map((kind) => (
                <SelectItem
                  key={kind.value}
                  value={kind.value}
                  data-testid={`option-ahs-${kind.value}`}
                >
                  {kind.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
          {!field.value && divisionError ? (
            <p className="text-sm font-medium text-destructive">{String(divisionError)}</p>
          ) : null}
        </FormItem>
      )}
    />
  );
}

export function AhsDetailsCard({
  form,
  prefill,
}: {
  form: UseFormReturn<any>;
  // Latest service-order lookup; null/undefined while off or loading.
  prefill?: AhsPrefillResponse | null;
}) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "ahsDetails.parts",
  });
  const values = (form.watch("ahsDetails") ?? {}) as Partial<AhsDetailsFormValues>;
  const partLines = (values.parts ?? []).map((part) => {
    // Blank quantity counts as 1, the same default the schema applies.
    const quantity = String(part?.quantity ?? "").trim() === "" ? 1 : toAmount(part?.quantity);
    const price = toAmount(part?.unitPrice);
    return quantity !== null && price !== null ? roundCents(quantity * price) : null;
  });
  const partCost = roundCents(partLines.reduce<number>((sum, line) => sum + (line ?? 0), 0));
  const total = roundCents(
    partCost + (toAmount(values.laborAmount) ?? 0) + (toAmount(values.taxAmount) ?? 0),
  );
  const partsError = form.getFieldState("ahsDetails.parts", form.formState).error?.message;
  const dispatchFromServiceOrder = ahsDispatchNumberFromServiceOrder(prefill);
  const hintFor = (field: AhsPrefillApplianceField) =>
    isAhsPrefilledValue(prefill, field, values[field]) ? AHS_PREFILL_HINT : null;

  return (
    <Card data-testid="card-ahs-details">
      <CardContent className="p-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            AHS Authorization Details
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            VRS AI uses these to call American Home Shield for you. Fields marked * are
            required. Leave the others blank if you don't have them; VRS AI confirms them
            with AHS.
          </p>
        </div>

        <div className="space-y-4" data-testid="section-ahs-service-order">
          {dispatchFromServiceOrder ? (
            <p
              className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground"
              data-testid="text-ahs-dispatch-from-so"
            >
              {AHS_DISPATCH_FROM_SO_TEXT}
            </p>
          ) : (
            <TextField
              form={form}
              name="ahsDetails.contractNumber"
              label="Dispatch / Contract Number (optional)"
              testId="input-ahs-contract-number"
            />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              form={form}
              name="ahsDetails.brand"
              label="Brand (optional)"
              testId="input-ahs-brand"
              hint={hintFor("brand")}
            />
            <TextField
              form={form}
              name="ahsDetails.modelNumber"
              label="Model Number (optional)"
              testId="input-ahs-model"
              hint={hintFor("modelNumber")}
            />
            <TextField
              form={form}
              name="ahsDetails.serialNumber"
              label="Serial Number (optional)"
              testId="input-ahs-serial"
              hint={hintFor("serialNumber")}
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            form={form}
            name="ahsDetails.failureCause"
            label="Failure Cause *"
            placeholder="Why did it break?"
            options={AHS_FAILURE_CAUSES}
            testId="select-ahs-failure-cause"
          />
          <SelectField
            form={form}
            name="ahsDetails.applianceLocation"
            label="Appliance Location *"
            placeholder="Select location"
            options={AHS_APPLIANCE_LOCATIONS.map((location) => ({ value: location, label: location }))}
            testId="select-ahs-location"
          />
          <SelectField
            form={form}
            name="ahsDetails.techRecommendation"
            label="Repair or Replace *"
            placeholder="Select one"
            options={AHS_TECH_RECOMMENDATIONS}
            testId="select-ahs-recommendation"
          />
        </div>

        <div className="space-y-3">
          <p className="text-sm font-medium">Parts *</p>
          {fields.map((part, index) => (
            <div
              key={part.id}
              className="rounded-md border p-3 space-y-3"
              data-testid={`ahs-part-${index}`}
            >
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
                    data-testid={`button-remove-ahs-part-${index}`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
              <div className="grid gap-3 grid-cols-3">
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
                label="Part Function (optional)"
                placeholder="What the part does"
                testId={`input-ahs-part-${index}-function`}
              />
              <TextField
                form={form}
                name={`ahsDetails.parts.${index}.failureReason`}
                label="Failure Reason (optional)"
                placeholder="Why this part failed"
                testId={`input-ahs-part-${index}-failure-reason`}
              />
            </div>
          ))}
          {partsError ? (
            <p className="text-sm font-medium text-destructive">{partsError}</p>
          ) : null}
          {fields.length < MAX_PARTS && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => append(emptyAhsPart())}
              data-testid="button-add-ahs-part"
            >
              <Plus className="w-4 h-4 mr-1" />
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
          />
          <TextField
            form={form}
            name="ahsDetails.taxAmount"
            label="Total Tax Amount (optional)"
            inputMode="decimal"
            placeholder="0.00"
            testId="input-ahs-tax"
          />
        </div>

        <div className="rounded-md bg-muted/50 p-3 text-sm space-y-1">
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Part cost (all parts)</span>
            <span className="font-medium" data-testid="text-ahs-part-cost">{money(partCost)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Total (parts + labor + tax)</span>
            <span className="font-semibold" data-testid="text-ahs-total">{money(total)}</span>
          </div>
        </div>

        <div className="space-y-4 border-t pt-4" data-testid="section-ahs-optional">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            More details (optional)
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              form={form}
              name="ahsDetails.applianceGrade"
              label="Appliance Grade"
              placeholder="Select grade"
              options={AHS_APPLIANCE_GRADES}
              testId="select-ahs-grade"
            />
            <TextField
              form={form}
              name="ahsDetails.applianceColor"
              label="Appliance Color"
              placeholder="e.g., White, Stainless"
              testId="input-ahs-color"
            />
            <TextField
              form={form}
              name="ahsDetails.applianceAge"
              label="Appliance Age (years)"
              inputMode="numeric"
              testId="input-ahs-age"
            />
          </div>
          <TextField
            form={form}
            name="ahsDetails.customerName"
            label="Customer Name"
            testId="input-ahs-customer-name"
          />
          <FormField
            control={form.control}
            name="ahsDetails.customerAddress"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Customer Address</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    value={field.value ?? ""}
                    rows={2}
                    placeholder="Street, city, state, ZIP"
                    data-testid="input-ahs-customer-address"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}
