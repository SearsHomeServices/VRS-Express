import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  APPLIANCE_CHOICES, applianceChoice, applianceKindFromServiceOrderProduct, applianceKindSchema,
  applianceSelectionMatches, applianceLabel, unambiguousApplianceKind, type ApplianceKind,
} from "../shared/appliance-types";
import { divisionFromServiceOrderProduct } from "../shared/appliance-division";

describe("detailed appliance choices preserve routing", () => {
  it("contains exactly the requested labels in ascending alphabetical order", () => {
    expect(APPLIANCE_CHOICES.map(c => c.label)).toEqual([
      "Chest Freezer", "Cooktop", "Dishwasher", "Dryer",
      "Free Standing IM", "Garbage Disposal", "HVAC", "Microwave",
      "Oven/Combo", "Range", "Range Hood", "Refrigerator", "Trash Compactor",
      "Upright Freezer", "Washer", "Washer/Dryer Combo",
    ]);
  });

  const schema = z.object({
    applianceType: z.string(),
    applianceKind: applianceKindSchema.nullish(),
  }).refine(applianceSelectionMatches);

  it.each(APPLIANCE_CHOICES)("validates and displays $label without replacing its routing division", choice => {
    const ticket = { applianceType: choice.division, applianceKind: choice.value };
    expect(schema.safeParse(ticket).success).toBe(true);
    expect(applianceLabel(ticket)).toBe(choice.label);
    expect(schema.safeParse({ ...ticket, applianceType: "wrong_division" }).success).toBe(false);
  });

  it("accepts legacy clients and preserves generic historical labels", () => {
    expect(schema.safeParse({ applianceType: "laundry" }).success).toBe(true);
    expect(applianceLabel({ applianceType: "laundry" })).toBe("Laundry");
    expect(schema.safeParse({ applianceType: "laundry", applianceKind: "toaster" }).success).toBe(false);
  });

  it("does not guess a detailed kind from a broad or historical category", () => {
    for (const division of ["cooking", "laundry", "refrigeration", "dishwasher", "all_other"]) {
      expect(unambiguousApplianceKind(division)).toBeUndefined();
    }
    expect(unambiguousApplianceKind("microwave")).toBe("microwave");
    expect(unambiguousApplianceKind("hvac")).toBe("hvac");
  });

  it("does not throw for a row with neither a kind nor a division", () => {
    expect(() => applianceLabel({} as { applianceType: string })).not.toThrow();
    expect(applianceLabel({} as { applianceType: string })).toBeUndefined();
  });

  it("does not display a stale detail after a division correction", () => {
    expect(applianceLabel({ applianceType: "cooking", applianceKind: "washer" })).toBe("Cooking");
  });
});

// One or more samples per rule of applianceKindFromServiceOrderProduct, in its
// priority order. WOM categories look like "WASHERDD - WASHER, DIRECT DRIVE";
// Snowflake HS_SP_CD is a bare word like "Washer".
const KIND_SAMPLES: [string, ApplianceKind][] = [
  ["WASHER/DRYER COMBO", "washer_dryer_combo"],
  ["WASHER DRYER", "washer_dryer_combo"],
  ["COMBO WASHER", "washer_dryer_combo"],
  ["DRYERELE - DRYER, ELECTRIC", "dryer"],
  ["Dryer", "dryer"],
  ["WASHERDD - WASHER, DIRECT DRIVE", "washer"],
  ["Washer", "washer"],
  ["WASHERFL - WASHER, FRONT LOAD", "washer"],
  ["DISHWASH - DISHWASHER, BUILT-IN", "dishwasher"],
  ["DISH WASHER", "dishwasher"],
  ["COMPACTR - TRASH COMPACTOR", "trash_compactor"],
  ["DISPOSER - FOOD WASTE DISPOSER", "garbage_disposal"],
  ["GARBAGE DISPOSAL", "garbage_disposal"],
  ["CHEST FREEZER", "chest_freezer"],
  ["FRZCHEST - FREEZER, CHEST", "chest_freezer"],
  ["UPRIGHT FREEZER", "upright_freezer"],
  ["FRZUPRT - FREEZER, UPRIGHT", "upright_freezer"],
  ["REFSBS - REFRIGERATOR, SIDE BY SIDE", "refrigerator"],
  ["REFRIGERATOR, BOTTOM FREEZER W/ ICE MAKER", "refrigerator"],
  ["MINI FRIDGE", "refrigerator"],
  [" refrigerator ", "refrigerator"],
  ["ICEMAKER - ICE MAKER, FREE STANDING", "free_standing_ice_maker"],
  ["IM", "free_standing_ice_maker"],
  ["MICROWAVE HOOD COMBO", "microwave"],
  ["MWOOTR - MICROWAVE, OVER THE RANGE", "microwave"],
  ["OTR", "microwave"],
  ["MWO", "microwave"],
  ["HOOD - RANGE HOOD", "range_hood"],
  ["COOKTOP - COOKTOP, ELECTRIC", "cooktop"],
  ["RANGEGAS - RANGE, GAS, SELF CLEAN OVEN", "range"],
  ["STOVE", "range"],
  ["WALLOVEN - WALL OVEN, DOUBLE", "oven_combo"],
  ["OVEN", "oven_combo"],
  ["COMBO - COOKING COMBO", "oven_combo"],
  ["HVAC", "hvac"],
  ["A/C - CENTRAL AIR CONDITIONER", "hvac"],
  ["FURNACE - GAS FURNACE", "hvac"],
  ["HEAT PUMP", "hvac"],
];

describe("applianceKindFromServiceOrderProduct", () => {
  it.each(KIND_SAMPLES)("maps %j to %s", (text, kind) => {
    expect(applianceKindFromServiceOrderProduct(text)).toBe(kind);
  });

  it.each(KIND_SAMPLES)("agrees with divisionFromServiceOrderProduct for %j", (text, kind) => {
    const division = divisionFromServiceOrderProduct(text);
    expect(division).toBeDefined();
    expect(applianceChoice(kind)?.division).toBe(division);
  });

  it("covers every one of the 16 choices", () => {
    expect(new Set(KIND_SAMPLES.map(([, kind]) => kind))).toEqual(new Set(APPLIANCE_CHOICES.map(c => c.value)));
  });

  it.each([
    ["a bare freezer (chest or upright)", "FREEZER"],
    ["a bare freezer category", "FREEZER - FREEZER"],
    ["a broad category", "LAUNDRY"],
    ["a wine cooler", "WINE COOLER"],
    ["a bare combo (laundry or cooking)", "COMBO"],
    ["a dishwasher abbreviation only", "DW"],
    ["an unknown product", "GENERATR - GENERATOR"],
    ["an unknown code", "ZZTOP"],
    ["blank", "   "],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
  ])("is undefined for %s", (_label, text) => {
    expect(applianceKindFromServiceOrderProduct(text)).toBeUndefined();
  });

  it("never returns a kind outside the routing division of the same text", () => {
    // COMBO is an oven/combo word, but the routing mapper says HVAC: the
    // two disagree, so no kind rather than a cooking appliance on HVAC.
    expect(divisionFromServiceOrderProduct("HVAC COMBO")).toBe("hvac");
    expect(applianceKindFromServiceOrderProduct("HVAC COMBO")).toBeUndefined();
    for (const text of ["SERVICE", "DISHWASHER DRYER", "AIR CONDITIONER HOOD"]) {
      const kind = applianceKindFromServiceOrderProduct(text);
      if (kind) expect(applianceChoice(kind)?.division).toBe(divisionFromServiceOrderProduct(text));
    }
  });

  it("keeps WASHER/DRYER COMBO in laundry for the routing mapper", () => {
    for (const text of ["WASHER/DRYER COMBO", "WASHER DRYER COMBO", "COMBO WASHER", "WASHDRY - WASHER/DRYER COMBO"]) {
      expect(divisionFromServiceOrderProduct(text)).toBe("laundry");
      expect(applianceKindFromServiceOrderProduct(text)).toBe("washer_dryer_combo");
    }
  });
});
