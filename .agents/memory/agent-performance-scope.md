---
name: Agent performance scope
description: User constraints for performance optimization of agents working tickets.
---

For agent performance work, identify the intended optimization areas before making changes. Keep changes performance-only and isolated; do not change or disrupt existing functionality, workflows, the AI/Sasha bridge, integrations, or optimizations already in place.

**Why:** The user explicitly requires faster, lighter ticket work without changing how VRS Express operates.

**How to apply:** Prefer bounded changes to redundant computation or read-only data access. Preserve permissions, response contracts, media identity, freshness safeguards, and business logic. Distinguish verified reductions in work from unmeasured production latency improvements.
