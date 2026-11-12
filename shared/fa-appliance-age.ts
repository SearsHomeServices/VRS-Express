// First American's appliance age buckets, exactly as FA's own "Select
// Appliance Age" dropdown lists them. On FA tickets the VRS agent picks one
// of these instead of typing a number; every other warranty keeps the number.
//
// The stored value stays a number everywhere (SASHA's appliance_age,
// ahsDetails.applianceAge): a number shows as the bucket it falls in, and a
// chosen bucket stores its lower bound, so the two round-trip.
//
// There is no 0: the youngest bucket is "1 - 2 years" (stores 1). SASHA sends
// appliance_age 0 when it has no age (the contract requires a number), so 0
// has no bucket: the dropdown shows "Select appliance age" for the VRS agent
// to answer. hasApplianceAge is the rule dispatch enforces: nothing is sent
// to VRS AI without an age.
import { vrsAiPartnerName } from "./warranty";

export const FA_APPLIANCE_AGE_PLACEHOLDER = "Select appliance age";

export const FA_APPLIANCE_AGE_BUCKETS = [
  "1 - 2 years",
  "3 years",
  "4 years",
  "5 years",
  "6 years",
  "7 years",
  "8 years",
  "9 - 11 years",
  "12 - 14 years",
  "15 - 30 years",
] as const;
export type FaApplianceAgeBucket = (typeof FA_APPLIANCE_AGE_BUCKETS)[number];

// Each bucket's lower bound: what choosing it stores.
const LOWER_BOUND: Record<FaApplianceAgeBucket, number> = {
  "1 - 2 years": 1,
  "3 years": 3,
  "4 years": 4,
  "5 years": 5,
  "6 years": 6,
  "7 years": 7,
  "8 years": 8,
  "9 - 11 years": 9,
  "12 - 14 years": 12,
  "15 - 30 years": 15,
};

// The bucket a stored age (a number, or the form's string) falls in.
// Fractions go by whole years (floor); anything above 0 and under 3 is
// "1 - 2 years". Missing, blank, unreadable, negative or 0 (unknown) ages
// have no bucket.
export function faApplianceAgeBucket(age: number | string | null | undefined): FaApplianceAgeBucket | undefined {
  if (age === null || age === undefined) return undefined;
  if (typeof age === "string" && age.trim() === "") return undefined;
  const n = typeof age === "number" ? age : Number(age.trim());
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const years = Math.floor(n);
  if (years <= 2) return "1 - 2 years";
  if (years <= 8) return `${years} years` as FaApplianceAgeBucket;
  if (years <= 11) return "9 - 11 years";
  if (years <= 14) return "12 - 14 years";
  // Above 30 still shows here (nothing is hidden); re-picking keeps the
  // number SASHA sent.
  return "15 - 30 years";
}

// The number to store for a chosen bucket; undefined for anything else
// (including the placeholder).
export function faApplianceAgeFromBucket(bucket: string | null | undefined): number | undefined {
  return bucket && Object.prototype.hasOwnProperty.call(LOWER_BOUND, bucket)
    ? LOWER_BOUND[bucket as FaApplianceAgeBucket]
    : undefined;
}

// Whether a request carries a real appliance age: a number above 0 (0 is
// SASHA's "no age") and at most 100, the contract's maximum. Dispatch refuses
// to send to VRS AI without one.
export function hasApplianceAge(age: unknown): boolean {
  return typeof age === "number" && Number.isFinite(age) && age > 0 && age <= 100;
}

// partner is the Stage 1 display name (vrsAiPartnerName).
export function isFirstAmericanPartner(partner: string | null | undefined): boolean {
  return partner === vrsAiPartnerName("first_american");
}
