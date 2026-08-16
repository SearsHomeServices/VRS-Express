---
name: Tech PDC filter parity
description: Client Tech PDC table filter vs server pdc export filter must stay in lockstep; how the parity test enforces it.
---

The Tech PDC filter is defined twice on purpose: the admin table uses the shared predicate in `shared/tech-pdc-filter.ts`, while the server keeps its own copy inside `getCoachingRecords` (coaching CSV/XLSX export + bulk Tech PDC push).

**Why:** the export must match the visible table; drift risks are subtle (whitespace-only coaching notes count as "missing_notes"; null AND empty-string techPdcStatus both count as "not_sent"; export scope is negative outcomes only, so a non-negative status tab must export zero rows).

**How to apply:** any change to either filter definition must keep the other in lockstep and pass `npm run test:tech-pdc-parity` (tests/tech-pdc-export-parity.test.ts — seeds a full pdc×notes×status matrix against the live dev server on :5000, cleans up by SO prefix 9994500). Change the shared module, not the inline dashboard logic.
