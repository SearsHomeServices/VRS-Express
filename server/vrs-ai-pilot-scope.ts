/**
 * Query/body opt-in for ticket-based VRS AI Pilot reports and actions.
 *
 * Only the literal boolean true or string "true" enables the scope. Missing,
 * false, and arbitrary truthy values retain the legacy behavior.
 */
export function requestsVrsAiPilotScope(
  input: Record<string, unknown> | null | undefined,
): boolean {
  return input?.vrsAiOnly === true || input?.vrsAiOnly === "true";
}

export const GLOBAL_REPORT_PILOT_SCOPE_ERROR =
  "This is a global administrative report and cannot be scoped to VRS AI Pilot tickets.";