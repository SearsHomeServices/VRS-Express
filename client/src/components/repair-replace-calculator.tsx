// Built-in repair / replace calculator for Sears Protect tickets (Sears
// Protect Home Warranty, Sears Home Warranty, Sears PA / Cinch). Replaces
// the Streamlit iframe in the agent dashboard's Calculator tab when
// REPAIR_REPLACE_CALCULATOR_ENABLED is on.
//
// Two calculators on the same inputs (shared/repair-replace.ts):
//   - Legacy formulas: what the Streamlit calculator does today (Standard,
//     PA 2.0 by age band, First American / AHS estimators, the Sears Protect
//     $3,500 cap). The default tab.
//   - Forward Repair Cost: the new model with five hard stops. Its policy
//     (illustrative-v1) is not approved, and the tab says so.
// The service order fills what it can prove (GET /api/submissions/:id/
// repair-replace/prefill) with a "From service order" badge; the manager
// enters the rest. Results recompute as they type. "Save to ticket notes"
// re-runs the check on the server and stores the summary as a staff-only
// note. Nothing here buys or authorizes a replacement.
//
// No customer data is read or shown, and nothing is stored in the browser.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardCopy, ExternalLink, Info, Loader2, NotebookPen, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  APPLIANCE_REPLACEMENT,
  PA20_AGE_BANDS,
  RR_APPLIANCES,
  RR_APPLIANCE_LABELS,
  RR_CALCULATOR_TYPES,
  RR_ESTIMATOR_CATEGORIES,
  RR_FIELD_LABELS,
  RR_MAJOR_COMPONENTS,
  RR_NOT_MAJOR_COMPONENT,
  RR_RULE_LABELS,
  RR_SERVICER_TYPES,
  CONTRACTOR_LABOR,
  evaluateFrc,
  evaluateLegacy,
  legacyCalculatorKind,
  rrRouteTitle,
  rrSummaryText,
  type RrInput,
  type RrModel,
  type RrPrefillField,
  type RrPrefillResponse,
  type RrResult,
} from "@shared/repair-replace";

export interface RepairReplaceTicket {
  id: number;
  serviceOrder: string;
  procId?: string | null;
}

type YesNo = "" | "true" | "false";
type PartsStatus = "" | "on_hand" | "backordered" | "unavailable" | "unknown";

interface FormState {
  appliance: string; // one of RR_APPLIANCES, "other", or ""
  applianceOther: string;
  ageYears: string;
  replacementCost: string;
  major: "" | "yes" | "no" | "unsure";
  component: string; // one of RR_MAJOR_COMPONENTS or "other"
  componentOther: string;
  partsCost: string;
  laborCost: string;
  tripCost: string;
  visitNumber: string;
  unresolved: YesNo;
  failedAttempts: string;
  otherServiceOrders: string;
  samePart: YesNo;
  contractSpend: string;
  confident: YesNo;
  partsStatus: PartsStatus;
  backorderDays: string;
  // Legacy
  calculatorType: string;
  catalog: string;
  sellPrice: string;
  quantity: string;
  procId: string;
  ageBand: string;
  servicerType: string;
  repairHours: string;
  laborCategory: string;
  taxRate: string;
}

type FieldKey = keyof FormState;

function blankForm(procId: string | null | undefined): FormState {
  return {
    appliance: "", applianceOther: "", ageYears: "", replacementCost: "", major: "", component: "", componentOther: "",
    partsCost: "", laborCost: "", tripCost: "", visitNumber: "", unresolved: "", failedAttempts: "",
    otherServiceOrders: "", samePart: "", contractSpend: "", confident: "", partsStatus: "", backorderDays: "",
    calculatorType: "Standard", catalog: "", sellPrice: "", quantity: "", procId: procId ?? "", ageBand: "",
    servicerType: "", repairHours: "", laborCategory: "", taxRate: "",
  };
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value.trim());
const yesNo = (value: YesNo) => (value === "" ? null : value === "true");

// The PA 2.0 band an age in years falls in (whole years).
export function ageBandForYears(age: string): string {
  const years = Number(age);
  if (age.trim() === "" || !Number.isFinite(years) || years < 0) return "";
  const whole = Math.floor(years);
  if (whole <= 2) return "0 - 2 years";
  if (whole <= 8) return `${whole} years`;
  if (whole <= 11) return "9 - 11 years";
  if (whole <= 14) return "12 - 14 years";
  return "15+ years";
}

export function frcInputFromForm(form: FormState): RrInput {
  const appliance = form.appliance === "other" ? blankToNull(form.applianceOther) : blankToNull(form.appliance);
  let component: string | null = null;
  if (form.major === "no") component = RR_NOT_MAJOR_COMPONENT;
  else if (form.major === "yes") component = form.component === "other" ? blankToNull(form.componentOther) : blankToNull(form.component);
  let partsAvailable: boolean | null = null;
  let backorderDays: string | null = null;
  if (form.partsStatus === "on_hand") { partsAvailable = true; backorderDays = "0"; }
  else if (form.partsStatus === "backordered") { partsAvailable = true; backorderDays = blankToNull(form.backorderDays); }
  else if (form.partsStatus === "unavailable") { partsAvailable = false; backorderDays = blankToNull(form.backorderDays); }
  // Blank replacement cost uses the appliance reference price, as legacy does.
  const catalogCost = form.catalog ? APPLIANCE_REPLACEMENT[form.catalog] : null;
  return {
    appliance_type: appliance,
    age_years: blankToNull(form.ageYears),
    replacement_cost: blankToNull(form.replacementCost) ?? (catalogCost != null ? String(catalogCost) : null),
    component,
    parts_cost: blankToNull(form.partsCost),
    labor_cost: blankToNull(form.laborCost),
    trip_cost: blankToNull(form.tripCost),
    visit_number: blankToNull(form.visitNumber),
    unresolved: yesNo(form.unresolved),
    failed_attempt_count: blankToNull(form.failedAttempts),
    other_service_orders_12mo: blankToNull(form.otherServiceOrders),
    same_part_or_system_repeat: yesNo(form.samePart),
    technician_confident: yesNo(form.confident),
    parts_available: partsAvailable,
    backorder_days: backorderDays,
    contract_spend: blankToNull(form.contractSpend),
  };
}

export function legacyInputFromForm(form: FormState): RrInput {
  const catalogCost = form.catalog ? APPLIANCE_REPLACEMENT[form.catalog] : null;
  const partsCost = blankToNull(form.partsCost);
  return {
    calculator_type: form.calculatorType || "Standard",
    appliance_type: form.catalog || (form.appliance === "other" ? blankToNull(form.applianceOther) : blankToNull(form.appliance)),
    replacement_cost: blankToNull(form.replacementCost) ?? (catalogCost != null ? String(catalogCost) : null),
    proc_id: form.procId.trim(),
    // The order's job-code charges (or typed labor) win over hours / category.
    labor_cost: blankToNull(form.laborCost),
    servicer_type: blankToNull(form.servicerType),
    repair_hours: blankToNull(form.repairHours),
    labor_category: blankToNull(form.laborCategory),
    tax_rate: blankToNull(form.taxRate),
    age_band: blankToNull(form.ageBand),
    parts: [{ cost: partsCost, sell_price: blankToNull(form.sellPrice) ?? partsCost, quantity: blankToNull(form.quantity) ?? "1" }],
  };
}

// Which form field each prefill field lands in.
const PREFILL_TARGETS: Partial<Record<keyof RrPrefillResponse["fields"], FieldKey>> = {
  appliance_type: "appliance",
  age_years: "ageYears",
  parts_cost: "partsCost",
  labor_cost: "laborCost",
  trip_cost: "tripCost",
  technician_confident: "confident",
  appliance_reference: "catalog",
  servicer_type: "servicerType",
  visit_number: "visitNumber",
  unresolved: "unresolved",
  failed_attempt_count: "failedAttempts",
  other_service_orders_12mo: "otherServiceOrders",
  same_part_or_system_repeat: "samePart",
  tax_rate: "taxRate",
  sell_price: "sellPrice",
};

function sourceLabel(field: RrPrefillField): string {
  return field.source === "ticket" ? "From technician" : "From service order";
}

// "4 fields filled: 2 from the technician, 2 from the service order."
export function filledSummary(prefilled: Partial<Record<string, RrPrefillField>>): string {
  const fields = Object.values(prefilled).filter(Boolean) as RrPrefillField[];
  if (!fields.length) return "No fields filled.";
  const fromTech = fields.filter((field) => field.source === "ticket").length;
  const fromOrder = fields.length - fromTech;
  const parts = [
    fromTech ? `${fromTech} from the technician` : "",
    fromOrder ? `${fromOrder} from the service order` : "",
  ].filter(Boolean);
  return `${fields.length} field${fields.length === 1 ? "" : "s"} filled: ${parts.join(", ")}.`;
}

function SourceBadge({ field, testId }: { field?: RrPrefillField; testId: string }) {
  if (!field) return null;
  return (
    <Badge variant="secondary" className="text-[10px] font-normal" title={field.source_field} data-testid={testId}>
      {sourceLabel(field)}
    </Badge>
  );
}

function money(value: string | null | undefined): string {
  if (!value) return "—";
  const amount = Number(value);
  return Number.isFinite(amount)
    ? `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${value}`;
}

function RouteBanner({ result, testId }: { result: RrResult; testId: string }) {
  const ok = result.route === "continue_authorization";
  const Icon = ok ? CheckCircle2 : AlertTriangle;
  return (
    <div
      className={`rounded-md border p-3 flex items-start gap-2 ${ok ? "border-green-600/40 bg-green-50 dark:bg-green-950/30" : "border-amber-500/50 bg-amber-50 dark:bg-amber-950/30"}`}
      data-testid={testId}
    >
      <Icon className={`w-5 h-5 shrink-0 ${ok ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`} />
      <div className="min-w-0">
        <p className="font-semibold">{rrRouteTitle(result.route)}</p>
        <p className="text-sm text-muted-foreground">{result.explanation}</p>
      </div>
    </div>
  );
}

function ResultDetails({ result, prefix }: { result: RrResult; prefix: string }) {
  const costRows: Array<[string, string | null | undefined]> = result.model === "frc"
    ? [
      ["Current repair (parts + labor + trip)", result.costs.current_repair],
      ["Expected future repair", result.costs.expected_future],
      ["Forward repair cost", result.costs.forward_repair],
      [`Threshold (${result.costs.threshold_rate} of replacement)`, result.costs.threshold_amount],
      ["Replacement", result.costs.replacement],
    ]
    : [
      ["Parts", result.costs.parts],
      ["Labor", result.costs.labor],
      ["Tax", result.costs.tax],
      ["Repair total", result.costs.current_repair],
      ["Replacement", result.costs.replacement],
      ["Comparison value", result.costs.comparison],
    ];
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1" data-testid={`${prefix}-costs`}>
        {costRows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{money(value)}</dd>
          </div>
        ))}
      </dl>
      {result.hard_stops.length > 0 && (
        <div data-testid={`${prefix}-hard-stops`}>
          <p className="font-medium mb-1">Hard stops</p>
          <ul className="space-y-1">
            {result.hard_stops.map((stop) => (
              <li key={stop.rule} className="flex gap-2">
                <Badge
                  variant={stop.status === "fired" ? "destructive" : "outline"}
                  className="shrink-0 text-[10px] h-5"
                >
                  {stop.status === "fired" ? "Fired" : stop.status === "not_fired" ? "Clear" : "Unknown"}
                </Badge>
                <span><span className="font-medium">{RR_RULE_LABELS[stop.rule] ?? stop.rule}:</span> {stop.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.factors.length > 0 && (
        <div>
          <p className="font-medium mb-1">Repeat-repair probability {result.probability ? `${result.probability.capped} (cap ${result.probability.cap})` : ""}</p>
          <ul className="space-y-0.5 text-muted-foreground">
            {result.factors.map((factor) => (
              <li key={factor.name}>×{factor.factor} {factor.applied ? "" : "(not applied) "}— {factor.reason}</li>
            ))}
          </ul>
        </div>
      )}
      {result.missing_inputs.length > 0 && (
        <p data-testid={`${prefix}-missing`}>
          <span className="font-medium">Open checks:</span>{" "}
          {result.missing_inputs.map((key) => RR_FIELD_LABELS[key] ?? key).join(", ")}
        </p>
      )}
      {result.warnings.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground" data-testid={`${prefix}-warnings`}>
          {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function Field({
  id, label, hint, badge, children,
}: { id: string; label: string; hint?: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Label htmlFor={id}>{label}</Label>
        {badge}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Choice<T extends string>({
  id, value, options, onChange,
}: { id: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="radiogroup" id={id}>
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          size="sm"
          variant={value === option.value ? "default" : "outline"}
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(value === option.value ? ("" as T) : option.value)}
          data-testid={`${id}-${option.value}`}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

const YES_NO: Array<{ value: YesNo; label: string }> = [{ value: "true", label: "Yes" }, { value: "false", label: "No" }];

export function RepairReplaceCalculator({
  ticket,
  onUseOldCalculator,
}: {
  ticket: RepairReplaceTicket;
  onUseOldCalculator?: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState<FormState>(() => blankForm(ticket.procId));
  const [model, setModel] = useState<RrModel>("legacy");
  const [prefilled, setPrefilled] = useState<Partial<Record<FieldKey, RrPrefillField>>>({});
  const edited = useRef(new Set<FieldKey>());

  const prefillQuery = useQuery<RrPrefillResponse>({
    queryKey: ["/api/submissions", String(ticket.id), "repair-replace", "prefill"],
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Fill blank or still-prefilled fields; never what the manager typed.
  useEffect(() => {
    const data = prefillQuery.data;
    if (!data) return;
    const next: Partial<Record<FieldKey, RrPrefillField>> = {};
    for (const [name, field] of Object.entries(data.fields) as Array<[keyof RrPrefillResponse["fields"], RrPrefillField]>) {
      const target = PREFILL_TARGETS[name];
      if (target && !edited.current.has(target)) next[target] = field;
    }
    setForm((current) => {
      const updated = { ...current };
      for (const [target, field] of Object.entries(next) as Array<[FieldKey, RrPrefillField]>) {
        (updated as any)[target] = String(field.value);
      }
      if (!edited.current.has("ageBand") && next.ageYears) updated.ageBand = ageBandForYears(updated.ageYears);
      return updated;
    });
    setPrefilled(next);
  }, [prefillQuery.data]);

  const set = <K extends FieldKey>(key: K, value: FormState[K]) => {
    edited.current.add(key);
    setPrefilled((current) => {
      if (!current[key]) return current;
      const { [key]: _removed, ...rest } = current;
      return rest;
    });
    setForm((current) => {
      const updated = { ...current, [key]: value };
      // The PA 2.0 band follows the age until the manager picks one.
      if (key === "ageYears" && !edited.current.has("ageBand")) updated.ageBand = ageBandForYears(String(value));
      return updated;
    });
  };
  const text = (key: FieldKey) => ({
    id: `rr-${key}`,
    value: form[key] as string,
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(key, event.target.value as any),
    "data-testid": `input-rr-${key}`,
  });

  const frcInput = useMemo(() => frcInputFromForm(form), [form]);
  const legacyInput = useMemo(() => legacyInputFromForm(form), [form]);
  const frc = useMemo(() => evaluateFrc(frcInput), [frcInput]);
  const legacy = useMemo(() => evaluateLegacy(legacyInput), [legacyInput]);
  const active = model === "frc" ? frc : legacy;
  const kind = legacyCalculatorKind(form.calculatorType);
  const partsHint = prefillQuery.data?.fields.parts_available?.value === true && !form.partsStatus
    ? "The service order shows a part installed or fulfilled. Confirm it is on hand, or enter the delay."
    : undefined;

  const saveNote = useMutation({
    mutationFn: async () => {
      const body = model === "frc"
        ? { model, input: frcInput, legacyInput }
        : { model, input: legacyInput };
      await apiRequest("POST", `/api/submissions/${ticket.id}/repair-replace/note`, body);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/submissions", String(ticket.id), "notes"] });
      toast({ title: "Calculator result saved", description: "Added to the ticket notes (staff only)." });
    },
    onError: (error: any) => {
      toast({ title: "Could not save the result", description: String(error?.message ?? error), variant: "destructive" });
    },
  });

  const copySummary = async () => {
    try {
      await navigator.clipboard.writeText(rrSummaryText(active, ticket.serviceOrder, model === "frc" ? legacy : null));
      toast({ title: "Summary copied" });
    } catch {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  };

  const prefillStatus = prefillQuery.data?.status;
  const filledCount = Object.keys(prefilled).length;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4" data-testid="panel-repair-replace">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h3 className="font-semibold">Repair / Replace</h3>
          <p className="text-xs text-muted-foreground">Service order {ticket.serviceOrder}. Nothing here buys or authorizes a replacement.</p>
        </div>
        <div className="flex gap-1 flex-wrap">
          <Button
            type="button" size="sm" variant="outline"
            onClick={() => prefillQuery.refetch()}
            disabled={prefillQuery.isFetching}
            data-testid="button-rr-refresh"
          >
            {prefillQuery.isFetching ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Refresh from service order
          </Button>
          {onUseOldCalculator && (
            <Button type="button" size="sm" variant="ghost" onClick={onUseOldCalculator} data-testid="button-rr-old-calculator">
              <ExternalLink className="w-4 h-4 mr-1" /> Old calculator
            </Button>
          )}
        </div>
      </div>

      <div className="rounded-md border p-2 text-xs flex items-start gap-2" data-testid="text-rr-prefill-status">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          {prefillQuery.isLoading ? "Looking up the service order…"
            : prefillQuery.isError ? "The service-order lookup failed. Enter the visit by hand."
            : prefillStatus === "unavailable" || prefillStatus === "not_found"
              ? `${prefillQuery.data?.warnings[0] ?? "No service-order data."} ${filledCount ? `${filledCount} field(s) filled from the ticket.` : ""}`
              : `${filledSummary(prefilled)} Everything else is blank until you enter it; blank is never treated as zero.`}
        </span>
      </div>

      <section className="space-y-3" aria-labelledby="rr-unit">
        <h4 id="rr-unit" className="text-sm font-semibold">Unit and repair</h4>
        <Field id="rr-appliance" label="Appliance" badge={<SourceBadge field={prefilled.appliance} testId="badge-rr-appliance" />}>
          <Choice
            id="rr-appliance"
            value={form.appliance}
            options={[...RR_APPLIANCES.map((value) => ({ value: value as string, label: RR_APPLIANCE_LABELS[value] })), { value: "other", label: "Other" }]}
            onChange={(value) => set("appliance", value)}
          />
          {form.appliance === "other" && (
            <Input {...text("applianceOther")} placeholder="Appliance name" maxLength={80} aria-label="Appliance name" />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field id="rr-ageYears" label="Age (years)" badge={<SourceBadge field={prefilled.ageYears} testId="badge-rr-age" />}>
            <Input {...text("ageYears")} inputMode="decimal" />
          </Field>
          <Field id="rr-replacementCost" label="Replacement cost ($)" hint={form.catalog && !form.replacementCost && APPLIANCE_REPLACEMENT[form.catalog] != null
            ? `Blank uses the appliance reference price, ${money(String(APPLIANCE_REPLACEMENT[form.catalog]))}.` : undefined}>
            <Input {...text("replacementCost")} inputMode="decimal" />
          </Field>
          <Field id="rr-partsCost" label="Parts cost ($)" badge={<SourceBadge field={prefilled.partsCost} testId="badge-rr-parts" />}>
            <Input {...text("partsCost")} inputMode="decimal" />
          </Field>
          <Field id="rr-laborCost" label="Labor ($)" badge={<SourceBadge field={prefilled.laborCost} testId="badge-rr-labor" />}
            hint={model === "legacy" ? "Blank uses the servicer and hours (or labor category) below." : undefined}>
            <Input {...text("laborCost")} inputMode="decimal" />
          </Field>
          <Field id="rr-tripCost" label="Trip charge ($)" badge={<SourceBadge field={prefilled.tripCost} testId="badge-rr-trip" />}>
            <Input {...text("tripCost")} inputMode="decimal" />
          </Field>
        </div>
      </section>

      <Tabs value={model} onValueChange={(value) => setModel(value as RrModel)}>
        <TabsList className="w-full">
          <TabsTrigger value="legacy" className="flex-1" data-testid="tab-rr-legacy">Legacy formulas</TabsTrigger>
          <TabsTrigger value="frc" className="flex-1" data-testid="tab-rr-frc">Forward Repair Cost</TabsTrigger>
        </TabsList>

        <TabsContent value="legacy" className="space-y-3 pt-2">
          <div className="grid grid-cols-2 gap-3">
            <Field id="rr-calculator" label="Calculator">
              <Select value={form.calculatorType} onValueChange={(value) => set("calculatorType", value)}>
                <SelectTrigger id="rr-calculator" data-testid="select-rr-calculator"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RR_CALCULATOR_TYPES.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field id="rr-catalog" label="Appliance reference" badge={<SourceBadge field={prefilled.catalog} testId="badge-rr-catalog" />}
              hint={form.catalog ? `Reference price ${APPLIANCE_REPLACEMENT[form.catalog] != null ? `$${APPLIANCE_REPLACEMENT[form.catalog]}` : "none"}.` : "Or enter a replacement cost above."}>
              <Select value={form.catalog || "none"} onValueChange={(value) => set("catalog", value === "none" ? "" : value)}>
                <SelectTrigger id="rr-catalog" data-testid="select-rr-catalog"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {Object.keys(APPLIANCE_REPLACEMENT).map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {form.calculatorType === "PA 2.0" && (
              <Field id="rr-ageBand" label="PA 2.0 age band"
                badge={form.ageBand && !edited.current.has("ageBand") && form.ageBand === ageBandForYears(form.ageYears)
                  ? <Badge variant="secondary" className="text-[10px] font-normal">From age</Badge> : undefined}>
                <Select value={form.ageBand || "none"} onValueChange={(value) => set("ageBand", value === "none" ? "" : value)}>
                  <SelectTrigger id="rr-ageBand" data-testid="select-rr-age-band"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select age band</SelectItem>
                    {PA20_AGE_BANDS.map((band) => <SelectItem key={band} value={band}>{band}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {kind === "estimate" ? (
              <>
                <Field id="rr-laborCategory" label="Labor category">
                  <Choice id="rr-laborCategory" value={form.laborCategory}
                    options={RR_ESTIMATOR_CATEGORIES.map((value) => ({ value: value as string, label: value }))}
                    onChange={(value) => set("laborCategory", value)} />
                </Field>
              </>
            ) : (
              <>
                <Field id="rr-servicer" label="Servicer" badge={<SourceBadge field={prefilled.servicerType} testId="badge-rr-servicer" />}>
                  <Choice id="rr-servicer" value={form.servicerType}
                    options={RR_SERVICER_TYPES.map((value) => ({ value: value as string, label: value }))}
                    onChange={(value) => set("servicerType", value)} />
                </Field>
                {form.servicerType === "Sears Tech" && (
                  <Field id="rr-repairHours" label="Repair hours" hint="Used when Labor is blank: hours × $32 + $27.">
                    <Input {...text("repairHours")} inputMode="decimal" />
                  </Field>
                )}
                {form.servicerType === "1099" && (
                  <Field id="rr-laborCategory" label="Labor category">
                    <Choice id="rr-laborCategory" value={form.laborCategory}
                      options={Object.keys(CONTRACTOR_LABOR).map((value) => ({ value, label: `${value} ($${CONTRACTOR_LABOR[value]})` }))}
                      onChange={(value) => set("laborCategory", value)} />
                  </Field>
                )}
              </>
            )}
            <Field id="rr-sellPrice" label="Sell price ($)" badge={<SourceBadge field={prefilled.sellPrice} testId="badge-rr-sell" />}
              hint="All parts at the customer's price. Blank uses the parts cost.">
              <Input {...text("sellPrice")} inputMode="decimal" />
            </Field>
            <Field id="rr-quantity" label="Quantity" hint="Blank is 1.">
              <Input {...text("quantity")} inputMode="numeric" />
            </Field>
            <Field id="rr-taxRate" label="Tax rate" badge={<SourceBadge field={prefilled.taxRate} testId="badge-rr-tax" />}
              hint={kind === "estimate" ? "Example 0.08, on parts and labor. Blank adds no tax." : "Example 0.08, on parts. Blank adds no tax."}>
              <Input {...text("taxRate")} inputMode="decimal" />
            </Field>
            <Field id="rr-procId" label="Proc ID" hint={'Containing "Sears Protect Home Warranty" caps replacement at $3,500.'}>
              <Input {...text("procId")} maxLength={120} />
            </Field>
          </div>
          <RouteBanner result={legacy} testId="result-rr-legacy" />
          <ResultDetails result={legacy} prefix="rr-legacy" />
        </TabsContent>

        <TabsContent value="frc" className="space-y-3 pt-2">
          <p className="text-xs rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-2" data-testid="text-rr-policy-note">
            Policy {frc.policy_version} is illustrative and not approved. Use it to compare, not to decide on its own.
          </p>
          <Field id="rr-major" label="Is a major component involved?" hint="Compressor, transmission, control board or sealed system.">
            <Choice id="rr-major" value={form.major}
              options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }, { value: "unsure", label: "Not sure" }]}
              onChange={(value) => set("major", value)} />
          </Field>
          {form.major === "yes" && (
            <Field id="rr-component" label="Which component?">
              <Choice id="rr-component" value={form.component}
                options={[...RR_MAJOR_COMPONENTS.map((value) => ({ value: value as string, label: value[0].toUpperCase() + value.slice(1) })), { value: "other", label: "Other" }]}
                onChange={(value) => set("component", value)} />
              {form.component === "other" && <Input {...text("componentOther")} placeholder="Component name" maxLength={80} aria-label="Component name" />}
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field id="rr-visitNumber" label="Visit number on this order" hint="This visit counts; the first is 1."
              badge={<SourceBadge field={prefilled.visitNumber} testId="badge-rr-visit" />}>
              <Input {...text("visitNumber")} inputMode="numeric" />
            </Field>
            <Field id="rr-unresolved" label="Still unresolved?" badge={<SourceBadge field={prefilled.unresolved} testId="badge-rr-unresolved" />}>
              <Choice id="rr-unresolved" value={form.unresolved} options={YES_NO} onChange={(value) => set("unresolved", value)} />
            </Field>
            <Field id="rr-failedAttempts" label="Failed attempts before this visit" badge={<SourceBadge field={prefilled.failedAttempts} testId="badge-rr-failed" />}>
              <Input {...text("failedAttempts")} inputMode="numeric" />
            </Field>
            <Field id="rr-otherServiceOrders" label="Other service orders, 12 months" hint="Not counting this one."
              badge={<SourceBadge field={prefilled.otherServiceOrders} testId="badge-rr-other-orders" />}>
              <Input {...text("otherServiceOrders")} inputMode="numeric" />
            </Field>
            <Field id="rr-samePart" label="Same part or system again?" badge={<SourceBadge field={prefilled.samePart} testId="badge-rr-same-part" />}>
              <Choice id="rr-samePart" value={form.samePart} options={YES_NO} onChange={(value) => set("samePart", value)} />
            </Field>
            <Field id="rr-contractSpend" label="Contract spend so far ($)">
              <Input {...text("contractSpend")} inputMode="decimal" />
            </Field>
            <Field id="rr-confident" label="Tech confident in the root cause?" badge={<SourceBadge field={prefilled.confident} testId="badge-rr-confident" />}>
              <Choice id="rr-confident" value={form.confident} options={YES_NO} onChange={(value) => set("confident", value)} />
            </Field>
          </div>
          <Field id="rr-partsStatus" label="Parts for this repair" hint={partsHint}>
            <Choice id="rr-partsStatus" value={form.partsStatus}
              options={[
                { value: "on_hand", label: "On hand" }, { value: "backordered", label: "Backordered" },
                { value: "unavailable", label: "Unavailable" }, { value: "unknown", label: "Not sure" },
              ]}
              onChange={(value) => set("partsStatus", value)} />
          </Field>
          {(form.partsStatus === "backordered" || form.partsStatus === "unavailable") && (
            <Field id="rr-backorderDays" label="Backorder days">
              <Input {...text("backorderDays")} inputMode="numeric" />
            </Field>
          )}
          <RouteBanner result={frc} testId="result-rr-frc" />
          <ResultDetails result={frc} prefix="rr-frc" />
        </TabsContent>
      </Tabs>

      <div className="flex gap-2 flex-wrap border-t pt-3">
        <Button type="button" size="sm" onClick={() => saveNote.mutate()} disabled={saveNote.isPending} data-testid="button-rr-save-note">
          {saveNote.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <NotebookPen className="w-4 h-4 mr-1" />}
          Save to ticket notes
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={copySummary} data-testid="button-rr-copy">
          <ClipboardCopy className="w-4 h-4 mr-1" /> Copy summary
        </Button>
      </div>
      {prefillQuery.data && prefillQuery.data.warnings.length > 1 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Service-order lookup notes</summary>
          <ul className="list-disc pl-5 mt-1">
            {prefillQuery.data.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
