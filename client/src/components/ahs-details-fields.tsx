import { useFieldArray, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { Plus, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  FormControl,
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
  ahsApplianceKind,
  ahsDetailsSchema,
  roundCents,
  type AhsDetails,
} from "@shared/ahs-details";

// AHS authorization details on the tech submit and resubmit forms. Shown
// only for AHS + Authorization while VRS AI enrollment is enabled; VRS AI
// needs every field to call American Home Shield. Validation is the shared
// schema (shared/ahs-details.ts), wired into each page's form resolver via
// addAhsDetailsIssues so errors behave like every other field.

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
    laborAmount: "",
    taxAmount: "",
    parts: [emptyAhsPart()],
  };
}

export function ahsDetailsToForm(details: AhsDetails): AhsDetailsFormValues {
  return {
    ...details,
    applianceAge: String(details.applianceAge),
    laborAmount: details.laborAmount.toFixed(2),
    taxAmount: details.taxAmount.toFixed(2),
    parts: details.parts.map((part) => ({
      ...part,
      quantity: String(part.quantity),
      unitPrice: part.unitPrice.toFixed(2),
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
}: {
  form: UseFormReturn<any>;
  name: string;
  label: string;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal";
  testId: string;
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

export function AhsDetailsCard({ form }: { form: UseFormReturn<any> }) {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "ahsDetails.parts",
  });
  const values = (form.watch("ahsDetails") ?? {}) as Partial<AhsDetailsFormValues>;
  const partLines = (values.parts ?? []).map((part) => {
    const quantity = toAmount(part?.quantity);
    const price = toAmount(part?.unitPrice);
    return quantity !== null && price !== null ? roundCents(quantity * price) : null;
  });
  const partCost = roundCents(partLines.reduce<number>((sum, line) => sum + (line ?? 0), 0));
  const total = roundCents(
    partCost + (toAmount(values.laborAmount) ?? 0) + (toAmount(values.taxAmount) ?? 0),
  );
  const partsError = form.getFieldState("ahsDetails.parts", form.formState).error?.message;

  return (
    <Card data-testid="card-ahs-details">
      <CardContent className="p-4 space-y-4">
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            AHS Authorization Details
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            VRS AI uses these to call American Home Shield for you. Copy them from the
            TechHub estimate.
          </p>
        </div>

        <TextField
          form={form}
          name="ahsDetails.contractNumber"
          label="Dispatch / Contract Number *"
          testId="input-ahs-contract-number"
        />
        <TextField
          form={form}
          name="ahsDetails.customerName"
          label="Customer Name *"
          testId="input-ahs-customer-name"
        />
        <FormField
          control={form.control}
          name="ahsDetails.customerAddress"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Customer Address *</FormLabel>
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

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField form={form} name="ahsDetails.brand" label="Brand *" testId="input-ahs-brand" />
          <TextField
            form={form}
            name="ahsDetails.modelNumber"
            label="Model Number *"
            testId="input-ahs-model"
          />
          <TextField
            form={form}
            name="ahsDetails.serialNumber"
            label="Serial Number *"
            testId="input-ahs-serial"
          />
          <TextField
            form={form}
            name="ahsDetails.applianceAge"
            label="Appliance Age (years) *"
            inputMode="numeric"
            testId="input-ahs-age"
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
            name="ahsDetails.applianceGrade"
            label="Appliance Grade *"
            placeholder="Select grade"
            options={AHS_APPLIANCE_GRADES}
            testId="select-ahs-grade"
          />
          <TextField
            form={form}
            name="ahsDetails.applianceColor"
            label="Appliance Color *"
            placeholder="e.g., White, Stainless"
            testId="input-ahs-color"
          />
          <SelectField
            form={form}
            name="ahsDetails.failureCause"
            label="Failure Cause *"
            placeholder="Why did it break?"
            options={AHS_FAILURE_CAUSES}
            testId="select-ahs-failure-cause"
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
                  label="Qty *"
                  inputMode="numeric"
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
                label="Part Function *"
                placeholder="What the part does"
                testId={`input-ahs-part-${index}-function`}
              />
              <TextField
                form={form}
                name={`ahsDetails.parts.${index}.failureReason`}
                label="Failure Reason *"
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
            label="Total Tax Amount *"
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
      </CardContent>
    </Card>
  );
}
