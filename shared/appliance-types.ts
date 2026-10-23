import { z } from "zod";
import { divisionFromServiceOrderProduct } from "./appliance-division";

// Detailed technician choices are separate from the existing routing divisions.
// Never use a kind as an agent permission, queue division, or bridge category.
export const APPLIANCE_CHOICES = [
  { value: "chest_freezer", label: "Chest Freezer", division: "refrigeration" },
  { value: "cooktop", label: "Cooktop", division: "cooking" },
  { value: "dishwasher", label: "Dishwasher", division: "dishwasher" },
  { value: "dryer", label: "Dryer", division: "laundry" },
  { value: "free_standing_ice_maker", label: "Free Standing IM", division: "refrigeration" },
  { value: "garbage_disposal", label: "Garbage Disposal", division: "all_other" },
  { value: "hvac", label: "HVAC", division: "hvac" },
  { value: "microwave", label: "Microwave", division: "microwave" },
  { value: "oven_combo", label: "Oven/Combo", division: "cooking" },
  { value: "range", label: "Range", division: "cooking" },
  { value: "range_hood", label: "Range Hood", division: "cooking" },
  { value: "refrigerator", label: "Refrigerator", division: "refrigeration" },
  { value: "trash_compactor", label: "Trash Compactor", division: "dishwasher" },
  { value: "upright_freezer", label: "Upright Freezer", division: "refrigeration" },
  { value: "washer", label: "Washer", division: "laundry" },
  { value: "washer_dryer_combo", label: "Washer/Dryer Combo", division: "laundry" },
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
  // `choice &&`: a row with neither field must not read an absent choice.
  return (choice && choice.division === row.applianceType ? choice.label : undefined)
    ?? legacy[row.applianceType] ?? row.applianceType;
}

// The specific appliance a service order's product category names, e.g. the
// WOM category "WASHERDD - WASHER, DIRECT DRIVE" -> washer. Conservative: it
// returns undefined when the text is ambiguous (a bare "FREEZER" can be a
// chest or an upright) or names nothing it knows, and the tech picks the
// appliance by hand.
//
// Rules are checked in this order; the first match wins ("laundry WASH" is
// WASH outside DISHWASH):
//   1. laundry WASH + DRYER, or COMBO + laundry WASH  -> washer_dryer_combo
//   2. DRYER                                          -> dryer
//   3. laundry WASH                                   -> washer
//   4. DISHWASH                                       -> dishwasher
//   5. COMPACTOR                                      -> trash_compactor
//   6. DISPOS (disposer, disposal)                    -> garbage_disposal
//   7. FREEZER + CHEST (either order)                 -> chest_freezer
//   8. FREEZER + UPRIGHT (either order)               -> upright_freezer
//   9. REFRIG / FRIDGE                                -> refrigerator
//      (before ice maker: "REFRIGERATOR W/ ICE MAKER" is a refrigerator)
//  10. ICE MAKER / ICEMAKER / IM                      -> free_standing_ice_maker
//  11. any other FREEZER                              -> undefined (ambiguous)
//  12. MICROWAVE / MICRO / OTR / MWO                  -> microwave
//      (before hood and oven: "MICROWAVE HOOD COMBO" is a microwave)
//  13. HOOD                                           -> range_hood
//  14. COOKTOP                                        -> cooktop
//  15. RANGE / STOVE                                  -> range
//      (before oven: "RANGE, GAS, SELF CLEAN OVEN" is a range)
//  16. OVEN (incl. WALL OVEN) / COMBO                 -> oven_combo
//  17. HVAC / AIR COND / A/C / FURNACE / HEAT PUMP    -> hvac
//
// The kind's division must agree with divisionFromServiceOrderProduct() for
// the same text (the routing mapper in shared/appliance-division.ts);
// otherwise this returns undefined, so the two mappers can never disagree.
const KIND_RULES: { kind: ApplianceKind | undefined; test: (value: string, laundryWash: boolean) => boolean }[] = [
  { kind: "washer_dryer_combo", test: (v, wash) => wash && (/DRYER/.test(v) || /COMBO/.test(v)) },
  { kind: "dryer", test: (v) => /DRYER/.test(v) },
  { kind: "washer", test: (_v, wash) => wash },
  { kind: "dishwasher", test: (v) => /DISH\s*WASH/.test(v) },
  { kind: "trash_compactor", test: (v) => /COMPACTOR/.test(v) },
  { kind: "garbage_disposal", test: (v) => /DISPOS/.test(v) },
  { kind: "chest_freezer", test: (v) => /FREEZER/.test(v) && /\bCHEST\b/.test(v) },
  { kind: "upright_freezer", test: (v) => /FREEZER/.test(v) && /\bUPRIGHT\b/.test(v) },
  { kind: "refrigerator", test: (v) => /REFRIG|FRIDGE/.test(v) },
  { kind: "free_standing_ice_maker", test: (v) => /ICE\s*MAKER|\bIM\b/.test(v) },
  { kind: undefined, test: (v) => /FREEZER/.test(v) },
  { kind: "microwave", test: (v) => /MICRO\s*WAVE|\bMICRO\b|\bMWO\b|\bOTR\b/.test(v) },
  { kind: "range_hood", test: (v) => /HOOD/.test(v) },
  { kind: "cooktop", test: (v) => /COOK\s*TOP/.test(v) },
  { kind: "range", test: (v) => /RANGE|STOVE/.test(v) },
  { kind: "oven_combo", test: (v) => /OVEN|COMBO/.test(v) },
  { kind: "hvac", test: (v) => /HVAC|AIR\s*COND|\bA\/?C\b|FURNACE|HEAT\s*PUMP/.test(v) },
];

// Snowflake product-line codes (shared/appliance-division.ts
// SNOWFLAKE_PRODUCT_CODE_DIVISIONS) that name one specific appliance. Broad
// codes (REFRIGERATION, COOKING, GRILLING, ...) are absent on purpose: they
// set the routing category and the tech picks the specific appliance.
const SNOWFLAKE_PRODUCT_CODE_KINDS: Record<string, ApplianceKind | null> = {
  REFRIGERATION: null,
  WASHER: "washer",
  DRYER: "dryer",
  COOKING: null,
  HVAC: "hvac",
  DISH: "dishwasher",
  "COOKING MICRO": "microwave",
  DISPOSER: "garbage_disposal",
  GRILLING: null,
};

export function applianceKindFromServiceOrderProduct(text: string | null | undefined): ApplianceKind | undefined {
  const value = (text ?? "").toString().trim().toUpperCase();
  if (!value) return undefined;
  if (value in SNOWFLAKE_PRODUCT_CODE_KINDS) return SNOWFLAKE_PRODUCT_CODE_KINDS[value] ?? undefined;
  const laundryWash = /WASH/.test(value.replace(/DISH\s*WASH/g, " "));
  const kind = KIND_RULES.find((rule) => rule.test(value, laundryWash))?.kind;
  if (!kind) return undefined;
  return applianceChoice(kind)?.division === divisionFromServiceOrderProduct(value) ? kind : undefined;
}
