// Maps the service order's product code (Snowflake
// IH_SERVICEORDER_FULLDETAIL_TBL.HS_SP_CD, e.g. "Washer", "HVAC"; the same
// thing ServicePower shows as Product Category, e.g. "WASHERDD - WASHER,
// DIRECT DRIVE") to the tech form's appliance type (agent division).
//
// Returned by GET /api/tech/lookup-warranty as derived.applianceType so the
// tech form can preselect it. Unknown products return undefined and the tech
// picks the type by hand.

export const APPLIANCE_DIVISIONS = [
  "refrigeration",
  "laundry",
  "cooking",
  "dishwasher",
  "microwave",
  "hvac",
  "all_other",
] as const;

export type ApplianceDivision = (typeof APPLIANCE_DIVISIONS)[number];

// Checked in order; the first matching rule wins. Microwave before cooking so
// "MICROWAVE HOOD COMBO" is a microwave; dishwasher before laundry so
// "DISHWASHER" never matches "WASH".
const RULES: { division: ApplianceDivision; pattern: RegExp }[] = [
  { division: "microwave", pattern: /MICRO\s*WAVE|\bMICRO\b|\bMWO\b|\bOTR\b/ },
  { division: "dishwasher", pattern: /DISH\s*WASH|\bDW\b|COMPACTOR/ },
  { division: "refrigeration", pattern: /REFRIG|FRIDGE|FREEZER|ICE\s*MAKER|\bICE\b|\bIM\b|WINE|BEVERAGE/ },
  { division: "laundry", pattern: /WASH|DRYER|LAUNDRY/ },
  { division: "cooking", pattern: /RANGE|OVEN|COOK|STOVE|HOOD|COOKTOP|GRILL|WARMING/ },
  { division: "hvac", pattern: /HVAC|AIR\s*COND|\bA\/?C\b|FURNACE|HEAT\s*PUMP|AIR\s*HANDLER|BOILER|DEHUMID|THERMOSTAT/ },
  { division: "all_other", pattern: /DISPOS|WATER\s*HEATER|SOFTENER|GENERATOR|VACUUM|MOWER|TRACTOR/ },
];

// Snowflake HS_SP_CD holds one of a small set of product-line codes, not a
// free-text description. The full list (orders created in the last 12
// months, 2026-10-23, via scripts/diagnostics/list-product-codes.mts) maps
// exactly; the keyword RULES below handle WOM's longer Product Category text.
// "COOL" and "PORTHEATER" are read as room cooling / portable heating (HVAC).
export const SNOWFLAKE_PRODUCT_CODE_DIVISIONS: Record<string, ApplianceDivision> = {
  REFRIGERATION: "refrigeration",
  WASHER: "laundry",
  DRYER: "laundry",
  COOKING: "cooking",
  HVAC: "hvac",
  DISH: "dishwasher",
  "COOKING MICRO": "microwave",
  TRACTOR: "all_other",
  "LAWN & GARDEN": "all_other",
  WATERHEAT: "all_other",
  COOL: "hvac",
  DISPOSER: "all_other",
  GDO: "all_other",
  WATERTREAT: "all_other",
  GRILLING: "cooking",
  RECREATION: "all_other",
  "OIL-BOILER": "hvac",
  OTHER: "all_other",
  PORTHEATER: "hvac",
  "TV DIGITAL": "all_other",
  TOOLS: "all_other",
  AV: "all_other",
};

export function divisionFromServiceOrderProduct(raw: string | null | undefined): ApplianceDivision | undefined {
  const value = (raw ?? "").toString().trim().toUpperCase();
  if (!value) return undefined;
  return SNOWFLAKE_PRODUCT_CODE_DIVISIONS[value] ?? RULES.find((rule) => rule.pattern.test(value))?.division;
}
