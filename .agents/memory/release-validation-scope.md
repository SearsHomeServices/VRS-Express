---
name: Release validation isolation
description: Keep release tests independent of a running app and preserve async viewer safety assertions.
---

Release-gate tests must run without an authenticated app, live provider calls, or production credentials.

**Why:** The coaching export parity suite logs into a running server; including it in release checks introduces an external prerequisite. Vite's mergeConfig concatenates test include arrays, so merging a narrowed list with the default suite can silently select live integration tests.

**How to apply:** Replace, rather than merge, test include lists and test the resulting configuration. Keep real-provider and running-server acceptance checks separate. Use condition-based waits for asynchronous React/TanStack assertions rather than disabling failed checks or relying on one zero-delay timer.