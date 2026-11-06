// First American's appliance age buckets, exactly as FA's own "Select
// Appliance Age" dropdown lists them. On FA tickets the VRS agent picks one
// of these instead of typing a number; every other warranty keeps the number.
//
// The stored value stays a number everywhere (SASHA's appliance_age,
// ahsDetails.applianceAge): a number shows as the bucket it falls in, and a
// chosen bucket stores its lower bound, so the two round-trip.
import { vrsAiPartnerName } from "./warranty";

export const FA_APPLIANCE_AGE_PLACEHOLDER = "Select appliance age";

export const FA_APPLIANCE_AGE_BUCKETS = [
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
] as const;
export type FaApplianceAgeBucket = (typeof FA_APPLIANCE_AGE_BUCKETS)[number];

// Each bucket's lower bound: what choosing it stores.
const LOWER_BOUND: Record<FaApplianceAgeBucket, number> = {
  "0 - 2 years": 0,
  "3 years": 3,
  "4 years": 4,
  "5 years": 5,
  "6 years": 6,
  "7 years": 7,
  "8 years": 8,
  "9 - 11 years": 9,
  "12 - 14 years": 12,
  "15+ years": 15,
};

// The bucket a stored age (a number, or the form's string) falls in.
// Fractions go by whole years (floor). Missing, blank, unreadable or
// negative ages have no bucket.
export function faApplianceAgeBucket(age: number | string | null | undefined): FaApplianceAgeBucket | undefined {
  if (age === null || age === undefined) return undefined;
  if (typeof age === "string" && age.trim() === "") return undefined;
  const n = typeof age === "number" ? age : Number(age.trim());
  if (!Number.isFinite(n) || n < 0) return undefined;
  const years = Math.floor(n);
  if (years <= 2) return "0 - 2 years";
  if (years <= 8) return `${years} years` as FaApplianceAgeBucket;
  if (years <= 11) return "9 - 11 years";
  if (years <= 14) return "12 - 14 years";
  return "15+ years";
}

// The number to store for a chosen bucket; undefined for anything else
// (including the placeholder).
export function faApplianceAgeFromBucket(bucket: string | null | undefined): number | undefined {
  return bucket && Object.prototype.hasOwnProperty.call(LOWER_BOUND, bucket)
    ? LOWER_BOUND[bucket as FaApplianceAgeBucket]
    : undefined;
}

// partner is the Stage 1 display name (vrsAiPartnerName).
export function isFirstAmericanPartner(partner: string | null | undefined): boolean {
  return partner === vrsAiPartnerName("first_american");
}
