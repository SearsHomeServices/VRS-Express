// The three appliance details the technician enters on AHS and First
// American authorization tickets (tech submit and resubmit forms).
//
// Stored as JSON in submissions.tech_appliance_details for both warranties.
// For AHS tickets the server also copies them into the AHS draft
// (submissions.ahs_details: applianceGrade, applianceColor and part 1's
// partFunction) so the VRS manager sees them prefilled at Stage 1.
// Behind TECH_APPLIANCE_DETAILS_ENABLED (/api/config techApplianceDetailsEnabled).
import { z } from "zod";
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

export const techApplianceDetailsSchema = z.object({
  applianceGrade: z.enum(
    TECH_APPLIANCE_GRADES.map((grade) => grade.value) as [TechApplianceGrade, ...TechApplianceGrade[]],
    { errorMap: () => ({ message: "Select the appliance grade" }) },
  ),
  applianceColor: z.enum(TECH_APPLIANCE_COLORS, {
    errorMap: () => ({ message: "Select the appliance color" }),
  }),
  partFunction: z
    .string({ required_error: "Part function is required" })
    .trim()
    .min(1, "Part function is required")
    .max(200, "Part function must be 200 characters or less"),
});

export type TechApplianceDetails = z.infer<typeof techApplianceDetailsSchema>;

export const TECH_APPLIANCE_DETAILS_WARRANTIES: readonly WarrantyType[] = [
  "american_home_shield",
  "first_american",
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

export function techApplianceGradeLabel(grade: string | null | undefined): string | undefined {
  return TECH_APPLIANCE_GRADES.find((option) => option.value === grade)?.label;
}

export function parseStoredTechApplianceDetails(raw: string | null | undefined): TechApplianceDetails | null {
  if (!raw) return null;
  try {
    const parsed = techApplianceDetailsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
