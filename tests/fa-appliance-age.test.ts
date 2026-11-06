import { describe, expect, it } from "vitest";
import {
  FA_APPLIANCE_AGE_BUCKETS,
  FA_APPLIANCE_AGE_PLACEHOLDER,
  faApplianceAgeBucket,
  faApplianceAgeFromBucket,
  isFirstAmericanPartner,
} from "../shared/fa-appliance-age";
import { vrsAiPartnerName } from "../shared/warranty";

describe("First American appliance age buckets", () => {
  it("lists FA's options in FA's order", () => {
    expect(FA_APPLIANCE_AGE_BUCKETS).toEqual([
      "0 - 2 years",
      "3 years",
      "4 years",
      "5 years",
      "6 years",
      "7 years",
      "8 years",
      "9 - 11 years",
      "12 - 14 years",
      "15+ years",
    ]);
    expect(FA_APPLIANCE_AGE_PLACEHOLDER).toBe("Select appliance age");
  });

  it.each([
    [0, "0 - 2 years"],
    [1, "0 - 2 years"],
    [2, "0 - 2 years"],
    [3, "3 years"],
    [4, "4 years"],
    [5, "5 years"],
    [6, "6 years"],
    [7, "7 years"],
    [8, "8 years"],
    [9, "9 - 11 years"],
    [10, "9 - 11 years"],
    [11, "9 - 11 years"],
    [12, "12 - 14 years"],
    [13, "12 - 14 years"],
    [14, "12 - 14 years"],
    [15, "15+ years"],
    [16, "15+ years"],
    [100, "15+ years"],
  ] as const)("puts %s in %s", (age, bucket) => {
    expect(faApplianceAgeBucket(age)).toBe(bucket);
    expect(faApplianceAgeBucket(String(age))).toBe(bucket);
  });

  it("buckets fractions by whole years", () => {
    expect(faApplianceAgeBucket(2.9)).toBe("0 - 2 years");
    expect(faApplianceAgeBucket(3.5)).toBe("3 years");
    expect(faApplianceAgeBucket(8.99)).toBe("8 years");
    expect(faApplianceAgeBucket(11.5)).toBe("9 - 11 years");
    expect(faApplianceAgeBucket(14.9)).toBe("12 - 14 years");
    expect(faApplianceAgeBucket(" 7.4 ")).toBe("7 years");
  });

  it.each([null, undefined, "", "   ", Number.NaN, "abc", -1, "-3", Number.POSITIVE_INFINITY])(
    "has no bucket for %s",
    (age) => {
      expect(faApplianceAgeBucket(age as number | string | null | undefined)).toBeUndefined();
    },
  );

  it("stores each bucket's lower bound", () => {
    expect(FA_APPLIANCE_AGE_BUCKETS.map(faApplianceAgeFromBucket)).toEqual([0, 3, 4, 5, 6, 7, 8, 9, 12, 15]);
  });

  it("stores nothing for the placeholder or an unknown label", () => {
    for (const label of ["", FA_APPLIANCE_AGE_PLACEHOLDER, "10 years", "toString", "constructor", null, undefined]) {
      expect(faApplianceAgeFromBucket(label)).toBeUndefined();
    }
  });

  it("round-trips: a chosen bucket's stored number shows that bucket again", () => {
    for (const bucket of FA_APPLIANCE_AGE_BUCKETS) {
      expect(faApplianceAgeBucket(faApplianceAgeFromBucket(bucket))).toBe(bucket);
    }
  });

  it("recognizes First American by its Stage 1 partner name only", () => {
    expect(isFirstAmericanPartner(vrsAiPartnerName("first_american"))).toBe(true);
    expect(isFirstAmericanPartner(vrsAiPartnerName("american_home_shield"))).toBe(false);
    expect(isFirstAmericanPartner(vrsAiPartnerName("sears_protect"))).toBe(false);
    expect(isFirstAmericanPartner(undefined)).toBe(false);
  });
});
