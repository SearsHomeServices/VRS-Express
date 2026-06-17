---
name: Business-hours elapsed math — JS↔SQL equivalence
description: How to port getBusinessElapsedMs (VRS dashboard timing avgs) into SQL bit-equivalently, and the timezone assumptions that make it safe.
---

# Porting business-hours elapsed math to SQL

`getBusinessElapsedMs` (shared/business-hours.ts) sums only the in-business-hours
portion of an interval, per the admin-configured profile (open/close HH:MM ET +
openDays). The admin dashboard analytics + district-rollup averages used to fetch
every reviewed row into Node and loop. This can run entirely in Postgres,
**bit-equivalent** to the JS, with this pattern:

- Truncate both endpoints to ms: `date_trunc('milliseconds', col AT TIME ZONE 'UTC')`.
  **Why:** JS `new Date("...841009Z").getTime()` truncates microseconds to ms;
  without this the SQL keeps µs and diverges in the last digits.
- Per-row: `generate_series` over **ET calendar days**
  `date_trunc('day', endpoint AT TIME ZONE 'America/New_York') ... interval '1 day'`,
  then per day add `GREATEST(0, EXTRACT(EPOCH FROM (LEAST(e, dayClose) - GREATEST(s, dayOpen))))`
  only when `EXTRACT(ISODOW FROM d)::int = ANY(open_dows)`. dayOpen/dayClose =
  `((d::date + open_t) AT TIME ZONE 'America/New_York')`.
- DayKey→ISODOW map: Mon=1..Sat=6, **Sun=7** (Postgres ISODOW), matching JS getDay().
- Use `LEFT JOIN LATERAL generate_series(...) g(d) ON true` + `COALESCE(...,0)` so
  EVERY base row yields exactly one output row — guarantees the AVG count matches
  the JS loop's count (a row whose series is empty would otherwise vanish).
- District keys: JS `districtCode || "Unknown"` merges BOTH null and `''`;
  mirror with `COALESCE(NULLIF(district_code, ''), 'Unknown')`.

**Why this is safe (timezone):** the container's Node AND Postgres both run UTC,
and the `timestamp` columns are `timestamp without time zone` interpreted as UTC
instants. `AT TIME ZONE 'UTC'` turns them into timestamptz instants; `AT TIME ZONE
'America/New_York'` is DST-correct, matching JS Intl/getDay in ET.

**How to apply:** verified on dev data — per-row ms identical for all reviewed rows,
and aggregate AVGs identical to JS doubles. Display floors to seconds via
`formatDuration`, so even sub-ms float differences are invisible. If you change the
business-hours profile shape or add per-category (HVAC) aggregation, re-derive
open_t/close_t/open_dows from the same cached profile the JS used.
