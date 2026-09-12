---
name: Executive reporting definitions
description: Executive email conventions differ intentionally from operational analytics.
---

Executive reports use ticket outcomes, not Stage-1 analytics: completed is the approved executive bucket, rejected includes rejected_closed, and pending includes queued. A literal approved ticket status is reported separately as Other, not silently equated to completed.

**Why:** The requested executive summaries use completed tickets, and Stage-1-based totals materially differed from the previously shared executive figures. Do not change operational statuses to reconcile reporting.

**How to apply:** Keep executive definitions independent of operational analytics. Prior-week comparisons select matching created-at cohorts but observe current outcomes; never describe them as historical point-in-time outcomes without an actual historical snapshot.