// 1099 Provider Portal — preset company list.
//
// Each 1099 provider account is assigned exactly one company name from this
// preset list by an admin at account-creation time. The list is intentionally
// a simple shared constant (not a DB-backed, admin-editable catalog) — the
// full management UI is out of scope for the initial portal. Replace the
// placeholder entries below with the real company list when it is provided.
export const PROVIDER_1099_COMPANIES: string[] = [
  "A&E Factory Service",
  "Diversified Service Group",
  "Marcone Servicer Network",
  "ServiceLive Providers",
  "United Appliance Repair",
];

export function isValidProvider1099Company(name: string | null | undefined): boolean {
  if (!name) return false;
  return PROVIDER_1099_COMPANIES.includes(name);
}
