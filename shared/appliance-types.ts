import { z } from "zod";

// Detailed technician choices are separate from the existing routing divisions.
// Never use a kind as an agent permission, queue division, or bridge category.
export const APPLIANCE_CHOICES = [
  { value: "cooktop", label: "Cooktop", division: "cooking" },
  { value: "dishwasher", label: "Dishwasher", division: "dishwasher" },
  { value: "dryer", label: "Dryer", division: "laundry" },
  { value: "chest_freezer", label: "Chest Freezer", division: "refrigeration" },
  { value: "upright_freezer", label: "Upright Freezer", division: "refrigeration" },
  { value: "free_standing_ice_maker", label: "Free Standing IM", division: "refrigeration" },
  { value: "garbage_disposal", label: "Garbage Disposal", division: "all_other" },
  { value: "trash_compactor", label: "Trash Compactor", division: "dishwasher" },
  { value: "microwave", label: "Microwave", division: "microwave" },
  { value: "oven_combo", label: "Oven/Combo", division: "cooking" },
  { value: "range", label: "Range", division: "cooking" },
  { value: "range_hood", label: "Range Hood", division: "cooking" },
  { value: "refrigerator", label: "Refrigerator", division: "refrigeration" },
  { value: "washer", label: "Washer", division: "laundry" },
  { value: "washer_dryer_combo", label: "Washer/Dryer Combo", division: "laundry" },
  { value: "hvac", label: "HVAC", division: "hvac" },
] as const;

export type ApplianceKind = (typeof APPLIANCE_CHOICES)[number]["value"];
export const applianceKindSchema = z.enum(
  APPLIANCE_CHOICES.map(choice => choice.value) as [ApplianceKind, ...ApplianceKind[]],
  { required_error: "Select an appliance type" },
);

export function applianceChoice(kind: unknown) {
  return APPLIANCE_CHOICES.find(choice => choice.value === kind);
}

export function applianceSelectionMatches(row: { applianceKind?: string | null; applianceType: string }) {
  return !row.applianceKind || applianceChoice(row.applianceKind)?.division === row.applianceType;
}

// Broad historical/product-code categories cannot tell us the exact appliance.
export function unambiguousApplianceKind(division: string): ApplianceKind | undefined {
  return division === "microwave" || division === "hvac" ? division : undefined;
}

export function applianceLabel(row: { applianceKind?: string | null; applianceType: string }) {
  const legacy: Record<string, string> = {
    cooking: "Cooking", dishwasher: "Dishwasher / Compactor", microwave: "Microwave",
    laundry: "Laundry", refrigeration: "Refrigerator", hvac: "HVAC", all_other: "All Other",
  };
  const choice = applianceChoice(row.applianceKind);
  return (choice?.division === row.applianceType ? choice.label : undefined)
    ?? legacy[row.applianceType] ?? row.applianceType;
}
