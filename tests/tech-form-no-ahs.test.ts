import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Product decision (2026-10): the technician on the ground never sees an AHS
// details section, not even optional fields. The server looks the service
// order up and drafts the AHS details; the VRS manager completes them at
// Stage 1. These checks keep the tech forms back on the pre-AHS fields.
//
// 2026-10-23: the one exception is the three tech appliance details
// (Appliance Grade, Appliance Color, Part Function) on AHS and First
// American authorization tickets, sent as `techApplianceDetails` and behind
// techApplianceDetailsEnabled. They are not an AHS details section; see
// tests/tech-appliance-details-form.test.ts.

const pages = {
  "tech-submit": readFileSync(new URL("../client/src/pages/tech-submit.tsx", import.meta.url), "utf8"),
  "tech-resubmit": readFileSync(new URL("../client/src/pages/tech-resubmit.tsx", import.meta.url), "utf8"),
};

// Source of the single <FormField name="applianceType"> element, plus the
// source just before and after it.
function applianceTypeField(src: string) {
  const nameAt = src.indexOf('name="applianceType"');
  const start = src.lastIndexOf("<FormField", nameAt);
  const end = src.indexOf("/>", src.indexOf("</FormItem>", nameAt)) + 2;
  return { before: src.slice(0, start), field: src.slice(start, end), after: src.slice(end) };
}

describe.each(Object.entries(pages))("%s has no AHS details section", (_name, src) => {
  it("does not import or render the AHS details card", () => {
    expect(src).not.toMatch(/from "@\/components\/ahs-details-fields"/);
    expect(src).not.toMatch(/from "@shared\/ahs-details"/);
    expect(src).not.toMatch(/from "@\/hooks\/use-ahs-prefill"/);
    // The feature-flag hook is allowed for techApplianceDetailsEnabled only.
    expect(src.match(/import .* from "@\/hooks\/use-feature-flags";/g)).toEqual([
      'import { useFeatureFlags } from "@/hooks/use-feature-flags";',
    ]);
    expect(src.match(/const \{ (\w+) \} = useFeatureFlags\(\);/g)).toEqual([
      "const { techApplianceDetailsEnabled } = useFeatureFlags();",
    ]);
    for (const id of [
      "AhsDetailsCard",
      "AhsApplianceKindField",
      "addAhsDetailsIssues",
      "useAhsServiceOrderPrefill",
      "useVrsAiAppEnrollEnabled",
      "ahsMode",
    ]) {
      expect(src).not.toContain(id);
    }
  });

  it("does not send AHS details", () => {
    // The form schema has no AHS fields, so the parsed submit data (and the
    // payload spread from it) cannot carry them.
    expect(src).not.toContain("ahsDetails");
    expect(src).not.toContain("ahsRequired");
    expect(src).not.toMatch(/payload\.ahs/i);
  });

  it("sends the three tech appliance details only as techApplianceDetails", () => {
    expect(src).toContain("payload.techApplianceDetails = techApplianceDetails;");
    // Every payload key it sets is a known one: no AHS-shaped key sneaks in.
    const keys = new Set(Array.from(src.matchAll(/payload\.(\w+) =/g), (m) => m[1]));
    for (const key of keys) expect(key).not.toMatch(/^ahs/i);
    expect(keys.has("techApplianceDetails")).toBe(true);
  });

  it("uses the standard appliance type dropdown for every warranty, American Home Shield included", () => {
    expect(src.match(/name="applianceType"/g)).toHaveLength(1);
    const { before, field, after } = applianceTypeField(src);
    // Not the branch of a ternary or && on the warranty: the field follows
    // and precedes plain JSX.
    expect(before.trimEnd().endsWith(">")).toBe(true);
    expect(after.trimStart()).toMatch(/^(<|\{\/\*)/);
    // Its options are the standard divisions; only NLA hides HVAC.
    expect(field).toContain("APPLIANCE_TYPES.filter(");
    expect(field).toContain('!(watchedRequestType === "parts_nla" && type.value === "hvac")');
    expect(field).not.toMatch(/warranty|american_home_shield/i);
    for (const division of ["refrigeration", "laundry", "cooking", "dishwasher", "microwave", "hvac", "all_other"]) {
      expect(src).toContain(`{ value: "${division}", label: `);
    }
  });
});

describe("tech-submit draft and review dialog", () => {
  const src = pages["tech-submit"];

  it("restores and saves only the form's own fields, so no AHS keys reach localStorage", () => {
    expect(src).toContain("Object.keys(submissionFormSchema.shape)");
    expect(src).toContain("...pickSubmissionFormFields(draft.formValues as Record<string, unknown>)");
    expect(src).toContain("formValues: pickSubmissionFormFields(formValues),");
  });

  it("shows the standard appliance label on the review dialog", () => {
    expect(src).toContain('data-testid="review-appliance">{formatApplianceLabel(pendingData.applianceType)}</span>');
    expect(src).not.toContain("review-ahs-");
  });
});

describe("AHS service-order prefill hook", () => {
  it("is gone from the client: the server drafts AHS details instead", () => {
    expect(existsSync(new URL("../client/src/hooks/use-ahs-prefill.ts", import.meta.url))).toBe(false);
  });
});
