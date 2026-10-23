import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useForm } from "react-hook-form";
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
import type { AhsPrefillResponse } from "../shared/ahs-prefill";
import {
  AHS_CUSTOMER_FROM_SO_TEXT,
  AHS_DISPATCH_FROM_SO_TEXT,
  AHS_PREFILL_HINT,
  AhsDetailsCard,
  addAhsDetailsIssues,
  ahsCustomerFromServiceOrder,
  ahsDetailsToForm,
  ahsPrefillUpdates,
  ahsReviewCustomer,
  emptyAhsDetailsForm,
  hasAhsCustomerValues,
  isAhsPrefilledValue,
  normalizeAhsPrefillResponse,
  omitAhsCustomerPiiFromDraft,
  splitAhsServiceOrder,
  type AhsDetailsFormValues,
} from "../client/src/components/ahs-details-fields";
import { Form } from "../client/src/components/ui/form";

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

// The fewest inputs a tech can submit with: one part, everything optional
// left blank exactly as the empty form holds it.
const minimalFormValues: AhsDetailsFormValues = {
  ...emptyAhsDetailsForm(),
  applianceKind: "washer",
  applianceLocation: "Laundry room",
  failureCause: "normal-wear",
  laborAmount: "120",
  parts: [{
    partNumber: "WPW10503278",
    quantity: "",
    description: "Electronic control board",
    unitPrice: "245",
    partFunction: "",
    failureReason: " ",
  }],
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
    ["blank required text", { applianceLocation: "  " }, "applianceLocation", "Appliance location is required"],
    ["blank labor", { laborAmount: "" }, "laborAmount", "Labor amount is required"],
    ["non-numeric tax", { taxAmount: "abc" }, "taxAmount", "Tax amount must be a number"],
    ["N/A grade", { applianceGrade: "N/A" }, "applianceGrade", "Select the appliance grade"],
    ["unknown recommendation", { techRecommendation: "upgrade" }, "techRecommendation", "Choose repair or replace"],
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

  it("accepts the minimal tech input: blanks become undefined, quantity 1, tax 0, repair", () => {
    const parsed = ahsDetailsSchema.parse(minimalFormValues);
    expect(parsed).toEqual({
      applianceKind: "washer",
      applianceLocation: "Laundry room",
      failureCause: "normal-wear",
      techRecommendation: "repair",
      laborAmount: 120,
      taxAmount: 0,
      parts: [{
        partNumber: "WPW10503278",
        quantity: 1,
        description: "Electronic control board",
        unitPrice: 245,
      }],
    });
    expect(ahsGrandTotal(parsed)).toBe(365);
  });

  it("keeps the tech's repair-or-replace choice", () => {
    expect(
      ahsDetailsSchema.parse({ ...minimalFormValues, techRecommendation: "replace" }).techRecommendation,
    ).toBe("replace");
  });

  it("still reads a ticket stored in the older, stricter shape", () => {
    // Exactly what POST /api/submissions stored before the trimmed form:
    // every field present, no techRecommendation, no prefilledFields.
    const stored = {
      contractNumber: "AHS-778812",
      customerName: "Maria Gonzalez",
      customerAddress: "742 Evergreen Terrace, Hagerstown, MD 21740",
      applianceKind: "dryer",
      brand: "Whirlpool",
      modelNumber: "WED5000DW",
      serialNumber: "C31290822",
      applianceAge: 7,
      applianceLocation: "Laundry room",
      applianceGrade: "entry",
      applianceColor: "White",
      failureCause: "age",
      laborAmount: 1120,
      taxAmount: 15.6,
      parts: [{
        partNumber: "W10724237",
        quantity: 3,
        description: "Drum roller",
        unitPrice: 19.99,
        partFunction: "Supports the drum",
        failureReason: "Worn flat",
      }],
    };
    expect(parseStoredAhsDetails(JSON.stringify(stored))).toEqual({
      ...stored,
      techRecommendation: "repair",
    });
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
    expect(paths.sort()).toEqual([
      "ahsDetails.applianceKind",
      "ahsDetails.applianceLocation",
      "ahsDetails.failureCause",
      "ahsDetails.laborAmount",
      "ahsDetails.parts.0.description",
      "ahsDetails.parts.0.partNumber",
      "ahsDetails.parts.0.unitPrice",
    ]);
  });

  it("round-trips stored details into form values for resubmission", () => {
    const parsed = ahsDetailsSchema.parse(formValues);
    const asForm = ahsDetailsToForm(parsed);
    expect(asForm.laborAmount).toBe("1120.00");
    expect(asForm.parts[0].quantity).toBe("3");
    expect(ahsDetailsSchema.parse(asForm)).toEqual(parsed);
  });

  it("round-trips minimal details with blanks back into empty form strings", () => {
    const parsed = ahsDetailsSchema.parse(minimalFormValues);
    const asForm = ahsDetailsToForm(parsed);
    expect(asForm).toMatchObject({
      contractNumber: "",
      brand: "",
      applianceAge: "",
      applianceGrade: "",
      taxAmount: "0.00",
      techRecommendation: "repair",
    });
    expect(asForm.parts[0]).toMatchObject({ quantity: "1", partFunction: "", failureReason: "" });
    expect(ahsDetailsSchema.parse(asForm)).toEqual(parsed);
  });

  it("keeps customer name and address out of the saved draft, and nothing else", () => {
    const formValues = {
      serviceOrder: "8175-13538277",
      issueDescription: "Washer will not spin",
      ahsDetails: { ...minimalFormValues, customerName: "Maria Gonzalez", customerAddress: "742 Evergreen Terrace" },
    };
    const draft = omitAhsCustomerPiiFromDraft(formValues);
    const saved = JSON.stringify(draft);
    expect(saved).not.toContain("Maria Gonzalez");
    expect(saved).not.toContain("742 Evergreen Terrace");
    expect(draft.ahsDetails).not.toHaveProperty("customerName");
    expect(draft.ahsDetails).not.toHaveProperty("customerAddress");
    const { customerName: _n, customerAddress: _a, ...rest } = formValues.ahsDetails;
    expect(draft).toEqual({ ...formValues, ahsDetails: rest });
    expect(omitAhsCustomerPiiFromDraft({ serviceOrder: "x" })).toEqual({ serviceOrder: "x" });
    // The tech forms no longer have an AHS section, so their drafts hold no
    // AHS keys at all (tests/tech-form-no-ahs.test.ts).
  });

  // A resubmission loads the stored ticket, which may hold customer values
  // the server filled from the service order.
  const storedWithServerCustomer = JSON.stringify({
    ...ahsDetailsSchema.parse(minimalFormValues),
    customerName: "so-customer-Maria",
    customerAddress: "so-address-742-Evergreen",
    prefilledFields: ["customerName", "customerAddress"],
  });

  it("keeps loading stored details, server-filled customer values included, on resubmit", () => {
    const stored = parseStoredAhsDetails(storedWithServerCustomer);
    expect(stored?.prefilledFields).toEqual(["customerName", "customerAddress"]);
    const asForm = ahsDetailsToForm(stored!);
    expect(asForm).toMatchObject({
      customerName: "so-customer-Maria",
      customerAddress: "so-address-742-Evergreen",
    });
  });

  it("never saves customer name or address to a draft, resubmit included", () => {
    const asForm = ahsDetailsToForm(parseStoredAhsDetails(storedWithServerCustomer)!);
    const saved = JSON.stringify(omitAhsCustomerPiiFromDraft({ serviceOrder: "8175-13538277", ahsDetails: asForm }));
    expect(saved).not.toContain("so-customer-Maria");
    expect(saved).not.toContain("so-address-742-Evergreen");
  });
});

describe("AHS service-order prefill", () => {
  it("splits DDDD-SSSSSSSS and waits for a complete service order", () => {
    expect(splitAhsServiceOrder("8175-13538277")).toEqual({ district: "8175", serviceOrder: "13538277" });
    expect(splitAhsServiceOrder("8175-1353")).toBeNull();
    expect(splitAhsServiceOrder(undefined)).toBeNull();
  });

  it("treats anything but a well-formed response as unavailable", () => {
    expect(normalizeAhsPrefillResponse(null)).toEqual({ status: "unavailable" });
    expect(normalizeAhsPrefillResponse({ error: "nope" })).toEqual({ status: "unavailable" });
    expect(normalizeAhsPrefillResponse({ status: "not_found" })).toEqual({ status: "not_found" });
    expect(
      normalizeAhsPrefillResponse({
        status: "found",
        appliance: { brand: " Whirlpool ", modelNumber: "", serialNumber: 42, contractNumber: "leak" },
        hasDispatchNumber: "yes",
        hasCustomer: "yes",
        customerName: "leak",
      }),
    ).toEqual({ status: "found", appliance: { brand: "Whirlpool" }, hasDispatchNumber: false, hasCustomer: false });
  });

  it("keeps only whether the server will fill the customer, never the values", () => {
    const normalized = normalizeAhsPrefillResponse({
      status: "found",
      appliance: { customerName: "leak-name", customerAddress: "leak-address" },
      hasDispatchNumber: false,
      hasCustomer: true,
      customer: { name: "leak-name" },
    });
    expect(normalized).toEqual({ status: "found", appliance: {}, hasDispatchNumber: false, hasCustomer: true });
    expect(JSON.stringify(normalized)).not.toContain("leak");
    expect(ahsCustomerFromServiceOrder(normalized)).toBe(true);
    expect(ahsCustomerFromServiceOrder({ status: "found", appliance: {}, hasDispatchNumber: true })).toBe(false);
    expect(ahsCustomerFromServiceOrder({ status: "not_found" })).toBe(false);
    expect(ahsCustomerFromServiceOrder(null)).toBe(false);
  });

  it("detects customer values the tech typed", () => {
    expect(hasAhsCustomerValues({ customerName: " ", customerAddress: "" })).toBe(false);
    expect(hasAhsCustomerValues({})).toBe(false);
    expect(hasAhsCustomerValues(null)).toBe(false);
    expect(hasAhsCustomerValues({ customerName: "Maria" })).toBe(true);
    expect(hasAhsCustomerValues({ customerAddress: "742 Evergreen" })).toBe(true);
  });

  it("fills blanks but never overwrites a value the tech typed", () => {
    const appliance = { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "C31290822" };
    expect(ahsPrefillUpdates({ brand: "", modelNumber: "WTW5000DW2", serialNumber: " " }, appliance)).toEqual({
      brand: "Whirlpool",
      serialNumber: "C31290822",
    });
  });

  it("replaces or clears only what an earlier lookup filled when the SO changes", () => {
    const earlier = { brand: "Whirlpool", modelNumber: "WTW5000DW1" };
    expect(
      ahsPrefillUpdates(
        { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "typed-by-tech" },
        { brand: "Maytag", serialNumber: "M123" },
        earlier,
      ),
    ).toEqual({ brand: "Maytag", modelNumber: "" });
  });

  it("only hints a value that still matches the lookup", () => {
    const found: AhsPrefillResponse = { status: "found", appliance: { brand: "Whirlpool" }, hasDispatchNumber: true };
    expect(isAhsPrefilledValue(found, "brand", "Whirlpool")).toBe(true);
    expect(isAhsPrefilledValue(found, "brand", "Maytag")).toBe(false);
    expect(isAhsPrefilledValue(found, "modelNumber", "")).toBe(false);
    expect(isAhsPrefilledValue({ status: "unavailable" }, "brand", "Whirlpool")).toBe(false);
  });

  function renderCard(values: AhsDetailsFormValues, prefill?: AhsPrefillResponse | null) {
    function Harness() {
      const form = useForm({ defaultValues: { ahsDetails: values } });
      return createElement(Form, { ...form, children: createElement(AhsDetailsCard, { form, prefill }) });
    }
    return renderToStaticMarkup(createElement(Harness));
  }

  const prefilledValues: AhsDetailsFormValues = {
    ...minimalFormValues,
    brand: "Whirlpool",
    modelNumber: "WTW5000DW1",
    serialNumber: "typed-by-tech",
  };
  const found: AhsPrefillResponse = {
    status: "found",
    appliance: { brand: "Whirlpool", modelNumber: "WTW5000DW1", serialNumber: "C31290822" },
    hasDispatchNumber: true,
  };

  it("hides the dispatch input and hints prefilled values when the SO has them", () => {
    const html = renderCard(prefilledValues, found);
    expect(html).not.toContain('data-testid="input-ahs-contract-number"');
    expect(html).toContain('data-testid="text-ahs-dispatch-from-so"');
    expect(html).toContain(AHS_DISPATCH_FROM_SO_TEXT);
    expect(html).toContain('data-testid="input-ahs-brand-hint"');
    expect(html).toContain('data-testid="input-ahs-model-hint"');
    expect(html).not.toContain('data-testid="input-ahs-serial-hint"');
    expect(html).toContain(AHS_PREFILL_HINT);
  });

  it.each([
    ["no dispatch number", { ...found, hasDispatchNumber: false } as AhsPrefillResponse, true],
    ["not found", { status: "not_found" } as AhsPrefillResponse, false],
    ["unavailable", { status: "unavailable" } as AhsPrefillResponse, false],
    ["flag off / loading", null, false],
  ])("shows the dispatch number as an optional manual field when %s", (_label, prefill, hints) => {
    const html = renderCard(prefilledValues, prefill);
    expect(html).toContain('data-testid="input-ahs-contract-number"');
    expect(html).toContain("Dispatch / Contract Number (optional)");
    expect(html).not.toContain('data-testid="text-ahs-dispatch-from-so"');
    expect(html.includes(AHS_PREFILL_HINT)).toBe(hints);
  });

  const withCustomer: AhsPrefillResponse = { ...found, hasCustomer: true };

  it("hides the customer inputs and says the service order fills them when hasCustomer", () => {
    const html = renderCard(minimalFormValues, withCustomer);
    expect(html).not.toContain('data-testid="input-ahs-customer-name"');
    expect(html).not.toContain('data-testid="input-ahs-customer-address"');
    expect(html).toContain('data-testid="text-ahs-customer-from-so"');
    expect(html).toContain(AHS_CUSTOMER_FROM_SO_TEXT);
    expect(AHS_CUSTOMER_FROM_SO_TEXT).toBe("Customer name and address will be filled from the service order.");
  });

  it.each([
    ["a name", { customerName: "Maria Gonzalez" }],
    ["an address", { customerAddress: "742 Evergreen Terrace" }],
  ])("keeps the customer inputs and their values when the tech typed %s", (_label, typed) => {
    const html = renderCard({ ...minimalFormValues, ...typed }, withCustomer);
    expect(html).toContain('data-testid="input-ahs-customer-name"');
    expect(html).toContain('data-testid="input-ahs-customer-address"');
    expect(html).not.toContain('data-testid="text-ahs-customer-from-so"');
    for (const value of Object.values(typed)) expect(html).toContain(value);
  });

  it.each([
    ["not found", { status: "not_found" } as AhsPrefillResponse],
    ["unavailable", { status: "unavailable" } as AhsPrefillResponse],
    ["found without customer", { ...found, hasCustomer: false } as AhsPrefillResponse],
    ["an older server without hasCustomer", found],
    ["flag off / loading", null],
  ])("shows the customer name and address as optional inputs when %s", (_label, prefill) => {
    const html = renderCard(minimalFormValues, prefill);
    expect(html).toContain('data-testid="input-ahs-customer-name"');
    expect(html).toContain('data-testid="input-ahs-customer-address"');
    expect(html).toContain(">Customer Name<");
    expect(html).toContain(">Customer Address<");
    expect(html).not.toContain('data-testid="text-ahs-customer-from-so"');
    expect(html).not.toContain(AHS_CUSTOMER_FROM_SO_TEXT);
  });

  it("shows \"From service order\" for a blank customer on the review dialog, never a value", () => {
    expect(ahsReviewCustomer(undefined, withCustomer)).toBe("From service order");
    expect(ahsReviewCustomer("  ", withCustomer)).toBe("From service order");
    expect(ahsReviewCustomer("Maria Gonzalez", withCustomer)).toBe("Maria Gonzalez");
    expect(ahsReviewCustomer("Maria Gonzalez", { status: "not_found" })).toBe("Maria Gonzalez");
    expect(ahsReviewCustomer(undefined, found)).toBeUndefined();
    expect(ahsReviewCustomer(undefined, { status: "unavailable" })).toBeUndefined();
    expect(ahsReviewCustomer(undefined, null)).toBeUndefined();
  });

  it("marks only the trimmed set of inputs as required", () => {
    const html = renderCard(emptyAhsDetailsForm(), null);
    const required = [...html.matchAll(/<label[^>]*>([^<]*\*)<\/label>/g)].map((m) => m[1]);
    expect(required).toEqual([
      "Failure Cause *",
      "Appliance Location *",
      "Repair or Replace *",
      "Part Number *",
      "Description *",
      "Price (each) *",
      "Labor Amount *",
    ]);
  });
});

describe("VRS AI amount limits", () => {
  const base = ahsDetailsSchema.parse(formValues);
  it("rejects a part line or parts total over $1,000,000", () => {
    const tooBig = { ...base, parts: [{ ...base.parts[0], quantity: 99, unitPrice: 20_000 }] };
    const result = ahsDetailsSchema.safeParse(tooBig);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("$1,000,000 or less");
    expect(ahsDetailsSchema.safeParse(base).success).toBe(true);
  });
});
