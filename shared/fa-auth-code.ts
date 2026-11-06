// First American authorization codes follow VRS's own format (FA only; AHS
// and every other warranty keep the partner's number):
//
//   "FA" + MMDD (US Eastern, no year) + "VRS" + the approver's initials
//   e.g. FA0728VRSHJ = First American, July 28, VRS, Hamed Jabarkhail.
//
// First American does not give a number of its own; this code IS the auth
// code. When VRS AI obtained the approval the initials are "AI".
import { getEtDateString } from "./business-hours";

export const VRS_AI_INITIALS = "AI";

// "FA" + MMDD in Eastern time + "VRS" + initials (uppercased, letters only).
export function buildFirstAmericanAuthCode(at: Date, initials: string): string {
  const [, month, day] = getEtDateString(at).split("-");
  const letters = (initials ?? "").replace(/[^A-Za-z]/g, "").toUpperCase();
  return `FA${month}${day}VRS${letters}`;
}

// Name suffixes that are not the last name ("John Smith Jr." -> JS).
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function firstLetter(word: string): string | null {
  const match = word.match(/[A-Za-z]/);
  return match ? match[0].toUpperCase() : null;
}

function nameWords(part: string): string[] {
  return part
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && /[A-Za-z]/.test(w));
}

// First letter of the first name + first letter of the last name, uppercase.
// "First Last", "First Middle Last" (first + last) and "Last, First" (comma
// form) are handled; null when two letters cannot be found (single word,
// empty).
export function agentInitials(name: string | null | undefined): string | null {
  const raw = (name ?? "").trim();
  if (!raw) return null;

  let first: string | undefined;
  let last: string | undefined;
  const comma = raw.indexOf(",");
  if (comma >= 0) {
    // "Last, First [Middle]"
    const lastWords = nameWords(raw.slice(0, comma));
    const firstWords = nameWords(raw.slice(comma + 1));
    first = firstWords[0];
    last = lastWords[0];
  } else {
    const words = nameWords(raw);
    while (words.length > 2 && NAME_SUFFIXES.has(words[words.length - 1].toLowerCase().replace(/\./g, ""))) {
      words.pop();
    }
    if (words.length >= 2) {
      first = words[0];
      last = words[words.length - 1];
    }
  }
  if (!first || !last) return null;
  const a = firstLetter(first);
  const b = firstLetter(last);
  return a && b ? `${a}${b}` : null;
}

// True for a First American ticket: warrantyType "first_american", or a
// warrantyProvider naming First American.
export function isFirstAmericanWarranty(ticket: {
  warrantyType?: string | null;
  warrantyProvider?: string | null;
}): boolean {
  if (ticket.warrantyType === "first_american") return true;
  const provider = (ticket.warrantyProvider ?? "").toLowerCase().replace(/_/g, " ");
  return provider.includes("first american");
}

// The auth code a VRS AI approval leaves on the ticket. First American gets
// FA + MMDD + VRS + AI, dated by the event's own occurredAt so a retried
// delivery of the same event always yields the same code; every other
// warranty keeps the partner's authNumber.
export function vrsAiTicketAuthCode(
  ticket: { warrantyType?: string | null; warrantyProvider?: string | null },
  result: { authNumber: string; occurredAt: string },
): string {
  if (!isFirstAmericanWarranty(ticket)) return result.authNumber;
  const at = new Date(result.occurredAt);
  if (Number.isNaN(at.getTime())) return result.authNumber;
  return buildFirstAmericanAuthCode(at, VRS_AI_INITIALS);
}

// The Stage 2 auth code a human agent starts with on a First American ticket:
// today's FA code with the agent's initials. null for any other warranty, or
// when the agent's initials cannot be derived (the input stays empty).
export function firstAmericanAuthCodePrefill(
  ticket: { warrantyType?: string | null; warrantyProvider?: string | null } | null | undefined,
  agentName: string | null | undefined,
  at: Date = new Date(),
): string | null {
  if (!ticket || !isFirstAmericanWarranty(ticket)) return null;
  const initials = agentInitials(agentName);
  return initials ? buildFirstAmericanAuthCode(at, initials) : null;
}
