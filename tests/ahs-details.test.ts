import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AHS_APPLIANCE_KINDS,
  ahsDetailsSchema,
  ahsDivisionFor,
  ahsGrandTotal,
  ahsPartsTotal,
  parseStoredAhsDetails,
} from "../shared/ahs-details";
import {
  addAhsDetailsIssues,
  ahsDetailsToForm,
  emptyAhsDetailsForm,
} from "../client/src/components/ahs-details-fields";

// What the tech form holds: every number still a typed string.
const formValues = {
  contractNumber: " AHS-778812 ",
  customerName: "Maria Gonzalez",
  customerAddress: "742 Evergreen Terrace, Hagerstown, MD 21740",
  applianceKind: "dryer",
  brand: "Whirlpool",
  modelNumber: "WED5000DW",
  serialNumber: "C31290822",
  applianceAge: "7",
  applianceLocation: "Laundry room",
  applianceGrade: "entry",
  applianceColor: "White",
  failureCause: "age",
  laborAmount: "$1,120.00",
  taxAmount: "15.60",
  parts: [
    {
      partNumber: "W10724237",
      quantity: "3",
      description: "Drum roller",
      unitPrice: "19.99",
      partFunction: "Supports the drum",
      failureReason: "Worn flat",
    },
  ],
};

describe("AHS details schema", () => {
  it("accepts form strings and returns trimmed text and real numbers", () => {
    const parsed = ahsDetailsSchema.parse(formValues);
    expect(parsed.contractNumber).toBe("AHS-778812");
    expect(parsed.applianceAge).toBe(7);
    expect(parsed.laborAmount).toBe(1120);
    expect(parsed.parts[0]).toMatchObject({ quantity: 3, unitPrice: 19.99 });
  });

  it("computes part cost as quantity × price and the grand total", () => {
    const parsed = ahsDetailsSchema.parse(formValues);
    expect(ahsPartsTotal(parsed)).toBe(59.97);
    expect(ahsGrandTotal(parsed)).toBe(1195.57);
  });

  it.each([
    ["blank required text", { brand: "  " }, "brand", "Brand is required"],
    ["blank amount", { taxAmount: "" }, "taxAmount", "Tax amount is required"],
    ["non-numeric amount", { laborAmount: "abc" }, "laborAmount", "Labor amount must be a number"],
    ["fractional cents", { laborAmount: "10.005" }, "laborAmount", "Labor amount can have at most 2 decimal places"],
    ["fractional age", { applianceAge: "2.5" }, "applianceAge", "Enter the age in whole years"],
    ["unknown appliance", { applianceKind: "hvac" }, "applianceKind", "Select an appliance type"],
    ["unknown failure cause", { failureCause: "" }, "failureCause", "Select the failure cause"],
    ["no parts", { parts: [] }, "parts", "Add at least one part"],
  ])("rejects %s with a field message", (_label, override, path, message) => {
    const result = ahsDetailsSchema.safeParse({ ...formValues, ...override });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({ path: [path], message }),
    );
  });

  it("rejects a zero part quantity on the part row", () => {
    const result = ahsDetailsSchema.safeParse({
      ...formValues,
      parts: [{ ...formValues.parts[0], quantity: "0" }],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      path: ["parts", 0, "quantity"],
      message: "Quantity must be at least 1",
    });
  });

  it("maps every detailed AHS appliance type to an existing agent division", () => {
    const divisions = ["cooking", "dishwasher", "microwave", "laundry", "refrigeration", "hvac", "all_other"];
    expect(AHS_APPLIANCE_KINDS).toHaveLength(15);
    for (const kind of AHS_APPLIANCE_KINDS) {
      expect(divisions).toContain(ahsDivisionFor(kind.value));
    }
    expect(ahsDivisionFor("washer_dryer_combo")).toBe("laundry");
    expect(ahsDivisionFor("range_hood")).toBe("cooking");
    expect(ahsDivisionFor("garbage_disposal")).toBe("all_other");
  });

  it("reads stored JSON back, and returns null for missing or bad data", () => {
    const parsed = ahsDetailsSchema.parse(formValues);
    expect(parseStoredAhsDetails(JSON.stringify(parsed))).toEqual(parsed);
    expect(parseStoredAhsDetails(null)).toBeNull();
    expect(parseStoredAhsDetails("{oops")).toBeNull();
    expect(parseStoredAhsDetails(JSON.stringify({ ...parsed, parts: [] }))).toBeNull();
  });
});

describe("AHS details on the tech forms", () => {
  const pageSchema = z
    .object({
      issueDescription: z.string(),
      ahsRequired: z.boolean().optional(),
      ahsDetails: z.any().optional(),
    })
    .superRefine(addAhsDetailsIssues);

  it("does not require AHS details when the section is hidden", () => {
    expect(pageSchema.safeParse({ issueDescription: "x" }).success).toBe(true);
    expect(
      pageSchema.safeParse({ issueDescription: "x", ahsRequired: false, ahsDetails: emptyAhsDetailsForm() }).success,
    ).toBe(true);
  });

  it("reports missing AHS fields under their own form field names", () => {
    const result = pageSchema.safeParse({
      issueDescription: "x",
      ahsRequired: true,
      ahsDetails: emptyAhsDetailsForm(),
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("ahsDetails.contractNumber");
    expect(paths).toContain("ahsDetails.applianceKind");
    expect(paths).toContain("ahsDetails.parts.0.partNumber");
    expect(paths).not.toContain("ahsDetails.parts.0.quantity");
  });

  it("round-trips stored details into form values for resubmission", () => {
    const parsed = ahsDetailsSchema.parse(formValues);
    const asForm = ahsDetailsToForm(parsed);
    expect(asForm.laborAmount).toBe("1120.00");
    expect(asForm.parts[0].quantity).toBe("3");
    expect(ahsDetailsSchema.parse(asForm)).toEqual(parsed);
  });
});
