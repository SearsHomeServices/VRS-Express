// AHS (American Home Shield) authorization details captured on the
// technician form so the ticket can be sent to VRS AI.
//
// One schema validates both sides: the tech form (string inputs, coerced
// here) and POST /api/submissions. The stored JSON lives in
// submissions.ahs_details; server/vrs-app-enroll.ts maps it onto the VRS AI
// V9 authorize contract.
import { z } from "zod";

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

// Form inputs arrive as strings; "" means not entered. "$1,234.50" is fine.
// NaN from junk text fails z.number() with its invalid_type_error message.
const numberFrom = (schema: z.ZodNumber) =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const cleaned = value.replace(/[$,\s]/g, "");
    return cleaned === "" ? undefined : Number(cleaned);
  }, schema);

const money = (label: string) =>
  numberFrom(
    z
      .number({
        required_error: `${label} is required`,
        invalid_type_error: `${label} must be a number`,
      })
      .nonnegative(`${label} can't be negative`)
      .max(1_000_000, `${label} is too large`)
      .multipleOf(0.01, `${label} can have at most 2 decimal places`),
  );

const enumOf = <T extends readonly { value: string }[]>(options: T, message: string) =>
  z.enum(options.map((option) => option.value) as [T[number]["value"], ...T[number]["value"][]], {
    errorMap: () => ({ message }),
  });

export const ahsPartSchema = z.object({
  partNumber: requiredText("Part number", 100),
  quantity: numberFrom(
    z
      .number({ required_error: "Quantity is required", invalid_type_error: "Quantity must be a number" })
      .int("Quantity must be a whole number")
      .min(1, "Quantity must be at least 1")
      .max(99, "Quantity must be 99 or less"),
  ),
  // 480 leaves room for the " (qty N)" suffix inside VRS AI's 500 limit.
  description: requiredText("Part description", 480),
  unitPrice: money("Part price"),
  partFunction: requiredText("Part function", 200),
  failureReason: requiredText("Part failure reason", 500),
});

export const ahsDetailsSchema = z.object({
  contractNumber: requiredText("Dispatch / contract number", 100),
  customerName: requiredText("Customer name", 255),
  customerAddress: requiredText("Customer address", 1_000),
  applianceKind: enumOf(AHS_APPLIANCE_KINDS, "Select an appliance type"),
  brand: requiredText("Brand", 100),
  modelNumber: requiredText("Model number", 100),
  serialNumber: requiredText("Serial number", 100),
  applianceAge: numberFrom(
    z
      .number({ required_error: "Appliance age is required", invalid_type_error: "Appliance age must be a number" })
      .int("Enter the age in whole years")
      .min(0, "Appliance age can't be negative")
      .max(100, "Appliance age must be 100 years or less"),
  ),
  applianceLocation: requiredText("Appliance location", 100),
  applianceGrade: enumOf(AHS_APPLIANCE_GRADES, "Select the appliance grade"),
  applianceColor: requiredText("Appliance color", 40),
  failureCause: enumOf(AHS_FAILURE_CAUSES, "Select the failure cause"),
  laborAmount: money("Labor amount"),
  taxAmount: money("Tax amount"),
  parts: z
    .array(ahsPartSchema, { required_error: "Add at least one part" })
    .min(1, "Add at least one part")
    .max(10, "No more than 10 parts"),
});

export type AhsPart = z.infer<typeof ahsPartSchema>;
export type AhsDetails = z.infer<typeof ahsDetailsSchema>;

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
