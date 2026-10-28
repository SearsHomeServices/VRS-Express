// The appliance details the technician enters on AHS, First American and
// Sears Protect authorization tickets (tech submit and resubmit forms):
// grade, color, location (room) and part function, plus the appliance's age
// in whole years on Sears Protect (the repair / replace calculator's age;
// the tech asks the customer).
//
// Stored as JSON in submissions.tech_appliance_details for all three.
// For AHS tickets the server also copies them into the AHS draft
// (submissions.ahs_details: applianceGrade, applianceColor,
// applianceLocation and part 1's partFunction) so the VRS manager sees them
// prefilled at Stage 1.
// Behind TECH_APPLIANCE_DETAILS_ENABLED (/api/config techApplianceDetailsEnabled).
import { z } from "zod";
import { AHS_APPLIANCE_LOCATIONS } from "./ahs-details";
import type { WarrantyType } from "./warranty";

export const TECH_APPLIANCE_GRADES = [
  { value: "low", label: "Low", ahsGrade: "entry" },
  { value: "medium", label: "Medium", ahsGrade: "mid" },
  { value: "high", label: "High", ahsGrade: "top" },
] as const;

export type TechApplianceGrade = (typeof TECH_APPLIANCE_GRADES)[number]["value"];

export const TECH_APPLIANCE_COLORS = [
  "Black",
  "White",
  "Black Stainless Steel",
  "Stainless Steel",
  "Bisque",
] as const;

export type TechApplianceColor = (typeof TECH_APPLIANCE_COLORS)[number];

// The same rooms the VRS manager's Stage 1 editor offers.
export const TECH_APPLIANCE_LOCATIONS = AHS_APPLIANCE_LOCATIONS;
export type TechApplianceLocation = (typeof TECH_APPLIANCE_LOCATIONS)[number];

const applianceLocationSchema = z.enum(TECH_APPLIANCE_LOCATIONS, {
  errorMap: () => ({ message: "Select the appliance location" }),
});

// What the tech form requires (client-side validation).
export const techApplianceDetailsSchema = z.object({
  applianceGrade: z.enum(
    TECH_APPLIANCE_GRADES.map((grade) => grade.value) as [TechApplianceGrade, ...TechApplianceGrade[]],
    { errorMap: () => ({ message: "Select the appliance grade" }) },
  ),
  applianceColor: z.enum(TECH_APPLIANCE_COLORS, {
    errorMap: () => ({ message: "Select the appliance color" }),
  }),
  applianceLocation: applianceLocationSchema,
  partFunction: z
    .string({ required_error: "Part function is required" })
    .trim()
    .min(1, "Part function is required")
    .max(200, "Part function must be 200 characters or less"),
});

export const TECH_APPLIANCE_AGE_MAX = 50;

// Whole years, 0 for under a year. The form sends the input's text.
const applianceAgeYearsSchema = z.preprocess(
  (value) => (typeof value === "string" ? (value.trim() === "" ? undefined : Number(value.trim())) : value),
  z
    .number({ required_error: "Appliance age is required", invalid_type_error: "Enter the age in whole years" })
    .int("Enter the age in whole years")
    .min(0, "Enter the age in whole years")
    .max(TECH_APPLIANCE_AGE_MAX, `Enter an age of ${TECH_APPLIANCE_AGE_MAX} years or less`),
);

export const TECH_APPLIANCE_AGE_WARRANTIES: readonly WarrantyType[] = ["sears_protect"];

// Whether the form asks for the appliance age (on top of the four details).
export function techApplianceAgeApplies(warrantyType: string | null | undefined): boolean {
  return TECH_APPLIANCE_AGE_WARRANTIES.includes(warrantyType as WarrantyType);
}

// What the tech form requires for this warranty.
export function techApplianceDetailsSchemaFor(warrantyType: string | null | undefined) {
  return techApplianceAgeApplies(warrantyType)
    ? techApplianceDetailsSchema.extend({ applianceAgeYears: applianceAgeYearsSchema })
    : techApplianceDetailsSchema;
}

// What the server accepts and stores: the location and age may be missing,
// so a tech form cached before they were added still submits and rows
// stored before they were added still parse.
export const storedTechApplianceDetailsSchema = techApplianceDetailsSchema.extend({
  applianceLocation: applianceLocationSchema.optional(),
  applianceAgeYears: z.number().int().min(0).max(TECH_APPLIANCE_AGE_MAX).optional(),
});

export type TechApplianceDetails = z.infer<typeof storedTechApplianceDetailsSchema>;

export const TECH_APPLIANCE_DETAILS_WARRANTIES: readonly WarrantyType[] = [
  "american_home_shield",
  "first_american",
  "sears_protect",
];

// Whether the tech form asks for (and the server keeps) these details.
export function techApplianceDetailsApply(
  warrantyType: string | null | undefined,
  requestType: string | null | undefined,
): boolean {
  return (
    requestType === "authorization" &&
    TECH_APPLIANCE_DETAILS_WARRANTIES.includes(warrantyType as WarrantyType)
  );
}

// Low/Medium/High → the VRS AI contract's entry/mid/top.
export function ahsGradeFromTechGrade(grade: TechApplianceGrade): "entry" | "mid" | "top" {
  return TECH_APPLIANCE_GRADES.find((option) => option.value === grade)!.ahsGrade;
}

export function techApplianceAgeLabel(years: number | null | undefined): string | undefined {
  if (years == null) return undefined;
  return years === 0 ? "Under 1 year" : `${years} year${years === 1 ? "" : "s"}`;
}

export function techApplianceGradeLabel(grade: string | null | undefined): string | undefined {
  return TECH_APPLIANCE_GRADES.find((option) => option.value === grade)?.label;
}

export function parseStoredTechApplianceDetails(raw: string | null | undefined): TechApplianceDetails | null {
  if (!raw) return null;
  try {
    const parsed = storedTechApplianceDetailsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
