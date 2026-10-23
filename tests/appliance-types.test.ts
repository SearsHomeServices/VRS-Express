import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  APPLIANCE_CHOICES, applianceKindSchema, applianceSelectionMatches,
  applianceLabel, unambiguousApplianceKind,
} from "../shared/appliance-types";

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

  it("does not display a stale detail after a division correction", () => {
    expect(applianceLabel({ applianceType: "cooking", applianceKind: "washer" })).toBe("Cooking");
  });
});
