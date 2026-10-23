// AHS (American Home Shield) authorization details captured on the
// technician form so the ticket can be sent to VRS AI.
//
// One schema validates both sides: the tech form (string inputs, coerced
// here) and POST /api/submissions. The stored JSON lives in
// submissions.ahs_details; server/vrs-app-enroll.ts maps it onto the VRS AI
// V9 authorize contract.
import { z } from "zod";
import { AHS_PREFILL_FIELDS } from "./ahs-prefill";

export const AHS_APPLIANCE_KINDS = [
  { value: "cooktop", label: "Cooktop", division: "cooking" },
  { value: "dishwasher", label: "Dishwasher", division: "dishwasher" },
  { value: "dryer", label: "Dryer", division: "laundry" },
  { value: "chest_freezer", label: "Chest Freezer", division: "refrigeration" },
  { value: "upright_freezer", label: "Upright Freezer", division: "refrigeration" },
  { value: "free_standing_ice_maker", label: "Free Standing Ice Maker", division: "refrigeration" },
  { value: "garbage_disposal", label: "Garbage Disposal", division: "all_other" },
  { value: "trash_compactor", label: "Trash Compactor", division: "dishwasher" },
  { value: "microwave", label: "Microwave", division: "microwave" },
  { value: "oven_combo", label: "Oven/Combo", division: "cooking" },
  { value: "range", label: "Range", division: "cooking" },
  { value: "range_hood", label: "Range Hood", division: "cooking" },
  { value: "refrigerator", label: "Refrigerator", division: "refrigeration" },
  { value: "washer", label: "Washer", division: "laundry" },
  { value: "washer_dryer_combo", label: "Washer/Dryer Combo", division: "laundry" },
] as const;

export type AhsApplianceKind = (typeof AHS_APPLIANCE_KINDS)[number]["value"];
export type AhsApplianceDivision = (typeof AHS_APPLIANCE_KINDS)[number]["division"];

export const AHS_APPLIANCE_LOCATIONS = [
  "Kitchen",
  "Laundry room",
  "Basement",
  "Garage",
  "Utility room",
  "Bathroom",
  "Hallway / closet",
  "Outdoor",
  "Other",
] as const;

// Values are the VRS AI contract's enums; labels are what the tech sees.
export const AHS_APPLIANCE_GRADES = [
  { value: "entry", label: "Entry" },
  { value: "mid", label: "Mid" },
  { value: "top", label: "Top" },
] as const;

export const AHS_FAILURE_CAUSES = [
  { value: "normal-wear", label: "Normal wear" },
  { value: "power-surge", label: "Power surge" },
  { value: "impact", label: "Impact" },
  { value: "installation-error", label: "Installation error" },
  { value: "abuse", label: "Abuse" },
  { value: "age", label: "Age" },
  { value: "other", label: "Other" },
] as const;

const requiredText = (label: string, max: number) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or less`);

// Blank (or whitespace-only) form input means "not entered".
const blankToUndefined = (value: unknown) =>
  value === null || (typeof value === "string" && value.trim() === "") ? undefined : value;

const optionalText = (label: string, max: number) =>
  z.preprocess(
    blankToUndefined,
    z.string().trim().max(max, `${label} must be ${max} characters or less`).optional(),
  );

// Form inputs arrive as strings; "" means not entered. "$1,234.50" is fine.
// NaN from junk text fails z.number() with its invalid_type_error message.
const numberFrom = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => {
    if (value === null) return undefined;
    if (typeof value !== "string") return value;
    const cleaned = value.replace(/[$,\s]/g, "");
    return cleaned === "" ? undefined : Number(cleaned);
  }, schema);

const moneyNumber = (label: string) =>
  z
    .number({
      required_error: `${label} is required`,
      invalid_type_error: `${label} must be a number`,
    })
    .nonnegative(`${label} can't be negative`)
    .max(1_000_000, `${label} is too large`)
    .multipleOf(0.01, `${label} can have at most 2 decimal places`);

const AHS_MAX_AMOUNT = 1_000_000;

const money = (label: string) => numberFrom(moneyNumber(label));

const enumOf = <T extends readonly { value: string }[]>(options: T, message: string) =>
  z.enum(options.map((option) => option.value) as [T[number]["value"], ...T[number]["value"][]], {
    errorMap: () => ({ message }),
  });

export const AHS_TECH_RECOMMENDATIONS = [
  { value: "repair", label: "Repair" },
  { value: "replace", label: "Replace" },
] as const;

export type AhsTechRecommendation = (typeof AHS_TECH_RECOMMENDATIONS)[number]["value"];

// What the tech types is kept to the minimum AHS asks for on the call
// (diagnosis, location, repair/replace, labor and the parts). Everything
// else is optional: VRS AI treats a missing value as "I'll confirm" and
// carries on. Contract number, brand, model and serial are filled from the
// service order on the server when available (prefilledFields).
//
// Every field that used to be required is still accepted, so tickets stored
// in the older, stricter shape keep parsing (parseStoredAhsDetails).
export const ahsPartSchema = z.object({
  partNumber: requiredText("Part number", 100),
  quantity: numberFrom(
    z
      .number({ invalid_type_error: "Quantity must be a number" })
      .int("Quantity must be a whole number")
      .min(1, "Quantity must be at least 1")
      .max(99, "Quantity must be 99 or less")
      .default(1),
  ),
  // 480 leaves room for the " (qty N)" suffix inside VRS AI's 500 limit.
  description: requiredText("Part description", 480),
  unitPrice: money("Part price"),
  partFunction: optionalText("Part function", 200),
  failureReason: optionalText("Part failure reason", 500),
});

export const ahsDetailsSchema = z.object({
  contractNumber: optionalText("Dispatch / contract number", 100),
  customerName: optionalText("Customer name", 255),
  customerAddress: optionalText("Customer address", 1_000),
  applianceKind: enumOf(AHS_APPLIANCE_KINDS, "Select an appliance type"),
  brand: optionalText("Brand", 100),
  modelNumber: optionalText("Model number", 100),
  serialNumber: optionalText("Serial number", 100),
  applianceAge: numberFrom(
    z
      .number({ invalid_type_error: "Appliance age must be a number" })
      .int("Enter the age in whole years")
      .min(0, "Appliance age can't be negative")
      .max(100, "Appliance age must be 100 years or less")
      .optional(),
  ),
  applianceLocation: requiredText("Appliance location", 100),
  applianceGrade: z.preprocess(
    blankToUndefined,
    enumOf(AHS_APPLIANCE_GRADES, "Select the appliance grade").optional(),
  ),
  applianceColor: optionalText("Appliance color", 40),
  failureCause: enumOf(AHS_FAILURE_CAUSES, "Select the failure cause"),
  // Absent on tickets stored before the choice existed; those were repairs.
  techRecommendation: z.preprocess(
    blankToUndefined,
    enumOf(AHS_TECH_RECOMMENDATIONS, "Choose repair or replace").default("repair"),
  ),
  laborAmount: money("Labor amount"),
  taxAmount: numberFrom(moneyNumber("Tax amount").default(0)),
  parts: z
    .array(ahsPartSchema, { required_error: "Add at least one part" })
    .min(1, "Add at least one part")
    .max(10, "No more than 10 parts")
    // VRS AI caps each line total (sell_price) and the parts total
    // (part_price) at 1,000,000; reject here so the tech sees it instead of
    // the ticket silently skipping VRS AI enrollment.
    .superRefine((parts, context) => {
      let total = 0;
      parts.forEach((part, index) => {
        const line = part.quantity * part.unitPrice;
        total += line;
        if (line > AHS_MAX_AMOUNT) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, "unitPrice"],
            message: "Quantity × price must be $1,000,000 or less",
          });
        }
      });
      if (total > AHS_MAX_AMOUNT) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Parts total must be $1,000,000 or less" });
      }
    }),
  // Which fields the server filled from the service order (Snowflake). Set
  // only by the server at submit; any client-sent value is discarded.
  prefilledFields: z.array(z.enum(AHS_PREFILL_FIELDS)).optional(),
  // Purchase year from the HSSOM Order Lookup, set by the server only when
  // the tech left the appliance age blank (never an invented age). Any
  // client-sent value is discarded.
  purchaseYear: z.number().int().min(1900).max(2100).optional(),
});

export type AhsPart = z.infer<typeof ahsPartSchema>;
export type AhsDetails = z.infer<typeof ahsDetailsSchema>;

// Draft AHS details. The technician no longer enters AHS details; at submit
// the server stores what the service-order lookups found (Snowflake, HSSOM)
// as a draft in submissions.ahs_details, and the VRS manager completes it at
// Stage 1 (PATCH /api/submissions/:id/ahs-details, see shared/ahs-review.ts).
// Every field is optional; a draft becomes complete once
// ahsDetailsSchema.safeParse succeeds on it.
export const ahsPartDraftSchema = ahsPartSchema.partial();
export const ahsDetailsDraftSchema = ahsDetailsSchema.partial().extend({
  parts: z.array(ahsPartDraftSchema).max(10).optional(),
});

export type AhsPartDraft = z.infer<typeof ahsPartDraftSchema>;
export type AhsDetailsDraft = z.infer<typeof ahsDetailsDraftSchema>;

// Reads submissions.ahs_details as a draft (complete details parse too).
export function parseStoredAhsDetailsDraft(raw: string | null | undefined): AhsDetailsDraft | null {
  if (!raw) return null;
  try {
    const parsed = ahsDetailsDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function ahsApplianceKind(value: string | null | undefined) {
  return AHS_APPLIANCE_KINDS.find((kind) => kind.value === value);
}

export function ahsDivisionFor(kind: AhsApplianceKind): AhsApplianceDivision {
  return ahsApplianceKind(kind)!.division;
}

export function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function ahsPartLineTotal(part: Pick<AhsPart, "quantity" | "unitPrice">): number {
  return roundCents(part.quantity * part.unitPrice);
}

// "Part cost" on the form: the sum of every part line (quantity × price).
export function ahsPartsTotal(details: Pick<AhsDetails, "parts">): number {
  return roundCents(details.parts.reduce((sum, part) => sum + ahsPartLineTotal(part), 0));
}

export function ahsGrandTotal(details: AhsDetails): number {
  return roundCents(ahsPartsTotal(details) + details.laborAmount + details.taxAmount);
}

export function parseStoredAhsDetails(raw: string | null | undefined): AhsDetails | null {
  if (!raw) return null;
  try {
    const parsed = ahsDetailsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
